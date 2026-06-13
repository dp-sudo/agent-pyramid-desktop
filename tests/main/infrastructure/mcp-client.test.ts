import { describe, expect, it, vi } from "vitest";
import { McpClient } from "../../../src/main/infrastructure/mcp/client";
import type { McpTransport } from "../../../src/main/infrastructure/mcp/transport";
import type { JsonRpcNotification } from "../../../src/main/infrastructure/mcp/protocol";
import type { McpServerConfig } from "../../../src/shared/agent-contracts";

class FakeTransport implements McpTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(notification: JsonRpcNotification) => void>();
  closed = false;

  constructor(private readonly replies: Record<string, unknown>) {}

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (!(method in this.replies)) {
      throw new Error(`Missing fake MCP reply for ${method}.`);
    }
    return this.replies[method];
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.calls.push({ method, params });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stderrTail(): string {
    return "";
  }

  emit(notification: JsonRpcNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }
}

describe("McpClient", () => {
  it("connects tools, prompts, and resources through one MCP lifecycle", async () => {
    const transport = new FakeTransport({
      initialize: {
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
      },
      "tools/list": {
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      },
      "prompts/list": {
        prompts: [
          {
            name: "review",
            description: "Review code",
            arguments: [{ name: "path", required: true }],
          },
        ],
      },
      "resources/list": {
        resources: [
          {
            uri: "file:///README.md",
            name: "README",
            mimeType: "text/markdown",
          },
        ],
      },
      "prompts/get": {
        messages: [
          { role: "user", content: { type: "text", text: "Review README" } },
        ],
      },
      "resources/read": {
        contents: [
          { uri: "file:///README.md", mimeType: "text/markdown", text: "# Readme" },
        ],
      },
      "tools/call": {
        content: [{ type: "text", text: "ok" }],
      },
    });
    const client = new McpClient(config(), { transport });

    const tools = await client.connect();

    expect(transport.calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "prompts/list",
      "resources/list",
    ]);
    expect(tools).toEqual([
      {
        rawName: "echo",
        name: "mcp__local-mcp__echo",
        description: "Echo",
        inputSchema: { type: "object" },
        readOnly: true,
      },
    ]);
    expect(client.listPrompts()).toEqual([
      {
        name: "review",
        description: "Review code",
        arguments: [{ name: "path", required: true }],
      },
    ]);
    expect(client.listResources()).toEqual([
      {
        uri: "file:///README.md",
        name: "README",
        description: "",
        mimeType: "text/markdown",
      },
    ]);
    await expect(client.getPrompt("review", { path: "README.md" })).resolves.toEqual({
      messages: [
        { role: "user", content: { type: "text", text: "Review README" } },
      ],
    });
    await expect(client.readResource("file:///README.md")).resolves.toEqual({
      contents: [
        { uri: "file:///README.md", mimeType: "text/markdown", text: "# Readme" },
      ],
    });
    await expect(client.callTool("mcp__local-mcp__echo", {})).resolves.toMatchObject({
      content: "ok",
      isError: false,
    });
  });

  it("fires the tools changed listener on MCP notifications", async () => {
    const transport = new FakeTransport({
      initialize: { capabilities: { tools: {} } },
      "tools/list": { tools: [] },
    });
    const listener = vi.fn();
    const client = new McpClient(config(), { transport });
    await client.connect();

    client.onToolsChanged(listener);
    transport.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps tool connection usable when auxiliary surfaces fail during connect", async () => {
    const transport = new FakeTransport({
      initialize: {
        capabilities: {
          tools: {},
          prompts: {},
        },
      },
      "tools/list": {
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new McpClient(config(), { transport });

    await expect(client.connect()).resolves.toEqual([
      {
        rawName: "echo",
        name: "mcp__local-mcp__echo",
        description: "",
        inputSchema: { type: "object" },
        readOnly: false,
      },
    ]);
    expect(client.listPrompts()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mcp-client] failed to refresh auxiliary MCP surface:",
      "Missing fake MCP reply for prompts/list.",
    );
    warn.mockRestore();
  });
});

function config(): McpServerConfig {
  return {
    id: "server-1",
    name: "local-mcp",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    headers: {},
    enabled: true,
    readOnlyTools: [],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };
}
