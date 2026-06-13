import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  getThreadInFlightTurn,
  useWorkbench,
  type ToolProgressUpdate,
  type WorkbenchActions,
  type WorkbenchRoute,
  type WorkbenchState,
} from "./store/WorkbenchContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import {
  type FloatingComposerRequestPayload,
} from "./components/composer";
import type { ApprovalPendingDecision } from "./components/chat/ChatBlock";
import {
  type WriteAssistantPromptPayload,
} from "./components/write/WriteWorkspaceView";
import { CodeWorkbenchStage } from "./components/workbench/CodeWorkbenchStage";
import { WriteWorkbenchStage } from "./components/workbench/WriteWorkbenchStage";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
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
  type ToolProgressEvent,
} from "../../../shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../../shared/ipc-errors";
import { resolveMcpInputReferences } from "./mcp-input";
export {
  copyWorkbenchErrorMessage,
  shouldShowWorkbenchErrorToast,
  WORKBENCH_DISMISS_BUTTON_TEXT,
  type WorkbenchErrorCopyResult,
} from "./components/workbench/WorkbenchErrorToast";

const SIDEBAR_KEYBOARD_STEP = 16;
const TOOL_PROGRESS_RENDER_FLUSH_MS = 100;

type WorkbenchComposerSendPayload = Pick<FloatingComposerRequestPayload, "text"> &
  Partial<Omit<FloatingComposerRequestPayload, "text">> &
  Partial<Pick<WriteAssistantPromptPayload, "displayText" | "threadTitle">>;

