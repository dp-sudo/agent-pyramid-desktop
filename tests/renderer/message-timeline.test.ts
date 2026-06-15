import { describe, expect, it } from "vitest";
import {
  getApprovalPendingDecision,
  getTimelineBottomScrollTop,
  getVisibleTimelineItems,
  groupCodeRouteProcessItems,
  isTimelineProcessOpen,
  shouldShowTimelineProcessItem,
  shouldShowTimelineJumpToBottom,
  shouldStickToTimelineBottom,
  shouldRecordTimelineProcessToggle,
} from "../../src/renderer/src/ui/components/chat/MessageTimeline";
import type { Item, ToolItem } from "../../src/shared/agent-contracts";

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

  it("shows the jump-to-bottom affordance only after the user leaves latest output", () => {
    expect(shouldShowTimelineJumpToBottom(true)).toBe(false);
    expect(shouldShowTimelineJumpToBottom(false)).toBe(true);
  });

  it("uses the full scroll height as the jump-to-bottom target", () => {
    expect(getTimelineBottomScrollTop(1200)).toBe(1200);
    expect(getTimelineBottomScrollTop(-1)).toBe(0);
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

  it("records only real user work process details toggles", () => {
    expect(
      shouldRecordTimelineProcessToggle({
        currentOpen: false,
        nextOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldRecordTimelineProcessToggle({
        currentOpen: false,
        nextOpen: true,
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

  it("folds consecutive completed read-only tool records for the code route", () => {
    const readFile = toolItem("read_file", "completed");
    const searchFiles = toolItem("search_files", "completed");
    const failedRead = toolItem("read_file", "failed");
    const writeFile = toolItem("write_file", "completed");

    const displayItems = groupCodeRouteProcessItems([
      readFile,
      searchFiles,
      failedRead,
      writeFile,
    ]);

    expect(displayItems).toHaveLength(3);
    expect(displayItems[0]).toMatchObject({
      kind: "readOnlyToolSummary",
      items: [readFile, searchFiles],
    });
    expect(displayItems[1]).toBe(failedRead);
    expect(displayItems[2]).toBe(writeFile);
  });

  it("resolves shared pending approval decisions by approval id", () => {
    const approval: Extract<Item, { kind: "approval" }> = {
      kind: "approval",
      id: "approval-item",
      threadId: "thread-1",
      turnId: "turn-1",
      approvalId: "approval-1",
      toolName: "write_file",
      args: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    expect(getApprovalPendingDecision(approval, {
      "approval-1": { decision: "allow", scope: "session" },
    })).toEqual({ decision: "allow", scope: "session" });
    expect(getApprovalPendingDecision(approval, {
      "approval-2": { decision: "deny" },
    })).toBeNull();
    expect(getApprovalPendingDecision(toolItem("read_file", "pending"), {
      "approval-1": { decision: "allow", scope: "persist_rule" },
    })).toBeNull();
  });

  it("keeps all items visible when the turn count is within the initial render limit", () => {
    const items = [
      userItem("turn-1"),
      userItem("turn-2"),
      userItem("turn-3"),
    ];

    expect(getVisibleTimelineItems(items, false, 5)).toEqual({
      visibleItems: items,
      hiddenTurnCount: 0,
    });
  });

  it("keeps full item groups for the latest turns before older history is expanded", () => {
    const turn3User = userItem("turn-3");
    const turn3Tool = toolItem("read_file", "completed", "turn-3");
    const turn4User = userItem("turn-4");
    const items = [
      userItem("turn-1"),
      toolItem("read_file", "completed", "turn-1"),
      userItem("turn-2"),
      turn3User,
      turn3Tool,
      turn4User,
    ];

    expect(getVisibleTimelineItems(items, false, 2)).toEqual({
      visibleItems: [turn3User, turn3Tool, turn4User],
      hiddenTurnCount: 2,
    });
  });

  it("shows the full item stream after older history is expanded", () => {
    const items = [
      userItem("turn-1"),
      userItem("turn-2"),
      userItem("turn-3"),
      userItem("turn-4"),
    ];

    expect(getVisibleTimelineItems(items, true, 2)).toEqual({
      visibleItems: items,
      hiddenTurnCount: 0,
    });
  });

  it("sorts visible timeline items before choosing the recent turn window", () => {
    const turn1 = userItem("turn-1", "2026-01-01T00:00:01.000Z");
    const turn2 = userItem("turn-2", "2026-01-01T00:00:02.000Z");
    const turn3 = userItem("turn-3", "2026-01-01T00:00:03.000Z");

    expect(getVisibleTimelineItems([turn3, turn1, turn2], false, 2)).toEqual({
      visibleItems: [turn2, turn3],
      hiddenTurnCount: 1,
    });
  });

  it("normalizes invalid visible turn limits to at least one turn", () => {
    const turn2 = userItem("turn-2");
    const items = [userItem("turn-1"), turn2];

    expect(getVisibleTimelineItems(items, false, 0)).toEqual({
      visibleItems: [turn2],
      hiddenTurnCount: 1,
    });
    expect(getVisibleTimelineItems(items, false, Number.NaN)).toEqual({
      visibleItems: [turn2],
      hiddenTurnCount: 1,
    });
  });
});

function userItem(
  turnId: string,
  createdAt = "2026-01-01T00:00:00.000Z",
): Extract<Item, { kind: "user" }> {
  return {
    kind: "user",
    id: `${turnId}-user`,
    threadId: "thread-1",
    turnId,
    text: turnId,
    createdAt,
  };
}

function toolItem(
  name: string,
  status: ToolItem["status"],
  turnId = "turn-1",
): ToolItem {
  return {
    kind: "tool",
    id: `${turnId}-${name}-${status}`,
    threadId: "thread-1",
    turnId,
    toolCallId: `${name}-call`,
    name,
    args: {},
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
