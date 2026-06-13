import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import {
  SSE_PUSH_CHANNEL,
  SSE_SUBSCRIBE_GLOBAL_CHANNEL,
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_GLOBAL_CHANNEL,
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

function mcpConnectionEvent(): RuntimeEvent {
  return {
    kind: "mcp_server_connection",
    serverId: "server-1",
    serverName: "local-mcp",
    status: "connected",
    toolCount: 1,
    occurredAt: "2026-06-08T00:00:00.000Z",
  };
}

function mcpToolListChangedEvent(): RuntimeEvent {
  return {
    kind: "mcp_tool_list_changed",
    serverId: "server-1",
    serverName: "local-mcp",
    toolCount: 1,
    tools: [
      {
        name: "mcp__local-mcp__echo",
        description: "Echo",
        inputSchema: { type: "object" },
        readOnly: true,
      },
    ],
    occurredAt: "2026-06-08T00:00:00.000Z",
  };
}

function mcpSurfaceChangedEvent(): RuntimeEvent {
  return {
    kind: "mcp_surface_changed",
    serverId: "server-1",
    serverName: "local-mcp",
    promptCount: 1,
    resourceCount: 1,
    occurredAt: "2026-06-08T00:00:00.000Z",
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

  it("forwards process-level MCP events through an explicit global subscription", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribeGlobal = electronMock.handlers.get(SSE_SUBSCRIBE_GLOBAL_CHANNEL);
    const unsubscribeGlobal = electronMock.handlers.get(SSE_UNSUBSCRIBE_GLOBAL_CHANNEL);
    if (!subscribeGlobal || !unsubscribeGlobal) throw new Error("Expected global SSE handlers.");

    const sender = new FakeWebContents();
    const subscribed = await subscribeGlobal({ sender }, undefined);

    const connection = mcpConnectionEvent();
    const tools = mcpToolListChangedEvent();
    const surface = mcpSurfaceChangedEvent();
    bus.emit(connection.kind, connection);
    bus.emit(tools.kind, tools);
    bus.emit(surface.kind, surface);

    expect(subscribed).toEqual({ ok: true, value: { subscribed: true } });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sender.send).toHaveBeenNthCalledWith(1, SSE_PUSH_CHANNEL, connection);
    expect(sender.send).toHaveBeenNthCalledWith(2, SSE_PUSH_CHANNEL, tools);
    expect(sender.send).toHaveBeenNthCalledWith(3, SSE_PUSH_CHANNEL, surface);

    const unsubscribed = await unsubscribeGlobal({ sender }, undefined);
    bus.emit("mcp_surface_changed", surface);

    expect(unsubscribed).toEqual({ ok: true, value: { unsubscribed: true } });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("keeps global subscriptions alive after thread unsubscribe", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    const unsubscribe = electronMock.handlers.get(SSE_UNSUBSCRIBE_CHANNEL);
    const subscribeGlobal = electronMock.handlers.get(SSE_SUBSCRIBE_GLOBAL_CHANNEL);
    if (!subscribe || !unsubscribe || !subscribeGlobal) throw new Error("Expected SSE handlers.");

    const sender = new FakeWebContents();
    await subscribeGlobal({ sender }, undefined);
    await subscribe({ sender }, { threadId: "thread-1" });
    await unsubscribe({ sender }, { threadId: "thread-1" });

    const event = mcpSurfaceChangedEvent();
    bus.emit("mcp_surface_changed", event);

    expect(sender.listenerCount("destroyed")).toBe(1);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(SSE_PUSH_CHANNEL, event);
  });

  it("returns an error envelope when no global subscription is active", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const unsubscribeGlobal = electronMock.handlers.get(SSE_UNSUBSCRIBE_GLOBAL_CHANNEL);
    if (!unsubscribeGlobal) throw new Error("Expected global unsubscribe handler.");

    const sender = new FakeWebContents();

    await expect(unsubscribeGlobal({ sender }, undefined)).resolves.toEqual({
      ok: false,
      code: "SSE_NOT_SUBSCRIBED",
      message: "No active global subscription for this window",
    });
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
