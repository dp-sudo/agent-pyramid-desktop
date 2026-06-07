import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./store/WorkbenchContext";
import { Pill } from "./components/primitives/Pill";

export function SettingsPlaceholder(): ReactElement {
  const { t } = useTranslation();
  const { actions } = useWorkbench();
  return (
    <div
      className="ds-stage-surface"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <strong style={{ fontSize: "var(--ds-size-title-lg)" }}>{t("settings.title")}</strong>
      <span style={{ color: "var(--ds-text-faint)" }}>{t("settings.comingSoon")}</span>
      <Pill onClick={() => actions.setRoute("code")}>{t("settings.backToWorkbench")}</Pill>
    </div>
  );
}
