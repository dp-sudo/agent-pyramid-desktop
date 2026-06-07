import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MODEL_REASONING_EFFORTS } from "../../../../../shared/agent-contracts";
import type {
  ModelConfigProfile,
  ModelReasoningEffort,
} from "../../../../../shared/agent-contracts";

interface FloatingComposerModelPickerProps {
  profiles: ModelConfigProfile[];
  selectedModel: string;
  selectedProfileId?: string;
  selectedReasoningEffort?: ModelReasoningEffort;
  onSelectModel(profile: ModelConfigProfile): void;
  onSelectReasoningEffort(effort: ModelReasoningEffort): void;
}

export function FloatingComposerModelPicker({
  profiles,
  selectedModel,
  selectedProfileId,
  selectedReasoningEffort,
  onSelectModel,
  onSelectReasoningEffort,
}: FloatingComposerModelPickerProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ds-composer-popover">
      <div className="ds-composer-popover-section">
        <div className="ds-composer-popover-label">{t("composer.model")}</div>
        {profiles.map((profile) => {
          const active =
            profile.id === selectedProfileId || profile.config.model === selectedModel;
          return (
            <button
              key={profile.id}
              type="button"
              className={`ds-composer-menu-row ${active ? "is-active" : ""}`}
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
