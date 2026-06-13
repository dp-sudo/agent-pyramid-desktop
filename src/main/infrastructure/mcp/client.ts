import type {
  McpServerConfig,
  McpToolInfo,
} from "../../../shared/agent-contracts.js";
import {
  MCP_HANDSHAKE_TIMEOUT_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
} from "../../application/constants.js";
import {
  MCP_PROTOCOL_VERSION,
  normalizeMcpCallToolResult,
  normalizeMcpToolsListResult,
  serializeMcpCallToolResult,
  type McpToolDescriptor,
} from "./protocol.js";
import { StdioMcpTransport, type McpTransport } from "./stdio-transport.js";

export interface McpClientOptions {
  transport?: McpTransport;
  handshakeTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export interface McpToolCallOutput {
  content: string;
  displayResult: unknown;
  isError: boolean;
}

/**
 * Tools-only MCP client. It owns the MCP lifecycle over an injected transport:
 * initialize, initialized notification, tools/list, and tools/call. Prompts,
 * resources, roots, and sampling are intentionally outside this first host.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly handshakeTimeoutMs: number;
  private readonly toolCallTimeoutMs: number;
  private readonly readOnlyTools: ReadonlySet<string>;
  private tools: McpToolDescriptor[] = [];
  private removeToolsChangedListener: (() => void) | null = null;
  private toolsChangedListener: (() => void) | null = null;

  constructor(
    private readonly config: McpServerConfig,
    options: McpClientOptions = {},
  ) {
    this.transport = options.transport ?? StdioMcpTransport.start(config);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? MCP_TOOL_CALL_TIMEOUT_MS;
    this.readOnlyTools = new Set(config.readOnlyTools);
  }

  async connect(): Promise<McpToolDescriptor[]> {
    await withTimeout(
      (signal) => this.transport.call("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "agent-pyramid-desktop",
          version: "0.1.0",
        },
      }, { signal }),
      this.handshakeTimeoutMs,
      `MCP server ${this.config.name} initialize timed out.`,
    );
    await this.transport.notify("notifications/initialized");
    this.removeToolsChangedListener = this.transport.onNotification((notification) => {
      if (notification.method === "notifications/tools/list_changed") {
        this.toolsChangedListener?.();
      }
    });
    return this.refreshTools();
  }

  async refreshTools(): Promise<McpToolDescriptor[]> {
    const result = await withTimeout(
      (signal) => this.transport.call("tools/list", {}, { signal }),
      this.handshakeTimeoutMs,
      `MCP server ${this.config.name} tools/list timed out.`,
    );
    this.tools = normalizeMcpToolsListResult(result).map((tool) => ({
      ...tool,
      name: namespaceMcpToolName(this.config.name, tool.rawName),
      readOnly: tool.readOnly || this.readOnlyTools.has(tool.rawName),
    }));
    return this.listTools();
  }

  listTools(): McpToolDescriptor[] {
    return this.tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
  }

  listToolInfo(): McpToolInfo[] {
    return this.tools.map(({ rawName: _rawName, ...tool }) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
    }));
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpToolCallOutput> {
    const tool = this.tools.find((candidate) => candidate.name === namespacedName);
    if (!tool) {
      throw new Error(`MCP tool is not registered on ${this.config.name}: ${namespacedName}`);
    }
    const result = normalizeMcpCallToolResult(await withTimeout(
      (signal) =>
        this.transport.call("tools/call", {
          name: tool.rawName,
          arguments: args,
        }, { signal: combineAbortSignals(options.signal, signal) }),
      this.toolCallTimeoutMs,
      `MCP tool ${namespacedName} timed out.`,
    ));
    return {
      content: serializeMcpCallToolResult(result),
      displayResult: result,
      isError: result.isError === true,
    };
  }

  onToolsChanged(listener: () => void): void {
    this.toolsChangedListener = listener;
  }

  stderrTail(): string {
    return this.transport.stderrTail();
  }

  async close(): Promise<void> {
    this.removeToolsChangedListener?.();
    this.removeToolsChangedListener = null;
    this.toolsChangedListener = null;
    await this.transport.close();
  }
}

export function namespaceMcpToolName(serverName: string, rawToolName: string): string {
  return `mcp__${toToolNameSegment(serverName)}__${toToolNameSegment(rawToolName)}`;
}

export function mcpPermissionValueFromToolName(toolName: string): string | null {
  const match = /^mcp__([^_][A-Za-z0-9_-]*)__([^_][A-Za-z0-9_-]*)$/.exec(toolName);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function toToolNameSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function combineAbortSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): AbortSignal {
  if (!outer) return inner;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (outer.aborted || inner.aborted) {
    controller.abort();
    return controller.signal;
  }
  outer.addEventListener("abort", abort, { once: true });
  inner.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
