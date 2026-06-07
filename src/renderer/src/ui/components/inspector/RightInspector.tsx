import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import type { Item, ToolItem } from "../../../../../shared/agent-contracts";

export function RightInspector(): ReactElement | null {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  if (!state.rightPanelMode) return null;

  return (
    <aside className="ds-right-inspector" style={{ width: state.rightSidebarWidth }}>
      <div className="ds-right-inspector-header">
        <strong style={{ fontSize: "var(--ds-size-title)" }}>
          {state.rightPanelMode === "changes"
            ? t("inspector.changes")
            : state.rightPanelMode === "todo"
              ? t("inspector.todo")
              : state.rightPanelMode === "plan"
                ? t("inspector.plan")
                : t("inspector.file")}
        </strong>
        <button className="ds-pill" onClick={() => actions.closeRightPanel()}>
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
  const toolItems = state.items.filter((i): i is ToolItem => i.kind === "tool");
  if (toolItems.length === 0) {
    return <div style={{ color: "var(--ds-text-faint)" }}>{t("inspector.noChanges")}</div>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {toolItems.map((item) => (
        <li
          key={item.id}
          style={{
            background: "var(--ds-surface-card)",
            border: "1px solid var(--ds-border-muted)",
            borderRadius: "var(--ds-radius-md)",
            padding: 10,
          }}
        >
          <div style={{ fontSize: "var(--ds-size-label)" }}>{item.name}</div>
          <pre
            style={{
              margin: "6px 0 0",
              whiteSpace: "pre-wrap",
              fontFamily: "var(--ds-font-mono)",
              fontSize: "var(--ds-size-caption)",
              color: "var(--ds-text-muted)",
            }}
          >
            {JSON.stringify(item.args, null, 2)}
          </pre>
        </li>
      ))}
    </ul>
  );
}

function TodoPanel(): ReactElement {
  const { t } = useTranslation();
  return <div style={{ color: "var(--ds-text-faint)" }}>{t("inspector.todoEmpty")}</div>;
}

function PlanPanel(): ReactElement {
  const { t } = useTranslation();
  return <div style={{ color: "var(--ds-text-faint)" }}>{t("inspector.planEmpty")}</div>;
}

function FilePanel(): ReactElement {
  const { t } = useTranslation();
  return <div style={{ color: "var(--ds-text-faint)" }}>{t("inspector.fileEmpty")}</div>;
}

// Keep Item import non-tree-shaken in case external callers reference it.
export type { Item };
