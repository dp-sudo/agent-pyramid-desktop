import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import {
  RIGHT_INSPECTOR_MAX_WIDTH,
  RIGHT_INSPECTOR_MIN_WIDTH,
} from "../../preferences";
import { summarizeToolItem } from "../chat/timeline-model";
import type {
  Item,
  PlanItem,
  PlanStepStatus,
  ToolItem,
} from "../../../../../shared/agent-contracts";

const RIGHT_INSPECTOR_KEYBOARD_STEP = 24;

export function RightInspector(): ReactElement | null {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  if (!state.rightPanelMode) return null;

  return (
    <aside className="ds-right-inspector" style={{ width: state.rightSidebarWidth }}>
      <div
        className="ds-right-inspector-resizer"
        role="separator"
        aria-orientation="vertical"
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
          target.setPointerCapture(event.pointerId);
          const onMove = (ev: PointerEvent): void => {
            const dx = startX - ev.clientX;
            actions.setRightSidebarWidth(clampRightInspectorWidth(startWidth + dx));
          };
          const onUp = (): void => {
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", onUp);
          };
          target.addEventListener("pointermove", onMove);
          target.addEventListener("pointerup", onUp);
        }}
      />
      <div className="ds-right-inspector-header">
        <strong className="ds-right-inspector-title">
          {state.rightPanelMode === "changes"
            ? t("inspector.changes")
            : state.rightPanelMode === "todo"
              ? t("inspector.todo")
              : state.rightPanelMode === "plan"
                ? t("inspector.plan")
                : t("inspector.file")}
        </strong>
        <button
          type="button"
          className="ds-pill"
          onClick={() => actions.closeRightPanel()}
          aria-label={t("inspector.close")}
          title={t("inspector.close")}
        >
          ✕
        </button>
      </div>
      <div className="ds-right-inspector-body">
        {state.rightPanelMode === "changes" ? <ChangesPanel /> : null}
        {state.rightPanelMode === "todo" ? <TodoPanel /> : null}
        {state.rightPanelMode === "plan" ? <PlanPanel /> : null}
        {state.rightPanelMode === "file" ? <FilePanel /> : null}
      </div>
    </aside>
  );
}

function ChangesPanel(): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const changes = summarizeInspectorChanges(state.items, t);
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
        </li>
      ))}
    </ul>
  );
}

function TodoPanel(): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const todos = deriveInspectorTodos(state.items, t);
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

function PlanPanel(): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const plans = state.items.filter((item): item is PlanItem => item.kind === "plan");
  const latest = plans.at(-1);
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

function FilePanel(): ReactElement {
  const { t } = useTranslation();
  return <div className="ds-inspector-empty">{t("inspector.fileEmpty")}</div>;
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

export interface InspectorChangeSummary {
  id: string;
  title: string;
  detail: string;
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
  items: Item[],
  t: (key: string, options?: Record<string, unknown>) => string,
): InspectorChangeSummary[] {
  return items
    .filter((item): item is ToolItem => item.kind === "tool")
    .map((item) => {
      const display = summarizeToolItem(item, t);
      return {
        id: item.id,
        title: display.title,
        detail: display.detail,
        statusText: display.statusText,
        tone: display.tone,
      };
    });
}

export function deriveInspectorTodos(
  items: Item[],
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
        title: summarizeToolItem(item, t).title,
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

  const latestPlan = items.filter((item): item is PlanItem => item.kind === "plan").at(-1);
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
