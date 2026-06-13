import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import { McpCacheStore } from "../../../src/main/infrastructure/mcp/cache-store";
import { McpHost } from "../../../src/main/infrastructure/mcp/host";
import type { AgentTool } from "../../../src/main/domain/agent/types";
import type { McpServerConfig } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const builtInTool: AgentTool = {
  definition: {
    name: "read_file",
    description: "Read file",
    inputSchema: { type: "object" },
  },
  metadata: { isReadOnly: true },
  async execute() {
    return "built-in";
  },
};

describe("McpHost", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-mcp-host-");
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("keeps failed servers isolated from built-in registry entries", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const bus = new RuntimeEventBus();
    const host = new McpHost(registry, bus);
    host.configure([
      config({ id: "bad", name: "bad-server", command: "definitely-missing-mcp-command" }),
    ]);

    const status = await host.connect("bad");

    expect(status.status).toBe("failed");
    expect(status.tools).toEqual([]);
    expect(registry.getTool("read_file")).toBe(builtInTool);
  });

  it("keeps status records shaped with tools, prompts, and resources", () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    host.configure([config({ id: "server-1", name: "local-mcp" })]);

    expect(host.listServers()).toEqual([
      {
        id: "server-1",
        name: "local-mcp",
        transport: "stdio",
        enabled: true,
        status: "disconnected",
        toolCount: 0,
        tools: [],
        promptCount: 0,
        prompts: [],
        resourceCount: 0,
        resources: [],
      },
    ]);
  });

  it("does not unregister connected MCP tools when prompt/resource surface refresh fails", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    host.configure([
      config({
        id: "server-1",
        name: "local-mcp",
        args: ["-e", mcpServerScriptWithFailingSurface()],
      }),
    ]);

    const connected = await host.connect("server-1");
    expect(connected.status).toBe("connected");
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();

    const refreshed = await host.refreshSurface("server-1");

    expect(refreshed.status).toBe("connected");
    expect(refreshed.lastError).toBe("MCP JSON-RPC error -32000: prompts unavailable");
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();
    await host.close();
    warn.mockRestore();
  });

  it("registers cached MCP tools as lazy placeholders and replaces them on first call", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const cacheStore = new McpCacheStore(userDataDir);
    await cacheStore.init();
    const serverConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithEchoTool()],
    });
    await cacheStore.saveSurface(serverConfig, {
      capabilities: { tools: {} },
      tools: [
        {
          rawName: "echo",
          name: "mcp__local-mcp__echo",
          description: "Echo",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      prompts: [],
      resources: [],
    });
    const host = new McpHost(registry, new RuntimeEventBus(), cacheStore);

    host.configure([serverConfig]);
    expect(host.listServers()[0]).toMatchObject({
      status: "cached",
      toolCount: 1,
    });
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();

    const result = await registry.execute({
      id: "call-1",
      name: "mcp__local-mcp__echo",
      arguments: { text: "hello" },
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toMatchObject({
      toolCallId: "call-1",
      name: "mcp__local-mcp__echo",
      content: "echo: hello",
    });
    expect(host.listServers()[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
      startupSuccessCount: 1,
      startupFailureCount: 0,
    });
    await host.close();
  });

  it("connects lazily before reading cached prompt and resource surfaces", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const cacheStore = new McpCacheStore(userDataDir);
    await cacheStore.init();
    const serverConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithPromptAndResource()],
    });
    await cacheStore.saveSurface(serverConfig, {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      tools: [
        {
          rawName: "echo",
          name: "mcp__local-mcp__echo",
          description: "Echo",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      prompts: [
        {
          name: "review",
          description: "Review",
          arguments: [{ name: "path", required: true }],
        },
      ],
      resources: [
        {
          uri: "file:///README.md",
          name: "README",
          description: "",
          mimeType: "text/markdown",
        },
      ],
    });
    const host = new McpHost(registry, new RuntimeEventBus(), cacheStore);
    host.configure([serverConfig]);

    await expect(host.getPrompt("server-1", "review", { path: "README.md" }))
      .resolves.toEqual({
        messages: [
          { role: "user", content: { type: "text", text: "Review README.md" } },
        ],
      });
    await expect(host.readResource("server-1", "file:///README.md"))
      .resolves.toEqual({
        contents: [
          { uri: "file:///README.md", mimeType: "text/markdown", text: "# README" },
        ],
      });
    expect(host.listServers()[0]).toMatchObject({ status: "connected" });
    await host.close();
  });

  it("installs cached prompt and resource surfaces even when no tools are cached", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const cacheStore = new McpCacheStore(userDataDir);
    await cacheStore.init();
    const serverConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithPromptAndResource()],
    });
    await cacheStore.saveSurface(serverConfig, {
      capabilities: { prompts: {}, resources: {} },
      tools: [],
      prompts: [
        {
          name: "review",
          description: "Review",
          arguments: [],
        },
      ],
      resources: [
        {
          uri: "file:///README.md",
          name: "README",
          description: "",
        },
      ],
    });
    const host = new McpHost(registry, new RuntimeEventBus(), cacheStore);

    host.configure([serverConfig]);

    expect(host.listServers()[0]).toMatchObject({
      status: "cached",
      toolCount: 0,
      promptCount: 1,
      resourceCount: 1,
    });
    expect(registry.getTool("mcp__local-mcp__echo")).toBeUndefined();
    await host.close();
  });

  it("keeps cached tools visible as lazy when live reconnect fails", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const cacheStore = new McpCacheStore(userDataDir);
    await cacheStore.init();
    const serverConfig = config({
      id: "server-1",
      name: "local-mcp",
      command: "definitely-missing-mcp-command",
      args: [],
    });
    await cacheStore.saveSurface(serverConfig, {
      capabilities: { tools: {} },
      tools: [
        {
          rawName: "echo",
          name: "mcp__local-mcp__echo",
          description: "Echo",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      prompts: [],
      resources: [],
    });
    const host = new McpHost(registry, new RuntimeEventBus(), cacheStore);
    host.configure([serverConfig]);

    const status = await host.connect("server-1");

    expect(status).toMatchObject({
      status: "lazy",
      toolCount: 1,
      startupSuccessCount: 0,
      startupFailureCount: 1,
    });
    expect(status.lastError).toBeTruthy();
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();
    await expect(registry.execute({
      id: "call-1",
      name: "mcp__local-mcp__echo",
      arguments: {},
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
    })).rejects.toThrow("MCP server is not connected: local-mcp.");
    await host.close();
  });
});

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "server-1",
    name: "local-mcp",
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    env: {},
    headers: {},
    enabled: true,
    readOnlyTools: [],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

function mcpServerScriptWithFailingSurface(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { capabilities: { tools: {}, prompts: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
    return;
  }
  if (request.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "prompts unavailable" },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function mcpServerScriptWithEchoTool(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: "echo: " + request.params.arguments.text }],
      },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function mcpServerScriptWithPromptAndResource(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { capabilities: { tools: {}, prompts: {}, resources: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      },
    });
    return;
  }
  if (request.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { prompts: [{ name: "review", arguments: [{ name: "path", required: true }] }] },
    });
    return;
  }
  if (request.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { resources: [{ uri: "file:///README.md", name: "README", mimeType: "text/markdown" }] },
    });
    return;
  }
  if (request.method === "prompts/get") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        messages: [{ role: "user", content: { type: "text", text: "Review " + request.params.arguments.path } }],
      },
    });
    return;
  }
  if (request.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: "# README" }] },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}
