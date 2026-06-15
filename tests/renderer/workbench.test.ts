import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../src/shared/ipc-errors";
import {
  beginPendingApprovalResponse,
  clearResolvedApprovalResponses,
  copyWorkbenchErrorMessage,
  shouldShowWorkbenchErrorToast,
  WORKBENCH_DISMISS_BUTTON_TEXT,
} from "../../src/renderer/src/ui/Workbench";
import {
  clampLeftSidebarWidth as clampSidebarWidth,
  getNextLeftSidebarWidth as getNextSidebarWidth,
  getResetLeftSidebarWidth as getResetSidebarWidth,
  getSidebarDividerClassName as getWorkbenchDividerClassName,
} from "../../src/renderer/src/ui/sidebar-resize-model";
import { explicitComposerModelProfileId } from "../../src/renderer/src/ui/store/composer-model-model";
import {
  applyWorkbenchRuntimeEvent,
  isGlobalRuntimeErrorEvent,
  shouldBufferLiveTextItemUpdate,
  shouldFlushBufferedItemUpdatesBeforeEvent,
} from "../../src/renderer/src/ui/workbench-runtime-events";
import {
  filterThreadsForWorkbench,
  findLatestThreadForWorkspace,
  isThreadMutationBusyError,
  shouldUnsubscribeRemovedThread,
  threadMutationBusyMessageKey,
  workbenchThreadModeForRoute,
} from "../../src/renderer/src/ui/workbench-thread-model";
import {
  formatInitialLoadErrors,
  messageOfWorkbenchError,
  runWorkbenchIpc,
} from "../../src/renderer/src/ui/workbench-ipc";
import {
  buildWorkbenchThreadTitle,
  buildComposerSendPayload,
  normalizeWriteAssistantSendPayload,
} from "../../src/renderer/src/ui/workbench-composer-payload";
import type {
  AssistantItem,
  Item,
  ThreadRecord,
  TurnRecord,
} from "../../src/shared/agent-contracts";

