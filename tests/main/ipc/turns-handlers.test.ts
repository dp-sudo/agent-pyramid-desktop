import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTurnGetRequest,
  parseTurnInterruptRequest,
  registerTurnHandlers,
  turnStartErrorCodeForMessage,
} from "../../../src/main/ipc/turns-handlers";
import {
  TURN_GET_CHANNEL,
  TURN_INTERRUPT_CHANNEL,
  TURN_START_CHANNEL,
} from "../../../src/shared/ipc";
import type { Item, TurnRecord } from "../../../src/shared/agent-contracts";
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

function createTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "in-flight",
    startedAt: "2026-06-07T00:00:00.000Z",
    model: "MiniMax-M3",
    mode: "agent",
    goalMode: false,
    ...overrides,
  };
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

  it("maps turn start runtime errors to stable IPC codes", () => {
    expect(turnStartErrorCodeForMessage("RUNTIME_TURN_BUSY")).toBe("RUNTIME_TURN_BUSY");
    expect(turnStartErrorCodeForMessage("RUNTIME_THREAD_ARCHIVED")).toBe("RUNTIME_THREAD_ARCHIVED");
    expect(turnStartErrorCodeForMessage("Turn text is required.")).toBe("TURN_START_FAILED");
  });

  it("returns a turn record for a valid start request", async () => {
    const runtime = createRuntime();
    const turn = createTurn();
    vi.mocked(runtime.startTurn).mockResolvedValue(turn);
    registerTurnHandlers(runtime, createStore());
    const handler = electronMock.handlers.get(TURN_START_CHANNEL);
    if (!handler) throw new Error("Expected turn start handler.");

    const request = { threadId: "thread-1", text: "Run" };
    const result = await handler({}, request);

    expect(result).toEqual({ ok: true, value: turn });
    expect(runtime.startTurn).toHaveBeenCalledWith(request);
  });

  it("returns a busy error envelope when runtime rejects a concurrent start", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.startTurn).mockRejectedValue(new Error("RUNTIME_TURN_BUSY"));
    registerTurnHandlers(runtime, createStore());
    const handler = electronMock.handlers.get(TURN_START_CHANNEL);
    if (!handler) throw new Error("Expected turn start handler.");

    const result = await handler({}, { threadId: "thread-1", text: "Run" });

    expect(result).toEqual({
      ok: false,
      code: "RUNTIME_TURN_BUSY",
      message: "RUNTIME_TURN_BUSY",
    });
  });

  it("returns an archived-thread error envelope when runtime rejects a start", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.startTurn).mockRejectedValue(new Error("RUNTIME_THREAD_ARCHIVED"));
    registerTurnHandlers(runtime, createStore());
    const handler = electronMock.handlers.get(TURN_START_CHANNEL);
    if (!handler) throw new Error("Expected turn start handler.");

    const result = await handler({}, { threadId: "thread-1", text: "Run" });

    expect(result).toEqual({
      ok: false,
      code: "RUNTIME_THREAD_ARCHIVED",
      message: "RUNTIME_THREAD_ARCHIVED",
    });
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

  it("returns an error envelope when runtime rejects an interrupt request", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.interruptTurn).mockRejectedValue(
      new Error("Turn turn-1 is not in flight."),
    );
    registerTurnHandlers(runtime, createStore());
    const handler = electronMock.handlers.get(TURN_INTERRUPT_CHANNEL);
    if (!handler) throw new Error("Expected turn interrupt handler.");

    const result = await handler({}, "turn-1");

    expect(result).toEqual({
      ok: false,
      code: "TURN_INTERRUPT_FAILED",
      message: "Turn turn-1 is not in flight.",
    });
    expect(runtime.interruptTurn).toHaveBeenCalledWith("turn-1");
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
