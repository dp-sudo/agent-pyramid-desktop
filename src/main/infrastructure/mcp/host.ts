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

  configure(configs: readonly McpServerConfig[]): void {
    const nextIds = new Set(configs.map((config) => config.id));
    for (const id of this.servers.keys()) {
      if (!nextIds.has(id)) {
        void this.disconnect(id);
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
          ...(startupStats ? { startupStats } : {}),
        });
        const created = this.servers.get(config.id);
        if (created && cached && config.enabled) {
          this.installCachedSurface(created);
        }
        continue;
      }
      const requiresReconnect = !isSameServerRuntimeConfig(existing.config, config);
      existing.config = config;
      if (!config.enabled || requiresReconnect) {
        void this.disconnect(config.id);
      }
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
    server.inFlight = this.connectServer(server).finally(() => {
      server.inFlight = undefined;
    });
    return server.inFlight;
  }

  async disconnect(serverId: string): Promise<McpServerStatusRecord> {
    const server = this.requireServer(serverId);
    this.unregisterServerTools(server);
    if (server.client) {
      await server.client.close();
      server.client = null;
    }
    server.status = "disconnected";
    server.tools = [];
    server.prompts = [];
    server.resources = [];
    server.lastError = undefined;
    this.emitConnection(server);
    return this.toStatus(server);
  }

  async refreshTools(serverId: string): Promise<McpServerStatusRecord> {
    const server = this.requireServer(serverId);
    if (!server.client) {
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
    if (!server.client) {
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

  private async connectServer(server: ManagedMcpServer): Promise<McpServerStatusRecord> {
    if (!server.config.enabled) {
      server.status = "disconnected";
      return this.toStatus(server);
    }
    await this.disconnectIfConnected(server);
    server.status = "connecting";
    server.lastError = undefined;
    this.emitConnection(server);
    const startedAt = Date.now();
    try {
      const client = new McpClient(server.config);
      const tools = await client.connect();
      client.onToolsChanged(() => {
        void this.refreshTools(server.config.id);
      });
      server.client = client;
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
    if (server.client || server.registeredToolMode === "live") {
      this.unregisterServerTools(server);
    }
    if (server.client) {
      await server.client.close();
      server.client = null;
    }
    if (server.registeredToolMode !== "lazy") {
      server.tools = [];
      server.prompts = [];
      server.resources = [];
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
      void server.client.close().catch((closeError) => {
        console.warn("[mcp-host] failed to close failed MCP client:", closeError);
      });
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
    if (!server.client) {
      await this.connect(serverId);
    }
    return this.requireConnectedServer(serverId);
  }

  private requireConnectedServer(serverId: string): ManagedMcpServer & { client: McpClient } {
    const server = this.requireServer(serverId);
    if (!server.client) {
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

function isSameServerRuntimeConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return a.name === b.name &&
    a.transport === b.transport &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.url === b.url &&
    a.enabled === b.enabled &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env) === JSON.stringify(b.env) &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers) &&
    JSON.stringify(a.readOnlyTools) === JSON.stringify(b.readOnlyTools);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
