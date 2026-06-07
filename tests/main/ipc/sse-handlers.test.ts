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
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
  BrowserWindow: electronMock.BrowserWindow,
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

describe("sse handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    __resetSseSubscriptionsForTests();
  });

  it("replaces webContents subscriptions without accumulating destroyed listeners", async () => {
    const bus = new RuntimeEventBus();
    registerSseHandlers(bus);
    const subscribe = electronMock.handlers.get(SSE_SUBSCRIBE_CHANNEL);
    if (!subscribe) throw new Error("Expected subscribe handler.");

    const sender = new FakeWebContents();
    await subscribe({ sender }, { threadId: "thread-1" });
    expect(sender.listenerCount("destroyed")).toBe(1);

    await subscribe({ sender }, { threadId: "thread-2" });
    expect(sender.listenerCount("destroyed")).toBe(1);

    const event = {
      kind: "turn_started" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: "2026-06-07T00:00:00.000Z",
    };
    bus.emit(event.kind, event);
    expect(sender.send).not.toHaveBeenCalled();
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
});
