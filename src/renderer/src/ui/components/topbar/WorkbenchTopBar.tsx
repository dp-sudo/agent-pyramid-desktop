import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  useWorkbench,
  type RightPanelMode,
} from "../../store/WorkbenchContext";
import { RIGHT_INSPECTOR_REGION_ID } from "../inspector/RightInspector";
import { BrandMark } from "../primitives/BrandMark";
import {
  THREAD_APPROVAL_POLICIES,
  THREAD_SANDBOX_MODES,
  type ThreadApprovalPolicy,
  type ThreadSandboxMode,
} from "../../../../../shared/agent-contracts";

export type ThreadSafetyUpdate =
  | { approvalPolicy: ThreadApprovalPolicy }
  | { sandboxMode: ThreadSandboxMode };

export interface WorkbenchTopBarProps {
  onUpdateThreadSafety?: (patch: ThreadSafetyUpdate) => void | Promise<void>;
  safetyUpdating?: boolean;
}

export function WorkbenchTopBar(props: WorkbenchTopBarProps): ReactElement {
  const { onUpdateThreadSafety, safetyUpdating = false } = props;
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const isBusy = getActiveThreadInFlightTurn(state) !== null;
  const safetyControlsDisabled = !state.activeThread ||
    isBusy ||
    safetyUpdating ||
    !onUpdateThreadSafety;
  const inspectorModes: Array<Exclude<RightPanelMode, null>> = [
    "changes",
    "checkpoints",
    "todo",
    "plan",
  ];
  return (
    <header className="ds-topbar-surface">
      <div className="ds-topbar-brand">
        <BrandMark size={18} />
        <span className="ds-topbar-brand-wordmark">Workbench</span>
      </div>
      <div className="ds-topbar-session">
        <span
          className="ds-topbar-title"
          title={state.activeThreadId
            ? t("chat.threadId", { id: state.activeThreadId })
            : undefined}
        >
          {state.activeThreadId ? t("chat.activeSession") : t("chat.noSession")}
        </span>
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
        {state.activeThread ? (
          <div className="ds-topbar-safety" aria-label={t("chat.safetyControls")}>
            <select
              className="ds-topbar-safety-select"
              aria-label={t("chat.approvalPolicy")}
              title={safetyControlsDisabled && isBusy
                ? t("chat.safetyControlsBusy")
                : t("chat.approvalPolicy")}
              value={state.activeThread.approvalPolicy}
              disabled={safetyControlsDisabled}
              onChange={(event) =>
                void onUpdateThreadSafety?.({
                  approvalPolicy: event.currentTarget.value as ThreadApprovalPolicy,
                })}
            >
              {THREAD_APPROVAL_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {t(`settings.approvalPolicies.${policy}`)}
                </option>
              ))}
            </select>
            <select
              className="ds-topbar-safety-select"
              aria-label={t("chat.sandboxMode")}
              title={safetyControlsDisabled && isBusy
                ? t("chat.safetyControlsBusy")
                : t("chat.sandboxMode")}
              value={state.activeThread.sandboxMode}
              disabled={safetyControlsDisabled}
              onChange={(event) =>
                void onUpdateThreadSafety?.({
                  sandboxMode: event.currentTarget.value as ThreadSandboxMode,
                })}
            >
              {THREAD_SANDBOX_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`settings.sandboxModes.${mode}`)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="ds-segmented-control ds-topbar-inspector-tabs" role="group">
          {inspectorModes.map((mode) => (
            <button
              key={mode}
              type="button"
              className={state.rightPanelMode === mode ? "is-active" : ""}
              aria-pressed={state.rightPanelMode === mode}
              aria-controls={RIGHT_INSPECTOR_REGION_ID}
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
          aria-controls={RIGHT_INSPECTOR_REGION_ID}
          aria-expanded={isInspectorExpanded(state.rightPanelMode)}
        >
          {getInspectorToggleLabel(state.rightPanelMode, t)}
        </button>
      </div>
    </header>
  );
}

export function isInspectorExpanded(mode: RightPanelMode): boolean {
  return mode !== null;
}

export function getInspectorToggleLabel(
  mode: RightPanelMode,
  t: (key: string) => string,
): string {
  return mode === null ? t("inspector.open") : t("inspector.close");
}
