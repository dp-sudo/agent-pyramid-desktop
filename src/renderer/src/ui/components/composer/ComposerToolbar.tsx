import type { ChangeEvent, ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import {
  SUPPORTED_ATTACHMENT_MIME_TYPES,
  type ModelConfigProfile,
} from "../../../../../shared/agent-contracts";
import { FloatingComposerModelPicker } from "./FloatingComposerModelPicker";
import { ComposerSendControls } from "./ComposerSendControls";
import type { FloatingComposerVariant } from "./FloatingComposer";

const COMPOSER_IMAGE_ACCEPT = SUPPORTED_ATTACHMENT_MIME_TYPES.join(",");

export function ComposerToolbar({
  variant,
  disabled,
  runtimeBusy,
  sendPending,
  sendDisabled,
  attachmentPending,
  attachmentPendingCount,
  fileInputRef,
  attachmentsEnabled,
  modelPickerEnabled,
  modeControlsEnabled,
  menuOpen,
  pickerOpen,
  onImageSelected,
  onToggleMenu,
  onCloseMenu,
  onTogglePicker,
  onInterrupt,
  onSend,
}: {
  variant: FloatingComposerVariant;
  disabled: boolean;
  runtimeBusy: boolean;
  sendPending: boolean;
  sendDisabled: boolean;
  attachmentPending: boolean;
  attachmentPendingCount: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  attachmentsEnabled: boolean;
  modelPickerEnabled: boolean;
  modeControlsEnabled: boolean;
  menuOpen: boolean;
  pickerOpen: boolean;
  onImageSelected(event: ChangeEvent<HTMLInputElement>): void;
  onToggleMenu(): void;
  onCloseMenu(): void;
  onTogglePicker(): void;
  onInterrupt(): void;
  onSend(): void;
}): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const showImagePicker = attachmentsEnabled && state.basicPreferences.allowComposerImageUpload;
  const showMenuButton = showImagePicker || modeControlsEnabled;

  function handleSelectModel(profile: ModelConfigProfile): void {
    actions.setComposerModel(profile.config.model, profile.id);
    actions.setComposerReasoningEffort(profile.config.model_reasoning_effort);
    onTogglePicker();
  }

  return (
    <div className={`ds-composer-toolbar is-${variant}`}>
      {attachmentsEnabled ? (
        <input
          ref={fileInputRef}
          type="file"
          accept={COMPOSER_IMAGE_ACCEPT}
          multiple
          hidden
          disabled={!state.basicPreferences.allowComposerImageUpload}
          onChange={onImageSelected}
        />
      ) : null}
      <div className="ds-composer-toolbar-left">
        {showMenuButton || modelPickerEnabled ? (
          <>
            {showMenuButton ? (
              <button
                type="button"
                className="ds-composer-tool-button"
                onClick={onToggleMenu}
                disabled={disabled || runtimeBusy || sendPending}
                title={t("composer.more")}
                aria-label={t("composer.more")}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                {...(menuOpen ? { "aria-controls": "composer-tool-menu" } : {})}
              >
                +
              </button>
            ) : null}
            {showMenuButton && menuOpen ? (
              <div
                id="composer-tool-menu"
                className="ds-composer-popover is-menu"
                role="menu"
              >
                {showImagePicker ? (
                  <button
                    type="button"
                    className="ds-composer-menu-row"
                    role="menuitem"
                    onClick={() => {
                      fileInputRef.current?.click();
                      onCloseMenu();
                    }}
                  >
                    <span>{t("composer.addImage")}</span>
                    <span>PNG/JPEG/WebP/GIF</span>
                  </button>
                ) : null}
                {modeControlsEnabled ? (
                  <>
                    <button
                      type="button"
                      className={`ds-composer-menu-row ${state.composer.mode === "plan" ? "is-active" : ""}`}
                      role="menuitemcheckbox"
                      aria-checked={state.composer.mode === "plan"}
                      onClick={() => {
                        actions.setComposerMode(state.composer.mode === "plan" ? "agent" : "plan");
                        onCloseMenu();
                      }}
                    >
                      <span>{t("composer.planMode")}</span>
                      <span>{state.composer.mode === "plan" ? t("common.on") : t("common.off")}</span>
                    </button>
                    <button
                      type="button"
                      className={`ds-composer-menu-row ${state.composer.goalMode ? "is-active" : ""}`}
                      role="menuitemcheckbox"
                      aria-checked={state.composer.goalMode}
                      onClick={() => {
                        actions.setComposerGoalMode(!state.composer.goalMode);
                        onCloseMenu();
                      }}
                    >
                      <span>{t("composer.goalMode")}</span>
                      <span>{state.composer.goalMode ? t("common.on") : t("common.off")}</span>
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {modelPickerEnabled ? (
              <>
                <button
                  type="button"
                  className="ds-composer-model-button"
                  aria-label={t("composer.model")}
                  aria-expanded={pickerOpen}
                  aria-haspopup="dialog"
                  {...(pickerOpen ? { "aria-controls": "composer-model-picker" } : {})}
                  onClick={onTogglePicker}
                >
                  <span>{state.composer.model}</span>
                  <span>{state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort}</span>
                </button>
                {pickerOpen ? (
                  <FloatingComposerModelPicker
                    id="composer-model-picker"
                    profiles={state.modelProfiles?.profiles ?? []}
                    selectedModel={state.composer.model}
                    selectedProfileId={state.composer.modelProfileId}
                    selectedReasoningEffort={
                      state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort
                    }
                    onSelectModel={handleSelectModel}
                    onSelectReasoningEffort={actions.setComposerReasoningEffort}
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>
      <ComposerSendControls
        runtimeBusy={runtimeBusy}
        sendPending={sendPending}
        sendDisabled={sendDisabled}
        attachmentPending={attachmentPending}
        attachmentPendingCount={attachmentPendingCount}
        mode={state.composer.mode}
        goalMode={state.composer.goalMode}
        showModeChips={modeControlsEnabled}
        onInterrupt={onInterrupt}
        onSend={onSend}
      />
    </div>
  );
}

export function canSubmitComposerDraft({
  text,
  attachmentCount,
  disabled,
  sendPending,
  attachmentPending = false,
}: {
  text: string;
  attachmentCount: number;
  disabled: boolean;
  sendPending: boolean;
  attachmentPending?: boolean;
}): boolean {
  return (
    !disabled &&
    !sendPending &&
    !attachmentPending &&
    (text.trim().length > 0 || attachmentCount > 0)
  );
}
