import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import {
  RIGHT_INSPECTOR_DEFAULT_WIDTH,
  RIGHT_INSPECTOR_MAX_WIDTH,
  RIGHT_INSPECTOR_MIN_WIDTH,
} from "../../preferences";
import { summarizeToolItemHeader, summarizeToolItemPreview } from "../chat/timeline-model";
import type {
  CheckpointMeta,
  Item,
  PlanItem,
  PlanStepStatus,
  ToolItem,
} from "../../../../../shared/agent-contracts";

const RIGHT_INSPECTOR_KEYBOARD_STEP = 24;
const RIGHT_INSPECTOR_CHANGE_LIMIT = 80;
const RIGHT_INSPECTOR_CHANGE_DETAIL_MAX_CHARS = 2000;
export const RIGHT_INSPECTOR_REGION_ID = "workbench-right-inspector";
export const RIGHT_INSPECTOR_TITLE_ID = "workbench-right-inspector-title";
export const RIGHT_INSPECTOR_CLOSE_BUTTON_TEXT = "x";

export function RightInspector(): ReactElement | null {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const [resizerDragging, setResizerDragging] = useState(false);
  if (!state.rightPanelMode) return null;
  const titleKey = state.rightPanelMode === "changes"
    ? "inspector.changes"
    : state.rightPanelMode === "checkpoints"
      ? "inspector.checkpoints"
      : state.rightPanelMode === "todo"
        ? "inspector.todo"
        : "inspector.plan";

  return (
    <aside
      id={RIGHT_INSPECTOR_REGION_ID}
      className="ds-right-inspector"
      style={{ width: state.rightSidebarWidth }}
      aria-labelledby={RIGHT_INSPECTOR_TITLE_ID}
    >
      <div
        className={getRightInspectorResizerClassName(resizerDragging)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("common.resizeRightInspector")}
        aria-valuemin={RIGHT_INSPECTOR_MIN_WIDTH}
        aria-valuemax={RIGHT_INSPECTOR_MAX_WIDTH}
        aria-valuenow={state.rightSidebarWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          const next = getNextRightInspectorWidth(state.rightSidebarWidth, event.key);
          if (next === state.rightSidebarWidth) return;
          event.preventDefault();
          actions.setRightSidebarWidth(next);
        }}
        onPointerDown={(event) => {
          const startX = event.clientX;
          const startWidth = state.rightSidebarWidth;
          const target = event.currentTarget;
          setResizerDragging(true);
          target.setPointerCapture(event.pointerId);
          const onMove = (ev: PointerEvent): void => {
            const dx = startX - ev.clientX;
            actions.setRightSidebarWidth(clampRightInspectorWidth(startWidth + dx));
          };
          const clearDragListeners = (): void => {
            setResizerDragging(false);
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", clearDragListeners);
            target.removeEventListener("pointercancel", clearDragListeners);
          };
          target.addEventListener("pointermove", onMove);
          target.addEventListener("pointerup", clearDragListeners);
          target.addEventListener("pointercancel", clearDragListeners);
        }}
        onDoubleClick={() => {
          actions.setRightSidebarWidth(getResetRightInspectorWidth());
        }}
      />
      <div className="ds-right-inspector-header">
        <strong id={RIGHT_INSPECTOR_TITLE_ID} className="ds-right-inspector-title">
          {t(titleKey)}
        </strong>
        <button
          type="button"
          className="ds-pill"
          onClick={() => actions.closeRightPanel()}
          aria-label={t("inspector.close")}
          title={t("inspector.close")}
        >
          {RIGHT_INSPECTOR_CLOSE_BUTTON_TEXT}
        </button>
      </div>
      <div className="ds-right-inspector-body">
        {state.rightPanelMode === "changes" ? <ChangesPanel /> : null}
        {state.rightPanelMode === "checkpoints" ? <CheckpointsPanel /> : null}
        {state.rightPanelMode === "todo" ? <TodoPanel /> : null}
        {state.rightPanelMode === "plan" ? <PlanPanel /> : null}
      </div>
    </aside>
  );
}

