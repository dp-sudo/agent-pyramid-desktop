import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  getThreadInFlightTurn,
  useWorkbench,
  type WorkbenchActions,
  type WorkbenchRoute,
  type WorkbenchState,
} from "./store/WorkbenchContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkbenchTopBar } from "./components/topbar/WorkbenchTopBar";
import { FloatingComposer } from "./components/composer/FloatingComposer";
import { MessageTimeline } from "./components/chat/MessageTimeline";
import { PendingApprovalPanel } from "./components/chat/PendingApprovalPanel";
import type { ApprovalPendingDecision } from "./components/chat/ChatBlock";
import { RightInspector } from "./components/inspector/RightInspector";
import {
  WriteWorkspaceView,
  type WriteAssistantPromptPayload,
} from "./components/write/WriteWorkspaceView";
import {
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "./preferences";
import {
  err,
  type Item,
  type IpcResult,
  type RuntimeEvent,
  type RuntimeErrorEvent,
  type ThreadRecord,
  type ThreadSummary,
} from "../../../shared/agent-contracts";

const SIDEBAR_KEYBOARD_STEP = 16;
export const WORKBENCH_DISMISS_BUTTON_TEXT = "x";

export function Workbench(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const workspaceRootRef = useRef<string>(state.workspaceRoot);
  const selectThreadRequestRef = useRef(0);
  const sendInProgressRef = useRef(false);
  const subscribedThreadIdsRef = useRef(new Set<string>());
  const pendingApprovalResponsesRef = useRef<Record<string, ApprovalPendingDecision>>({});
  const [pendingApprovalResponses, setPendingApprovalResponses] = useState<
    Record<string, ApprovalPendingDecision>
  >({});
  const activeThreadArchived = state.activeThread?.status === "archived";
  const activeThreadInFlightTurn = getActiveThreadInFlightTurn(state);
  const codeThreads = filterThreadsForWorkbench(state.threads, "code");

  useEffect(() => {
    activeThreadIdRef.current = state.activeThreadId;
  }, [state.activeThreadId]);

  useEffect(() => {
    workspaceRootRef.current = state.workspaceRoot;
  }, [state.workspaceRoot]);

  useEffect(() => {
    const nextPending = clearResolvedApprovalResponses(
      pendingApprovalResponsesRef.current,
      state.items,
    );
    if (nextPending === pendingApprovalResponsesRef.current) return;
    pendingApprovalResponsesRef.current = nextPending;
    setPendingApprovalResponses(nextPending);
  }, [state.items]);

  // Load thread list on mount.
  useEffect(() => {
    if (!window.agentApi) {
      actions.setError("Preload script not loaded — check the Electron main process logs.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const [
        threadsResult,
        configResult,
        profilesResult,
        runtimePreferencesResult,
      ] = await Promise.all([
        runWorkbenchIpc(() =>
          window.agentApi.threads.list({
            includeArchived: state.showArchivedThreads,
          }),
        ),
        runWorkbenchIpc(() => window.agentApi.modelConfig.get()),
        runWorkbenchIpc(() => window.agentApi.modelConfig.listProfiles()),
        runWorkbenchIpc(() => window.agentApi.runtimePreferences.get()),
      ]);
      if (cancelled) return;
      if (threadsResult.ok) actions.setThreads(threadsResult.value);
      if (configResult.ok) actions.setModelConfig(configResult.value);
      if (profilesResult.ok) actions.setModelProfiles(profilesResult.value);
      if (runtimePreferencesResult.ok) {
        actions.setRuntimePreferences(runtimePreferencesResult.value);
      }
      const initialLoadError = formatInitialLoadErrors([
        threadsResult,
        configResult,
        profilesResult,
        runtimePreferencesResult,
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
    (event: RuntimeEvent): void => {
      applyWorkbenchRuntimeEvent(
        event,
        {
          activeThread: state.activeThread,
          activeThreadId: activeThreadIdRef.current,
        },
        actions,
      );
    },
    [actions, state.activeThread],
  );

  useEffect(() => {
    if (!window.agentApi) return;
    return window.agentApi.sse.onEvent(handleRuntimeEvent);
  }, [handleRuntimeEvent]);

  const refreshThreads = useCallback(async () => {
    const result = await runWorkbenchIpc(() =>
      window.agentApi.threads.list({
        includeArchived: state.showArchivedThreads,
      }),
    );
    if (result.ok) {
      actions.setThreads(result.value);
    } else {
      actions.setError(result.message);
    }
  }, [actions, state.showArchivedThreads]);

  const subscribeThreadEvents = useCallback(
    async (threadId: string): Promise<boolean> => {
      if (subscribedThreadIdsRef.current.has(threadId)) return true;
      const result = await runWorkbenchIpc(() =>
        window.agentApi.sse.subscribe({ threadId }),
      );
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
      const result = await runWorkbenchIpc(() =>
        window.agentApi.sse.unsubscribe({ threadId }),
      );
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

    const result = await runWorkbenchIpc(() => window.agentApi.workspace.pickDirectory());
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
    async (id: string): Promise<boolean> => {
      const requestId = selectThreadRequestRef.current + 1;
      selectThreadRequestRef.current = requestId;
      actions.setError(null);
      const threadResult = await runWorkbenchIpc(() => window.agentApi.threads.get(id));
      if (requestId !== selectThreadRequestRef.current) return false;
      if (!threadResult.ok) {
        actions.setError(threadResult.message);
        return false;
      }
      const itemsResult = await runWorkbenchIpc(() => window.agentApi.turns.get(id));
      if (requestId !== selectThreadRequestRef.current) return false;
      if (!itemsResult.ok) {
        actions.setError(itemsResult.message);
        return false;
      }
      const items = itemsResult.ok ? itemsResult.value.items : [];
      actions.selectThread(threadResult.value, items);
      return true;
    },
    [actions],
  );

  const selectThreadById = useCallback(
    async (id: string): Promise<boolean> => {
      return onSelectThread(id);
    },
    [onSelectThread],
  );

  const selectOrCreateThreadForWorkspace = useCallback(
    async (workspace: string, mode: ThreadRecord["mode"]): Promise<boolean> => {
      const threadsResult = await runWorkbenchIpc(() =>
        window.agentApi.threads.list({
          includeArchived: state.showArchivedThreads,
        }),
      );
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
        return selectThreadById(latestForWorkspace.id);
      }

      const created = await runWorkbenchIpc(() =>
        window.agentApi.threads.create({
          title: "New thread",
          workspace,
          mode,
        }),
      );
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
    const result = await runWorkbenchIpc(() => window.agentApi.workspace.pickDirectory());
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
    const result = await runWorkbenchIpc(() =>
      window.agentApi.threads.create({
        title: "New thread",
        workspace,
        mode: "code",
      }),
    );
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

      const result = await runWorkbenchIpc(() => window.agentApi.threads.delete(id));
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

      const result = await runWorkbenchIpc(() =>
        window.agentApi.threads.update(id, { status: "archived" }),
      );
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
      const result = await runWorkbenchIpc(() =>
        window.agentApi.threads.update(id, { status: "active" }),
      );
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
        const threadResult = await runWorkbenchIpc(() =>
          window.agentApi.threads.create({
            title,
            workspace,
            mode: workbenchThreadModeForRoute(state.route),
          }),
        );
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
        const goalResult = await runWorkbenchIpc(() =>
          window.agentApi.goals.update({
            threadId,
            goal: sendPayload.text,
            status: "active",
          }),
        );
        if (goalResult.ok) {
          actions.updateActiveThread(goalResult.value);
        } else {
          actions.setError(goalResult.message);
          return false;
        }
      }

      const result = await runWorkbenchIpc(() =>
        window.agentApi.turns.start({
          threadId,
          text: sendPayload.text,
          displayText: sendPayload.displayText,
          model: state.composer.model,
          modelProfileId: explicitComposerModelProfileId(state.composer),
          reasoningEffort:
            state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort,
          attachmentIds: state.composer.attachmentIds,
          mode: state.composer.mode,
          goalMode: state.composer.goalMode,
        }),
      );
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
          const threadResult = await runWorkbenchIpc(() =>
            window.agentApi.threads.create({
              title,
              workspace,
              mode: "write",
            }),
          );
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

        const result = await runWorkbenchIpc(() =>
          window.agentApi.turns.start({
            threadId,
            text: sendPayload.text,
            displayText: sendPayload.displayText,
            model: state.composer.model,
            modelProfileId: explicitComposerModelProfileId(state.composer),
            reasoningEffort:
              state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort,
            attachmentIds: [],
            mode: "agent",
            goalMode: false,
          }),
        );
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
      state.composer.modelProfileSelection,
      state.composer.reasoningEffort,
      state.modelConfig.model_reasoning_effort,
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
    const result = await runWorkbenchIpc(() =>
      window.agentApi.turns.interrupt(activeThreadInFlightTurn.id),
    );
    if (result.ok) {
      actions.setError(null);
    } else {
      actions.setError(result.message);
    }
  }, [actions, activeThreadInFlightTurn]);

  const onApprove = useCallback(
    async (approvalId: string, decision: "allow" | "deny") => {
      const nextPending = beginPendingApprovalResponse(
        pendingApprovalResponsesRef.current,
        approvalId,
        decision,
      );
      if (!nextPending) return;
      pendingApprovalResponsesRef.current = nextPending;
      setPendingApprovalResponses(nextPending);
      const result = await runWorkbenchIpc(() =>
        window.agentApi.approvals.respond({ approvalId, decision }),
      );
      if (result.ok) {
        actions.setError(null);
      } else {
        actions.setError(result.message);
        const { [approvalId]: _removed, ...rest } = pendingApprovalResponsesRef.current;
        void _removed;
        pendingApprovalResponsesRef.current = rest;
        setPendingApprovalResponses(rest);
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
              enabled={state.runtimePreferences.approvalExperience.showFailureToasts}
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
                <MessageTimeline
                  onApprove={onApprove}
                  pendingApprovalResponses={pendingApprovalResponses}
                />
                <div style={{ padding: "0 0 12px", display: "flex", justifyContent: "center" }}>
                  <div style={{ width: "min(100%, 720px)" }}>
                    <PendingApprovalPanel
                      onApprove={onApprove}
                      pendingApprovalResponses={pendingApprovalResponses}
                    />
                    <FloatingComposer
                      onSend={onSend}
                      onInterrupt={() => void onInterrupt()}
                      disabled={activeThreadArchived}
                    />
                    <WorkbenchErrorToast
                      message={state.errorMessage}
                      enabled={state.runtimePreferences.approvalExperience.showFailureToasts}
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
  enabled = true,
  onDismiss,
  floating = false,
}: {
  message: string | null;
  enabled?: boolean;
  onDismiss: () => void;
  floating?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!shouldShowWorkbenchErrorToast(message, enabled)) return null;
  return (
    <div className={`ds-error-toast ${floating ? "is-floating" : ""}`} role="status">
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.dismiss")}
        title={t("common.dismiss")}
      >
        {WORKBENCH_DISMISS_BUTTON_TEXT}
      </button>
    </div>
  );
}

export function shouldShowWorkbenchErrorToast(
  message: string | null,
  enabled = true,
): boolean {
  return enabled && Boolean(message);
}

export function formatInitialLoadErrors(results: Array<IpcResult<unknown>>): string | null {
  const messages = results
    .filter((result) => !result.ok)
    .map((result) => result.message);
  return messages.length > 0 ? messages.join("\n") : null;
}

export function beginPendingApprovalResponse(
  current: Record<string, ApprovalPendingDecision>,
  approvalId: string,
  decision: Exclude<ApprovalPendingDecision, null>,
): Record<string, ApprovalPendingDecision> | null {
  if (current[approvalId]) return null;
  return {
    ...current,
    [approvalId]: decision,
  };
}

export function clearResolvedApprovalResponses(
  current: Record<string, ApprovalPendingDecision>,
  items: readonly Item[],
): Record<string, ApprovalPendingDecision> {
  let next: Record<string, ApprovalPendingDecision> | null = null;
  for (const item of items) {
    if (
      item.kind !== "approval" ||
      item.decision === undefined ||
      current[item.approvalId] === undefined
    ) {
      continue;
    }
    const source: Record<string, ApprovalPendingDecision> = next ?? current;
    const { [item.approvalId]: _removed, ...rest }: Record<string, ApprovalPendingDecision> =
      source;
    void _removed;
    next = rest;
  }
  return next ?? current;
}

export async function runWorkbenchIpc<T>(
  invoke: () => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  try {
    return await invoke();
  } catch (error) {
    return err("RENDERER_IPC_REJECTED", messageOfWorkbenchError(error));
  }
}

export function messageOfWorkbenchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

type WorkbenchRuntimeEventActions = Pick<
  WorkbenchActions,
  | "appendItem"
  | "setError"
  | "turnEnded"
  | "turnStarted"
  | "updateActiveThread"
  | "updateItem"
>;

export function applyWorkbenchRuntimeEvent(
  event: RuntimeEvent,
  context: {
    activeThread: ThreadRecord | null;
    activeThreadId: string | null;
  },
  actions: WorkbenchRuntimeEventActions,
): void {
  // Retained SSE subscriptions may deliver background turn lifecycle events
  // after route switches clear the active thread; keep in-flight state correct
  // while limiting timeline mutations to the active thread.
  const activeThreadId = context.activeThreadId;
  if (event.kind === "runtime_error") {
    if (isGlobalRuntimeErrorEvent(event) || event.threadId === activeThreadId) {
      actions.setError(event.message);
    }
    return;
  }

  const isActiveThreadEvent = event.threadId === activeThreadId;
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
    context.activeThread &&
    event.threadId === context.activeThread.id
  ) {
    actions.updateActiveThread({
      ...context.activeThread,
      ...(event.goal ? { goal: event.goal } : { goal: undefined }),
    });
  }
}

export function workbenchThreadModeForRoute(route: WorkbenchRoute): ThreadRecord["mode"] {
  return route === "write" ? "write" : "code";
}

export function explicitComposerModelProfileId(
  composer: WorkbenchState["composer"],
): string | undefined {
  return composer.modelProfileSelection === "explicit"
    ? composer.modelProfileId
    : undefined;
}

export function findLatestThreadForWorkspace(
  threads: readonly ThreadSummary[],
  workspace: string,
  mode: ThreadRecord["mode"],
): ThreadSummary | null {
  let latest: ThreadSummary | null = null;
  for (const thread of threads) {
    if (
      thread.mode !== mode ||
      thread.workspace !== workspace ||
      thread.status === "archived"
    ) {
      continue;
    }
    if (!latest || Date.parse(thread.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = thread;
    }
  }
  return latest;
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
