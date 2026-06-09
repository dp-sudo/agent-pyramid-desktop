import { beforeEach, describe, expect, it, vi } from "vitest";
import { SSE_PUSH_CHANNEL } from "../../src/shared/ipc";
import type { RuntimeEvent } from "../../src/shared/agent-contracts";

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
});

function getAgentApi(): {
  sse: {
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
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
  };
}

function getSsePushListener(): IpcRendererListener {
  const listener = electronMock.listeners.get(SSE_PUSH_CHANNEL);
  if (!listener) throw new Error("Expected SSE push listener.");
  return listener;
}
