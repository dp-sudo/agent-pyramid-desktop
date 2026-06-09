import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../src/main/event-bus";
import {
  RUNTIME_EVENT_KINDS,
  type RuntimeEvent,
  type RuntimeEventKind,
  type TurnRecord,
  type UserItem,
} from "../../src/shared/agent-contracts";

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

function userItem(): UserItem {
  return {
    kind: "user",
    id: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    text: "Hello",
    createdAt: "2026-06-07T00:00:00.000Z",
  };
}

function eventForKind(kind: RuntimeEventKind): RuntimeEvent {
  switch (kind) {
    case "turn_started":
      return turnStartedEvent();
    case "turn_completed":
      return {
        kind,
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-07T00:01:00.000Z",
      };
    case "turn_failed":
      return {
        kind,
        threadId: "thread-1",
        turnId: "turn-1",
        message: "failure",
        failedAt: "2026-06-07T00:01:00.000Z",
      };
    case "item_appended":
    case "item_updated":
      return {
        kind,
        threadId: "thread-1",
        turnId: "turn-1",
        item: userItem(),
      };
    case "approval_requested":
      return {
        kind,
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "edit_file",
        args: {},
      };
    case "tool_budget_reached":
      return {
        kind,
        threadId: "thread-1",
        turnId: "turn-1",
        maxToolRounds: 12,
        attemptedToolCalls: 1,
        message: "Continue this turn.",
        reachedAt: "2026-06-08T00:00:00.000Z",
      };
    case "goal_updated":
      return {
        kind,
        threadId: "thread-1",
        goal: {
          text: "Ship the task",
          status: "active",
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      };
    case "runtime_error":
      return {
        kind,
        threadId: "thread-1",
        code: "internal",
        message: "failure",
      };
  }
}

describe("RuntimeEventBus", () => {
  it("filters thread subscriptions and unsubscribes cleanly", () => {
    const bus = new RuntimeEventBus();
    const listener = vi.fn<(event: RuntimeEvent) => void>();
    const unsubscribe = bus.onThread("thread-1", listener);

    const matching = turnStartedEvent();
    const other = turnStartedEvent({ id: "turn-2", threadId: "thread-2" });

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

    bus.emit("turn_started", turnStartedEvent());
    bus.emit("runtime_error", event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    bus.emit("runtime_error", event);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("forwards tool budget events to thread subscribers", () => {
    const bus = new RuntimeEventBus();
    const listener = vi.fn<(event: RuntimeEvent) => void>();
    const unsubscribe = bus.onThread("thread-1", listener);
    const event: RuntimeEvent = {
      kind: "tool_budget_reached",
      threadId: "thread-1",
      turnId: "turn-1",
      maxToolRounds: 12,
      attemptedToolCalls: 1,
      message: "Continue this turn.",
      reachedAt: "2026-06-08T00:00:00.000Z",
    };

    bus.emit("tool_budget_reached", event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
  });

  it("uses the shared runtime event kind list for thread subscriptions", () => {
    const bus = new RuntimeEventBus();
    const listener = vi.fn<(event: RuntimeEvent) => void>();
    const unsubscribe = bus.onThread("thread-1", listener);

    for (const kind of RUNTIME_EVENT_KINDS) {
      bus.emit(kind, eventForKind(kind));
    }

    expect(listener).toHaveBeenCalledTimes(RUNTIME_EVENT_KINDS.length);
    expect(listener.mock.calls.map(([event]) => event.kind)).toEqual([
      ...RUNTIME_EVENT_KINDS,
    ]);

    unsubscribe();
    for (const kind of RUNTIME_EVENT_KINDS) {
      bus.emit(kind, eventForKind(kind));
    }
    expect(listener).toHaveBeenCalledTimes(RUNTIME_EVENT_KINDS.length);
  });
});
