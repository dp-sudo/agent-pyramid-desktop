import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../src/main/event-bus";
import type { RuntimeEvent } from "../../src/shared/agent-contracts";

describe("RuntimeEventBus", () => {
  it("filters thread subscriptions and unsubscribes cleanly", () => {
    const bus = new RuntimeEventBus();
    const listener = vi.fn<(event: RuntimeEvent) => void>();
    const unsubscribe = bus.onThread("thread-1", listener);

    const matching: RuntimeEvent = {
      kind: "turn_started",
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: "2026-06-07T00:00:00.000Z",
    };
    const other: RuntimeEvent = {
      kind: "turn_started",
      threadId: "thread-2",
      turnId: "turn-2",
      startedAt: "2026-06-07T00:00:00.000Z",
    };

    bus.emit(matching.kind, matching);
    bus.emit(other.kind, other);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(matching);

    unsubscribe();
    bus.emit(matching.kind, matching);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("subscribes to one event kind", () => {
    const bus = new RuntimeEventBus();
    const listener = vi.fn<(event: RuntimeEvent) => void>();
    const unsubscribe = bus.onKind("runtime_error", listener);
    const event: RuntimeEvent = {
      kind: "runtime_error",
      threadId: "thread-1",
      code: "internal",
      message: "failure",
    };

    bus.emit("turn_started", {
      kind: "turn_started",
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: "2026-06-07T00:00:00.000Z",
    });
    bus.emit("runtime_error", event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    bus.emit("runtime_error", event);
    expect(listener).toHaveBeenCalledOnce();
  });
});
