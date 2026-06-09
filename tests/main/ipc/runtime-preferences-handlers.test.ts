import { describe, expect, it, vi } from "vitest";
import { registerRuntimePreferencesHandlers } from "../../../src/main/ipc/runtime-preferences-handlers";
import {
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
} from "../../../src/shared/ipc";
import { DEFAULT_RUNTIME_PREFERENCES } from "../../../src/shared/agent-contracts";
import type { RuntimePreferencesStore } from "../../../src/main/persistence/runtime-preferences-store";

type IpcHandler = (_event: unknown, request: unknown) => Promise<unknown>;

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

function createStore(): RuntimePreferencesStore {
  return {
    get: vi.fn(async () => DEFAULT_RUNTIME_PREFERENCES),
    update: vi.fn(async () => DEFAULT_RUNTIME_PREFERENCES),
  } as unknown as RuntimePreferencesStore;
}

describe("runtime preferences handlers", () => {
  it("registers get and update handlers", async () => {
    const store = createStore();
    registerRuntimePreferencesHandlers(store);

    const getHandler = electronMock.handlers.get(RUNTIME_PREFERENCES_GET_CHANNEL);
    const updateHandler = electronMock.handlers.get(RUNTIME_PREFERENCES_UPDATE_CHANNEL);
    if (!getHandler) throw new Error("Expected runtime preferences get handler.");
    if (!updateHandler) throw new Error("Expected runtime preferences update handler.");

    await expect(getHandler({}, undefined)).resolves.toEqual({
      ok: true,
      value: DEFAULT_RUNTIME_PREFERENCES,
    });
    await expect(updateHandler({}, { command: { timeoutMs: 45_000 } })).resolves.toEqual({
      ok: true,
      value: DEFAULT_RUNTIME_PREFERENCES,
    });
    expect(store.update).toHaveBeenCalledWith({ command: { timeoutMs: 45_000 } });
  });

  it("returns an error envelope for malformed updates before store access", async () => {
    const store = createStore();
    registerRuntimePreferencesHandlers(store);
    const updateHandler = electronMock.handlers.get(RUNTIME_PREFERENCES_UPDATE_CHANNEL);
    if (!updateHandler) throw new Error("Expected runtime preferences update handler.");

    const result = await updateHandler({}, { command: { timeoutMs: 0 } });

    expect(result).toEqual({
      ok: false,
      code: "RUNTIME_PREFERENCES_UPDATE_FAILED",
      message: "command.timeoutMs must be an integer between 100 and 120000.",
    });
    expect(store.update).not.toHaveBeenCalled();
  });
});
