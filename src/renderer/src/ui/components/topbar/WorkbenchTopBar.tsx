import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench, type RightPanelMode } from "../../store/WorkbenchContext";

export function WorkbenchTopBar(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const isBusy = state.inFlightTurn !== null;
  const inspectorModes: Array<Exclude<RightPanelMode, null | "file">> = [
    "changes",
    "todo",
    "plan",
  ];
  return (
    <header className="ds-topbar-surface">
      <div className="ds-topbar-session">
        <span className="ds-topbar-title">
          {state.activeThreadId ? t("chat.activeSession") : t("chat.noSession")}
        </span>
        {state.activeThreadId ? (
          <span className="ds-topbar-meta">
            {t("chat.threadId", { id: state.activeThreadId.slice(0, 8) })}
          </span>
        ) : null}
        {state.workspaceRoot ? (
          <span className="ds-topbar-workspace" title={state.workspaceRoot}>
            {state.workspaceRoot}
          </span>
        ) : null}
      </div>
      <div className="ds-topbar-actions">
        {isBusy ? (
          <span className="ds-topbar-running">
            {t("chat.running")}
          </span>
        ) : null}
        <div className="ds-segmented-control ds-topbar-inspector-tabs" role="group">
          {inspectorModes.map((mode) => (
            <button
              key={mode}
              type="button"
              className={state.rightPanelMode === mode ? "is-active" : ""}
              aria-pressed={state.rightPanelMode === mode}
              onClick={() => actions.openRightPanel(mode)}
            >
              {t(`inspector.${mode}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ds-pill"
          onClick={state.rightPanelMode === null
            ? () => actions.openRightPanel("changes")
            : () => actions.closeRightPanel()}
        >
          {getInspectorToggleLabel(state.rightPanelMode, t)}
        </button>
      </div>
    </header>
  );
}

export function getInspectorToggleLabel(
  mode: RightPanelMode,
  t: (key: string) => string,
): string {
  return mode === null ? t("inspector.open") : t("inspector.close");
}
