import { describe, expect, it } from "vitest";
import {
  approvalStatusText,
  canRespondToApproval,
} from "../../src/renderer/src/ui/components/chat/ChatBlock";

describe("ChatBlock approval helpers", () => {
  it("allows approval response only before a decision and without a pending submission", () => {
    expect(canRespondToApproval(undefined, null, true)).toBe(true);
    expect(canRespondToApproval("allow", null, true)).toBe(false);
    expect(canRespondToApproval(undefined, "deny", true)).toBe(false);
    expect(canRespondToApproval(undefined, null, false)).toBe(false);
  });

  it("formats approval status from pending or final decisions", () => {
    const t = (key: string): string => key;

    expect(approvalStatusText(undefined, "allow", t)).toBe("approvals.submitting");
    expect(approvalStatusText("deny", null, t)).toBe("approvals.deny");
    expect(approvalStatusText(undefined, null, t)).toBe("");
  });
});
