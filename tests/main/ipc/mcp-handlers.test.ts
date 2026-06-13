import { describe, expect, it, vi } from "vitest";
import {
  parsePromptGetRequest,
  parseResourceReadRequest,
  parseServerConnectRequest,
  parseServerPromptsRequest,
  parseServerRefreshToolsRequest,
  registerMcpHandlers,
} from "../../../src/main/ipc/mcp-handlers";
import {
  MCP_PROMPTS_GET_CHANNEL,
  MCP_RESOURCES_READ_CHANNEL,
  MCP_SERVERS_LIST_CHANNEL,
  MCP_SURFACE_REFRESH_CHANNEL,
} from "../../../src/shared/ipc";
import type { McpHost } from "../../../src/main/infrastructure/mcp/host";

type IpcHandler = (_event: unknown, request?: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

describe("mcp handlers", () => {
  it("parses MCP IPC requests at the process boundary", () => {
    expect(parseServerConnectRequest({ serverId: " server-1 " })).toEqual({
      serverId: "server-1",
    });
    expect(parseServerPromptsRequest({ serverId: "server-1" })).toEqual({
      serverId: "server-1",
    });
    expect(parseServerRefreshToolsRequest({ serverId: "server-1" })).toEqual({
      serverId: "server-1",
    });
    expect(parsePromptGetRequest({
      serverId: "server-1",
      name: "review",
      arguments: { path: "README.md" },
    })).toEqual({
      serverId: "server-1",
      name: "review",
      arguments: { path: "README.md" },
    });
    expect(parseResourceReadRequest({
      serverId: "server-1",
      uri: "file:///README.md",
    })).toEqual({
      serverId: "server-1",
      uri: "file:///README.md",
    });
    expect(() => parsePromptGetRequest({
      serverId: "server-1",
      name: "review",
      arguments: { bad: 1 },
    })).toThrow("MCP prompt arguments must contain only string values without NUL bytes.");
    expect(() => parsePromptGetRequest({
      serverId: "server-1",
      name: "review",
      arguments: { path: "README.md", " path ": "CHANGELOG.md" },
    })).toThrow("MCP prompt arguments.path key is duplicated.");
  });

  it("registers prompt/resource/surface handlers with envelopes", async () => {
    electronMock.handlers.clear();
    const host = createHost();
    registerMcpHandlers(host);

    const list = electronMock.handlers.get(MCP_SERVERS_LIST_CHANNEL);
    const refreshSurface = electronMock.handlers.get(MCP_SURFACE_REFRESH_CHANNEL);
    const getPrompt = electronMock.handlers.get(MCP_PROMPTS_GET_CHANNEL);
    const readResource = electronMock.handlers.get(MCP_RESOURCES_READ_CHANNEL);
    if (!list || !refreshSurface || !getPrompt || !readResource) {
      throw new Error("Expected MCP handlers.");
    }

    await expect(list({})).resolves.toEqual({
      ok: true,
      value: { servers: [] },
    });
    await expect(refreshSurface({}, { serverId: "server-1" })).resolves.toEqual({
      ok: true,
      value: { id: "server-1", status: "connected" },
    });
    await expect(getPrompt({}, { serverId: "server-1", name: "review" }))
      .resolves.toEqual({
        ok: true,
        value: { messages: [] },
      });
    await expect(readResource({}, { serverId: "server-1", uri: "file:///README.md" }))
      .resolves.toEqual({
        ok: true,
        value: { contents: [] },
      });
  });
});

function createHost(): McpHost {
  return {
    listServers: vi.fn(() => []),
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTools: vi.fn(() => []),
    refreshTools: vi.fn(),
    refreshSurface: vi.fn(async () => ({ id: "server-1", status: "connected" })),
    listPrompts: vi.fn(() => []),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    listResources: vi.fn(() => []),
    readResource: vi.fn(async () => ({ contents: [] })),
  } as unknown as McpHost;
}
