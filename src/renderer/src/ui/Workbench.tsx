import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  getThreadInFlightTurn,
  useWorkbench,
  type WorkbenchRoute,
} from "./store/WorkbenchContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkbenchTopBar } from "./components/topbar/WorkbenchTopBar";
import { FloatingComposer } from "./components/composer/FloatingComposer";
import { MessageTimeline } from "./components/chat/MessageTimeline";
import { PendingApprovalPanel } from "./components/chat/PendingApprovalPanel";
import { RightInspector } from "./components/inspector/RightInspector";
import {
  WriteWorkspaceView,
  type WriteAssistantPromptPayload,
} from "./components/write/WriteWorkspaceView";
import {
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "./preferences";
import type {
  IpcResult,
  RuntimeErrorEvent,
  ThreadRecord,
  ThreadSummary,
} from "../../../shared/agent-contracts";

const SIDEBAR_KEYBOARD_STEP = 16;

export function Workbench(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const workspaceRootRef = useRef<string>(state.workspaceRoot);
  const selectThreadRequestRef = useRef(0);
  const sendInProgressRef = useRef(false);
  const subscribedThreadIdsRef = useRef(new Set<string>());
  const activeThreadArchived = state.activeThread?.status === "archived";
  const activeThreadInFlightTurn = getActiveThreadInFlightTurn(state);
  const codeThreads = filterThreadsForWorkbench(state.threads, "code");

  useEffect(() => {
    activeThreadIdRef.current = state.activeThreadId;
  }, [state.activeThreadId]);

  useEffect(() => {
    workspaceRootRef.current = state.workspaceRoot;
  }, [state.workspaceRoot]);

  // Load thread list on mount.
  useEffect(() => {
    if (!window.agentApi) {
      actions.setError("Preload script not loaded — check the Electron main process logs.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const [threadsResult, configResult, profilesResult] = await Promise.all([
        window.agentApi.threads.list({
          includeArchived: state.showArchivedThreads,
        }),
        window.agentApi.modelConfig.get(),
        window.agentApi.modelConfig.listProfiles(),
      ]);
      if (cancelled) return;
      if (threadsResult.ok) actions.setThreads(threadsResult.value);
      if (configResult.ok) actions.setModelConfig(configResult.value);
      if (profilesResult.ok) actions.setModelProfiles(profilesResult.value);
      const initialLoadError = formatInitialLoadErrors([
        threadsResult,
        configResult,
        profilesResult,
      ]);
      if (initialLoadError) {
        actions.setError(initialLoadError);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, state.showArchivedThreads]);

  const handleRuntimeEvent = useCallback(
    (event: Parameters<typeof window.agentApi.sse.onEvent>[0] extends (
      event: infer E,
    ) => void
      ? E
      : never): void => {
      const threadId = activeThreadIdRef.current;
      if (event.kind === "runtime_error") {
        if (isGlobalRuntimeErrorEvent(event) || event.threadId === threadId) {
          actions.setError(event.message);
        }
        return;
      }
      if (!threadId || !("threadId" in event)) return;
      const isActiveThreadEvent = event.threadId === threadId;
      if (event.kind === "turn_started") {
        actions.turnStarted(event.turn);
      } else if (event.kind === "item_appended" && isActiveThreadEvent) {
        actions.appendItem(event.item);
      } else if (event.kind === "item_updated" && isActiveThreadEvent) {
        actions.updateItem(event.item);
      } else if (event.kind === "turn_completed") {
        actions.turnEnded(event.threadId, event.status);
      } else if (event.kind === "tool_budget_reached") {
        // The timeline receives the persisted warning item; continuation status is not a UI error.
      } else if (event.kind === "turn_failed") {
        actions.turnEnded(event.threadId, "failed");
        if (isActiveThreadEvent) actions.setError(event.message);
      } else if (
        event.kind === "goal_updated" &&
        state.activeThread &&
        event.threadId === state.activeThread.id
      ) {
        actions.updateActiveThread({
          ...state.activeThread,
          ...(event.goal ? { goal: event.goal } : { goal: undefined }),
        });
      }
    },
    [actions, state.activeThread],
  );

  useEffect(() => {
    if (!window.agentApi) return;
    return window.agentApi.sse.onEvent(handleRuntimeEvent);
  }, [handleRuntimeEvent]);

  const refreshThreads = useCallback(async () => {
    const result = await window.agentApi.threads.list({
      includeArchived: state.showArchivedThreads,
    });
    if (result.ok) {
      actions.setThreads(result.value);
    } else {
      actions.setError(result.message);
    }
  }, [actions, state.showArchivedThreads]);

  const subscribeThreadEvents = useCallback(
    async (threadId: string): Promise<boolean> => {
      if (subscribedThreadIdsRef.current.has(threadId)) return true;
      const result = await window.agentApi.sse.subscribe({ threadId });
      if (result.ok) {
        subscribedThreadIdsRef.current.add(threadId);
        return true;
      }
      actions.setError(result.message);
      return false;
    },
    [actions],
  );

  const unsubscribeThreadEvents = useCallback(
    async (threadId: string): Promise<boolean> => {
      if (!shouldUnsubscribeRemovedThread(subscribedThreadIdsRef.current, threadId)) {
        return true;
      }
      const result = await window.agentApi.sse.unsubscribe({ threadId });
      if (!result.ok && result.code !== "SSE_NOT_SUBSCRIBED") {
        actions.setError(result.message);
        subscribedThreadIdsRef.current.delete(threadId);
        return false;
      }
      subscribedThreadIdsRef.current.delete(threadId);
      return true;
    },
    [actions],
  );

  // Keep thread subscriptions alive after switching so background turns can
  // complete, fail, or request approval without leaving renderer state stale.
  useEffect(() => {
    if (!state.activeThreadId) return;
    void subscribeThreadEvents(state.activeThreadId);
  }, [state.activeThreadId, subscribeThreadEvents]);

  const ensureWorkspaceRoot = useCallback(async (): Promise<string | null> => {
    const current = workspaceRootRef.current.trim();
    if (current) return current;

    const result = await window.agentApi.workspace.pickDirectory();
    if (!result.ok) {
      actions.setError(result.message);
      return null;
    }
    if (result.value.canceled || !result.value.path) {
      return null;
    }
    workspaceRootRef.current = result.value.path;
    actions.setWorkspaceRoot(result.value.path);
    actions.setError(null);
    return result.value.path;
  }, [actions]);

  const onSelectThread = useCallback(
    async (id: string) => {
      const requestId = selectThreadRequestRef.current + 1;
      selectThreadRequestRef.current = requestId;
      actions.setError(null);
      const threadResult = await window.agentApi.threads.get(id);
      if (requestId !== selectThreadRequestRef.current) return;
      if (!threadResult.ok) {
        actions.setError(threadResult.message);
        return;
      }
      const itemsResult = await window.agentApi.turns.get(id);
      if (requestId !== selectThreadRequestRef.current) return;
      if (!itemsResult.ok) {
        actions.setError(itemsResult.message);
        return;
      }
      const items = itemsResult.ok ? itemsResult.value.items : [];
      actions.selectThread(threadResult.value, items);
    },
    [actions],
  );

  const selectThreadById = useCallback(
    async (id: string): Promise<void> => {
      await onSelectThread(id);
    },
    [onSelectThread],
  );

  const selectOrCreateThreadForWorkspace = useCallback(
    async (workspace: string, mode: ThreadRecord["mode"]): Promise<boolean> => {
      const threadsResult = await window.agentApi.threads.list({
        includeArchived: state.showArchivedThreads,
      });
      if (!threadsResult.ok) {
        actions.setError(threadsResult.message);
        return false;
      }

      actions.setThreads(threadsResult.value);
      const latestForWorkspace = findLatestThreadForWorkspace(
        threadsResult.value,
        workspace,
        mode,
      );
      if (latestForWorkspace) {
        await selectThreadById(latestForWorkspace.id);
        return true;
      }

      const created = await window.agentApi.threads.create({
        title: "New thread",
        workspace,
        mode,
      });
      if (!created.ok) {
        actions.setError(created.message);
        return false;
      }
      activeThreadIdRef.current = created.value.id;
      if (!await subscribeThreadEvents(created.value.id)) return false;
      actions.selectThread(created.value, []);
      void refreshThreads();
      return true;
    },
    [
      actions,
      refreshThreads,
      selectThreadById,
      state.showArchivedThreads,
      subscribeThreadEvents,
    ],
  );

  const onPickWorkspace = useCallback(async () => {
    const result = await window.agentApi.workspace.pickDirectory();
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    if (result.value.canceled || !result.value.path) return;

    const workspace = result.value.path;
    workspaceRootRef.current = workspace;
    actions.setWorkspaceRoot(workspace);
    actions.setError(null);

    const mode = workbenchThreadModeForRoute(state.route);
    await selectOrCreateThreadForWorkspace(workspace, mode);
  }, [actions, selectOrCreateThreadForWorkspace, state.route]);

  const onNewChat = useCallback(async () => {
    const workspace = await ensureWorkspaceRoot();
    if (!workspace) return;
    const result = await window.agentApi.threads.create({
      title: "New thread",
      workspace,
      mode: "code",
    });
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    activeThreadIdRef.current = result.value.id;
    if (!await subscribeThreadEvents(result.value.id)) return;
    actions.selectThread(result.value, []);
    actions.setError(null);
    void refreshThreads();
  }, [actions, ensureWorkspaceRoot, refreshThreads, subscribeThreadEvents]);

  const onDeleteThread = useCallback(
    async (id: string) => {
      if (getThreadInFlightTurn(state, id)) {
        actions.setError(t("threads.deleteBlockedRunning"));
        return;
      }

      const result = await window.agentApi.threads.delete(id);
      if (!result.ok) {
        actions.setError(
          result.code === "THREAD_DELETE_BUSY"
            ? t("threads.deleteBlockedRunning")
            : result.message,
        );
        return;
      }

      const wasActiveThread = state.activeThreadId === id;
      if (wasActiveThread) {
        activeThreadIdRef.current = null;
      }
      const unsubscribed = await unsubscribeThreadEvents(id);
      actions.removeThread(id);
      if (unsubscribed) actions.setError(null);
      await refreshThreads();
    },
    [actions, refreshThreads, state, t, unsubscribeThreadEvents],
  );

  const onArchiveThread = useCallback(
    async (id: string) => {
      if (getThreadInFlightTurn(state, id)) {
        actions.setError(t("threads.archiveBlockedRunning"));
        return;
      }

      const result = await window.agentApi.threads.update(id, { status: "archived" });
      if (!result.ok) {
        actions.setError(
          result.code === "THREAD_ARCHIVE_BUSY"
            ? t("threads.archiveBlockedRunning")
            : result.message,
        );
        return;
      }

      const wasActiveThread = state.activeThreadId === id;
      if (wasActiveThread) {
        activeThreadIdRef.current = null;
        actions.deselectThread();
      }
      const unsubscribed = await unsubscribeThreadEvents(id);
      if (unsubscribed) actions.setError(null);
      await refreshThreads();
    },
    [actions, refreshThreads, state, t, unsubscribeThreadEvents],
  );

  const onRestoreThread = useCallback(
    async (id: string) => {
      const result = await window.agentApi.threads.update(id, { status: "active" });
      if (!result.ok) {
        actions.setError(result.message);
        return;
      }
      actions.setError(null);
      await refreshThreads();
    },
    [actions, refreshThreads],
  );

  const onSend = useCallback(async (draftText: string): Promise<boolean> => {
    const sendPayload = buildComposerSendPayload(
      draftText,
      state.composer.attachmentIds.length,
      t,
    );
    if (!sendPayload) return false;
    if (activeThreadArchived) {
      actions.setError(t("threads.sendBlockedArchived"));
      return false;
    }
    if (sendInProgressRef.current) {
      return false;
    }

    sendInProgressRef.current = true;
    actions.setError(null);
    try {
      let threadId = state.activeThreadId;
      if (!threadId) {
        const workspace = await ensureWorkspaceRoot();
        if (!workspace) return false;
        const title =
          sendPayload.threadTitle.length > 60
            ? `${sendPayload.threadTitle.slice(0, 57)}...`
            : sendPayload.threadTitle;
        const threadResult = await window.agentApi.threads.create({
          title,
          workspace,
          mode: workbenchThreadModeForRoute(state.route),
        });
        if (!threadResult.ok) {
          actions.setError(threadResult.message);
          return false;
        }
        threadId = threadResult.value.id;
        activeThreadIdRef.current = threadId;
        actions.selectThread(threadResult.value, []);
        if (!await subscribeThreadEvents(threadId)) return false;
        void refreshThreads();
      }

      if (state.composer.goalMode && threadId && !state.activeThread?.goal) {
        const goalResult = await window.agentApi.goals.update({
          threadId,
          goal: sendPayload.text,
          status: "active",
        });
        if (goalResult.ok) {
          actions.updateActiveThread(goalResult.value);
        } else {
          actions.setError(goalResult.message);
          return false;
        }
      }

      const result = await window.agentApi.turns.start({
        threadId,
        text: sendPayload.text,
        displayText: sendPayload.displayText,
        model: state.composer.model,
        modelProfileId: state.composer.modelProfileId ?? state.modelProfiles?.activeProfileId,
        reasoningEffort:
          state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort,
        attachmentIds: state.composer.attachmentIds,
        mode: state.composer.mode,
        goalMode: state.composer.goalMode,
      });
      if (!result.ok) {
        actions.setError(result.message);
        return false;
      }
      actions.setComposerText("");
      actions.clearComposerAttachments();
      actions.turnStarted(result.value);
      return true;
    } finally {
      sendInProgressRef.current = false;
    }
  }, [
    state.activeThread,
    state.activeThreadId,
    state.composer,
    state.modelConfig,
    state.modelProfiles,
    state.route,
    activeThreadArchived,
    actions,
    ensureWorkspaceRoot,
    refreshThreads,
    subscribeThreadEvents,
    t,
  ]);

  const onSendWriteAssistantPrompt = useCallback(
    async (payload: WriteAssistantPromptPayload): Promise<boolean> => {
      const sendPayload = normalizeWriteAssistantSendPayload(payload);
      if (!sendPayload) return false;
      if (activeThreadArchived) {
        actions.setError(t("threads.sendBlockedArchived"));
        return false;
      }
      if (sendInProgressRef.current) {
        return false;
      }

      sendInProgressRef.current = true;
      actions.setError(null);
      try {
        let threadId = state.activeThread?.mode === "write"
          ? state.activeThreadId
          : null;
        if (!threadId) {
          const workspace = await ensureWorkspaceRoot();
          if (!workspace) return false;
          const title =
            sendPayload.threadTitle.length > 60
              ? `${sendPayload.threadTitle.slice(0, 57)}...`
              : sendPayload.threadTitle;
          const threadResult = await window.agentApi.threads.create({
            title,
            workspace,
            mode: "write",
          });
          if (!threadResult.ok) {
            actions.setError(threadResult.message);
            return false;
          }
          threadId = threadResult.value.id;
          activeThreadIdRef.current = threadId;
          actions.selectThread(threadResult.value, []);
          if (!await subscribeThreadEvents(threadId)) return false;
          void refreshThreads();
        }

        const result = await window.agentApi.turns.start({
          threadId,
          text: sendPayload.text,
          displayText: sendPayload.displayText,
          model: state.composer.model,
          modelProfileId: state.composer.modelProfileId ?? state.modelProfiles?.activeProfileId,
          reasoningEffort:
            state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort,
          attachmentIds: [],
          mode: "agent",
          goalMode: false,
        });
        if (!result.ok) {
          actions.setError(result.message);
          return false;
        }
        actions.turnStarted(result.value);
        return true;
      } finally {
        sendInProgressRef.current = false;
      }
    },
    [
      state.activeThread,
      state.activeThreadId,
      state.composer.model,
      state.composer.modelProfileId,
      state.composer.reasoningEffort,
      state.modelConfig.model_reasoning_effort,
      state.modelProfiles,
      activeThreadArchived,
      actions,
      ensureWorkspaceRoot,
      refreshThreads,
      subscribeThreadEvents,
      t,
    ],
  );

  const onInterrupt = useCallback(async () => {
    if (!activeThreadInFlightTurn) return;
    const result = await window.agentApi.turns.interrupt(activeThreadInFlightTurn.id);
    if (result.ok) {
      actions.setError(null);
    } else {
      actions.setError(result.message);
    }
  }, [actions, activeThreadInFlightTurn]);

  const onApprove = useCallback(
    async (approvalId: string, decision: "allow" | "deny") => {
      const result = await window.agentApi.approvals.respond({ approvalId, decision });
      if (result.ok) {
        actions.setError(null);
      } else {
        actions.setError(result.message);
      }
    },
    [actions],
  );

  const onOpenSettings = useCallback(() => {
    actions.setRoute("settings");
  }, [actions]);

  const onSwitchWorkbench = useCallback(
    (route: "code" | "write") => {
      actions.setRoute(route);
    },
    [actions],
  );

  // ----- Sidebar for the Code route is the chat thread list.
  // ----- For the Write route, the workspace sidebar lives inside the view.

  return (
    <>
      {state.route === "code" ? (
        <div
          className="ds-sidebar"
          style={{ width: state.leftSidebarWidth, flex: `0 0 ${state.leftSidebarWidth}px` }}
        >
          <Sidebar
            threads={codeThreads}
            activeView="code"
            onSelectThread={(id) => void onSelectThread(id)}
            onNewChat={() => void onNewChat()}
            onPickWorkspace={() => void onPickWorkspace()}
            onDeleteThread={(id) => void onDeleteThread(id)}
            onArchiveThread={(id) => void onArchiveThread(id)}
            onRestoreThread={(id) => void onRestoreThread(id)}
            onOpenSettings={onOpenSettings}
            onSwitchWorkbench={onSwitchWorkbench}
            workspaceRoot={state.workspaceRoot}
            showArchivedThreads={state.showArchivedThreads}
            confirmThreadDelete={state.basicPreferences.confirmThreadDelete}
            onToggleArchivedThreads={() =>
              actions.setShowArchivedThreads(!state.showArchivedThreads)
            }
          />
        </div>
      ) : null}
      {state.route === "code" ? (
        <div
          className="ds-workbench-divider"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={state.leftSidebarWidth}
          tabIndex={0}
          onKeyDown={(event) => {
            const next = getNextSidebarWidth(
              state.leftSidebarWidth,
              event.key,
              SIDEBAR_KEYBOARD_STEP,
            );
            if (next === state.leftSidebarWidth) return;
            event.preventDefault();
            actions.setLeftSidebarWidth(next);
          }}
          onPointerDown={(event) => {
            const startX = event.clientX;
            const startWidth = state.leftSidebarWidth;
            const target = event.currentTarget;
            target.setPointerCapture(event.pointerId);
            const onMove = (ev: PointerEvent): void => {
              const dx = ev.clientX - startX;
              const next = clampSidebarWidth(startWidth + dx);
              actions.setLeftSidebarWidth(next);
            };
            const onUp = (): void => {
              target.removeEventListener("pointermove", onMove);
              target.removeEventListener("pointerup", onUp);
            };
            target.addEventListener("pointermove", onMove);
            target.addEventListener("pointerup", onUp);
          }}
        />
      ) : null}
      <main className="ds-stage-surface">
        {state.route === "write" ? (
          <>
            <WriteWorkspaceView
              onWorkspaceSelected={(workspace) =>
                selectOrCreateThreadForWorkspace(workspace, "write")
              }
              onSendAssistantPrompt={onSendWriteAssistantPrompt}
              onInterruptAssistant={() => void onInterrupt()}
              assistantBusy={Boolean(activeThreadInFlightTurn)}
            />
            <WorkbenchErrorToast
              message={state.errorMessage}
              onDismiss={() => actions.setError(null)}
              floating
            />
          </>
        ) : (
          <section className="ds-chat-stage">
            <div style={{ padding: 12 }}>
              <WorkbenchTopBar />
            </div>
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
              <div className="ds-chat-column-inset" style={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0 }}>
                <MessageTimeline onApprove={onApprove} />
                <div style={{ padding: "0 0 12px", display: "flex", justifyContent: "center" }}>
                  <div style={{ width: "min(100%, 720px)" }}>
                    <PendingApprovalPanel onApprove={onApprove} />
                    <FloatingComposer
                      onSend={onSend}
                      onInterrupt={() => void onInterrupt()}
                      disabled={activeThreadArchived}
                    />
                    <WorkbenchErrorToast
                      message={state.errorMessage}
                      onDismiss={() => actions.setError(null)}
                    />
                  </div>
                </div>
              </div>
              <RightInspector />
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function WorkbenchErrorToast({
  message,
  onDismiss,
  floating = false,
}: {
  message: string | null;
  onDismiss: () => void;
  floating?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!shouldShowWorkbenchErrorToast(message)) return null;
  return (
    <div className={`ds-error-toast ${floating ? "is-floating" : ""}`} role="status">
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.dismiss")}
        title={t("common.dismiss")}
      >
        ×
      </button>
    </div>
  );
}

export function shouldShowWorkbenchErrorToast(message: string | null): boolean {
  return Boolean(message);
}

export function formatInitialLoadErrors(results: Array<IpcResult<unknown>>): string | null {
  const messages = results
    .filter((result) => !result.ok)
    .map((result) => result.message);
  return messages.length > 0 ? messages.join("\n") : null;
}

export function shouldUnsubscribeRemovedThread(
  subscribedThreadIds: ReadonlySet<string>,
  threadId: string,
): boolean {
  return subscribedThreadIds.has(threadId);
}

export function isGlobalRuntimeErrorEvent(event: RuntimeErrorEvent): boolean {
  return event.kind === "runtime_error" && !event.threadId;
}

export function workbenchThreadModeForRoute(route: WorkbenchRoute): ThreadRecord["mode"] {
  return route === "write" ? "write" : "code";
}

export function findLatestThreadForWorkspace(
  threads: readonly ThreadSummary[],
  workspace: string,
  mode: ThreadRecord["mode"],
): ThreadSummary | null {
  return threads.find(
    (thread) =>
      thread.mode === mode &&
      thread.workspace === workspace &&
      thread.status !== "archived",
  ) ?? null;
}

export function filterThreadsForWorkbench(
  threads: readonly ThreadSummary[],
  mode: ThreadRecord["mode"],
): ThreadSummary[] {
  return threads.filter((thread) => thread.mode === mode);
}

export function clampSidebarWidth(width: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, width));
}

export function getNextSidebarWidth(
  currentWidth: number,
  key: string,
  step = SIDEBAR_KEYBOARD_STEP,
): number {
  if (key === "ArrowLeft") return clampSidebarWidth(currentWidth - step);
  if (key === "ArrowRight") return clampSidebarWidth(currentWidth + step);
  if (key === "Home") return LEFT_SIDEBAR_MIN_WIDTH;
  if (key === "End") return LEFT_SIDEBAR_MAX_WIDTH;
  return currentWidth;
}

export function buildComposerSendPayload(
  draftText: string,
  attachmentCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): { text: string; displayText?: string; threadTitle: string } | null {
  const text = draftText.trim();
  if (text.length > 0) {
    return { text, threadTitle: text };
  }
  if (attachmentCount <= 0) return null;

  const attachmentOnlyText = t(
    attachmentCount === 1
      ? "composer.attachmentOnlyMessageSingle"
      : "composer.attachmentOnlyMessageMultiple",
  );
  return {
    text: attachmentOnlyText,
    displayText: attachmentOnlyText,
    threadTitle: attachmentOnlyText,
  };
}

export function normalizeWriteAssistantSendPayload(
  payload: WriteAssistantPromptPayload,
): WriteAssistantPromptPayload | null {
  const text = payload.text.trim();
  const displayText = payload.displayText.trim();
  const threadTitle = payload.threadTitle.trim();
  if (!text || !displayText || !threadTitle) return null;
  return { text, displayText, threadTitle };
}