function CheckpointsPanel(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const activeThread = state.activeThread?.mode === "code" ? state.activeThread : null;
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async (): Promise<void> => {
    if (!activeThread) {
      setCheckpoints([]);
      return;
    }
    setLoading(true);
    try {
      const result = await window.agentApi.checkpoints.list({ threadId: activeThread.id });
      if (result.ok) {
        setCheckpoints(result.value.checkpoints);
      } else {
        actions.setError(result.message);
      }
    } finally {
      setLoading(false);
    }
  }, [actions, activeThread]);

  useEffect(() => {
    void loadCheckpoints();
  }, [loadCheckpoints, state.items]);

  const rewind = useCallback(
    async (checkpoint: CheckpointMeta, rewindSession: boolean): Promise<void> => {
      if (!activeThread) return;
      setPendingTurnId(checkpoint.turnId);
      setStatusMessage(null);
      try {
        const result = await window.agentApi.checkpoints.rewind({
          threadId: activeThread.id,
          turnId: checkpoint.turnId,
          rewindSession,
        });
        if (!result.ok) {
          actions.setError(result.message);
          return;
        }
        actions.setError(null);
        setStatusMessage(t("checkpoints.rewindSuccess", {
          restored: result.value.restoredPaths.length,
          deleted: result.value.deletedPaths.length,
        }));
        if (rewindSession) {
          const itemsResult = await window.agentApi.turns.get(activeThread.id);
          if (itemsResult.ok) {
            actions.selectThread(activeThread, itemsResult.value.items);
          } else {
            actions.setError(itemsResult.message);
          }
        }
        await loadCheckpoints();
      } finally {
        setPendingTurnId(null);
      }
    },
    [actions, activeThread, loadCheckpoints, t],
  );

  if (!activeThread) {
    return <div className="ds-inspector-empty">{t("checkpoints.codeOnly")}</div>;
  }
  if (loading && checkpoints.length === 0) {
    return <div className="ds-inspector-empty">{t("checkpoints.loading")}</div>;
  }
  if (checkpoints.length === 0) {
    return <div className="ds-inspector-empty">{t("checkpoints.empty")}</div>;
  }

  return (
    <div className="ds-checkpoint-panel">
      {statusMessage ? <p className="ds-checkpoint-status">{statusMessage}</p> : null}
      <ul className="ds-checkpoint-list">
        {checkpoints.map((checkpoint) => (
          <li key={checkpoint.turnId} className="ds-checkpoint-item">
            <div className="ds-checkpoint-header">
              <strong>{formatCheckpointPrompt(checkpoint.prompt, t)}</strong>
              <span>{formatCheckpointTimestamp(checkpoint.createdAt)}</span>
            </div>
            <p className="ds-checkpoint-files">
              {checkpoint.files.length > 0
                ? t("checkpoints.fileCount", { count: checkpoint.files.length })
                : t("checkpoints.noFiles")}
            </p>
            {checkpoint.files.length > 0 ? (
              <ul className="ds-checkpoint-file-list">
                {checkpoint.files.slice(0, 4).map((file) => (
                  <li key={`${checkpoint.turnId}:${file.path}`}>
                    <span>{file.operation}</span>
                    <strong>{file.path}</strong>
                  </li>
                ))}
              </ul>
            ) : null}
            {checkpoint.files.length > 4 ? (
              <p className="ds-checkpoint-files">
                {t("checkpoints.moreFiles", { count: checkpoint.files.length - 4 })}
              </p>
            ) : null}
            <div className="ds-checkpoint-actions">
              <button
                type="button"
                className="ds-pill"
                disabled={!checkpoint.canRewindCode || pendingTurnId !== null}
                onClick={() => {
                  void rewind(checkpoint, false);
                }}
              >
                {t("checkpoints.rewindCode")}
              </button>
              <button
                type="button"
                className="ds-pill"
                disabled={!checkpoint.canRewindSession || pendingTurnId !== null}
                onClick={() => {
                  void rewind(checkpoint, true);
                }}
              >
                {t("checkpoints.rewindBoth")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangesPanel(): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const changes = useMemo(() => summarizeInspectorChanges(state.items, t), [state.items, t]);
  if (changes.length === 0) {
    return <div className="ds-inspector-empty">{t("inspector.noChanges")}</div>;
  }
  return (
    <ul className="ds-inspector-change-list">
      {changes.map((item) => (
        <li key={item.id} className={`ds-inspector-change-item is-${item.tone}`}>
          <div className="ds-inspector-item-header">
            <strong>{item.title}</strong>
            <span>{item.statusText}</span>
          </div>
          {item.detail ? <pre>{item.detail}</pre> : null}
          {item.detailTruncated ? (
            <p className="ds-inspector-detail-note">
              {t("inspector.changeDetailTruncated", { count: item.hiddenCharCount })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TodoPanel(): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const todos = useMemo(() => deriveInspectorTodos(state.items, t), [state.items, t]);
  if (todos.length === 0) {
    return <div className="ds-inspector-empty">{t("inspector.todoEmpty")}</div>;
  }
  return (
    <ul className="ds-inspector-todo-list">
      {todos.map((todo) => (
        <li key={todo.id} className={`ds-inspector-todo-item is-${todo.tone}`}>
          <span>{todo.label}</span>
          <strong>{todo.title}</strong>
        </li>
      ))}
    </ul>
  );
}

export function formatCheckpointPrompt(
  prompt: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  maxChars = 80,
): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return t("checkpoints.untitled");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}...`;
}

export function formatCheckpointTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function PlanPanel(): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const latest = useMemo(() => findLatestPlanItem(state.items), [state.items]);
  if (!latest) {
    return <div className="ds-inspector-empty">{t("inspector.planEmpty")}</div>;
  }
  const progress = summarizePlanProgress(latest.steps);
  return (
    <div className="ds-inspector-plan">
      <div className="ds-inspector-plan-summary">
        <strong>{latest.title ?? t("inspector.plan")}</strong>
        <span>
          {t("inspector.planProgress", {
            completed: progress.completed,
            total: progress.total,
          })}
        </span>
      </div>
      <div className="ds-inspector-plan-meter" aria-hidden="true">
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <ol className="ds-inspector-plan-steps">
        {latest.steps.map((step) => (
          <li key={step.id} className={`is-${step.status}`}>
            <span>{labelForPlanStepStatus(step.status, t)}</span>
            <strong>{step.title}</strong>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function clampRightInspectorWidth(width: number): number {
  return Math.min(RIGHT_INSPECTOR_MAX_WIDTH, Math.max(RIGHT_INSPECTOR_MIN_WIDTH, width));
}

export function getNextRightInspectorWidth(
  currentWidth: number,
  key: string,
  step = RIGHT_INSPECTOR_KEYBOARD_STEP,
): number {
  if (key === "ArrowLeft") return clampRightInspectorWidth(currentWidth + step);
  if (key === "ArrowRight") return clampRightInspectorWidth(currentWidth - step);
  if (key === "Home") return RIGHT_INSPECTOR_MIN_WIDTH;
  if (key === "End") return RIGHT_INSPECTOR_MAX_WIDTH;
  return currentWidth;
}

export function getResetRightInspectorWidth(): number {
  return RIGHT_INSPECTOR_DEFAULT_WIDTH;
}

export function getRightInspectorResizerClassName(isDragging: boolean): string {
  return isDragging
    ? "ds-right-inspector-resizer is-dragging"
    : "ds-right-inspector-resizer";
}

export interface InspectorChangeSummary {
  id: string;
  title: string;
  detail: string;
  detailTruncated: boolean;
  hiddenCharCount: number;
  statusText: string;
  tone: "neutral" | "running" | "success" | "danger";
}

export interface InspectorTodo {
  id: string;
  title: string;
  label: string;
  tone: "neutral" | "running" | "danger";
}

export function summarizeInspectorChanges(
  items: readonly Item[],
  t: (key: string, options?: Record<string, unknown>) => string,
  limit = RIGHT_INSPECTOR_CHANGE_LIMIT,
  detailMaxChars = RIGHT_INSPECTOR_CHANGE_DETAIL_MAX_CHARS,
): InspectorChangeSummary[] {
  return getRecentInspectorToolItems(items, limit)
    .map((item) => {
      const display = summarizeToolItemPreview(item, t, detailMaxChars);
      return {
        id: item.id,
        title: display.title,
        detail: display.detail,
        detailTruncated: display.detailTruncated,
        hiddenCharCount: display.hiddenCharCount,
        statusText: display.statusText,
        tone: display.tone,
      };
    });
}

export function getRecentInspectorToolItems(
  items: readonly Item[],
  limit = RIGHT_INSPECTOR_CHANGE_LIMIT,
): ToolItem[] {
  const normalizedLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const tools: ToolItem[] = [];
  for (let index = items.length - 1; index >= 0 && tools.length < normalizedLimit; index -= 1) {
    const item = items[index];
    if (item.kind === "tool") {
      tools.push(item);
    }
  }
  return tools.reverse();
}

export function deriveInspectorTodos(
  items: readonly Item[],
  t: (key: string, options?: Record<string, unknown>) => string,
): InspectorTodo[] {
  const todos: InspectorTodo[] = [];
  for (const item of items) {
    if (item.kind === "approval" && item.decision === undefined) {
      todos.push({
        id: item.id,
        title: item.toolName,
        label: t("inspector.todoApproval"),
        tone: "running",
      });
      continue;
    }

    if (item.kind === "tool" && item.status === "failed") {
      todos.push({
        id: item.id,
        title: summarizeToolItemHeader(item, t).title,
        label: t("inspector.todoFailedTool"),
        tone: "danger",
      });
      continue;
    }

    if (item.kind === "system" && item.level === "error") {
      todos.push({
        id: item.id,
        title: item.text,
        label: t("inspector.todoRuntimeError"),
        tone: "danger",
      });
    }
  }

  const latestPlan = findLatestPlanItem(items);
  if (latestPlan) {
    for (const step of latestPlan.steps) {
      if (step.status === "completed") continue;
      todos.push({
        id: `${latestPlan.id}:${step.id}`,
        title: step.title,
        label: labelForPlanStepStatus(step.status, t),
        tone: step.status === "in_progress" ? "running" : "neutral",
      });
    }
  }

  return todos;
}

export function findLatestPlanItem(items: readonly Item[]): PlanItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "plan") return item;
  }
  return null;
}

export function summarizePlanProgress(
  steps: PlanItem["steps"],
): { completed: number; total: number; percent: number } {
  const total = steps.length;
  const completed = steps.filter((step) => step.status === "completed").length;
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

function labelForPlanStepStatus(
  status: PlanStepStatus,
  t: (key: string) => string,
): string {
  switch (status) {
    case "pending":
      return t("inspector.planStatusPending");
    case "in_progress":
      return t("inspector.planStatusInProgress");
    case "completed":
      return t("inspector.planStatusCompleted");
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
