import { describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/shared/agent-contracts";
import {
  applyWorkbenchRuntimeEvent,
  buildComposerSendPayload,
  clampSidebarWidth,
  filterThreadsForWorkbench,
  findLatestThreadForWorkspace,
  formatInitialLoadErrors,
  getNextSidebarWidth,
  isGlobalRuntimeErrorEvent,
  messageOfWorkbenchError,
  normalizeWriteAssistantSendPayload,
  runWorkbenchIpc,
  shouldShowWorkbenchErrorToast,
  shouldUnsubscribeRemovedThread,
  WORKBENCH_DISMISS_BUTTON_TEXT,
  workbenchThreadModeForRoute,
} from "../../src/renderer/src/ui/Workbench";
import type {
  AssistantItem,
  ThreadRecord,
  TurnRecord,
} from "../../src/shared/agent-contracts";

describe("Workbench", () => {
  it("formats initial load IPC errors instead of silently ignoring them", () => {
    expect(
      formatInitialLoadErrors([
        ok([]),
        err("CONFIG_FAILED", "Could not load model config."),
        err("PROFILES_FAILED", "Could not load model profiles."),
      ]),
    ).toBe("Could not load model config.\nCould not load model profiles.");
  });

  it("does not report an initial load error when all IPC requests succeed", () => {
    expect(formatInitialLoadErrors([ok([]), ok({}), ok({})])).toBeNull();
  });

  it("keeps rejected Workbench IPC calls visible through IpcResult errors", async () => {
    await expect(
      runWorkbenchIpc(() => Promise.reject(new Error("threads channel unavailable"))),
    ).resolves.toEqual(
      err("RENDERER_IPC_REJECTED", "threads channel unavailable"),
    );
    await expect(
      runWorkbenchIpc(() => {
        throw "preload bridge unavailable";
      }),
    ).resolves.toEqual(
      err("RENDERER_IPC_REJECTED", "preload bridge unavailable"),
    );
    expect(messageOfWorkbenchError(new Error("runtime failed"))).toBe("runtime failed");
  });

  it("keeps sidebar width inside the supported drag range", () => {
    expect(clampSidebarWidth(120)).toBe(180);
    expect(clampSidebarWidth(260)).toBe(260);
    expect(clampSidebarWidth(520)).toBe(420);
  });

  it("maps separator keyboard controls to sidebar widths", () => {
    expect(getNextSidebarWidth(260, "ArrowLeft")).toBe(244);
    expect(getNextSidebarWidth(260, "ArrowRight")).toBe(276);
    expect(getNextSidebarWidth(260, "Home")).toBe(180);
    expect(getNextSidebarWidth(260, "End")).toBe(420);
    expect(getNextSidebarWidth(260, "Enter")).toBe(260);
  });

  it("builds no send payload for an empty composer with no attachments", () => {
    expect(buildComposerSendPayload("   ", 0, testT)).toBeNull();
  });

  it("builds a trimmed text payload when the composer has text", () => {
    expect(buildComposerSendPayload("  Explain this  ", 1, testT)).toEqual({
      text: "Explain this",
      threadTitle: "Explain this",
    });
  });

  it("builds an attachment-only payload with visible text", () => {
    expect(buildComposerSendPayload("   ", 2, testT)).toEqual({
      text: "Analyze attached images",
      displayText: "Analyze attached images",
      threadTitle: "Analyze attached images",
    });
  });

  it("normalizes write assistant payloads without accepting empty fields", () => {
    expect(normalizeWriteAssistantSendPayload({
      text: "  internal prompt  ",
      displayText: "  visible prompt  ",
      threadTitle: "  title  ",
    })).toEqual({
      text: "internal prompt",
      displayText: "visible prompt",
      threadTitle: "title",
    });
    expect(normalizeWriteAssistantSendPayload({
      text: "internal prompt",
      displayText: "",
      threadTitle: "title",
    })).toBeNull();
  });

  it("shows the shared Workbench error toast only when an error is present", () => {
    expect(shouldShowWorkbenchErrorToast(null)).toBe(false);
    expect(shouldShowWorkbenchErrorToast("Runtime failed")).toBe(true);
    expect(shouldShowWorkbenchErrorToast("Runtime failed", false)).toBe(false);
    expect(WORKBENCH_DISMISS_BUTTON_TEXT).toBe("x");
  });

  it("cleans up only threads with retained SSE subscriptions", () => {
    const subscribed = new Set(["thread-1", "thread-2"]);

    expect(shouldUnsubscribeRemovedThread(subscribed, "thread-1")).toBe(true);
    expect(shouldUnsubscribeRemovedThread(subscribed, "thread-3")).toBe(false);
  });

  it("identifies runtime errors that are not scoped to a subscribed thread", () => {
    expect(
      isGlobalRuntimeErrorEvent({
        kind: "runtime_error",
        code: "internal",
        message: "Global failure",
      }),
    ).toBe(true);

    expect(
      isGlobalRuntimeErrorEvent({
        kind: "runtime_error",
        threadId: "thread-1",
        code: "internal",
        message: "Thread failure",
      }),
    ).toBe(false);
  });

  it("derives new thread mode from the active workbench route", () => {
    expect(workbenchThreadModeForRoute("code")).toBe("code");
    expect(workbenchThreadModeForRoute("write")).toBe("write");
    expect(workbenchThreadModeForRoute("settings")).toBe("code");
  });

  it("prefers the latest active thread that matches workspace and route mode", () => {
    const threads = [
      makeThreadSummary("write-older", "/workspace", "write", "2026-06-08T07:00:00.000Z"),
      makeThreadSummary("code-1", "/workspace", "code", "2026-06-08T08:00:00.000Z"),
      makeThreadSummary("write-1", "/workspace", "write", "2026-06-08T09:00:00.000Z"),
      makeThreadSummary("write-archived", "/workspace", "write", "2026-06-08T10:00:00.000Z", "archived"),
      makeThreadSummary("write-other", "/other", "write", "2026-06-08T11:00:00.000Z"),
    ];

    expect(findLatestThreadForWorkspace(threads, "/workspace", "write")?.id).toBe("write-1");
    expect(findLatestThreadForWorkspace(threads, "/workspace", "code")?.id).toBe("code-1");
    expect(findLatestThreadForWorkspace(threads, "/missing", "write")).toBeNull();
  });

  it("applies subscribed thread lifecycle events when no thread is active", () => {
    const actions = makeRuntimeEventActions();
    const turn = makeTurnRecord({ threadId: "background-thread" });

    applyWorkbenchRuntimeEvent(
      {
        kind: "turn_started",
        threadId: turn.threadId,
        turnId: turn.id,
        startedAt: turn.startedAt,
        turn,
      },
      { activeThread: null, activeThreadId: null },
      actions,
    );
    applyWorkbenchRuntimeEvent(
      {
        kind: "turn_completed",
        threadId: turn.threadId,
        turnId: turn.id,
        status: "completed",
        completedAt: "2026-06-09T00:01:00.000Z",
      },
      { activeThread: null, activeThreadId: null },
      actions,
    );

    expect(actions.turnStarted).toHaveBeenCalledWith(turn);
    expect(actions.turnEnded).toHaveBeenCalledWith("background-thread", "completed");
  });

  it("keeps subscribed background items out of the active timeline", () => {
    const actions = makeRuntimeEventActions();
    const item: AssistantItem = {
      kind: "assistant",
      id: "assistant-1",
      threadId: "background-thread",
      turnId: "turn-1",
      text: "background",
      createdAt: "2026-06-09T00:00:00.000Z",
    };

    applyWorkbenchRuntimeEvent(
      {
        kind: "item_appended",
        threadId: "background-thread",
        turnId: "turn-1",
        item,
      },
      {
        activeThread: makeThreadRecord({ id: "active-thread" }),
        activeThreadId: "active-thread",
      },
      actions,
    );

    expect(actions.appendItem).not.toHaveBeenCalled();
  });

  it("keeps Code sidebar thread lists limited to Code threads", () => {
    const threads = [
      makeThreadSummary("code-1", "/workspace", "code", "2026-06-08T08:00:00.000Z"),
      makeThreadSummary("write-1", "/workspace", "write", "2026-06-08T09:00:00.000Z"),
    ];

    expect(filterThreadsForWorkbench(threads, "code").map((thread) => thread.id))
      .toEqual(["code-1"]);
    expect(filterThreadsForWorkbench(threads, "write").map((thread) => thread.id))
      .toEqual(["write-1"]);
  });
});

function makeRuntimeEventActions() {
  return {
    appendItem: vi.fn(),
    setError: vi.fn(),
    turnEnded: vi.fn(),
    turnStarted: vi.fn(),
    updateActiveThread: vi.fn(),
    updateItem: vi.fn(),
  };
}

function makeTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "in-flight",
    startedAt: "2026-06-09T00:00:00.000Z",
    model: "MiniMax-M3",
    mode: "agent",
    ...overrides,
  };
}

function makeThreadRecord(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: "Thread",
    workspace: "/workspace",
    mode: "code",
    status: "active",
    relation: "primary",
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    ...overrides,
  };
}

function makeThreadSummary(
  id: string,
  workspace: string,
  mode: "code" | "write",
  updatedAt: string,
  status: "active" | "archived" = "active",
) {
  return {
    id,
    title: id,
    workspace,
    status,
    relation: "primary" as const,
    mode,
    updatedAt,
  };
}

function testT(key: string): string {
  if (key === "composer.attachmentOnlyMessageSingle") {
    return "Analyze attached image";
  }
  if (key === "composer.attachmentOnlyMessageMultiple") {
    return "Analyze attached images";
  }
  return key;
}
