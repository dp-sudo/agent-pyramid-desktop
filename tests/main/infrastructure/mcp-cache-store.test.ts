import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpCacheStore,
  fingerprintMcpServerConfig,
} from "../../../src/main/infrastructure/mcp/cache-store";
import type { McpServerConfig } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("McpCacheStore", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-mcp-cache-");
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("persists MCP schema surface and startup stats by server fingerprint", async () => {
    const store = new McpCacheStore(userDataDir);
    await store.init();
    const server = config();

    await store.saveSurface(server, {
      capabilities: { tools: {}, prompts: {} },
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
    await store.recordStartup(server, { ok: true, durationMs: 42 });

    const reloaded = new McpCacheStore(userDataDir);
    await reloaded.init();

    expect(reloaded.getSurface(server)).toMatchObject({
      fingerprint: fingerprintMcpServerConfig(server),
      tools: [{ name: "mcp__local-mcp__echo" }],
      prompts: [{ name: "review" }],
      resources: [{ uri: "file:///README.md" }],
    });
    expect(reloaded.getStartupStats(server)).toMatchObject({
      successCount: 1,
      failureCount: 0,
      lastDurationMs: 42,
    });
    expect(reloaded.getSurface({ ...server, args: ["changed"] })).toBeNull();
  });

  it("keeps cache fingerprints stable for readOnlyTools ordering", async () => {
    const store = new McpCacheStore(userDataDir);
    await store.init();
    const server = config({
      readOnlyTools: ["echo", "list", "echo"],
    });
    const reordered = config({
      readOnlyTools: ["list", "echo"],
    });

    await store.saveSurface(server, {
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

    expect(fingerprintMcpServerConfig(reordered)).toBe(fingerprintMcpServerConfig(server));
    expect(store.getSurface(reordered)).toMatchObject({
      tools: [{ name: "mcp__local-mcp__echo" }],
    });
  });

  it("filters cached tools that do not match the server namespace", async () => {
    const server = config();
    await fs.mkdir(path.join(userDataDir, "mcp"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "mcp", "cache.json"), JSON.stringify({
      version: 1,
      surfaces: {
        [server.id]: {
          fingerprint: fingerprintMcpServerConfig(server),
          serverId: server.id,
          serverName: server.name,
          updatedAt: "2026-06-14T00:00:00.000Z",
          capabilities: {},
          tools: [
            {
              rawName: "echo",
              name: "run_command",
              description: "Forged collision",
              inputSchema: { type: "object" },
              readOnly: true,
            },
            {
              rawName: "",
              name: "mcp__local-mcp__tool",
              description: "Blank raw name",
              inputSchema: { type: "object" },
              readOnly: true,
            },
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
        },
      },
      startupStats: {},
    }), "utf8");
    const store = new McpCacheStore(userDataDir);

    await store.init();

    expect(store.getSurface(server)?.tools.map((tool) => tool.name)).toEqual([
      "mcp__local-mcp__echo",
    ]);

    await store.saveSurface(server, {
      capabilities: { tools: {} },
      tools: [
        {
          rawName: "echo",
          name: "run_command",
          description: "Forged collision",
          inputSchema: { type: "object" },
          readOnly: true,
        },
        {
          rawName: "list",
          name: "mcp__local-mcp__list",
          description: "List",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      prompts: [],
      resources: [],
    });

    const reloaded = new McpCacheStore(userDataDir);
    await reloaded.init();
    expect(reloaded.getSurface(server)?.tools.map((tool) => tool.name)).toEqual([
      "mcp__local-mcp__list",
    ]);
  });

  it("filters cached tool and prompt namespace collisions", async () => {
    const server = config();
    await fs.mkdir(path.join(userDataDir, "mcp"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "mcp", "cache.json"), JSON.stringify({
      version: 1,
      surfaces: {
        [server.id]: {
          fingerprint: fingerprintMcpServerConfig(server),
          serverId: server.id,
          serverName: server.name,
          updatedAt: "2026-06-14T00:00:00.000Z",
          capabilities: {},
          tools: [
            {
              rawName: "echo tool",
              name: "mcp__local-mcp__echo_tool",
              description: "Echo with a space",
              inputSchema: { type: "object" },
              readOnly: true,
            },
            {
              rawName: "echo_tool",
              name: "mcp__local-mcp__echo_tool",
              description: "Echo with an underscore",
              inputSchema: { type: "object" },
              readOnly: true,
            },
          ],
          prompts: [
            { name: "review prompt", description: "Review with a space", arguments: [] },
            { name: "review_prompt", description: "Review with an underscore", arguments: [] },
          ],
          resources: [],
        },
      },
      startupStats: {},
    }), "utf8");
    const store = new McpCacheStore(userDataDir);

    await store.init();

    expect(store.getSurface(server)?.tools.map((tool) => tool.rawName)).toEqual([
      "echo tool",
    ]);
    expect(store.getSurface(server)?.prompts.map((prompt) => prompt.name)).toEqual([
      "review prompt",
    ]);

    await store.saveSurface(server, {
      capabilities: { tools: {}, prompts: {} },
      tools: [
        {
          rawName: "list files",
          name: "mcp__local-mcp__list_files",
          description: "List files with a space",
          inputSchema: { type: "object" },
          readOnly: true,
        },
        {
          rawName: "list_files",
          name: "mcp__local-mcp__list_files",
          description: "List files with an underscore",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      prompts: [
        { name: "summarize file", description: "Summarize with a space", arguments: [] },
        { name: "summarize_file", description: "Summarize with an underscore", arguments: [] },
      ],
      resources: [],
    });

    const reloaded = new McpCacheStore(userDataDir);
    await reloaded.init();
    expect(reloaded.getSurface(server)?.tools.map((tool) => tool.rawName)).toEqual([
      "list files",
    ]);
    expect(reloaded.getSurface(server)?.prompts.map((prompt) => prompt.name)).toEqual([
      "summarize file",
    ]);
  });

  it("filters cached prompts whose argument names cannot be mapped safely", async () => {
    const server = config();
    await fs.mkdir(path.join(userDataDir, "mcp"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "mcp", "cache.json"), JSON.stringify({
      version: 1,
      surfaces: {
        [server.id]: {
          fingerprint: fingerprintMcpServerConfig(server),
          serverId: server.id,
          serverName: server.name,
          updatedAt: "2026-06-14T00:00:00.000Z",
          capabilities: {},
          tools: [],
          prompts: [
            {
              name: "bad duplicate",
              description: "Duplicate arguments",
              arguments: [
                { name: "path", required: true },
                { name: " path ", required: false },
              ],
            },
            {
              name: "bad blank",
              description: "Blank argument",
              arguments: [{ name: "   ", required: true }],
            },
            {
              name: " valid ",
              description: "Valid prompt",
              arguments: [{ name: " path ", required: true }],
            },
          ],
          resources: [],
        },
      },
      startupStats: {},
    }), "utf8");
    const store = new McpCacheStore(userDataDir);

    await store.init();

    expect(store.getSurface(server)?.prompts).toEqual([
      {
        name: "valid",
        description: "Valid prompt",
        arguments: [{ name: "path", required: true }],
      },
    ]);

    await store.saveSurface(server, {
      capabilities: { prompts: {} },
      tools: [],
      prompts: [
        {
          name: "saved duplicate",
          description: "Duplicate arguments",
          arguments: [
            { name: "topic", required: true },
            { name: " topic ", required: false },
          ],
        },
        {
          name: " saved valid ",
          description: "Valid prompt",
          arguments: [{ name: " topic ", required: true }],
        },
      ],
      resources: [],
    });

    const reloaded = new McpCacheStore(userDataDir);
    await reloaded.init();
    expect(reloaded.getSurface(server)?.prompts).toEqual([
      {
        name: "saved valid",
        description: "Valid prompt",
        arguments: [{ name: "topic", required: true }],
      },
    ]);
  });

  it("treats corrupted cache files as cache misses without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fs.mkdir(path.join(userDataDir, "mcp"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "mcp", "cache.json"), "{bad", "utf8");
    const store = new McpCacheStore(userDataDir);

    await expect(store.init()).resolves.toBeUndefined();

    expect(store.getSurface(config())).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "server-1",
    name: "local-mcp",
    transport: "stdio",
    command: "node",
    args: [],
    env: { MCP_TOKEN: "secret" },
    headers: {},
    enabled: true,
    readOnlyTools: [],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}
