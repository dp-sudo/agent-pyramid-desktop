import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./store/WorkbenchContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkbenchTopBar } from "./components/topbar/WorkbenchTopBar";
import { FloatingComposer } from "./components/composer/FloatingComposer";
import { MessageTimeline } from "./components/chat/MessageTimeline";
import { RightInspector } from "./components/inspector/RightInspector";
import { WriteWorkspaceView } from "./components/write/WriteWorkspaceView";
import {
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "./preferences";
import type { IpcResult, ThreadRecord } from "../../../shared/agent-contracts";

const SIDEBAR_KEYBOARD_STEP = 16;

export function Workbench(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const workspaceRootRef = useRef<string>(state.workspaceRoot);
  const selectThreadRequestRef = useRef(0);
  const sendInProgressRef = useRef(false);
  const activeThreadArchived = state.activeThread?.status === "archived";

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
      if (!threadId || !("threadId" in event) || event.threadId !== threadId) return;
      if (event.kind === "item_appended") {
        actions.appendItem(event.item);
      } else if (event.kind === "item_updated") {
        actions.updateItem(event.item);
      } else if (event.kind === "turn_completed") {
        if (event.status !== "in-flight") {
          actions.turnEnded(event.status);
        }
      } else if (event.kind === "tool_budget_reached") {
        // The timeline receives the persisted warning item; continuation status is not a UI error.
      } else if (event.kind === "turn_failed") {
        actions.turnEnded("failed");
        actions.setError(event.message);
      } else if (event.kind === "runtime_error") {
        actions.setError(event.message);
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
      const result = await window.agentApi.sse.subscribe({ threadId });
      if (result.ok) return true;
      actions.setError(result.message);
      return false;
    },
    [actions],
  );

  const unsubscribeThreadEvents = useCallback(
    async (threadId: string): Promise<void> => {
      const result = await window.agentApi.sse.unsubscribe({ threadId });
      if (!result.ok && result.code !== "SSE_NOT_SUBSCRIBED") {
        actions.setError(result.message);
      }
    },
    [actions],
  );

  // Subscribe the main process event bus to the active thread.
  useEffect(() => {
    if (!state.activeThreadId) return;
    const threadId = state.activeThreadId;
    void subscribeThreadEvents(threadId);
    return () => {
      void unsubscribeThreadEvents(threadId);
    };
  }, [state.activeThreadId, subscribeThreadEvents, unsubscribeThreadEvents]);

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
      actions.selectThread(threadResult.value as ThreadRecord, items);
    },
    [actions],
  );

  const selectThreadById = useCallback(
    async (id: string): Promise<void> => {
      await onSelectThread(id);
    },
    [onSelectThread],
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

    const threadsResult = await window.agentApi.threads.list({
      includeArchived: state.showArchivedThreads,
    });
    if (!threadsResult.ok) {
      actions.setError(threadsResult.message);
      return;
    }

    actions.setThreads(threadsResult.value);
    const latestForWorkspace = threadsResult.value.find(
      (thread) =>
        thread.mode === "code" &&
        thread.workspace === workspace &&
        thread.status !== "archived",
    );
    if (latestForWorkspace) {
      await selectThreadById(latestForWorkspace.id);
      return;
    }

    const created = await window.agentApi.threads.create({
      title: "New thread",
      workspace,
      mode: "code",
    });
    if (!created.ok) {
      actions.setError(created.message);
      return;
    }
    activeThreadIdRef.current = created.value.id;
    if (!await subscribeThreadEvents(created.value.id)) return;
    actions.selectThread(created.value as ThreadRecord, []);
    void refreshThreads();
  }, [actions, refreshThreads, selectThreadById, state.showArchivedThreads, subscribeThreadEvents]);

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
    actions.selectThread(result.value as ThreadRecord, []);
    actions.setError(null);
    void refreshThreads();
  }, [actions, ensureWorkspaceRoot, refreshThreads, subscribeThreadEvents]);

  const onDeleteThread = useCallback(
    async (id: string) => {
      if (state.inFlightTurn?.threadId === id) {
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

      if (state.activeThreadId === id) {
        activeThreadIdRef.current = null;
        await unsubscribeThreadEvents(id);
      }
      actions.removeThread(id);
      actions.setError(null);
      await refreshThreads();
    },
    [actions, refreshThreads, state.activeThreadId, state.inFlightTurn, t, unsubscribeThreadEvents],
  );

  const onArchiveThread = useCallback(
    async (id: string) => {
      if (state.inFlightTurn?.threadId === id) {
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

      if (state.activeThreadId === id) {
        activeThreadIdRef.current = null;
        await unsubscribeThreadEvents(id);
        actions.deselectThread();
      }
      actions.setError(null);
      await refreshThreads();
    },
    [actions, refreshThreads, state.activeThreadId, state.inFlightTurn, t, unsubscribeThreadEvents],
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
          mode: "code",
        });
        if (!threadResult.ok) {
          actions.setError(threadResult.message);
          return false;
        }
        threadId = threadResult.value.id;
        activeThreadIdRef.current = threadId;
        actions.selectThread(threadResult.value as ThreadRecord, []);
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
          actions.updateActiveThread(goalResult.value as ThreadRecord);
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
    activeThreadArchived,
    actions,
    ensureWorkspaceRoot,
    refreshThreads,
    subscribeThreadEvents,
    t,
  ]);

  const onInterrupt = useCallback(async () => {
    if (!state.inFlightTurn) return;
    const result = await window.agentApi.turns.interrupt(state.inFlightTurn.id, { force: true });
    if (result.ok) {
      actions.setError(null);
    } else {
      actions.setError(result.message);
    }
  }, [actions, state.inFlightTurn]);

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

  // ----- Sidebar for the Code route is the chat thread list.
  // ----- For the Write route, the workspace sidebar lives inside the view.

  return (
    <>
      {!state.route || state.route === "code" ? (
        <div
          className="ds-sidebar"
          style={{ width: state.leftSidebarWidth, flex: `0 0 ${state.leftSidebarWidth}px` }}
        >
          <Sidebar
            threads={state.threads}
            activeView="code"
            onSelectThread={(id) => void onSelectThread(id)}
            onNewChat={() => void onNewChat()}
            onPickWorkspace={() => void onPickWorkspace()}
            onDeleteThread={(id) => void onDeleteThread(id)}
            onArchiveThread={(id) => void onArchiveThread(id)}
            onRestoreThread={(id) => void onRestoreThread(id)}
            onOpenSettings={onOpenSettings}
            workspaceRoot={state.workspaceRoot}
            showArchivedThreads={state.showArchivedThreads}
            confirmThreadDelete={state.basicPreferences.confirmThreadDelete}
            onToggleArchivedThreads={() =>
              actions.setShowArchivedThreads(!state.showArchivedThreads)
            }
          />
        </div>
      ) : null}
      {!state.route || state.route === "code" ? (
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
          <WriteWorkspaceView />
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
                    <FloatingComposer
                      onSend={onSend}
                      onInterrupt={() => void onInterrupt()}
                      disabled={activeThreadArchived}
                    />
                    {state.errorMessage ? (
                      <div className="ds-error-toast" role="status">
                        <span>{state.errorMessage}</span>
                        <button
                          type="button"
                          onClick={() => actions.setError(null)}
                          aria-label={t("common.dismiss")}
                          title={t("common.dismiss")}
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
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

export function formatInitialLoadErrors(results: Array<IpcResult<unknown>>): string | null {
  const messages = results
    .filter((result) => !result.ok)
    .map((result) => result.message);
  return messages.length > 0 ? messages.join("\n") : null;
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
