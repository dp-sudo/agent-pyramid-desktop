import { describe, expect, it } from "vitest";
import type { Item } from "../../src/shared/agent-contracts";
import {
  getPendingApprovalsForThread,
  pendingApprovalSignature,
  shouldAutoScrollPendingApprovals,
} from "../../src/renderer/src/ui/components/chat/PendingApprovalPanel";

describe("PendingApprovalPanel helpers", () => {
  it("returns only unresolved approvals for the active thread", () => {
    const items: Item[] = [
      {
        kind: "approval",
        id: "approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "write_file",
        args: {},
        createdAt,
      },
      {
        kind: "approval",
        id: "approval-2",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-2",
        toolName: "run_command",
        args: {},
        decision: "allow",
        createdAt,
      },
      {
        kind: "approval",
        id: "approval-3",
        threadId: "thread-2",
        turnId: "turn-2",
        approvalId: "approval-3",
        toolName: "apply_patch",
        args: {},
        createdAt,
      },
    ];

    expect(getPendingApprovalsForThread(items, "thread-1").map((item) => item.id))
      .toEqual(["approval-1"]);
  });

  it("uses pending approval identity rather than count as the auto-scroll trigger", () => {
    const first = approvalItem("item-1", "approval-1");
    const replacement = approvalItem("item-2", "approval-2");

    expect(pendingApprovalSignature([first])).toBe("approval-1");
    expect(pendingApprovalSignature([replacement])).toBe("approval-2");
    expect(pendingApprovalSignature([first, replacement])).toBe("approval-1|approval-2");
  });

  it("only auto-scrolls when the setting is enabled and pending approvals exist", () => {
    expect(shouldAutoScrollPendingApprovals(true, "approval-1")).toBe(true);
    expect(shouldAutoScrollPendingApprovals(false, "approval-1")).toBe(false);
    expect(shouldAutoScrollPendingApprovals(true, "")).toBe(false);
  });
});

const createdAt = "2026-01-01T00:00:00.000Z";

function approvalItem(
  id: string,
  approvalId: string,
): Extract<Item, { kind: "approval" }> {
  return {
    kind: "approval",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    approvalId,
    toolName: "write_file",
    args: {},
    createdAt,
  };
}
