import { describe, expect, it } from "vitest";
import {
  appendToolProgressToItems,
  mergeToolProgressBufferEvent,
  toolProgressBufferKey,
  toolProgressUpdateFromEvent,
  type ToolProgressDisplayResult,
} from "../../src/renderer/src/ui/store/tool-progress-model";
import type { ToolItem, ToolProgressEvent } from "../../src/shared/agent-contracts";

function toolItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "tool-1",
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    name: "run_command",
    args: { command: "npm test" },
    status: "running",
    createdAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

function expectToolItem(item: unknown): ToolItem {
  if (!item || typeof item !== "object" || (item as { kind?: unknown }).kind !== "tool") {
    throw new Error("Expected tool item.");
  }
  return item as ToolItem;
}

describe("tool progress model", () => {
  it("builds stable buffer keys for live tool progress events", () => {
    expect(toolProgressBufferKey(toolProgressEvent())).toBe("thread-1:turn-1:call-1");
  });

  it("maps live tool progress events to store updates", () => {
    expect(toolProgressUpdateFromEvent(toolProgressEvent({
      seq: 2,
      stream: "stderr",
      chunk: "err-1\n",
    }))).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 2,
      stderr: "err-1\n",
    });
  });

  it("merges live stdout and stderr chunks into one buffered update", () => {
    const withStdout = mergeToolProgressBufferEvent(undefined, toolProgressEvent({
      seq: 1,
      stream: "stdout",
      chunk: "out-1\n",
    }));
    const withStderr = mergeToolProgressBufferEvent(withStdout, toolProgressEvent({
      seq: 2,
      stream: "stderr",
      chunk: "err-1\n",
    }));
    const withMoreStdout = mergeToolProgressBufferEvent(withStderr, toolProgressEvent({
      seq: 3,
      stream: "stdout",
      chunk: "out-2\n",
    }));

    expect(withMoreStdout).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 3,
      stdout: "out-1\nout-2\n",
      stderr: "err-1\n",
    });
  });

  it("appends stdout and stderr chunks to running tool items", () => {
    const items = [toolItem()];

    const withStdout = appendToolProgressToItems(items, {
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 1,
      stdout: "out-1\n",
    });
    const withStderr = appendToolProgressToItems(withStdout, {
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 2,
      stderr: "err-1\n",
    });

    expect(withStderr[0]).toMatchObject({
      result: {
        kind: "tool_progress",
        stdout: "out-1\n",
        stderr: "err-1\n",
      },
    });
  });

  it("ignores non-running tools and unknown tool call ids", () => {
    const completed = [toolItem({ status: "completed", result: { stdout: "final\n" } })];
    const missing = [toolItem()];
    const progress = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "missing-call",
      seq: 1,
      stdout: "late\n",
    };

    expect(appendToolProgressToItems(completed, {
      ...progress,
      toolCallId: "call-1",
    })).toBe(completed);
    expect(appendToolProgressToItems(missing, progress)).toBe(missing);
  });

  it("keeps only the latest progress text when the display limit is exceeded", () => {
    const previous = "a".repeat(11_995);
    const item = toolItem({
      result: {
        kind: "tool_progress",
        stdout: previous,
      } satisfies ToolProgressDisplayResult,
    });

    const next = appendToolProgressToItems([item], {
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 3,
      stdout: "b".repeat(10),
    });
    const result = expectToolItem(next[0]).result as ToolProgressDisplayResult;

    expect(result.stdout).toHaveLength(12_000);
    expect(result.stdout).toBe(`${"a".repeat(11_990)}${"b".repeat(10)}`);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("preserves existing truncated flags when a later progress event has no chunk", () => {
    const item = toolItem({
      result: {
        kind: "tool_progress",
        stderr: "tail",
        stderrTruncated: true,
      } satisfies ToolProgressDisplayResult,
    });

    const next = appendToolProgressToItems([item], {
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 4,
    });

    expect(next[0]).toMatchObject({
      result: {
        kind: "tool_progress",
        stderr: "tail",
        stderrTruncated: true,
      },
    });
  });
});

function toolProgressEvent(overrides: Partial<ToolProgressEvent> = {}): ToolProgressEvent {
  return {
    kind: "tool_progress",
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    seq: 1,
    stream: "stdout",
    chunk: "out\n",
    ...overrides,
  };
}
