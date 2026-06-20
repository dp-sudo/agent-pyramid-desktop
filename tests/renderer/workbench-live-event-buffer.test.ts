import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchLiveEventBuffer } from "../../src/renderer/src/ui/workbench-live-event-buffer";
import type {
  AssistantItem,
  RuntimeEvent,
  ToolProgressEvent,
} from "../../src/shared/agent-contracts";

describe("WorkbenchLiveEventBuffer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces tool progress by tool call before dispatching", () => {
    vi.useFakeTimers();
    const appendToolProgress = vi.fn();
    const updateItem = vi.fn();
    const buffer = new WorkbenchLiveEventBuffer(
      { appendToolProgress, updateItem },
      { toolProgressFlushMs: 10 },
    );

    expect(buffer.handleRuntimeEvent(toolProgressEvent({ chunk: "a", seq: 1 }), "thread-1"))
      .toBe(true);
    expect(buffer.handleRuntimeEvent(toolProgressEvent({ chunk: "b", seq: 2 }), "thread-1"))
      .toBe(true);
    expect(buffer.handleRuntimeEvent(
      toolProgressEvent({ chunk: "err", stream: "stderr", seq: 3 }),
      "thread-1",
    )).toBe(true);

    expect(appendToolProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);

    expect(appendToolProgress).toHaveBeenCalledTimes(1);
    expect(appendToolProgress).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 3,
      stdout: "ab",
      stderr: "err",
    });
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("keeps only the latest active text delta and flushes before terminal events", () => {
    vi.useFakeTimers();
    const appendToolProgress = vi.fn();
    const updateItem = vi.fn();
    const buffer = new WorkbenchLiveEventBuffer(
      { appendToolProgress, updateItem },
      { textDeltaFlushMs: 10 },
    );
    const first = assistantItem({ text: "Hel" });
    const latest = assistantItem({ text: "Hello" });

    expect(buffer.handleRuntimeEvent(itemUpdatedEvent(first), "thread-1")).toBe(true);
    expect(buffer.handleRuntimeEvent(itemUpdatedEvent(latest), "thread-1")).toBe(true);
    expect(updateItem).not.toHaveBeenCalled();

    expect(buffer.handleRuntimeEvent({
      kind: "turn_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      completedAt: "2026-01-01T00:00:01.000Z",
    }, "thread-1")).toBe(false);

    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(updateItem).toHaveBeenCalledWith(latest);
    vi.advanceTimersByTime(10);
    expect(updateItem).toHaveBeenCalledTimes(1);
  });

  it("leaves non-live item updates for the normal runtime event path", () => {
    vi.useFakeTimers();
    const appendToolProgress = vi.fn();
    const updateItem = vi.fn();
    const buffer = new WorkbenchLiveEventBuffer(
      { appendToolProgress, updateItem },
      { textDeltaFlushMs: 10 },
    );

    expect(buffer.handleRuntimeEvent(itemUpdatedEvent(assistantItem()), "thread-2"))
      .toBe(false);
    vi.advanceTimersByTime(10);

    expect(updateItem).not.toHaveBeenCalled();
    expect(appendToolProgress).not.toHaveBeenCalled();
  });

  it("clears pending live updates on dispose", () => {
    vi.useFakeTimers();
    const appendToolProgress = vi.fn();
    const updateItem = vi.fn();
    const buffer = new WorkbenchLiveEventBuffer(
      { appendToolProgress, updateItem },
      { toolProgressFlushMs: 10, textDeltaFlushMs: 10 },
    );

    buffer.handleRuntimeEvent(toolProgressEvent(), "thread-1");
    buffer.handleRuntimeEvent(itemUpdatedEvent(assistantItem()), "thread-1");
    buffer.dispose();
    vi.advanceTimersByTime(10);

    expect(appendToolProgress).not.toHaveBeenCalled();
    expect(updateItem).not.toHaveBeenCalled();
  });
});

function toolProgressEvent(overrides: Partial<ToolProgressEvent> = {}): ToolProgressEvent {
  return {
    kind: "tool_progress",
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    chunk: "out",
    stream: "stdout",
    seq: 1,
    ...overrides,
  };
}

function itemUpdatedEvent(item: AssistantItem): Extract<RuntimeEvent, { kind: "item_updated" }> {
  return {
    kind: "item_updated",
    threadId: item.threadId,
    turnId: item.turnId,
    item,
  };
}

function assistantItem(overrides: Partial<AssistantItem> = {}): AssistantItem {
  return {
    kind: "assistant",
    id: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    text: "Hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
