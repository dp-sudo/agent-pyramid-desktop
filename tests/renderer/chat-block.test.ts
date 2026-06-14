import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChatBlock,
  TOOL_DETAIL_PREVIEW_MAX_CHARS,
  approvalStatusText,
  canRespondToApproval,
  getReasoningCollapsedPreview,
  isReasoningOpenByDefault,
  isLongToolDetail,
  resolveToolDetailDisplay,
  resolveNextApprovalDiffOpenState,
  resolveNextReasoningOpenState,
  shouldRecordApprovalDiffToggle,
  shouldRecordReasoningToggle,
} from "../../src/renderer/src/ui/components/chat/ChatBlock";
import { WorkbenchProvider, INITIAL_STATE } from "../../src/renderer/src/ui/store/WorkbenchContext";
import type { Item } from "../../src/shared/agent-contracts";

// Code route is the default (defaultStartupView="code"); the write variant
// seeds the provider so tool blocks render the full card path.
function writeRouteState() {
  return { ...INITIAL_STATE, route: "write" as const };
}

describe("ChatBlock approval helpers", () => {
  it("previews long tool details without changing the full detail source", () => {
    const detail = `${"line\n".repeat(90)}tail`;

    expect(isLongToolDetail(detail, 10000, 80)).toBe(true);
    expect(resolveToolDetailDisplay("short", false, 100, 80)).toEqual({
      text: "short",
      truncated: false,
      hiddenCharCount: 0,
    });
    expect(resolveToolDetailDisplay("abcdef", false, 4, 80)).toEqual({
      text: "abcd",
      truncated: true,
      hiddenCharCount: 2,
    });
    expect(resolveToolDetailDisplay("abcdef", true, 4, 80)).toEqual({
      text: "abcdef",
      truncated: false,
      hiddenCharCount: 0,
    });
  });

  it("renders long tool details as a preview with an expand control", () => {
    const toolItem: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "read_file",
      args: {},
      result: {
        content: `${"A".repeat(TOOL_DETAIL_PREVIEW_MAX_CHARS + 20)}TAIL`,
      },
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: toolItem }),
      ),
    );

    expect(html).toContain("ds-process-entry-detail is-truncated");
    expect(html).toContain("chat.toolDetailTruncated");
    expect(html).toContain("chat.expandToolDetail");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("TAIL");
  });

  it("renders a compact tool row in code route", () => {
    const toolItem: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "read_file",
      args: { path: "src/foo.ts" },
      result: { content: "file body" },
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: toolItem }),
      ),
    );

    expect(html).toContain("ds-process-tool-row is-success");
    expect(html).toContain("chat.toolAction.read");
    expect(html).toContain("src/foo.ts");
    expect(html).not.toContain("ds-process-entry ds-process-tool");
  });

  it("renders a structured diff preview for completed coding tools", () => {
    const toolItem: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "edit_file",
      args: { path: "src/foo.ts" },
      result: {
        path: "src/foo.ts",
        sha256: "abc123",
        diff: {
          kind: "file_diff",
          path: "src/foo.ts",
          operation: "update",
          added: 1,
          removed: 1,
          lines: [
            { type: "context", text: "function demo() {" },
            { type: "removed", text: "  return oldValue;" },
            { type: "added", text: "  return newValue;" },
            { type: "context", text: "}" },
          ],
        },
      },
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: toolItem }),
      ),
    );

    expect(html).toContain("ds-tool-diff-preview");
    expect(html).toContain("src/foo.ts");
    expect(html).toContain("return oldValue");
    expect(html).toContain("return newValue");
    expect(html).toContain("+1 -1");
    expect(html).not.toContain("sha256");
  });

  it("renders the full tool card in write route", () => {
    const toolItem: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "read_file",
      args: { path: "src/foo.ts" },
      result: { content: "file body" },
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(WorkbenchProvider, {
        initialState: writeRouteState(),
        children: createElement(ChatBlock, { item: toolItem }),
      }),
    );

    expect(html).toContain("ds-process-entry ds-process-tool is-success");
    expect(html).toContain("chat.toolStatus.completed");
    expect(html).not.toContain("ds-process-tool-row");
  });

  it("renders a failed tool row with the danger label tone in code route", () => {
    const command = `find src -type d -name _tests_ ${"nested ".repeat(16)}`;
    const toolItem: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "run_command",
      args: { command },
      result: { content: "find: not found" },
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: toolItem }),
      ),
    );

    // Failed status maps to the danger tone on the row and the localized
    // "failed" label, so the row surfaces the live outcome without relying on
    // a whole-row red background.
    expect(html).toContain("ds-process-tool-row is-danger");
    expect(html).toContain("chat.toolAction.failed");
    // The row title is a short preview, while the expandable detail still
    // keeps the complete command args and result traceable.
    expect(html).toContain("chat.tools.failedCommandPreview");
    expect(html).toContain("find src -type d -name _tests_ nested nested");
    expect(html).toContain("&quot;command&quot;");
    expect(html).toContain("find: not found");
  });

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

  it("renders shared pending approval state as disabled submitting actions", () => {
    const approvalItem: Extract<Item, { kind: "approval" }> = {
      kind: "approval",
      id: "approval-item",
      threadId: "thread-1",
      turnId: "turn-1",
      approvalId: "approval-1",
      toolName: "write_file",
      args: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, {
          item: approvalItem,
          onApprove: async () => undefined,
          approvalPendingDecision: "allow",
        }),
      ),
    );

    expect(html).toContain("is-pending");
    expect(html).toContain("approvals.submitting");
    expect(html).toContain("disabled=\"\"");
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
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: reasoningItem, isLive: true, nested: true }),
      ),
    );

    expect(isReasoningOpenByDefault(true)).toBe(true);
    expect(isReasoningOpenByDefault(false)).toBe(false);
    expect(isReasoningOpenByDefault(false, true)).toBe(true);
    expect(isReasoningOpenByDefault(true, false)).toBe(true);
    expect(html).toContain("<details");
    expect(html).toContain("ds-process-reasoning-entry");
    expect(html).toContain("is-nested");
    expect(html).toContain("open=\"\"");
    expect(html).toContain("chat.reasoningLabel");
    // Live + open reasoning shows the rotating chevron affordance and the
    // active "thinking" indicator label.
    expect(html).toContain("ds-process-reasoning-chevron");
    expect(html).toContain("chat.thinking");
  });

  it("renders folded reasoning with a chevron but no thinking indicator or body", () => {
    const reasoningItem: Extract<Item, { kind: "reasoning" }> = {
      kind: "reasoning",
      id: "reasoning-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "Need to inspect files.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: reasoningItem, nested: true }),
      ),
    );

    // Chevron is present in both states; the thinking indicator and body are
    // absent once the live stream ends and the block collapses.
    expect(html).toContain("ds-process-reasoning-chevron");
    expect(html).not.toContain("ds-thinking-indicator");
    expect(html).not.toContain("ds-process-entry-detail ds-process-reasoning");
  });

  it("renders completed folded reasoning as a light preview without markdown body", () => {
    const reasoningItem: Extract<Item, { kind: "reasoning" }> = {
      kind: "reasoning",
      id: "reasoning-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "Need to inspect files.\n\n```ts\nconst expensive = true;\n```",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(ChatBlock, { item: reasoningItem, nested: true }),
      ),
    );

    expect(getReasoningCollapsedPreview(" one\n\n two ", 20)).toBe("one two");
    expect(getReasoningCollapsedPreview("abcdef", 3)).toBe("abc...");
    expect(html).toContain("ds-process-reasoning-preview");
    expect(html).toContain("Need to inspect files.");
    expect(html).not.toContain("ds-process-entry-detail ds-process-reasoning");
    expect(html).not.toContain("const expensive");
  });

  it("updates reasoning open state from live defaults until the user overrides it", () => {
    expect(
      resolveNextReasoningOpenState({
        currentOpen: true,
        defaultOpen: false,
        userControlled: false,
      }),
    ).toBe(false);
    expect(
      resolveNextReasoningOpenState({
        currentOpen: false,
        defaultOpen: true,
        userControlled: false,
      }),
    ).toBe(true);
    expect(
      resolveNextReasoningOpenState({
        currentOpen: true,
        defaultOpen: false,
        userControlled: true,
      }),
    ).toBe(true);
  });

  it("records only real user reasoning details toggles", () => {
    expect(
      shouldRecordReasoningToggle({
        currentOpen: true,
        nextOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldRecordReasoningToggle({
        currentOpen: true,
        nextOpen: false,
      }),
    ).toBe(true);
  });

  it("updates approval diff open state from defaults until the user overrides it", () => {
    expect(
      resolveNextApprovalDiffOpenState({
        currentOpen: true,
        defaultOpen: false,
        userControlled: false,
      }),
    ).toBe(false);
    expect(
      resolveNextApprovalDiffOpenState({
        currentOpen: false,
        defaultOpen: true,
        userControlled: false,
      }),
    ).toBe(true);
    expect(
      resolveNextApprovalDiffOpenState({
        currentOpen: true,
        defaultOpen: false,
        userControlled: true,
      }),
    ).toBe(true);
  });

  it("records only real user approval diff details toggles", () => {
    expect(
      shouldRecordApprovalDiffToggle({
        currentOpen: false,
        nextOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldRecordApprovalDiffToggle({
        currentOpen: false,
        nextOpen: true,
      }),
    ).toBe(true);
  });
});
