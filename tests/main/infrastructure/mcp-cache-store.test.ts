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

function config(): McpServerConfig {
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
  };
}
