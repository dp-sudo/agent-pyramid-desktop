import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
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
    await host.configure([
      config({ id: "bad", name: "bad-server", command: "definitely-missing-mcp-command" }),
    ]);

    const status = await host.connect("bad");

    expect(status.status).toBe("failed");
    expect(status.tools).toEqual([]);
    expect(registry.getTool("read_file")).toBe(builtInTool);
  });

  it("keeps status records shaped with tools, prompts, and resources", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    await host.configure([config({ id: "server-1", name: "local-mcp" })]);

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
    await host.configure([
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

  it("emits tool-list changes when refresh failure clears live MCP tools", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const bus = new RuntimeEventBus();
    const host = new McpHost(registry, bus);
    const toolCounts: number[] = [];
    const unsubscribe = bus.onKind("mcp_tool_list_changed", (event) => {
      if (event.kind !== "mcp_tool_list_changed") return;
      toolCounts.push(event.toolCount);
    });
    await host.configure([
      config({
        id: "server-1",
        name: "local-mcp",
        args: ["-e", mcpServerScriptWithToolListFailingAfterFirstSuccess()],
      }),
    ]);

    await expect(host.connect("server-1")).resolves.toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();

    const refreshed = await host.refreshTools("server-1");

    expect(refreshed).toMatchObject({
      status: "failed",
      toolCount: 0,
      tools: [],
    });
    expect(registry.getTool("mcp__local-mcp__echo")).toBeUndefined();
    expect(toolCounts).toEqual([1, 0]);
    unsubscribe();
    await host.close();
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

    await host.configure([serverConfig]);
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

  it("waits for reconnect disconnects before connecting the updated server config", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const oldConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithSlowShutdown(200)],
    });
    const newConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithEchoTool()],
    });

    await host.configure([oldConfig]);
    await expect(host.connect("server-1")).resolves.toMatchObject({
      status: "connected",
      toolCount: 1,
    });

    await host.configure([newConfig]);
    await expect(host.connect("server-1")).resolves.toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    await delay(250);

    expect(host.listServers()[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();
    await host.close();
  });

  it("clears local server state before surfacing streamable HTTP close failures", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const server = await listenStreamableMcpServerWithFailingClose();
    try {
      await host.configure([
        config({
          id: "server-1",
          name: "remote-mcp",
          transport: "streamable-http",
          url: server.url,
        }),
      ]);
      await expect(host.connect("server-1")).resolves.toMatchObject({
        status: "connected",
        toolCount: 1,
      });
      expect(registry.getTool("mcp__remote-mcp__echo")).toBeDefined();

      await expect(host.disconnect("server-1")).rejects.toThrow(
        "MCP server disconnected locally but close failed: MCP HTTP session close failed with status 500.",
      );

      expect(host.listServers()[0]).toMatchObject({
        status: "disconnected",
        toolCount: 0,
        promptCount: 0,
        resourceCount: 0,
        lastError: "MCP disconnect close failed: MCP HTTP session close failed with status 500.",
      });
      expect(registry.getTool("mcp__remote-mcp__echo")).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("keeps reconfigure authoritative when the old streamable HTTP close fails", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const oldServer = await listenStreamableMcpServerWithFailingClose("old");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await host.configure([
        config({
          id: "server-1",
          name: "remote-mcp",
          transport: "streamable-http",
          url: oldServer.url,
        }),
      ]);
      await expect(host.connect("server-1")).resolves.toMatchObject({
        status: "connected",
        toolCount: 1,
      });
      expect(registry.getTool("mcp__remote-mcp__old")).toBeDefined();

      await expect(host.configure([
        config({
          id: "server-1",
          name: "remote-mcp",
          args: ["-e", mcpServerScriptWithEchoTool()],
        }),
      ])).resolves.toBeUndefined();
      await expect(host.connect("server-1")).resolves.toMatchObject({
        status: "connected",
        toolCount: 1,
      });

      expect(host.listServers()[0]).toMatchObject({
        status: "connected",
        toolCount: 1,
      });
      expect(registry.getTool("mcp__remote-mcp__old")).toBeUndefined();
      expect(registry.getTool("mcp__remote-mcp__echo")).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(
        "[mcp-host] MCP server disconnected locally during reconfigure but close failed:",
        expect.any(Error),
      );
    } finally {
      await host.close();
      await oldServer.close();
      warnSpy.mockRestore();
    }
  });

  it("keeps connected servers when record key order changes without runtime changes", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const baseConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithEchoTool()],
      env: { BETA: "2", ALPHA: "1" },
      headers: { "X-Beta": "2", "X-Alpha": "1" },
      readOnlyTools: ["echo", "list"],
    });
    const reorderedConfig = config({
      ...baseConfig,
      env: { ALPHA: "1", BETA: "2" },
      headers: { "X-Alpha": "1", "X-Beta": "2" },
      readOnlyTools: ["list", "echo"],
    });

    await host.configure([baseConfig]);
    await expect(host.connect("server-1")).resolves.toMatchObject({
      status: "connected",
      toolCount: 1,
    });

    await host.configure([reorderedConfig]);

    expect(host.listServers()[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();
    await host.close();
  });

  it("ignores stale in-flight connects after server config changes", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const oldConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithDelayedTool("old", 200)],
    });
    const newConfig = config({
      id: "server-1",
      name: "local-mcp",
      args: ["-e", mcpServerScriptWithEchoTool()],
    });

    await host.configure([oldConfig]);
    const staleConnect = host.connect("server-1");
    await delay(30);
    await host.configure([newConfig]);
    const connected = await host.connect("server-1");
    await staleConnect.catch(() => undefined);
    await delay(250);

    expect(connected.status).toBe("connected");
    expect(connected.tools.map((tool) => tool.name)).toEqual(["mcp__local-mcp__echo"]);
    expect(host.listServers()[0]?.tools.map((tool) => tool.name)).toEqual([
      "mcp__local-mcp__echo",
    ]);
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();
    expect(registry.getTool("mcp__local-mcp__old")).toBeUndefined();
    await host.close();
  });

  it("closes partially connected clients when tools/list fails", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    const pidFile = path.join(userDataDir, "failing-mcp.pid");
    await host.configure([
      config({
        id: "server-1",
        name: "local-mcp",
        args: ["-e", mcpServerScriptWithFailingToolsList()],
        env: { MCP_TEST_PID_FILE: pidFile },
      }),
    ]);

    const status = await host.connect("server-1");
    const pid = Number(await fs.readFile(pidFile, "utf8"));

    expect(status.status).toBe("failed");
    expect(Number.isInteger(pid)).toBe(true);
    await expectProcessExit(pid);
    await host.close();
  });

  it("waits for in-flight initialization before refreshing tools", async () => {
    const registry = new InMemoryToolRegistry([builtInTool]);
    const host = new McpHost(registry, new RuntimeEventBus());
    await host.configure([
      config({
        id: "server-1",
        name: "local-mcp",
        args: ["-e", mcpServerScriptWithDelayedInitialize(100)],
      }),
    ]);

    const connecting = host.connect("server-1");
    await delay(20);
    const refreshed = await host.refreshTools("server-1");
    await expect(connecting).resolves.toMatchObject({ status: "connected" });

    expect(refreshed.status).toBe("connected");
    expect(refreshed.tools.map((tool) => tool.name)).toEqual(["mcp__local-mcp__echo"]);
    expect(registry.getTool("mcp__local-mcp__echo")).toBeDefined();
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
    await host.configure([serverConfig]);

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

    await host.configure([serverConfig]);

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
    await host.configure([serverConfig]);

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

function mcpServerScriptWithToolListFailingAfterFirstSuccess(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let toolsListed = false;
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
    if (!toolsListed) {
      toolsListed = true;
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
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "tools unavailable" },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function mcpServerScriptWithDelayedTool(toolName: string, delayMs: number): string {
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
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            {
              name: ${JSON.stringify(toolName)},
              description: "Delayed",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    }, ${delayMs});
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function mcpServerScriptWithFailingToolsList(): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
if (process.env.MCP_TEST_PID_FILE) {
  fs.writeFileSync(process.env.MCP_TEST_PID_FILE, String(process.pid));
}
setInterval(() => {}, 1000);
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
      error: { code: -32000, message: "tools unavailable" },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function mcpServerScriptWithDelayedInitialize(delayMs: number): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    setTimeout(() => {
      initialized = true;
      send({ jsonrpc: "2.0", id: request.id, result: { capabilities: { tools: {} } } });
    }, ${delayMs});
    return;
  }
  if (request.method === "tools/list") {
    if (!initialized) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "tools/list before initialize" },
      });
      return;
    }
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
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

function mcpServerScriptWithSlowShutdown(delayMs: number): string {
  return `
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(0), ${delayMs});
});
${mcpServerScriptWithEchoTool()}
`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Expected process ${pid} to exit.`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function listenStreamableMcpServerWithFailingClose(toolName = "echo"): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleStreamableMcpRequestWithFailingClose(request, response, toolName)
      .catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected MCP HTTP test server address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

async function handleStreamableMcpRequestWithFailingClose(
  request: IncomingMessage,
  response: ServerResponse,
  toolName: string,
): Promise<void> {
  if (request.method === "DELETE") {
    response.statusCode = 500;
    response.end("close failed");
    return;
  }
  const body = await readHttpBody(request);
  const payload = JSON.parse(body) as { id?: number; method: string };
  response.setHeader("Content-Type", "application/json");
  if (payload.method === "initialize") {
    response.setHeader("Mcp-Session-Id", "session-1");
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: { capabilities: { tools: {} } },
    }));
    return;
  }
  if (payload.method === "tools/list") {
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        tools: [
          {
            name: toolName,
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    }));
    return;
  }
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    id: payload.id,
    result: {},
  }));
}

async function readHttpBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
