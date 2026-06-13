import type {
  McpPromptInfo,
  McpPromptResult,
  McpResourceInfo,
  McpResourceReadResult,
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
  normalizeMcpPromptGetResult,
  normalizeMcpPromptsListResult,
  normalizeMcpResourceReadResult,
  normalizeMcpResourcesListResult,
  normalizeMcpToolsListResult,
  serializeMcpCallToolResult,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpToolDescriptor,
} from "./protocol.js";
import { HttpMcpTransport } from "./http-transport.js";
import { StdioMcpTransport } from "./stdio-transport.js";
import type { McpTransport } from "./transport.js";

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

export interface McpSurfaceRefreshResult {
  prompts: McpPromptInfo[];
  resources: McpResourceInfo[];
  errors: string[];
}

/**
 * MCP client owns the protocol lifecycle over an injected transport. Tools are
 * adapted into AgentTool by McpHost; prompts and resources stay as queryable
 * surfaces because the renderer/runtime consume them through dedicated IPC.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly handshakeTimeoutMs: number;
  private readonly toolCallTimeoutMs: number;
  private readonly readOnlyTools: ReadonlySet<string>;
  private tools: McpToolDescriptor[] = [];
  private prompts: McpPromptDescriptor[] = [];
  private resources: McpResourceDescriptor[] = [];
  private capabilities: Record<string, unknown> = {};
  private removeToolsChangedListener: (() => void) | null = null;
  private toolsChangedListener: (() => void) | null = null;

  constructor(
    private readonly config: McpServerConfig,
    options: McpClientOptions = {},
  ) {
    this.transport = options.transport ?? createTransport(config);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? MCP_TOOL_CALL_TIMEOUT_MS;
    this.readOnlyTools = new Set(config.readOnlyTools);
  }

  async connect(): Promise<McpToolDescriptor[]> {
    const initializeResult = await withTimeout(
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
    this.capabilities = normalizeCapabilities(initializeResult);
    await this.transport.notify("notifications/initialized");
    this.removeToolsChangedListener = this.transport.onNotification((notification) => {
      if (notification.method === "notifications/tools/list_changed") {
        this.toolsChangedListener?.();
      }
    });
    const tools = await this.refreshTools();
    const surface = await this.refreshSurfaceBestEffort();
    if (surface.errors.length > 0) {
      console.warn("[mcp-client] failed to refresh auxiliary MCP surface:", surface.errors.join("; "));
    }
    return tools;
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

  capabilitiesSnapshot(): Record<string, unknown> {
    return { ...this.capabilities };
  }

  async refreshSurface(): Promise<{
    prompts: McpPromptInfo[];
    resources: McpResourceInfo[];
  }> {
    const [prompts, resources] = await Promise.all([
      this.refreshPrompts(),
      this.refreshResources(),
    ]);
    return { prompts, resources };
  }

  async refreshSurfaceBestEffort(): Promise<McpSurfaceRefreshResult> {
    const [prompts, resources] = await Promise.all([
      this.refreshPrompts().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      this.refreshResources().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    const errors: string[] = [];
    if (!prompts.ok) {
      this.prompts = [];
      errors.push(messageOf(prompts.error));
    }
    if (!resources.ok) {
      this.resources = [];
      errors.push(messageOf(resources.error));
    }
    return {
      prompts: prompts.ok ? prompts.value : [],
      resources: resources.ok ? resources.value : [],
      errors,
    };
  }

  async refreshPrompts(): Promise<McpPromptInfo[]> {
    if (!hasCapability(this.capabilities, "prompts")) {
      this.prompts = [];
      return [];
    }
    const result = await withTimeout(
      (signal) => this.transport.call("prompts/list", {}, { signal }),
      this.handshakeTimeoutMs,
      `MCP server ${this.config.name} prompts/list timed out.`,
    );
    this.prompts = normalizeMcpPromptsListResult(result);
    return this.listPrompts();
  }

  listPrompts(): McpPromptInfo[] {
    return this.prompts.map(toPromptInfo);
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult> {
    const prompt = this.prompts.find((candidate) => candidate.name === name);
    if (!prompt) {
      throw new Error(`MCP prompt is not registered on ${this.config.name}: ${name}`);
    }
    return normalizeMcpPromptGetResult(await withTimeout(
      (signal) =>
        this.transport.call("prompts/get", {
          name: prompt.rawName,
          arguments: args,
        }, { signal }),
      this.toolCallTimeoutMs,
      `MCP prompt ${name} timed out.`,
    ));
  }

  async refreshResources(): Promise<McpResourceInfo[]> {
    if (!hasCapability(this.capabilities, "resources")) {
      this.resources = [];
      return [];
    }
    const result = await withTimeout(
      (signal) => this.transport.call("resources/list", {}, { signal }),
      this.handshakeTimeoutMs,
      `MCP server ${this.config.name} resources/list timed out.`,
    );
    this.resources = normalizeMcpResourcesListResult(result);
    return this.listResources();
  }

  listResources(): McpResourceInfo[] {
    return this.resources.map((resource) => ({ ...resource }));
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.resources.some((resource) => resource.uri === uri)) {
      throw new Error(`MCP resource is not registered on ${this.config.name}: ${uri}`);
    }
    return normalizeMcpResourceReadResult(await withTimeout(
      (signal) =>
        this.transport.call("resources/read", {
          uri,
        }, { signal }),
      this.toolCallTimeoutMs,
      `MCP resource ${uri} timed out.`,
    ));
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

function createTransport(config: McpServerConfig): McpTransport {
  if (config.transport === "streamable-http") {
    return HttpMcpTransport.start(config);
  }
  return StdioMcpTransport.start(config);
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

function normalizeCapabilities(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const capabilities = (value as Record<string, unknown>).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return {};
  }
  return capabilities as Record<string, unknown>;
}

function hasCapability(capabilities: Record<string, unknown>, name: string): boolean {
  return capabilities[name] !== undefined;
}

function toPromptInfo(prompt: McpPromptDescriptor): McpPromptInfo {
  return {
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments.map((arg) => ({ ...arg })),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
