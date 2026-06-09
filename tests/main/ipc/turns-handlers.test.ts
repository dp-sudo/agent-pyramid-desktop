import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTurnGetRequest,
  parseTurnInterruptRequest,
  registerTurnHandlers,
} from "../../../src/main/ipc/turns-handlers";
import {
  TURN_GET_CHANNEL,
  TURN_INTERRUPT_CHANNEL,
} from "../../../src/shared/ipc";
import type { Item } from "../../../src/shared/agent-contracts";
import type { AgentRuntime } from "../../../src/main/application/agent-runtime";
import type { JsonlThreadStore } from "../../../src/main/persistence/index";

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

function createRuntime(): AgentRuntime {
  return {
    startTurn: vi.fn(),
    interruptTurn: vi.fn(),
  } as unknown as AgentRuntime;
}

function createStore(items: Item[] = []): JsonlThreadStore {
  return {
    replayItems: vi.fn(async function* (_threadId: string) {
      for (const item of items) {
        yield item;
      }
    }),
  } as unknown as JsonlThreadStore;
}

describe("turn handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
  });

  it("parses interrupt turn ids strictly at the IPC boundary", () => {
    expect(parseTurnInterruptRequest(" turn-1 ")).toBe("turn-1");
    expect(() => parseTurnInterruptRequest("")).toThrow(
      "Turn interrupt requires a turnId string.",
    );
    expect(() => parseTurnInterruptRequest({ turnId: "turn-1" })).toThrow(
      "Turn interrupt requires a turnId string.",
    );
  });

  it("parses get thread ids strictly at the IPC boundary", () => {
    expect(parseTurnGetRequest(" thread-1 ")).toBe("thread-1");
    expect(() => parseTurnGetRequest("")).toThrow(
      "Turn get requires a threadId string.",
    );
    expect(() => parseTurnGetRequest({ threadId: "thread-1" })).toThrow(
      "Turn get requires a threadId string.",
    );
  });

  it("returns an error envelope for malformed interrupt requests", async () => {
    const runtime = createRuntime();
    registerTurnHandlers(runtime, createStore());
    const handler = electronMock.handlers.get(TURN_INTERRUPT_CHANNEL);
    if (!handler) throw new Error("Expected turn interrupt handler.");

    const result = await handler({}, { turnId: "turn-1" });

    expect(result).toEqual({
      ok: false,
      code: "TURN_INTERRUPT_FAILED",
      message: "Turn interrupt requires a turnId string.",
    });
    expect(runtime.interruptTurn).not.toHaveBeenCalled();
  });

  it("returns timeline items for a valid get request", async () => {
    const runtime = createRuntime();
    const userItem: Item = {
      id: "item-1",
      kind: "user",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-06-07T00:00:00.000Z",
      text: "Hello",
    };
    const latestAssistant: Item = {
      id: "item-2",
      kind: "assistant",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-06-07T00:00:01.000Z",
      text: "Hi",
    };
    const store = createStore([userItem, { ...latestAssistant, text: "H" }, latestAssistant]);
    registerTurnHandlers(runtime, store);
    const handler = electronMock.handlers.get(TURN_GET_CHANNEL);
    if (!handler) throw new Error("Expected turn get handler.");

    const result = await handler({}, " thread-1 ");

    expect(result).toEqual({
      ok: true,
      value: { threadId: "thread-1", items: [userItem, latestAssistant] },
    });
    expect(store.replayItems).toHaveBeenCalledWith("thread-1");
  });

  it("returns an error envelope for malformed get requests", async () => {
    const runtime = createRuntime();
    const store = createStore();
    registerTurnHandlers(runtime, store);
    const handler = electronMock.handlers.get(TURN_GET_CHANNEL);
    if (!handler) throw new Error("Expected turn get handler.");

    const result = await handler({}, { threadId: "thread-1" });

    expect(result).toEqual({
      ok: false,
      code: "TURN_GET_FAILED",
      message: "Turn get requires a threadId string.",
    });
    expect(store.replayItems).not.toHaveBeenCalled();
  });
});