describe("Workbench", () => {
  it("formats initial load IPC errors instead of silently ignoring them", () => {
    expect(
      formatInitialLoadErrors([
        ok([]),
        err(IPC_ERROR_CODES.MODEL_CONFIG_GET_FAILED, "Could not load model config."),
        err(IPC_ERROR_CODES.MODEL_CONFIG_PROFILES_LIST_FAILED, "Could not load model profiles."),
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
      err(IPC_ERROR_CODES.RENDERER_IPC_REJECTED, "threads channel unavailable"),
    );
    await expect(
      runWorkbenchIpc(() => {
        throw "preload bridge unavailable";
      }),
    ).resolves.toEqual(
      err(IPC_ERROR_CODES.RENDERER_IPC_REJECTED, "preload bridge unavailable"),
    );
    expect(messageOfWorkbenchError(new Error("runtime failed"))).toBe("runtime failed");
  });

  it("keeps only one in-flight approval response per approval id", () => {
    const first = beginPendingApprovalResponse(
      {},
      "approval-1",
      { decision: "allow", scope: "session" },
    );

    expect(first).toEqual({ "approval-1": { decision: "allow", scope: "session" } });
    expect(beginPendingApprovalResponse(
      first ?? {},
      "approval-1",
      { decision: "deny" },
    )).toBeNull();
    expect(beginPendingApprovalResponse(
      first ?? {},
      "approval-2",
      { decision: "deny" },
    )).toEqual({
      "approval-1": { decision: "allow", scope: "session" },
      "approval-2": { decision: "deny" },
    });
  });

  it("clears pending approval responses only after resolved approval items arrive", () => {
    const pending = {
      "approval-1": { decision: "allow" as const, scope: "once" as const },
      "approval-2": { decision: "deny" as const },
    };
    const unresolved = approvalItem("item-1", "approval-1");
    const resolved: Extract<Item, { kind: "approval" }> = {
      ...approvalItem("item-2", "approval-2"),
      decision: "deny",
      resolvedAt: "2026-01-01T00:00:01.000Z",
    };

    expect(clearResolvedApprovalResponses(pending, [unresolved])).toBe(pending);
    expect(clearResolvedApprovalResponses(pending, [unresolved, resolved])).toEqual({
      "approval-1": { decision: "allow", scope: "once" },
    });
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

  it("resets the sidebar separator to the default width on double click", () => {
    expect(getResetSidebarWidth()).toBe(268);
  });

  it("marks the sidebar separator while pointer resizing is active", () => {
    expect(getWorkbenchDividerClassName(false)).toBe("ds-workbench-divider");
    expect(getWorkbenchDividerClassName(true)).toBe("ds-workbench-divider is-dragging");
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
      attachmentIds: [],
      mode: "agent",
      goalMode: false,
    });
    expect(normalizeWriteAssistantSendPayload({
      text: "internal prompt",
      displayText: "",
      threadTitle: "title",
    })).toBeNull();
  });

  it("keeps generated thread titles within the Workbench title limit", () => {
    const exactTitle = "a".repeat(60);
    const longTitle = "a".repeat(61);

    expect(buildWorkbenchThreadTitle("Short title")).toBe("Short title");
    expect(buildWorkbenchThreadTitle(exactTitle)).toBe(exactTitle);
    expect(buildWorkbenchThreadTitle(longTitle)).toBe(`${"a".repeat(57)}...`);
  });

  it("shows the shared Workbench error toast only when an error is present", () => {
    expect(shouldShowWorkbenchErrorToast(null)).toBe(false);
    expect(shouldShowWorkbenchErrorToast("Runtime failed")).toBe(true);
    expect(shouldShowWorkbenchErrorToast("Runtime failed", false)).toBe(false);
    expect(WORKBENCH_DISMISS_BUTTON_TEXT).toBe("x");
  });

  it("copies Workbench error toast text through the clipboard boundary", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    await expect(copyWorkbenchErrorMessage("Runtime failed", writeText)).resolves.toEqual({
      ok: true,
    });
    expect(writeText).toHaveBeenCalledWith("Runtime failed");
  });

  it("reports Workbench error toast copy failures without throwing", async () => {
    await expect(copyWorkbenchErrorMessage("", vi.fn())).resolves.toEqual({
      ok: false,
      reason: "empty",
    });

    await expect(copyWorkbenchErrorMessage("Runtime failed", undefined)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    const error = new Error("clipboard denied");
    await expect(
      copyWorkbenchErrorMessage(
        "Runtime failed",
        vi.fn<(text: string) => Promise<void>>().mockRejectedValue(error),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "failed",
      error,
    });
  });

  it("cleans up only threads with retained SSE subscriptions", () => {
    const subscribed = new Set(["thread-1", "thread-2"]);

    expect(shouldUnsubscribeRemovedThread(subscribed, "thread-1")).toBe(true);
    expect(shouldUnsubscribeRemovedThread(subscribed, "thread-3")).toBe(false);
  });

  it("maps thread mutation busy states to shared error codes and message keys", () => {
    expect(threadMutationBusyMessageKey("delete")).toBe("threads.deleteBlockedRunning");
    expect(threadMutationBusyMessageKey("archive")).toBe("threads.archiveBlockedRunning");
    expect(isThreadMutationBusyError("delete", IPC_ERROR_CODES.THREAD_DELETE_BUSY))
      .toBe(true);
    expect(isThreadMutationBusyError("delete", IPC_ERROR_CODES.THREAD_ARCHIVE_BUSY))
      .toBe(false);
    expect(isThreadMutationBusyError("archive", IPC_ERROR_CODES.THREAD_ARCHIVE_BUSY))
      .toBe(true);
    expect(isThreadMutationBusyError("archive", IPC_ERROR_CODES.THREAD_DELETE_BUSY))
      .toBe(false);
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

  it("buffers only active live assistant and reasoning item updates", () => {
    const assistant: AssistantItem = {
      kind: "assistant",
      id: "assistant-1",
      threadId: "active-thread",
      turnId: "turn-1",
      text: "live",
      createdAt: "2026-06-09T00:00:00.000Z",
    };
    const reasoning: Extract<Item, { kind: "reasoning" }> = {
      kind: "reasoning",
      id: "reasoning-1",
      threadId: "active-thread",
      turnId: "turn-1",
      text: "thinking",
      createdAt: "2026-06-09T00:00:00.000Z",
    };
    const tool: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      threadId: "active-thread",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "run_command",
      args: {},
      status: "running",
      createdAt: "2026-06-09T00:00:00.000Z",
    };

    expect(shouldBufferLiveTextItemUpdate({
      kind: "item_updated",
      threadId: "active-thread",
      turnId: "turn-1",
      item: assistant,
    }, "active-thread")).toBe(true);
    expect(shouldBufferLiveTextItemUpdate({
      kind: "item_updated",
      threadId: "active-thread",
      turnId: "turn-1",
      item: reasoning,
    }, "active-thread")).toBe(true);
    expect(shouldBufferLiveTextItemUpdate({
      kind: "item_updated",
      threadId: "background-thread",
      turnId: "turn-1",
      item: { ...assistant, threadId: "background-thread" },
    }, "active-thread")).toBe(false);
    expect(shouldBufferLiveTextItemUpdate({
      kind: "item_updated",
      threadId: "active-thread",
      turnId: "turn-1",
      item: tool,
    }, "active-thread")).toBe(false);
  });

  it("flushes buffered text updates before terminal turn events only", () => {
    const turn = makeTurnRecord();

    expect(shouldFlushBufferedItemUpdatesBeforeEvent({
      kind: "turn_completed",
      threadId: turn.threadId,
      turnId: turn.id,
      status: "completed",
      completedAt: "2026-06-09T00:01:00.000Z",
    })).toBe(true);
    expect(shouldFlushBufferedItemUpdatesBeforeEvent({
      kind: "turn_failed",
      threadId: turn.threadId,
      turnId: turn.id,
      message: "failed",
      failedAt: "2026-06-09T00:01:00.000Z",
    })).toBe(true);
    expect(shouldFlushBufferedItemUpdatesBeforeEvent({
      kind: "turn_started",
      threadId: turn.threadId,
      turnId: turn.id,
      startedAt: turn.startedAt,
      turn,
    })).toBe(false);
  });

  it("derives new thread mode from the active workbench route", () => {
    expect(workbenchThreadModeForRoute("code")).toBe("code");
    expect(workbenchThreadModeForRoute("write")).toBe("write");
    expect(workbenchThreadModeForRoute("settings")).toBe("code");
  });

  it("only sends a model profile id after an explicit composer model selection", () => {
    expect(explicitComposerModelProfileId({
      text: "",
      model: "active-model",
      modelProfileSelection: "auto",
      reasoningEffort: "medium",
      mode: "agent",
      goalMode: false,
      attachmentIds: [],
      attachments: [],
    })).toBeUndefined();
    expect(explicitComposerModelProfileId({
      text: "",
      model: "active-model",
      modelProfileId: "active-profile",
      modelProfileSelection: "auto",
      reasoningEffort: "medium",
      mode: "agent",
      goalMode: false,
      attachmentIds: [],
      attachments: [],
    })).toBeUndefined();
    expect(explicitComposerModelProfileId({
      text: "",
      model: "selected-model",
      modelProfileId: "selected-profile",
      modelProfileSelection: "explicit",
      reasoningEffort: "medium",
      mode: "agent",
      goalMode: false,
      attachmentIds: [],
      attachments: [],
    })).toBe("selected-profile");
  });

  it("resolves Code MCP input before creating a new thread", () => {
    const source = readFileSync(
      new URL("../../src/renderer/src/ui/Workbench.tsx", import.meta.url),
      "utf8",
    );
    const sendStart = source.indexOf("const sendCodeComposerPayload");
    const sendEnd = source.indexOf("const sendWriteComposerPayload", sendStart);
    const sendCodeSource = source.slice(sendStart, sendEnd);

    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(sendEnd).toBeGreaterThan(sendStart);
    expect(sendCodeSource.indexOf("resolveCodeMcpInputReferences(sendPayload, t)"))
      .toBeGreaterThanOrEqual(0);
    expect(sendCodeSource.indexOf("resolveCodeMcpInputReferences(sendPayload, t)"))
      .toBeLessThan(sendCodeSource.indexOf("window.agentApi.threads.create"));
  });

  it("passes approval response scope through the preload approval IPC payload", () => {
    const source = readFileSync(
      new URL("../../src/renderer/src/ui/Workbench.tsx", import.meta.url),
      "utf8",
    );
    const approveStart = source.indexOf("const onApprove = useCallback");
    const approveEnd = source.indexOf("const onOpenSettings", approveStart);
    const approveSource = source.slice(approveStart, approveEnd);

    expect(approveStart).toBeGreaterThanOrEqual(0);
    expect(approveEnd).toBeGreaterThan(approveStart);
    expect(approveSource).toContain("decision: response.decision");
    expect(approveSource).toContain("scope: response.scope");
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

  it("routes active tool progress events into the active timeline only", () => {
    const actions = makeRuntimeEventActions();

    applyWorkbenchRuntimeEvent(
      {
        kind: "tool_progress",
        threadId: "active-thread",
        turnId: "turn-1",
        toolCallId: "call-1",
        chunk: "running\n",
        stream: "stdout",
        seq: 1,
      },
      {
        activeThread: makeThreadRecord({ id: "active-thread" }),
        activeThreadId: "active-thread",
      },
      actions,
    );
    applyWorkbenchRuntimeEvent(
      {
        kind: "tool_progress",
        threadId: "background-thread",
        turnId: "turn-1",
        toolCallId: "call-2",
        chunk: "background\n",
        stream: "stderr",
        seq: 1,
      },
      {
        activeThread: makeThreadRecord({ id: "active-thread" }),
        activeThreadId: "active-thread",
      },
      actions,
    );

    expect(actions.appendToolProgress).toHaveBeenCalledOnce();
    expect(actions.appendToolProgress).toHaveBeenCalledWith({
      threadId: "active-thread",
      turnId: "turn-1",
      toolCallId: "call-1",
      seq: 1,
      stdout: "running\n",
    });
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
    appendToolProgress: vi.fn(),
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
    createdAt: "2026-01-01T00:00:00.000Z",
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
