import type {
  McpPromptInfo,
  McpPromptResult,
  McpResourceInfo,
  McpResourceReadResult,
  McpServerConfig,
  McpServerStatusRecord,
  McpToolInfo,
} from "../../../shared/agent-contracts.js";
import type { ToolRegistry } from "../../domain/agent/ports.js";
import type { AgentTool, AgentToolContext } from "../../domain/agent/types.js";
import { RuntimeEventBus } from "../../event-bus.js";
import {
  MCP_CONNECT_CONCURRENCY,
} from "../../application/constants.js";
import { McpClient } from "./client.js";
import {
  McpCacheStore,
  type McpStartupStatsRecord,
} from "./cache-store.js";
import type { McpToolDescriptor } from "./protocol.js";

interface ManagedMcpServer {
  config: McpServerConfig;
  client: McpClient | null;
  status: McpServerStatusRecord["status"];
  tools: McpToolDescriptor[];
  prompts: McpPromptInfo[];
  resources: McpResourceInfo[];
  registeredToolNames: string[];
  registeredToolMode: "none" | "lazy" | "live";
  lastConnectedAt?: string;
  lastError?: string;
  startupStats?: McpStartupStatsRecord;
  inFlight?: Promise<McpServerStatusRecord>;
  generation: number;
}

/**
 * Main-process MCP host adapts external MCP tools into the existing ToolRegistry.
 * Each server is isolated: a failed handshake unregisters only that server's
 * tools, records a status, and emits a typed runtime event without affecting
 * built-in tools or other MCP servers.
 */
