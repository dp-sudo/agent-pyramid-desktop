import { useCallback, useEffect, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./store/WorkbenchContext.js";
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

  // Load thread list on mount.
  useEffect(() => {
    if (!window.agentApi) {
      actions.setError("Preload script not loaded — check the Electron main process logs.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const [threadsResult, configResult] = await Promise.all([
        window.agentApi.threads.list({}),
        window.agentApi.modelConfig.get(),
      ]);
      if (cancelled) return;
      if (threadsResult.ok) actions.setThreads(threadsResult.value);
      if (configResult.ok) actions.setModelConfig(configResult.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

  // Subscribe to SSE for the active thread.
  useEffect(() => {
    if (!state.activeThreadId) return;
    const threadId = state.activeThreadId;
    void window.agentApi.sse.subscribe({ threadId });
    const off = window.agentApi.sse.onEvent((event) => {
      if (!("threadId" in event) || event.threadId !== threadId) return;
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
      } else if (event.kind === "turn_started") {
        // No-op; we already have the turn record from startTurn.
      } else if (event.kind === "approval_requested") {
        // The ApprovalBlock in the timeline will handle the user interaction.
      }
    });
    return () => {
      off();
      void window.agentApi.sse.unsubscribe({ threadId });
    };
  }, [state.activeThreadId, actions]);

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
    const workspace = window.prompt("Workspace path? (empty for now)", "") ?? "";
    const result = await window.agentApi.threads.create({
      title: "New thread",
      workspace,
      mode: "code",
    });
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    await refreshThreads();
    actions.selectThread(result.value as ThreadRecord, []);
  }, [actions, refreshThreads]);

  const onSend = useCallback(async () => {
    if (!state.activeThreadId) return;
    const text = state.composer.text;
    actions.setComposerText("");
    const result = await window.agentApi.turns.start({
      threadId: state.activeThreadId,
      text,
      model: state.modelConfig.model,
      reasoningEffort: state.modelConfig.model_reasoning_effort,
    });
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    actions.turnStarted(result.value);
  }, [state.activeThreadId, state.composer.text, state.modelConfig, actions]);

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
