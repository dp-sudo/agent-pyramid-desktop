import type {
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
import type { McpToolDescriptor } from "./protocol.js";

interface ManagedMcpServer {
  config: McpServerConfig;
  client: McpClient | null;
  status: McpServerStatusRecord["status"];
  tools: McpToolDescriptor[];
  registeredToolNames: string[];
  lastConnectedAt?: string;
  lastError?: string;
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
        this.servers.set(config.id, {
          config,
          client: null,
          status: "disconnected",
          tools: [],
          registeredToolNames: [],
        });
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
      server.status = "connected";
      server.lastError = undefined;
      this.emitToolListChanged(server);
    } catch (error) {
      this.markFailed(server, error);
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
      this.replaceServerTools(server, tools);
      this.emitConnection(server);
      this.emitToolListChanged(server);
    } catch (error) {
      this.markFailed(server, error);
    }
    return this.toStatus(server);
  }

  private async disconnectIfConnected(server: ManagedMcpServer): Promise<void> {
    this.unregisterServerTools(server);
    if (server.client) {
      await server.client.close();
      server.client = null;
    }
    server.tools = [];
  }

  private replaceServerTools(server: ManagedMcpServer, tools: McpToolDescriptor[]): void {
    this.unregisterServerTools(server);
    server.tools = tools;
    for (const tool of tools) {
      const agentTool = this.toAgentTool(server, tool);
      this.registry.register(agentTool);
      server.registeredToolNames.push(agentTool.definition.name);
    }
  }

  private unregisterServerTools(server: ManagedMcpServer): void {
    for (const name of server.registeredToolNames) {
      this.registry.unregister(name);
    }
    server.registeredToolNames = [];
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

  private markFailed(server: ManagedMcpServer, error: unknown): void {
    this.unregisterServerTools(server);
    if (server.client) {
      void server.client.close().catch((closeError) => {
        console.warn("[mcp-host] failed to close failed MCP client:", closeError);
      });
      server.client = null;
    }
    server.status = "failed";
    server.tools = [];
    server.lastError = messageOf(error);
    this.emitConnection(server);
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

  private toStatus(server: ManagedMcpServer): McpServerStatusRecord {
    return {
      id: server.config.id,
      name: server.config.name,
      transport: server.config.transport,
      enabled: server.config.enabled,
      status: server.status,
      toolCount: server.tools.length,
      tools: server.tools.map(toToolInfo),
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
}

function toToolInfo(tool: McpToolDescriptor): McpToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly,
  };
}

function isSameServerRuntimeConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return a.name === b.name &&
    a.transport === b.transport &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.enabled === b.enabled &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env) === JSON.stringify(b.env) &&
    JSON.stringify(a.readOnlyTools) === JSON.stringify(b.readOnlyTools);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
