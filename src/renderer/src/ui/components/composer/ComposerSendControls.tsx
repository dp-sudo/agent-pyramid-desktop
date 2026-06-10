import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { WorkbenchState } from "../../store/WorkbenchContext";
import { Pill } from "../primitives/Pill";

export function ComposerSendControls({
  runtimeBusy,
  sendPending,
  sendDisabled,
  attachmentPending,
  attachmentPendingCount,
  mode,
  goalMode,
  showModeChips,
  onInterrupt,
  onSend,
}: {
  runtimeBusy: boolean;
  sendPending: boolean;
  sendDisabled: boolean;
  attachmentPending: boolean;
  attachmentPendingCount: number;
  mode: WorkbenchState["composer"]["mode"];
  goalMode: boolean;
  showModeChips: boolean;
  onInterrupt(): void;
  onSend(): void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="ds-composer-toolbar-actions">
      {attachmentPending ? (
        <span className="ds-composer-status" role="status" aria-live="polite">
          {t("composer.attachmentsProcessing", { count: attachmentPendingCount })}
        </span>
      ) : null}
      {showModeChips && mode === "plan" ? (
        <span className="ds-composer-mode-chip">{t("composer.planMode")}</span>
      ) : null}
      {showModeChips && goalMode ? (
        <span className="ds-composer-mode-chip">{t("composer.goalMode")}</span>
      ) : null}
      {runtimeBusy ? (
        <Pill onClick={onInterrupt}>{t("composer.interrupt")}</Pill>
      ) : (
        <Pill
          onClick={onSend}
          accent
          disabled={sendDisabled}
        >
          {sendPending ? t("composer.sending") : t("composer.send")}
        </Pill>
      )}
    </div>
  );
}
