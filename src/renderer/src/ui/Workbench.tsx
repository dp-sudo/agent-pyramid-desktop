import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./store/WorkbenchContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkbenchTopBar } from "./components/topbar/WorkbenchTopBar";
import { FloatingComposer } from "./components/composer/FloatingComposer";
import { MessageTimeline } from "./components/chat/MessageTimeline";
import { RightInspector } from "./components/inspector/RightInspector";
import { WriteWorkspaceView } from "./components/write/WriteWorkspaceView";
import type { ThreadRecord } from "../../../shared/agent-contracts";

export function Workbench(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);

  useEffect(() => {
    activeThreadIdRef.current = state.activeThreadId;
  }, [state.activeThreadId]);

  // Load thread list on mount.
  useEffect(() => {
    if (!window.agentApi) {
      actions.setError("Preload script not loaded — check the Electron main process logs.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const [threadsResult, configResult, profilesResult] = await Promise.all([
        window.agentApi.threads.list({}),
        window.agentApi.modelConfig.get(),
        window.agentApi.modelConfig.listProfiles(),
      ]);
      if (cancelled) return;
      if (threadsResult.ok) actions.setThreads(threadsResult.value);
      if (configResult.ok) actions.setModelConfig(configResult.value);
      if (profilesResult.ok) actions.setModelProfiles(profilesResult.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

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
      } else if (event.kind === "turn_failed") {
        actions.turnEnded("failed");
        actions.setError(event.message);
      } else if (event.kind === "runtime_error") {
        actions.setError(event.message);
      } else if (event.kind === "goal_updated" && state.activeThread) {
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

  // Subscribe the main process event bus to the active thread.
  useEffect(() => {
    if (!state.activeThreadId) return;
    const threadId = state.activeThreadId;
    void window.agentApi.sse.subscribe({ threadId });
    return () => {
      void window.agentApi.sse.unsubscribe({ threadId });
    };
  }, [state.activeThreadId]);

  const refreshThreads = useCallback(async () => {
    const result = await window.agentApi.threads.list({});
    if (result.ok) actions.setThreads(result.value);
  }, [actions]);

  const onSelectThread = useCallback(
    async (id: string) => {
      const threadResult = await window.agentApi.threads.get(id);
      if (!threadResult.ok) return;
      const itemsResult = await window.agentApi.turns.get(id);
      const items = itemsResult.ok ? itemsResult.value.items : [];
      actions.selectThread(threadResult.value as ThreadRecord, items);
    },
    [actions],
  );

  const onNewChat = useCallback(async () => {
    const result = await window.agentApi.threads.create({
      title: "New thread",
      workspace: "",
      mode: "code",
    });
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    activeThreadIdRef.current = result.value.id;
    await window.agentApi.sse.subscribe({ threadId: result.value.id });
    await refreshThreads();
    actions.selectThread(result.value as ThreadRecord, []);
  }, [actions, refreshThreads]);

  const onSend = useCallback(async () => {
    const text = state.composer.text.trim();
    if (!text) return;

    let threadId = state.activeThreadId;
    if (!threadId) {
      const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
      const threadResult = await window.agentApi.threads.create({
        title,
        workspace: "",
        mode: "code",
      });
      if (!threadResult.ok) {
        actions.setError(threadResult.message);
        return;
      }
      threadId = threadResult.value.id;
      activeThreadIdRef.current = threadId;
      await window.agentApi.sse.subscribe({ threadId });
      await refreshThreads();
      actions.selectThread(threadResult.value as ThreadRecord, []);
    }

    if (state.composer.goalMode && threadId && !state.activeThread?.goal) {
      const goalResult = await window.agentApi.goals.update({
        threadId,
        goal: text,
        status: "active",
      });
      if (goalResult.ok) {
        actions.updateActiveThread(goalResult.value as ThreadRecord);
      } else {
        actions.setError(goalResult.message);
        return;
      }
    }

    const result = await window.agentApi.turns.start({
      threadId,
      text,
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
      return;
    }
    actions.setComposerText("");
    actions.clearComposerAttachments();
    actions.turnStarted(result.value);
  }, [
    state.activeThread,
    state.activeThreadId,
    state.composer,
    state.modelConfig,
    state.modelProfiles,
    actions,
    refreshThreads,
  ]);

  const onInterrupt = useCallback(async () => {
    if (!state.inFlightTurn) return;
    await window.agentApi.turns.interrupt(state.inFlightTurn.id, { force: true });
  }, [state.inFlightTurn]);

  const onApprove = useCallback(
    async (approvalId: string, decision: "allow" | "deny") => {
      await window.agentApi.approvals.respond({ approvalId, decision });
    },
    [],
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
            onOpenSettings={onOpenSettings}
          />
        </div>
      ) : null}
      {!state.route || state.route === "code" ? (
        <div
          className="ds-workbench-divider"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            const startX = event.clientX;
            const startWidth = state.leftSidebarWidth;
            const target = event.currentTarget;
            target.setPointerCapture(event.pointerId);
            const onMove = (ev: PointerEvent): void => {
              const dx = ev.clientX - startX;
              const next = Math.min(420, Math.max(180, startWidth + dx));
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
                <MessageTimeline onApprove={(id, decision) => void onApprove(id, decision)} />
                <div style={{ padding: "0 0 12px", display: "flex", justifyContent: "center" }}>
                  <div style={{ width: "min(100%, 720px)" }}>
                    <FloatingComposer
                      onSend={() => void onSend()}
                      onInterrupt={() => void onInterrupt()}
                    />
                    {state.errorMessage ? (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "6px 10px",
                          background: "var(--ds-danger-soft)",
                          color: "var(--ds-danger)",
                          borderRadius: "var(--ds-radius-md)",
                          fontSize: "var(--ds-size-caption)",
                        }}
                      >
                        {state.errorMessage}
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
