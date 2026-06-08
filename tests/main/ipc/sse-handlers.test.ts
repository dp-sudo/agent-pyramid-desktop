import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import {
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_CHANNEL,
} from "../../../src/shared/ipc";
import {
  __resetSseSubscriptionsForTests,
  registerSseHandlers,
} from "../../../src/main/ipc/sse-handlers";
import type { RuntimeEvent, TurnRecord } from "../../../src/shared/agent-contracts";

type IpcHandler = (
  event: { sender: FakeWebContents },
  request: unknown,
) => Promise<unknown>;

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

class FakeWebContents extends EventEmitter {
  readonly id = 1;
  readonly send = vi.fn();
  private destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "in-flight",
    startedAt: "2026-06-07T00:00:00.000Z",
    model: "MiniMax-M3",
    mode: "agent",
    ...overrides,
  };
}

function turnStartedEvent(overrides: Partial<TurnRecord> = {}): RuntimeEvent {
  const record = turn(overrides);
  return {
    kind: "turn_started",
    threadId: record.threadId,
    turnId: record.id,
    startedAt: record.startedAt,
    turn: record,
  };
}

describe("sse handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    __resetSseSubscriptionsForTests();
  });

  it("keeps multiple thread subscriptions on one webContents", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    if (!subscribe) throw new Error("Expected subscribe handler.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    expect(sender.listenerCount("destroyed")).toBe(1);

    await subscribe({ sender }, { threadId: "thread-2" });
    expect(sender.listenerCount("destroyed")).toBe(1);

    const firstEvent = turnStartedEvent();
    const secondEvent = turnStartedEvent({ id: "turn-2", threadId: "thread-2" });
    bus.emit(firstEvent.kind, firstEvent);
    bus.emit(secondEvent.kind, secondEvent);
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it("removes destroyed listeners on unsubscribe", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    if (!subscribe || !unsubscribe) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    expect(sender.listenerCount("destroyed")).toBe(1);

    const result = await unsubscribe({ sender }, { threadId: "thread-1" });

    expect(result).toEqual({ ok: true, value: { unsubscribed: true } });
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("unsubscribes one thread without dropping other thread subscriptions", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    if (!subscribe || !unsubscribe) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    await subscribe({ sender }, { threadId: "thread-2" });
    const result = await unsubscribe({ sender }, { threadId: "thread-1" });

    expect(result).toEqual({ ok: true, value: { unsubscribed: true } });
    expect(sender.listenerCount("destroyed")).toBe(1);

    bus.emit("turn_started", turnStartedEvent());
    bus.emit("turn_started", turnStartedEvent({ id: "turn-2", threadId: "thread-2" }));

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send.mock.calls[0]?.[1]).toMatchObject({ threadId: "thread-2" });
  });

  it("replaces only the same thread subscription when re-subscribed", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    if (!subscribe || !unsubscribe) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    await subscribe({ sender }, { threadId: "thread-1" });

    expect(sender.listenerCount("destroyed")).toBe(1);

    bus.emit("turn_started", turnStartedEvent());
    expect(sender.send).toHaveBeenCalledOnce();

    const result = await unsubscribe({ sender }, { threadId: "thread-1" });
    expect(result).toEqual({ ok: true, value: { unsubscribed: true } });
  });

  it("returns error envelopes for malformed subscription requests", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    if (!subscribe || !unsubscribe) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();

    await expect(subscribe({ sender }, undefined)).resolves.toEqual({
      ok: false,
      code: "SSE_SUBSCRIBE_FAILED",
      message: "SSE request must be an object.",
    });
    await expect(unsubscribe({ sender }, { threadId: "" })).resolves.toEqual({
      ok: false,
      code: "SSE_UNSUBSCRIBE_FAILED",
      message: "threadId is required.",
    });
  });
});