export class McpHost {
  private readonly servers = new Map<string, ManagedMcpServer>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly bus: RuntimeEventBus,
    private readonly cacheStore?: McpCacheStore,
  ) {}

  /**
   * Runtime preferences are the MCP config authority. Reconfiguration waits for
   * stale clients to disconnect before callers reconnect enabled servers, so an
   * old close cannot overwrite the new server status or registered tools.
   */
  async configure(configs: readonly McpServerConfig[]): Promise<void> {
    const nextIds = new Set(configs.map((config) => config.id));
    for (const id of this.servers.keys()) {
      if (!nextIds.has(id)) {
        const server = this.requireServer(id);
        await this.disconnectForReconfigure(server);
        this.servers.delete(id);
      }
    }
    for (const config of configs) {
      const existing = this.servers.get(config.id);
      if (!existing) {
        const cached = this.cacheStore?.getSurface(config) ?? null;
        const startupStats = this.cacheStore?.getStartupStats(config) ?? undefined;
        this.servers.set(config.id, {
          config,
          client: null,
          status: cached && config.enabled ? "cached" : "disconnected",
          tools: cached?.tools ?? [],
          prompts: cached?.prompts ?? [],
          resources: cached?.resources ?? [],
          registeredToolNames: [],
          registeredToolMode: "none",
          generation: 0,
          ...(startupStats ? { startupStats } : {}),
        });
        const created = this.servers.get(config.id);
        if (created && cached && config.enabled) {
          this.installCachedSurface(created);
        }
        continue;
      }
      const requiresReconnect = !isSameServerRuntimeConfig(existing.config, config);
      if (!config.enabled || requiresReconnect) {
        await this.disconnectForReconfigure(existing);
      }
      existing.config = config;
    }
  }

  async connectEnabled(): Promise<void> {
    const enabled = [...this.servers.values()].filter((server) => server.config.enabled);
    let cursor = 0;
    const workers = Array.from({
      length: Math.min(MCP_CONNECT_CONCURRENCY, enabled.length),
    }, async () => {
      while (cursor < enabled.length) {
        const current = enabled[cursor];
        cursor += 1;
        this.installCachedSurface(current);
        await this.connect(current.config.id).catch((error) => {
          console.warn("[mcp-host] failed to connect MCP server:", error);
        });
      }
    });
    await Promise.all(workers);
  }

  async connect(serverId: string): Promise<McpServerStatusRecord> {
    const server = this.requireServer(serverId);
    if (server.inFlight) return server.inFlight;
    const generation = server.generation;
    let inFlight: Promise<McpServerStatusRecord>;
    inFlight = this.connectServer(server, generation).finally(() => {
      if (server.inFlight === inFlight) {
        server.inFlight = undefined;
      }
    });
    server.inFlight = inFlight;
    return server.inFlight;
  }

  async disconnect(serverId: string): Promise<McpServerStatusRecord> {
    const server = this.requireServer(serverId);
    server.generation += 1;
    server.inFlight = undefined;
    this.unregisterServerTools(server);
    let closeError: unknown;
    if (server.client) {
      const client = server.client;
      server.client = null;
      try {
        await client.close();
      } catch (error) {
        closeError = error;
      }
    }
    server.status = "disconnected";
    server.tools = [];
    server.prompts = [];
    server.resources = [];
    server.lastError = closeError
      ? `MCP disconnect close failed: ${messageOf(closeError)}`
      : undefined;
    this.emitConnection(server);
    if (closeError) {
      throw new Error(`MCP server disconnected locally but close failed: ${messageOf(closeError)}`);
    }
    return this.toStatus(server);
  }

  async refreshTools(serverId: string): Promise<McpServerStatusRecord> {
    const server = this.requireServer(serverId);
    if (!isServerConnected(server)) {
      return this.connect(serverId);
    }
    try {
      const tools = await server.client.refreshTools();
      this.replaceServerTools(server, tools);
      await this.cacheStore?.saveSurface(server.config, {
        capabilities: server.client.capabilitiesSnapshot(),
        tools,
        prompts: server.prompts,
        resources: server.resources,
      });
      server.status = "connected";
      server.lastError = undefined;
      this.emitToolListChanged(server);
    } catch (error) {
      await this.markFailed(server, error);
    }
    return this.toStatus(server);
  }

  async refreshSurface(serverId: string): Promise<McpServerStatusRecord> {
    const server = this.requireServer(serverId);
    if (!isServerConnected(server)) {
      return this.connect(serverId);
    }
    try {
      const surface = await server.client.refreshSurface();
      server.prompts = surface.prompts;
      server.resources = surface.resources;
      await this.cacheStore?.saveSurface(server.config, {
        capabilities: server.client.capabilitiesSnapshot(),
        tools: server.tools,
        prompts: surface.prompts,
        resources: surface.resources,
      });
      server.status = "connected";
      server.lastError = undefined;
      this.emitSurfaceChanged(server);
    } catch (error) {
      server.prompts = [];
      server.resources = [];
      server.lastError = messageOf(error);
      this.emitSurfaceChanged(server);
    }
    return this.toStatus(server);
  }

  listServers(): McpServerStatusRecord[] {
    return [...this.servers.values()].map((server) => this.toStatus(server));
  }

  listTools(serverId?: string): Array<{
    serverId: string;
    serverName: string;
    tools: McpToolInfo[];
  }> {
    const servers = serverId ? [this.requireServer(serverId)] : [...this.servers.values()];
    return servers.map((server) => ({
      serverId: server.config.id,
      serverName: server.config.name,
      tools: server.tools.map(toToolInfo),
    }));
  }

  listPrompts(serverId?: string): Array<{
    serverId: string;
    serverName: string;
    prompts: McpPromptInfo[];
  }> {
    const servers = serverId ? [this.requireServer(serverId)] : [...this.servers.values()];
    return servers.map((server) => ({
      serverId: server.config.id,
      serverName: server.config.name,
      prompts: server.prompts.map(toPromptInfo),
    }));
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult> {
    const server = await this.ensureConnectedServer(serverId);
    return server.client.getPrompt(name, args);
  }

  listResources(serverId?: string): Array<{
    serverId: string;
    serverName: string;
    resources: McpResourceInfo[];
  }> {
    const servers = serverId ? [this.requireServer(serverId)] : [...this.servers.values()];
    return servers.map((server) => ({
      serverId: server.config.id,
      serverName: server.config.name,
      resources: server.resources.map((resource) => ({ ...resource })),
    }));
  }

  async readResource(serverId: string, uri: string): Promise<McpResourceReadResult> {
    const server = await this.ensureConnectedServer(serverId);
    return server.client.readResource(uri);
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.disconnect(id).catch((error) => {
      console.warn("[mcp-host] failed to close MCP server:", error);
    })));
  }

  private async connectServer(
    server: ManagedMcpServer,
    generation: number,
  ): Promise<McpServerStatusRecord> {
    if (!server.config.enabled) {
      server.status = "disconnected";
      return this.toStatus(server);
    }
    await this.disconnectIfConnected(server);
    if (server.generation !== generation) {
      return this.toStatus(server);
    }
    server.status = "connecting";
    server.lastError = undefined;
    this.emitConnection(server);
    const startedAt = Date.now();
    let client: McpClient | null = null;
    try {
      client = new McpClient(server.config);
      // The client becomes server-owned before handshake completion so
      // disconnect/reconfigure can close a partially connected transport.
      server.client = client;
      const tools = await client.connect();
      if (server.generation !== generation || server.client !== client) {
        await this.closeClientAfterFailure(client, "stale");
        return this.toStatus(server);
      }
      client.onToolsChanged(() => {
        void this.refreshTools(server.config.id);
      });
      server.status = "connected";
      server.lastConnectedAt = new Date().toISOString();
      server.lastError = undefined;
      server.prompts = client.listPrompts();
      server.resources = client.listResources();
      this.replaceServerTools(server, tools);
      await this.cacheStore?.saveSurface(server.config, {
        capabilities: client.capabilitiesSnapshot(),
        tools,
        prompts: server.prompts,
        resources: server.resources,
      });
      await this.recordStartup(server, {
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      this.emitConnection(server);
      this.emitToolListChanged(server);
      this.emitSurfaceChanged(server);
    } catch (error) {
      if (server.generation !== generation || (client && server.client !== client)) {
        if (client) {
          await this.closeClientAfterFailure(client, "stale failed");
        }
        return this.toStatus(server);
      }
      await this.recordStartup(server, {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: messageOf(error),
      });
      await this.markFailed(server, error);
    }
    return this.toStatus(server);
  }

  private async disconnectIfConnected(server: ManagedMcpServer): Promise<void> {
    const client = server.client;
    const wasLazy = server.registeredToolMode === "lazy";
    if (client || server.registeredToolMode === "live") {
      this.unregisterServerTools(server);
    }
    server.client = null;
    if (!wasLazy) {
      server.tools = [];
      server.prompts = [];
      server.resources = [];
    }
    if (!client) {
      return;
    }
    try {
      await client.close();
    } catch (error) {
      console.warn("[mcp-host] failed to close previous MCP client before reconnect:", error);
    }
  }

  // Runtime preferences are the config authority. A stale server may fail its
  // protocol close after local state has been cleared; keep that failure
  // traceable without leaving removed or updated configs stuck behind old tools.
  private async disconnectForReconfigure(server: ManagedMcpServer): Promise<void> {
    try {
      await this.disconnect(server.config.id);
    } catch (error) {
      console.warn(
        "[mcp-host] MCP server disconnected locally during reconfigure but close failed:",
        error,
      );
    }
  }

  private replaceServerTools(
    server: ManagedMcpServer,
    tools: McpToolDescriptor[],
    options: { lazy?: boolean } = {},
  ): void {
    this.unregisterServerTools(server);
    server.tools = tools;
    for (const tool of tools) {
      const agentTool = options.lazy ? this.toLazyAgentTool(server, tool) : this.toAgentTool(server, tool);
      this.registry.register(agentTool);
      server.registeredToolNames.push(agentTool.definition.name);
    }
    server.registeredToolMode = options.lazy ? "lazy" : "live";
  }

  private unregisterServerTools(server: ManagedMcpServer): void {
    for (const name of server.registeredToolNames) {
      this.registry.unregister(name);
    }
    server.registeredToolNames = [];
    server.registeredToolMode = "none";
  }

  private toAgentTool(server: ManagedMcpServer, tool: McpToolDescriptor): AgentTool {
    return {
      definition: {
        name: tool.name,
        description: tool.description || `MCP tool ${tool.rawName} from ${server.config.name}.`,
        inputSchema: tool.inputSchema,
      },
      metadata: {
        category: "command",
        isReadOnly: tool.readOnly,
        isDestructive: tool.readOnly ? false : true,
      },
      execute: async (input: Record<string, unknown>, context: AgentToolContext) => {
        if (!server.client) {
          throw new Error(`MCP server is not connected: ${server.config.name}`);
        }
        const result = await server.client.callTool(tool.name, input, {
          signal: context.signal,
        });
        if (result.isError) {
          throw new Error(result.content);
        }
        return {
          toolCallId: "",
          name: tool.name,
          content: result.content,
          displayResult: {
            serverId: server.config.id,
            serverName: server.config.name,
            toolName: tool.rawName,
            result: result.displayResult,
          },
        };
      },
    };
  }

  private toLazyAgentTool(server: ManagedMcpServer, tool: McpToolDescriptor): AgentTool {
    let lazyTool: AgentTool;
    lazyTool = {
      definition: {
        name: tool.name,
        description: tool.description || `MCP tool ${tool.rawName} from ${server.config.name}.`,
        inputSchema: tool.inputSchema,
      },
      metadata: {
        category: "command",
        isReadOnly: tool.readOnly,
        isDestructive: tool.readOnly ? false : true,
      },
      execute: async (input: Record<string, unknown>, context: AgentToolContext) => {
        await this.connect(server.config.id);
        const liveTool = this.registry.getTool(tool.name);
        if (!liveTool || liveTool === lazyTool || !server.client) {
          throw new Error(
            server.lastError
              ? `MCP server is not connected: ${server.config.name}. ${server.lastError}`
              : `MCP server is not connected: ${server.config.name}`,
          );
        }
        const result = await liveTool.execute(input, context);
        if (typeof result === "string") {
          return result;
        }
        return {
          ...result,
          toolCallId: "",
          name: tool.name,
        };
      },
    };
    return lazyTool;
  }

  private async markFailed(server: ManagedMcpServer, error: unknown): Promise<void> {
    if (server.client) {
      await this.closeClientAfterFailure(server.client, "failed");
      server.client = null;
    }
    server.lastError = messageOf(error);
    if (this.installCachedSurface(server)) {
      server.status = "lazy";
    } else {
      this.unregisterServerTools(server);
      server.status = "failed";
      server.tools = [];
      server.prompts = [];
      server.resources = [];
    }
    this.emitConnection(server);
  }

  private async closeClientAfterFailure(client: McpClient, reason: string): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      console.warn(`[mcp-host] failed to close ${reason} MCP client:`, error);
    }
  }

  private installCachedSurface(server: ManagedMcpServer): boolean {
    if (!server.config.enabled || server.client) {
      return false;
    }
    const cached = this.cacheStore?.getSurface(server.config);
    if (!cached || (
      cached.tools.length === 0 &&
      cached.prompts.length === 0 &&
      cached.resources.length === 0
    )) {
      return false;
    }
    server.tools = cached.tools;
    server.prompts = cached.prompts;
    server.resources = cached.resources;
    server.status = server.lastError ? "lazy" : "cached";
    this.replaceServerTools(server, cached.tools, { lazy: true });
    this.emitToolListChanged(server);
    this.emitSurfaceChanged(server);
    return true;
  }

  private async recordStartup(
    server: ManagedMcpServer,
    outcome: { durationMs: number; ok: true } | { durationMs: number; ok: false; error: string },
  ): Promise<void> {
    const stats = await this.cacheStore?.recordStartup(server.config, outcome);
    if (stats) {
      server.startupStats = stats;
    }
  }

  private emitConnection(server: ManagedMcpServer): void {
    this.bus.emit("mcp_server_connection", {
      kind: "mcp_server_connection",
      serverId: server.config.id,
      serverName: server.config.name,
      status: server.status,
      toolCount: server.tools.length,
      occurredAt: new Date().toISOString(),
      ...(server.lastError ? { message: server.lastError } : {}),
    });
  }

  private emitToolListChanged(server: ManagedMcpServer): void {
    this.bus.emit("mcp_tool_list_changed", {
      kind: "mcp_tool_list_changed",
      serverId: server.config.id,
      serverName: server.config.name,
      toolCount: server.tools.length,
      tools: server.tools.map(toToolInfo),
      occurredAt: new Date().toISOString(),
    });
  }

  private emitSurfaceChanged(server: ManagedMcpServer): void {
    this.bus.emit("mcp_surface_changed", {
      kind: "mcp_surface_changed",
      serverId: server.config.id,
      serverName: server.config.name,
      promptCount: server.prompts.length,
      resourceCount: server.resources.length,
      occurredAt: new Date().toISOString(),
    });
  }

  private toStatus(server: ManagedMcpServer): McpServerStatusRecord {
    return {
      id: server.config.id,
      name: server.config.name,
      transport: server.config.transport,
      enabled: server.config.enabled,
      status: server.status,
      toolCount: server.tools.length,
      tools: server.tools.map(toToolInfo),
      promptCount: server.prompts.length,
      prompts: server.prompts.map(toPromptInfo),
      resourceCount: server.resources.length,
      resources: server.resources.map((resource) => ({ ...resource })),
      ...(server.startupStats
        ? {
            lastStartupDurationMs: server.startupStats.lastDurationMs,
            startupSuccessCount: server.startupStats.successCount,
            startupFailureCount: server.startupStats.failureCount,
          }
        : {}),
      ...(server.lastConnectedAt ? { lastConnectedAt: server.lastConnectedAt } : {}),
      ...(server.lastError ? { lastError: server.lastError } : {}),
    };
  }

  private requireServer(serverId: string): ManagedMcpServer {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`MCP server was not found: ${serverId}`);
    }
    return server;
  }

  private async ensureConnectedServer(
    serverId: string,
  ): Promise<ManagedMcpServer & { client: McpClient }> {
    const server = this.requireServer(serverId);
    if (!isServerConnected(server)) {
      await this.connect(serverId);
    }
    return this.requireConnectedServer(serverId);
  }

  private requireConnectedServer(serverId: string): ManagedMcpServer & { client: McpClient } {
    const server = this.requireServer(serverId);
    if (!isServerConnected(server)) {
      throw new Error(
        server.lastError
          ? `MCP server is not connected: ${server.config.name}. ${server.lastError}`
          : `MCP server is not connected: ${server.config.name}`,
      );
    }
    return server as ManagedMcpServer & { client: McpClient };
  }
}

function toToolInfo(tool: McpToolDescriptor): McpToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly,
  };
}

function toPromptInfo(prompt: McpPromptInfo): McpPromptInfo {
  return {
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments.map((argument) => ({ ...argument })),
  };
}

function isServerConnected(
  server: ManagedMcpServer,
): server is ManagedMcpServer & { client: McpClient } {
  return server.status === "connected" && server.client !== null;
}

function isSameServerRuntimeConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return a.name === b.name &&
    a.transport === b.transport &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.url === b.url &&
    a.enabled === b.enabled &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    isSameStringRecord(a.env, b.env) &&
    isSameStringRecord(a.headers, b.headers) &&
    isSameStringSet(a.readOnlyTools, b.readOnlyTools);
}

function isSameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

function isSameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size !== bSet.size) return false;
  for (const entry of aSet) {
    if (!bSet.has(entry)) return false;
  }
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
