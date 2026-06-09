import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import {
  SSE_PUSH_CHANNEL,
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_CHANNEL,
} from "../../../src/shared/ipc";
import {
  __resetSseSubscriptionsForTests,
  registerSseHandlers,
} from "../../../src/main/ipc/sse-handlers";
import type {
  RuntimeErrorEvent,
  RuntimeEvent,
  TurnRecord,
} from "../../../src/shared/agent-contracts";

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

function runtimeErrorEvent(overrides: Partial<RuntimeErrorEvent> = {}): RuntimeErrorEvent {
  return {
    kind: "runtime_error",
    code: "internal",
    message: "Global failure",
    ...overrides,
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

  it("forwards global runtime errors once per webContents", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    if (!subscribe) throw new Error("Expected subscribe handler.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    await subscribe({ sender }, { threadId: "thread-2" });

    const event = runtimeErrorEvent();
    bus.emit("runtime_error", event);

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(SSE_PUSH_CHANNEL, event);
  });

  it("keeps thread-scoped runtime errors on the matching thread subscription", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    if (!subscribe) throw new Error("Expected subscribe handler.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });

    const ignored = runtimeErrorEvent({ threadId: "thread-2", message: "Ignored" });
    const delivered = runtimeErrorEvent({ threadId: "thread-1", message: "Delivered" });
    bus.emit("runtime_error", ignored);
    bus.emit("runtime_error", delivered);

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(SSE_PUSH_CHANNEL, delivered);
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

  it("stops forwarding global runtime errors after the last unsubscribe", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    if (!subscribe || !unsubscribe) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    await unsubscribe({ sender }, { threadId: "thread-1" });

    bus.emit("runtime_error", runtimeErrorEvent());

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("stops forwarding global runtime errors after webContents destruction", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    if (!subscribe) throw new Error("Expected subscribe handler.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    sender.destroy();

    bus.emit("runtime_error", runtimeErrorEvent());

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("normalizes subscription thread ids before storing unsubscribe keys", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    if (!subscribe || !unsubscribe) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();
    const subscribed = await subscribe({ sender }, { threadId: " thread-1 " });
    const unsubscribed = await unsubscribe({ sender }, { threadId: "thread-1" });

    expect(subscribed).toEqual({ ok: true, value: { subscribed: "thread-1" } });
    expect(unsubscribed).toEqual({ ok: true, value: { unsubscribed: true } });
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