export function Workbench(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const workspaceRootRef = useRef<string>(state.workspaceRoot);
  const selectThreadRequestRef = useRef(0);
  const sendInProgressRef = useRef(false);
  const subscribedThreadIdsRef = useRef(new Set<string>());
  const toolProgressBuffersRef = useRef(new Map<string, ToolProgressUpdate>());
  const toolProgressFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingApprovalResponsesRef = useRef<Record<string, ApprovalPendingDecision>>({});
  const [leftSidebarDragging, setLeftSidebarDragging] = useState(false);
  const [pendingApprovalResponses, setPendingApprovalResponses] = useState<
    Record<string, ApprovalPendingDecision>
  >({});
  const activeThreadArchived = state.activeThread?.status === "archived";
  const activeThreadInFlightTurn = getActiveThreadInFlightTurn(state);
  const codeThreads = filterThreadsForWorkbench(state.threads, "code");
  const writeThreads = filterThreadsForWorkbench(state.threads, "write");

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

  const flushToolProgressBuffers = useCallback((): void => {
    if (toolProgressFlushTimerRef.current) {
      clearTimeout(toolProgressFlushTimerRef.current);
      toolProgressFlushTimerRef.current = null;
    }
    const updates = [...toolProgressBuffersRef.current.values()];
    toolProgressBuffersRef.current.clear();
    for (const update of updates) {
      actions.appendToolProgress(update);
    }
  }, [actions]);

  const queueToolProgress = useCallback(
    (event: ToolProgressEvent): void => {
      const key = `${event.threadId}:${event.turnId}:${event.toolCallId}`;
      const current = toolProgressBuffersRef.current.get(key);
      toolProgressBuffersRef.current.set(key, {
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        seq: event.seq,
        stdout: event.stream === "stdout"
          ? `${current?.stdout ?? ""}${event.chunk}`
          : current?.stdout,
        stderr: event.stream === "stderr"
          ? `${current?.stderr ?? ""}${event.chunk}`
          : current?.stderr,
      });
      if (toolProgressFlushTimerRef.current) return;
      toolProgressFlushTimerRef.current = setTimeout(
        flushToolProgressBuffers,
        TOOL_PROGRESS_RENDER_FLUSH_MS,
      );
    },
    [flushToolProgressBuffers],
  );

  useEffect(() => {
    return () => {
      if (toolProgressFlushTimerRef.current) {
        clearTimeout(toolProgressFlushTimerRef.current);
      }
      toolProgressBuffersRef.current.clear();
    };
  }, []);

  const handleRuntimeEvent = useCallback(
    (event: RuntimeEvent): void => {
      if (event.kind === "tool_progress") {
        queueToolProgress(event);
        return;
      }
      applyWorkbenchRuntimeEvent(
        event,
        {
          activeThread: state.activeThread,
          activeThreadId: activeThreadIdRef.current,
        },
        actions,
      );
    },
    [actions, queueToolProgress, state.activeThread],
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

  const onNewWriteThread = useCallback(async () => {
    const workspace = await ensureWorkspaceRoot();
    if (!workspace) return;
    const result = await runWorkbenchIpc(() =>
      window.agentApi.threads.create({
        title: "New thread",
        workspace,
        mode: "write",
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
          result.code === IPC_ERROR_CODES.THREAD_DELETE_BUSY
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
          result.code === IPC_ERROR_CODES.THREAD_ARCHIVE_BUSY
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

  const sendCodeComposerPayload = useCallback(async (
    payload: WorkbenchComposerSendPayload,
  ): Promise<boolean> => {
    const sendPayload = buildComposerSendPayload(
      payload.text,
      payload.attachmentIds?.length ?? 0,
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

      const goalMode = payload.goalMode ?? false;
      const mode = payload.mode ?? "agent";
      const attachmentIds = payload.attachmentIds ?? [];
      const resolvedMcpInput = await resolveCodeMcpInputReferences(sendPayload, t);
      if (!resolvedMcpInput.ok) {
        actions.setError(resolvedMcpInput.message);
        return false;
      }
      const turnPayload = resolvedMcpInput.value;

      if (goalMode && threadId && !state.activeThread?.goal) {
        const goalResult = await runWorkbenchIpc(() =>
          window.agentApi.goals.update({
            threadId,
            goal: turnPayload.displayText ?? turnPayload.text,
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
          text: turnPayload.text,
          displayText: turnPayload.displayText,
          model: state.composer.model,
          modelProfileId: explicitComposerModelProfileId(state.composer),
          reasoningEffort:
            state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort,
          attachmentIds,
          mode,
          goalMode,
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

  const sendWriteComposerPayload = useCallback(
    async (payload: WorkbenchComposerSendPayload): Promise<boolean> => {
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
            attachmentIds: payload.attachmentIds ?? [],
            mode: payload.mode ?? "agent",
            goalMode: payload.goalMode ?? false,
          }),
        );
        if (!result.ok) {
          actions.setError(result.message);
          return false;
        }
        actions.clearComposerAttachments();
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

  const onSend = useCallback(
    async (payload: WorkbenchComposerSendPayload): Promise<boolean> => {
      return state.route === "write"
        ? sendWriteComposerPayload(payload)
        : sendCodeComposerPayload(payload);
    },
    [sendCodeComposerPayload, sendWriteComposerPayload, state.route],
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
        const next = { ...pendingApprovalResponsesRef.current };
        delete next[approvalId];
        pendingApprovalResponsesRef.current = next;
        setPendingApprovalResponses(next);
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
          onToggleArchivedThreads={() =>
            actions.setShowArchivedThreads(!state.showArchivedThreads)
          }
          style={{ width: state.leftSidebarWidth, flex: `0 0 ${state.leftSidebarWidth}px` }}
        />
      ) : null}
      {state.route === "code" ? (
        <div
          className={getWorkbenchDividerClassName(leftSidebarDragging)}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizeLeftSidebar")}
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
            setLeftSidebarDragging(true);
            target.setPointerCapture(event.pointerId);
            const onMove = (ev: PointerEvent): void => {
              const dx = ev.clientX - startX;
              const next = clampSidebarWidth(startWidth + dx);
              actions.setLeftSidebarWidth(next);
            };
            const clearDragListeners = (): void => {
              setLeftSidebarDragging(false);
              target.removeEventListener("pointermove", onMove);
              target.removeEventListener("pointerup", clearDragListeners);
              target.removeEventListener("pointercancel", clearDragListeners);
            };
            target.addEventListener("pointermove", onMove);
            target.addEventListener("pointerup", clearDragListeners);
            target.addEventListener("pointercancel", clearDragListeners);
          }}
          onDoubleClick={() => {
            actions.setLeftSidebarWidth(getResetSidebarWidth());
          }}
        />
      ) : null}
      <main className="ds-stage-surface">
        {state.route === "write" ? (
          <WriteWorkbenchStage
            onApprove={onApprove}
            pendingApprovalResponses={pendingApprovalResponses}
            onWorkspaceSelected={(workspace) =>
              selectOrCreateThreadForWorkspace(workspace, "write")
            }
            onSendAssistantPrompt={onSend}
            onInterruptAssistant={() => void onInterrupt()}
            assistantBusy={Boolean(activeThreadInFlightTurn)}
            writeThreads={writeThreads}
            onSelectWriteThread={(id) => void onSelectThread(id)}
            onNewWriteThread={() => void onNewWriteThread()}
            onDeleteWriteThread={(id) => void onDeleteThread(id)}
            onArchiveWriteThread={(id) => void onArchiveThread(id)}
            onRestoreWriteThread={(id) => void onRestoreThread(id)}
            showArchivedThreads={state.showArchivedThreads}
            onToggleArchivedThreads={() =>
              actions.setShowArchivedThreads(!state.showArchivedThreads)
            }
            toastMessage={state.errorMessage}
            toastEnabled={state.runtimePreferences.approvalExperience.showFailureToasts}
            onDismissToast={() => actions.setError(null)}
          />
        ) : (
          <CodeWorkbenchStage
            onApprove={onApprove}
            pendingApprovalResponses={pendingApprovalResponses}
            onComposerRequestSend={onSend}
            onInterrupt={() => void onInterrupt()}
            composerDisabled={activeThreadArchived}
            toastMessage={state.errorMessage}
            toastEnabled={state.runtimePreferences.approvalExperience.showFailureToasts}
            onDismissToast={() => actions.setError(null)}
          />
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
    const remaining: Record<string, ApprovalPendingDecision> = { ...source };
    delete remaining[item.approvalId];
    next = remaining;
  }
  return next ?? current;
}

export async function runWorkbenchIpc<T>(
  invoke: () => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  try {
    return await invoke();
  } catch (error) {
    return err(IPC_ERROR_CODES.RENDERER_IPC_REJECTED, messageOfWorkbenchError(error));
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
  | "appendToolProgress"
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
  if (
    event.kind === "mcp_server_connection" ||
    event.kind === "mcp_tool_list_changed" ||
    event.kind === "mcp_surface_changed"
  ) {
    return;
  }

  const isActiveThreadEvent = event.threadId === activeThreadId;
  if (event.kind === "turn_started") {
    actions.turnStarted(event.turn);
  } else if (event.kind === "item_appended" && isActiveThreadEvent) {
    actions.appendItem(event.item);
  } else if (event.kind === "item_updated" && isActiveThreadEvent) {
    actions.updateItem(event.item);
  } else if (event.kind === "tool_progress" && isActiveThreadEvent) {
    actions.appendToolProgress({
      threadId: event.threadId,
      turnId: event.turnId,
      toolCallId: event.toolCallId,
      seq: event.seq,
      ...(event.stream === "stdout" ? { stdout: event.chunk } : {}),
      ...(event.stream === "stderr" ? { stderr: event.chunk } : {}),
    });
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

export function getResetSidebarWidth(): number {
  return LEFT_SIDEBAR_DEFAULT_WIDTH;
}

export function getWorkbenchDividerClassName(isDragging: boolean): string {
  return isDragging ? "ds-workbench-divider is-dragging" : "ds-workbench-divider";
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

export async function resolveCodeMcpInputReferences(
  payload: {
    text: string;
    displayText?: string;
    threadTitle: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<{
  ok: true;
  value: { text: string; displayText?: string; threadTitle: string };
} | { ok: false; message: string }> {
  if (!window.agentApi?.mcp) {
    return { ok: true, value: payload };
  }
  if (!payload.text.includes("/mcp__") && !payload.text.includes("@")) {
    return { ok: true, value: payload };
  }
  return resolveMcpInputReferences(payload, window.agentApi.mcp, t);
}

export function normalizeWriteAssistantSendPayload(
  payload: WorkbenchComposerSendPayload,
): WriteAssistantPromptPayload | null {
  const text = payload.text.trim();
  const displayText = payload.displayText?.trim() ?? "";
  const threadTitle = payload.threadTitle?.trim() ?? "";
  if (!text || !displayText || !threadTitle) return null;
  return {
    text,
    displayText,
    threadTitle,
    attachmentIds: payload.attachmentIds ?? [],
    mode: payload.mode ?? "agent",
    goalMode: payload.goalMode ?? false,
  };
}
