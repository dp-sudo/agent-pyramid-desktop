import { describe, expect, it } from "vitest";
import {
  isTimelineProcessOpen,
  shouldShowTimelineProcessItem,
  shouldStickToTimelineBottom,
} from "../../src/renderer/src/ui/components/chat/MessageTimeline";
import type { ToolItem } from "../../src/shared/agent-contracts";

describe("MessageTimeline helpers", () => {
  it("sticks to the bottom while the viewport is near the latest output", () => {
    expect(
      shouldStickToTimelineBottom({
        scrollTop: 820,
        scrollHeight: 1200,
        clientHeight: 300,
        threshold: 96,
      }),
    ).toBe(true);
  });

  it("does not steal scroll when the user is reading older output", () => {
    expect(
      shouldStickToTimelineBottom({
        scrollTop: 600,
        scrollHeight: 1200,
        clientHeight: 300,
        threshold: 96,
      }),
    ).toBe(false);
  });

  it("opens the active turn process by default", () => {
    expect(
      isTimelineProcessOpen({
        turnId: "turn-1",
        activeTurnId: "turn-1",
        openByTurnId: {},
      }),
    ).toBe(true);
  });

  it("respects an explicit user process toggle over the active default", () => {
    expect(
      isTimelineProcessOpen({
        turnId: "turn-1",
        activeTurnId: "turn-1",
        openByTurnId: { "turn-1": false },
      }),
    ).toBe(false);
    expect(
      isTimelineProcessOpen({
        turnId: "turn-2",
        activeTurnId: null,
        openByTurnId: { "turn-2": true },
      }),
    ).toBe(true);
  });

  it("keeps failed read-only tool records visible when read-only records are hidden", () => {
    const failedReadOnlyTool = toolItem("read_file", "failed");
    const completedReadOnlyTool = toolItem("read_file", "completed");
    const completedWriteTool = toolItem("write_file", "completed");

    expect(shouldShowTimelineProcessItem(failedReadOnlyTool, false)).toBe(true);
    expect(shouldShowTimelineProcessItem(completedReadOnlyTool, false)).toBe(false);
    expect(shouldShowTimelineProcessItem(completedWriteTool, false)).toBe(true);
    expect(shouldShowTimelineProcessItem(completedReadOnlyTool, true)).toBe(true);
  });
});

function toolItem(name: string, status: ToolItem["status"]): ToolItem {
  return {
    kind: "tool",
    id: `${name}-${status}`,
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: `${name}-call`,
    name,
    args: {},
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
