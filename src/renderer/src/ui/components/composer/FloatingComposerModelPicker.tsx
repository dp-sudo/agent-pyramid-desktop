import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MODEL_REASONING_EFFORTS } from "../../../../../shared/agent-contracts";
import type {
  ModelReasoningEffort,
  RendererModelConfigProfile,
} from "../../../../../shared/agent-contracts";

interface FloatingComposerModelPickerProps {
  id?: string;
  profiles: RendererModelConfigProfile[];
  selectedModel: string;
  selectedProfileId?: string;
  selectedReasoningEffort?: ModelReasoningEffort;
  onSelectModel(profile: RendererModelConfigProfile): void;
  onSelectReasoningEffort(effort: ModelReasoningEffort): void;
}

export function FloatingComposerModelPicker({
  id,
  profiles,
  selectedModel,
  selectedProfileId,
  selectedReasoningEffort,
  onSelectModel,
  onSelectReasoningEffort,
}: FloatingComposerModelPickerProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      id={id}
      className="ds-composer-popover is-model-picker"
      role="dialog"
      aria-label={t("composer.model")}
    >
      <div className="ds-composer-popover-section">
        <div className="ds-composer-popover-label">{t("composer.model")}</div>
        {profiles.length === 0 ? (
          <div className="ds-composer-empty">{t("composer.noModelProfiles")}</div>
        ) : null}
        {profiles.map((profile) => {
          const active = selectedProfileId
            ? profile.id === selectedProfileId
            : profile.config.model === selectedModel;
          return (
            <button
              key={profile.id}
              type="button"
              className={`ds-composer-menu-row ${active ? "is-active" : ""}`}
              aria-pressed={active}
              onClick={() => onSelectModel(profile)}
            >
              <span>{profile.name}</span>
              <span>{profile.config.model}</span>
            </button>
          );
        })}
      </div>
      <div className="ds-composer-popover-section">
        <div className="ds-composer-popover-label">
          {t("composer.reasoningEffort")}
        </div>
        <div className="ds-segmented-control">
          {MODEL_REASONING_EFFORTS.map((effort) => (
            <button
              key={effort}
              type="button"
              className={effort === selectedReasoningEffort ? "is-active" : ""}
              aria-pressed={effort === selectedReasoningEffort}
              onClick={() => onSelectReasoningEffort(effort)}
            >
              {t(`settings.efforts.${effort}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
