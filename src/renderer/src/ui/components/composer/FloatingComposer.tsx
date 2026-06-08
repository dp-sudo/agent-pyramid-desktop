import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  useWorkbench,
} from "../../store/WorkbenchContext";
import { Pill } from "../primitives/Pill";
import { FloatingComposerModelPicker } from "./FloatingComposerModelPicker";
import type {
  AttachmentRecord,
  ModelConfigProfile,
} from "../../../../../shared/agent-contracts";

interface FloatingComposerProps {
  onSend: (text: string) => Promise<boolean>;
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
  const runtimeBusy = getActiveThreadInFlightTurn(state) !== null;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draftText, setDraftText] = useState(state.composer.text);
  const [sendPending, setSendPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const attachmentRemovalDisabled = isAttachmentRemovalDisabled({
    disabled: Boolean(disabled),
    runtimeBusy,
    sendPending,
  });
  const sendDisabled = !canSubmitComposerDraft({
    text: draftText,
    attachmentCount: state.composer.attachmentIds.length,
    disabled: Boolean(disabled),
    sendPending,
  });

  useEffect(() => {
    setDraftText(state.composer.text);
  }, [state.composer.text]);

  useEffect(() => {
    if (state.composer.attachmentIds.length === 0 && attachments.length > 0) {
      setAttachments([]);
    }
  }, [attachments.length, state.composer.attachmentIds.length]);

  useEffect(() => {
    if (!menuOpen && !pickerOpen) return undefined;

    function closeOpenPopover(): void {
      setMenuOpen(false);
      setPickerOpen(false);
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (shellRef.current?.contains(target)) return;
      closeOpenPopover();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        closeOpenPopover();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen, pickerOpen]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!runtimeBusy && !sendDisabled) {
        void sendDraft();
      }
    }
  }

  async function sendDraft(): Promise<void> {
    const text = draftText.trim();
    if (
      !canSubmitComposerDraft({
        text,
        attachmentCount: state.composer.attachmentIds.length,
        disabled: Boolean(disabled),
        sendPending,
      })
    ) {
      return;
    }
    setSendPending(true);
    try {
      const sent = await onSend(text);
      if (sent) {
        setDraftText("");
      }
    } finally {
      setSendPending(false);
    }
  }

  async function handleImageSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) {
      try {
        const dataBase64 = await readFileAsBase64(file);
        const result = await window.agentApi.attachments.create({
          name: file.name,
          mimeType: file.type,
          dataBase64,
        });
        if (!result.ok) {
          actions.setError(result.message);
          continue;
        }
        actions.addComposerAttachment(result.value.id);
        setAttachments((current) => [...current, result.value]);
      } catch (error) {
        actions.setError(error instanceof Error ? error.message : String(error));
      }
    }
    setMenuOpen(false);
  }

  async function removeAttachment(id: string): Promise<void> {
    if (attachmentRemovalDisabled) return;
    const result = await window.agentApi.attachments.delete(id);
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    actions.removeComposerAttachment(id);
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function handleSelectModel(profile: ModelConfigProfile): void {
    actions.setComposerModel(profile.config.model, profile.id);
    actions.setComposerReasoningEffort(profile.config.model_reasoning_effort);
    setPickerOpen(false);
  }

  return (
    <div ref={shellRef} className="ds-composer-shell" style={{ width: "100%" }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => void handleImageSelected(event)}
      />
      <textarea
        value={draftText}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraftText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("composer.placeholder")}
        disabled={disabled}
      />
      {attachments.length > 0 ? (
        <div className="ds-composer-attachments">
          {attachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="ds-composer-attachment"
              onClick={() => void removeAttachment(attachment.id)}
              disabled={attachmentRemovalDisabled}
              title={t("composer.removeAttachment")}
            >
              <span>{attachment.name}</span>
              <span>{formatBytes(attachment.size)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px 10px",
          borderTop: "1px solid var(--ds-border-muted)",
        }}
      >
        <div className="ds-composer-toolbar-left">
          <button
            type="button"
            className="ds-composer-tool-button"
            onClick={() => {
              setMenuOpen((value) => !value);
              setPickerOpen(false);
            }}
            disabled={disabled || runtimeBusy || sendPending}
            title={t("composer.more")}
            aria-label={t("composer.more")}
          >
            +
          </button>
          {menuOpen ? (
            <div className="ds-composer-popover is-menu">
              <button
                type="button"
                className="ds-composer-menu-row"
                onClick={() => {
                  fileInputRef.current?.click();
                  setMenuOpen(false);
                }}
              >
                <span>{t("composer.addImage")}</span>
                <span>PNG/JPEG/WebP/GIF</span>
              </button>
              <button
                type="button"
                className={`ds-composer-menu-row ${state.composer.mode === "plan" ? "is-active" : ""}`}
                onClick={() => {
                  actions.setComposerMode(state.composer.mode === "plan" ? "agent" : "plan");
                  setMenuOpen(false);
                }}
              >
                <span>{t("composer.planMode")}</span>
                <span>{state.composer.mode === "plan" ? t("common.on") : t("common.off")}</span>
              </button>
              <button
                type="button"
                className={`ds-composer-menu-row ${state.composer.goalMode ? "is-active" : ""}`}
                onClick={() => {
                  actions.setComposerGoalMode(!state.composer.goalMode);
                  setMenuOpen(false);
                }}
              >
                <span>{t("composer.goalMode")}</span>
                <span>{state.composer.goalMode ? t("common.on") : t("common.off")}</span>
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="ds-composer-model-button"
            onClick={() => {
              setPickerOpen((value) => !value);
              setMenuOpen(false);
            }}
          >
            <span>{state.composer.model}</span>
            <span>{state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort}</span>
          </button>
          {pickerOpen ? (
            <FloatingComposerModelPicker
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
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {state.composer.mode === "plan" ? (
            <span className="ds-composer-mode-chip">{t("composer.planMode")}</span>
          ) : null}
          {state.composer.goalMode ? (
            <span className="ds-composer-mode-chip">{t("composer.goalMode")}</span>
          ) : null}
          {runtimeBusy ? (
            <Pill onClick={onInterrupt}>{t("composer.interrupt")}</Pill>
          ) : (
            <Pill
              onClick={() => void sendDraft()}
              accent
              disabled={sendDisabled}
            >
              {sendPending ? t("composer.sending") : t("composer.send")}
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") {
        reject(new Error("Failed to read image file."));
        return;
      }
      const marker = "base64,";
      const index = value.indexOf(marker);
      resolve(index >= 0 ? value.slice(index + marker.length) : value);
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

export function canSubmitComposerDraft({
  text,
  attachmentCount,
  disabled,
  sendPending,
}: {
  text: string;
  attachmentCount: number;
  disabled: boolean;
  sendPending: boolean;
}): boolean {
  return !disabled && !sendPending && (text.trim().length > 0 || attachmentCount > 0);
}

export function isAttachmentRemovalDisabled({
  disabled,
  runtimeBusy,
  sendPending,
}: {
  disabled: boolean;
  runtimeBusy: boolean;
  sendPending: boolean;
}): boolean {
  return disabled || runtimeBusy || sendPending;
}
