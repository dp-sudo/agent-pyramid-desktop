import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChatBlock,
  approvalStatusText,
  canRespondToApproval,
  isReasoningOpenByDefault,
} from "../../src/renderer/src/ui/components/chat/ChatBlock";
import type { Item } from "../../src/shared/agent-contracts";

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

  it("renders reasoning as a collapsible process entry that opens while live", () => {
    const reasoningItem: Extract<Item, { kind: "reasoning" }> = {
      kind: "reasoning",
      id: "reasoning-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "Need to inspect files.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(ChatBlock, { item: reasoningItem, isLive: true, nested: true }),
    );

    expect(isReasoningOpenByDefault(true)).toBe(true);
    expect(isReasoningOpenByDefault(false)).toBe(false);
    expect(html).toContain("<details");
    expect(html).toContain("ds-process-reasoning-entry");
    expect(html).toContain("is-nested");
    expect(html).toContain("open=\"\"");
    expect(html).toContain("chat.reasoningLabel");
  });
});
