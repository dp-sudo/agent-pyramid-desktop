import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SSE_PUSH_CHANNEL,
  SKILL_LIST_CHANNEL,
  WRITE_CREATE_CHANNEL,
  WRITE_DELETE_CHANNEL,
  WRITE_RENAME_CHANNEL,
} from "../../src/shared/ipc";
import type {
  IpcResult,
  RuntimeEvent,
  WriteCreateRequest,
  WriteDeleteRequest,
  WriteRenameRequest,
} from "../../src/shared/agent-contracts";

type IpcRendererListener = (_event: unknown, payload: unknown) => void;

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, IpcRendererListener>();
  const exposed = new Map<string, unknown>();
  return {
    exposed,
    listeners,
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, api: unknown) => {
        exposed.set(name, api);
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: IpcRendererListener) => {
        listeners.set(channel, listener);
      }),
    },
  };
});

vi.mock("electron", () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
}));

describe("preload bridge", () => {
  beforeEach(async () => {
    vi.resetModules();
    electronMock.exposed.clear();
    electronMock.listeners.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockClear();
    electronMock.ipcRenderer.on.mockClear();
    await import("../../src/preload/index");
  });

  it("forwards only valid runtime events to renderer SSE listeners", () => {
    const api = getAgentApi();
    const listener = vi.fn();
    const unsubscribe = api.sse.onEvent(listener);
    const push = getSsePushListener();
    const event: RuntimeEvent = {
      kind: "runtime_error",
      code: "internal",
      message: "global failure",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    push({}, event);
    push({}, { kind: "runtime_error", code: "unknown", message: "bad" });
    unsubscribe();
    push({}, event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
    expect(warn).toHaveBeenCalledWith("[preload] dropped invalid runtime event payload.");
    warn.mockRestore();
  });

  it("exposes write document management IPC methods", async () => {
    const api = getAgentApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({ ok: true, value: { path: "notes.md" } });

    await api.write.create({ workspace: "/workspace", path: "notes.md", content: "" });
    await api.write.rename({
      workspace: "/workspace",
      path: "notes.md",
      newPath: "drafts/notes.md",
    });
    await api.write.delete({ workspace: "/workspace", path: "drafts/notes.md" });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      WRITE_CREATE_CHANNEL,
      { workspace: "/workspace", path: "notes.md", content: "" },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      WRITE_RENAME_CHANNEL,
      { workspace: "/workspace", path: "notes.md", newPath: "drafts/notes.md" },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      WRITE_DELETE_CHANNEL,
      { workspace: "/workspace", path: "drafts/notes.md" },
    );
  });

  it("exposes skill catalog IPC methods", async () => {
    const api = getAgentApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      value: { workspace: "/workspace", enabled: true, skills: [], roots: [], validationErrors: [] },
    });

    await api.skills.list({ workspace: "/workspace" });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      SKILL_LIST_CHANNEL,
      { workspace: "/workspace" },
    );
  });
});

function getAgentApi(): {
  sse: {
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
  };
  write: {
    create(
      request: WriteCreateRequest,
    ): Promise<IpcResult<{ path: string; content: string; bytes: number }>>;
    rename(request: WriteRenameRequest): Promise<IpcResult<{ path: string; newPath: string }>>;
    delete(request: WriteDeleteRequest): Promise<IpcResult<{ path: string }>>;
  };
  skills: {
    list(request: { workspace: string }): Promise<IpcResult<unknown>>;
  };
} {
  const api = electronMock.exposed.get("agentApi");
  if (!api || typeof api !== "object" || !("sse" in api)) {
    throw new Error("Expected exposed agentApi.");
  }
  return api as {
    sse: {
      onEvent(listener: (event: RuntimeEvent) => void): () => void;
    };
    write: {
      create(
        request: WriteCreateRequest,
      ): Promise<IpcResult<{ path: string; content: string; bytes: number }>>;
      rename(request: WriteRenameRequest): Promise<IpcResult<{ path: string; newPath: string }>>;
      delete(request: WriteDeleteRequest): Promise<IpcResult<{ path: string }>>;
    };
    skills: {
      list(request: { workspace: string }): Promise<IpcResult<unknown>>;
    };
  };
}

function getSsePushListener(): IpcRendererListener {
  const listener = electronMock.listeners.get(SSE_PUSH_CHANNEL);
  if (!listener) throw new Error("Expected SSE push listener.");
  return listener;
}
