import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import { Pill } from "../primitives/Pill";

export function WorkbenchTopBar(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const isBusy = state.inFlightTurn !== null;
  return (
    <header className="ds-topbar-surface">
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span style={{ fontSize: "var(--ds-size-title)", fontWeight: 600 }}>
          {state.activeThreadId ? t("chat.activeSession") : t("chat.noSession")}
        </span>
        {state.activeThreadId ? (
          <span style={{ fontSize: "var(--ds-size-caption)", color: "var(--ds-text-faint)" }}>
            {t("chat.threadId", { id: state.activeThreadId.slice(0, 8) })}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {isBusy ? (
          <span
            className="ds-pill"
            style={{
              background: "var(--ds-warning-soft)",
              color: "var(--ds-text)",
              border: "1px solid var(--ds-border)",
            }}
          >
            {t("chat.running")}
          </span>
        ) : null}
        <Pill
          onClick={() => actions.openRightPanel("changes")}
          accent={state.rightPanelMode === "changes"}
        >
          {t("inspector.changes")}
        </Pill>
        <Pill
          onClick={() => actions.openRightPanel("todo")}
          accent={state.rightPanelMode === "todo"}
        >
          {t("inspector.todo")}
        </Pill>
        <Pill
          onClick={state.rightPanelMode === null
            ? () => actions.openRightPanel("changes")
            : () => actions.closeRightPanel()}
        >
          {state.rightPanelMode === null ? t("inspector.open") : t("inspector.close")}
        </Pill>
      </div>
    </header>
  );
}
