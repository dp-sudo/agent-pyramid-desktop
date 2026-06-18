import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  getThreadInFlightTurn,
  useWorkbench,
  type ToolProgressUpdate,
  type WorkbenchState,
} from "./store/WorkbenchContext";
import {
  mergeToolProgressBufferEvent,
  toolProgressBufferKey,
} from "./store/tool-progress-model";
import { explicitComposerModelProfileId } from "./store/composer-model-model";
import {
  applyWorkbenchRuntimeEvent,
  shouldBufferLiveTextItemUpdate,
  shouldFlushBufferedItemUpdatesBeforeEvent,
} from "./workbench-runtime-events";
import {
  filterThreadsForWorkbench,
  findLatestThreadForWorkspace,
  isThreadMutationBusyError,
  shouldUnsubscribeRemovedThread,
  threadMutationBusyMessageKey,
  workbenchThreadModeForRoute,
} from "./workbench-thread-model";
import {
  formatInitialLoadErrors,
  runWorkbenchIpc,
} from "./workbench-ipc";
import { Sidebar } from "./components/sidebar/Sidebar";
import {
  buildWorkbenchThreadTitle,
  buildComposerSendPayload,
  normalizeWriteAssistantSendPayload,
  resolveCodeMcpInputReferences,
  type WorkbenchComposerSendPayload,
} from "./workbench-composer-payload";
import {
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "./preferences";
import {
  clampLeftSidebarWidth,
  getNextLeftSidebarWidth,
  getResetLeftSidebarWidth,
  getSidebarDividerClassName,
} from "./sidebar-resize-model";
import {
  DEFAULT_THREAD_TITLE,
  type Item,
  type RuntimeEvent,
  type ThreadRecord,
} from "../../../shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../../shared/ipc-errors";
import { CodeWorkbenchStage } from "./components/workbench/CodeWorkbenchStage";
import { WriteWorkbenchStage } from "./components/workbench/WriteWorkbenchStage";
import type {
  ApprovalResponseChoice,
  UserInputResponseChoice,
} from "./components/chat/ChatBlock";
import type { ThreadSafetyUpdate } from "./components/topbar/WorkbenchTopBar";
import { usePanelResizer } from "./hooks/usePanelResizer";
import {
  createNewThread,
  ensureThreadForSend,
  runThreadMutation,
} from "./workbench-thread-service";
import { usePendingApprovalResponses } from "./hooks/usePendingApprovalResponses";
export {
  beginPendingApprovalResponse,
  clearResolvedApprovalResponses,
} from "./hooks/usePendingApprovalResponses";
export {
  copyWorkbenchErrorMessage,
  shouldShowWorkbenchErrorToast,
  type WorkbenchErrorCopyResult,
} from "./components/workbench/WorkbenchErrorToast";

const TOOL_PROGRESS_RENDER_FLUSH_MS = 100;
// Assistant text and reasoning arrive as high-frequency item_updated deltas
// (one per model token). Coalescing them into a single store dispatch per
// window avoids re-rendering the whole visible timeline on every token while
// keeping the cadence fast enough to feel live. Tool/approval item_updated
// events are low-frequency and stay immediate.
const TEXT_DELTA_RENDER_FLUSH_MS = 60;

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
  const latestItemUpdateByItemIdRef = useRef(new Map<string, Item>());
  const itemUpdateFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [threadSafetyUpdating, setThreadSafetyUpdating] = useState(false);
  const activeThreadArchived = state.activeThread?.status === "archived";
  const activeThreadInFlightTurn = getActiveThreadInFlightTurn(state);
  const codeThreads = filterThreadsForWorkbench(state.threads, "code");
  const writeThreads = filterThreadsForWorkbench(state.threads, "write");
  const {
    pendingApprovalResponses,
    beginApprovalResponse,
    clearApprovalResponse,
  } = usePendingApprovalResponses(state.items);
  const {
    dragging: leftSidebarDragging,
    handlePointerDown: handleLeftSidebarPointerDown,
  } = usePanelResizer({
    width: state.leftSidebarWidth,
    onWidthChange: actions.setLeftSidebarWidth,
    applyDragDelta: (startWidth, clientX, startX) =>
      clampLeftSidebarWidth(startWidth + (clientX - startX)),
  });

  useEffect(() => {
    activeThreadIdRef.current = state.activeThreadId;
  }, [state.activeThreadId]);

  useEffect(() => {
    workspaceRootRef.current = state.workspaceRoot;
  }, [state.workspaceRoot]);

  // Load thread list on mount.
  useEffect(() => {
    if (!window.agentApi) {
      actions.setError(t("settings.preloadMissing"));
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
  }, [actions, state.showArchivedThreads, t]);

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
    (event: Extract<RuntimeEvent, { kind: "tool_progress" }>): void => {
      const key = toolProgressBufferKey(event);
      const current = toolProgressBuffersRef.current.get(key);
      toolProgressBuffersRef.current.set(key, mergeToolProgressBufferEvent(current, event));
      if (toolProgressFlushTimerRef.current) return;
      toolProgressFlushTimerRef.current = setTimeout(
        flushToolProgressBuffers,
        TOOL_PROGRESS_RENDER_FLUSH_MS,
      );
    },
    [flushToolProgressBuffers],
  );

  const flushItemUpdates = useCallback((): void => {
    if (itemUpdateFlushTimerRef.current) {
      clearTimeout(itemUpdateFlushTimerRef.current);
      itemUpdateFlushTimerRef.current = null;
    }
    const updates = [...latestItemUpdateByItemIdRef.current.values()];
    latestItemUpdateByItemIdRef.current.clear();
    for (const item of updates) {
      actions.updateItem(item);
    }
  }, [actions]);

  const queueItemUpdate = useCallback(
    (item: Item): void => {
      // Keep only the freshest snapshot per item id; the last delta in the
      // window is the one that lands in the store, so no content is lost.
      latestItemUpdateByItemIdRef.current.set(item.id, item);
      if (itemUpdateFlushTimerRef.current) return;
      itemUpdateFlushTimerRef.current = setTimeout(
        flushItemUpdates,
        TEXT_DELTA_RENDER_FLUSH_MS,
      );
    },
    [flushItemUpdates],
  );

  useEffect(() => {
    return () => {
      if (toolProgressFlushTimerRef.current) {
        clearTimeout(toolProgressFlushTimerRef.current);
      }
      if (itemUpdateFlushTimerRef.current) {
        clearTimeout(itemUpdateFlushTimerRef.current);
      }
      toolProgressBuffersRef.current.clear();
      latestItemUpdateByItemIdRef.current.clear();
    };
  }, []);

  const handleRuntimeEvent = useCallback(
    (event: RuntimeEvent): void => {
      if (event.kind === "tool_progress") {
        queueToolProgress(event);
        return;
      }
      // Coalesce high-frequency assistant/reasoning text deltas so the live
      // turn re-renders at most once per window; tool/approval item_updated
      // and all other events stay immediate via the normal apply path.
      if (shouldBufferLiveTextItemUpdate(event, activeThreadIdRef.current)) {
        queueItemUpdate(event.item);
        return;
      }
      // Flush any buffered text deltas before terminal turn events so the
      // final streamed content is committed before the turn status flips.
      if (shouldFlushBufferedItemUpdatesBeforeEvent(event)) {
        flushItemUpdates();
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
    [actions, queueToolProgress, queueItemUpdate, flushItemUpdates, state.activeThread],
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
      if (!result.ok && result.code !== IPC_ERROR_CODES.SSE_NOT_SUBSCRIBED) {
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
    async (workspace: string, mode: ThreadRecord["mode"]): Promise<string | false> => {
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
        return await selectThreadById(latestForWorkspace.id)
          ? latestForWorkspace.id
          : false;
      }

      const created = await runWorkbenchIpc(() =>
        window.agentApi.threads.create({
          title: DEFAULT_THREAD_TITLE,
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
      return created.value.id;
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
    await createNewThread(actions, workspace, "code", {
      setActiveThreadId: (id) => { activeThreadIdRef.current = id; },
      subscribeThreadEvents,
      refreshThreads,
    });
  }, [actions, ensureWorkspaceRoot, refreshThreads, subscribeThreadEvents]);

  const onNewWriteThread = useCallback(async () => {
    const workspace = await ensureWorkspaceRoot();
    if (!workspace) return;
    await createNewThread(actions, workspace, "write", {
      setActiveThreadId: (id) => { activeThreadIdRef.current = id; },
      subscribeThreadEvents,
      refreshThreads,
    });
  }, [actions, ensureWorkspaceRoot, refreshThreads, subscribeThreadEvents]);

  const onDeleteThread = useCallback(
    async (id: string) => {
      await runThreadMutation(
        state,
        actions,
        id,
        "delete",
        t,
        (threadId) => runWorkbenchIpc(() => window.agentApi.threads.delete(threadId)),
        {
          setActiveThreadId: (newId) => { activeThreadIdRef.current = newId; },
          unsubscribeThreadEvents,
          refreshThreads,
        },
      );
    },
    [actions, refreshThreads, state, t, unsubscribeThreadEvents],
  );

  const onArchiveThread = useCallback(
    async (id: string) => {
      await runThreadMutation(
        state,
        actions,
        id,
        "archive",
        t,
        (threadId) => runWorkbenchIpc(() =>
          window.agentApi.threads.update(threadId, { status: "archived" }),
        ),
        {
          setActiveThreadId: (newId) => { activeThreadIdRef.current = newId; },
          unsubscribeThreadEvents,
          refreshThreads,
        },
      );
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

  const onUpdateThreadSafety = useCallback(
    async (patch: ThreadSafetyUpdate) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      setThreadSafetyUpdating(true);
      const result = await runWorkbenchIpc(() =>
        window.agentApi.threads.update(threadId, patch),
      );
      setThreadSafetyUpdating(false);
      if (result.ok) {
        actions.updateActiveThread(result.value);
        actions.setError(null);
        void refreshThreads();
        return;
      }
      actions.setError(result.message);
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
      const resolvedMcpInput = await resolveCodeMcpInputReferences(sendPayload, t);
      if (!resolvedMcpInput.ok) {
        actions.setError(resolvedMcpInput.message);
        return false;
      }
      const turnPayload = resolvedMcpInput.value;

      let threadId = state.activeThreadId;
      if (!threadId) {
        const workspace = await ensureWorkspaceRoot();
        if (!workspace) return false;
        const title = buildWorkbenchThreadTitle(turnPayload.threadTitle);
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
          const title = buildWorkbenchThreadTitle(sendPayload.threadTitle);
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
    async (approvalId: string, response: ApprovalResponseChoice) => {
      if (!beginApprovalResponse(approvalId, response)) return;
      const result = await runWorkbenchIpc(() =>
        window.agentApi.approvals.respond({
          approvalId,
          decision: response.decision,
          ...(response.scope ? { scope: response.scope } : {}),
        }),
      );
      if (result.ok) {
        actions.setError(null);
        if (!result.value.accepted) {
          clearApprovalResponse(approvalId);
        }
      } else {
        actions.setError(result.message);
        clearApprovalResponse(approvalId);
      }
    },
    [actions, beginApprovalResponse, clearApprovalResponse],
  );

  const onUserInputRespond = useCallback(
    async (userInputId: string, response: UserInputResponseChoice) => {
      const result = await runWorkbenchIpc(() =>
        window.agentApi.userInput.respond({
          userInputId,
          ...(response.answer !== undefined ? { answer: response.answer } : {}),
          ...(response.cancelled !== undefined ? { cancelled: response.cancelled } : {}),
        }),
      );
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
          className={getSidebarDividerClassName(leftSidebarDragging)}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizeLeftSidebar")}
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={state.leftSidebarWidth}
          tabIndex={0}
          onKeyDown={(event) => {
            const next = getNextLeftSidebarWidth(
              state.leftSidebarWidth,
              event.key,
            );
            if (next === state.leftSidebarWidth) return;
            event.preventDefault();
            actions.setLeftSidebarWidth(next);
          }}
          onPointerDown={handleLeftSidebarPointerDown}
          onDoubleClick={() => {
            actions.setLeftSidebarWidth(getResetLeftSidebarWidth());
          }}
        />
      ) : null}
      <main className="ds-stage-surface">
        {state.route === "write" ? (
          <WriteWorkbenchStage
            onApprove={onApprove}
            pendingApprovalResponses={pendingApprovalResponses}
            onUserInputRespond={onUserInputRespond}
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
            onUserInputRespond={onUserInputRespond}
            onComposerRequestSend={onSend}
            onInterrupt={() => void onInterrupt()}
            composerDisabled={activeThreadArchived}
            onUpdateThreadSafety={onUpdateThreadSafety}
            safetyUpdating={threadSafetyUpdating}
            toastMessage={state.errorMessage}
            toastEnabled={state.runtimePreferences.approvalExperience.showFailureToasts}
            onDismissToast={() => actions.setError(null)}
          />
        )}
      </main>
    </>
  );
}
