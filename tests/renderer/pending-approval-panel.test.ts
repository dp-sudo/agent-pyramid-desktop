import { describe, expect, it } from "vitest";
import type { Item } from "../../src/shared/agent-contracts";
import { getPendingApprovalsForThread } from "../../src/renderer/src/ui/components/chat/PendingApprovalPanel";

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
});

const createdAt = "2026-01-01T00:00:00.000Z";
