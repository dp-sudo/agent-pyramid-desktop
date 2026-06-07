import type { ChangeEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import { Pill } from "../primitives/Pill";

interface FloatingComposerProps {
  onSend: () => void;
  onInterrupt: () => void;
  disabled?: boolean;
}

export function FloatingComposer({
  onSend,
  onInterrupt,
  disabled,
}: FloatingComposerProps): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const busy = state.inFlightTurn !== null;

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy && state.composer.text.trim().length > 0) onSend();
    }
  }

  return (
    <div className="ds-composer-shell" style={{ width: "100%" }}>
      <textarea
        value={state.composer.text}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => actions.setComposerText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("composer.placeholder")}
        disabled={disabled}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px 10px",
          borderTop: "1px solid var(--ds-border-muted)",
        }}
      >
        <span style={{ fontSize: "var(--ds-size-caption)", color: "var(--ds-text-faint)" }}>
          {t("composer.model")}: {state.composer.model}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {busy ? (
            <Pill onClick={onInterrupt}>{t("composer.interrupt")}</Pill>
          ) : (
            <Pill
              onClick={onSend}
              accent
              disabled={disabled || state.composer.text.trim().length === 0}
            >
              {t("composer.send")}
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}
