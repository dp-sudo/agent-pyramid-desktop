import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  useWorkbench,
} from "../../store/WorkbenchContext";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray";
import {
  ComposerToolbar,
  canSubmitComposerDraft,
} from "./ComposerToolbar";
import {
  getDeleteShortcutAttachmentId,
  isAttachmentRemovalDisabled,
  useComposerAttachments,
} from "./useComposerAttachments";
import {
  shouldSubmitComposerKeyboardEvent,
  useComposerDraft,
} from "./useComposerDraft";
import { useComposerPopovers } from "./useComposerPopovers";

export type FloatingComposerVariant = "code" | "write";

export interface FloatingComposerRequestPayload {
  text: string;
  attachmentIds: string[];
  mode: "agent" | "plan";
  goalMode: boolean;
}

interface FloatingComposerProps {
  onRequestSend(payload: FloatingComposerRequestPayload): Promise<boolean>;
  onInterrupt(): void;
  disabled?: boolean;
  variant?: FloatingComposerVariant;
  placeholder?: string;
  attachmentsEnabled?: boolean;
  modelPickerEnabled?: boolean;
  modeControlsEnabled?: boolean;
}

export function FloatingComposer({
  onRequestSend,
  onInterrupt,
  disabled = false,
  variant = "code",
  placeholder,
  attachmentsEnabled = variant === "code",
  modelPickerEnabled = variant === "code",
  modeControlsEnabled = variant === "code",
}: FloatingComposerProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const runtimeBusy = getActiveThreadInFlightTurn(state) !== null;
  const {
    draftText,
    textareaRef,
    clearDraft,
    handleDraftChange,
  } = useComposerDraft();
  const [sendPending, setSendPending] = useState(false);
  const popovers = useComposerPopovers();
  const controlsLocked = disabled || runtimeBusy || sendPending;
  const attachments = useComposerAttachments({
    disabled,
    runtimeBusy,
    sendPending,
    enabled: attachmentsEnabled,
  });
  const attachmentCount = attachmentsEnabled ? state.composer.attachmentIds.length : 0;
  const attachmentRemovalDisabled = isAttachmentRemovalDisabled({
    disabled,
    runtimeBusy,
    sendPending,
    attachmentPending: attachments.attachmentPending,
  });
  const sendDisabled = !canSubmitComposerDraft({
    text: draftText,
    attachmentCount,
    disabled,
    sendPending,
    attachmentPending: attachments.attachmentPending,
  });
  const composerPlaceholder = placeholder ?? t("composer.placeholder");

  useEffect(() => {
    if (!shouldCloseComposerPopoversOnLock({
      controlsLocked,
      menuOpen: popovers.menuOpen,
      pickerOpen: popovers.pickerOpen,
    })) {
      return;
    }
    popovers.closePopovers();
  }, [controlsLocked, popovers]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (attachmentsEnabled) {
      const attachmentIdToRemove = getDeleteShortcutAttachmentId({
        key: event.key,
        text: event.currentTarget.value,
        attachments: state.composer.attachments,
        removalDisabled: attachmentRemovalDisabled,
      });
      if (attachmentIdToRemove) {
        event.preventDefault();
        void attachments.removeAttachment(attachmentIdToRemove);
        return;
      }
    }

    if (shouldSubmitComposerKeyboardEvent({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) {
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
        attachmentCount,
        disabled,
        sendPending,
        attachmentPending: attachments.attachmentPending,
      })
    ) {
      return;
    }
    setSendPending(true);
    try {
      const sent = await onRequestSend({
        text,
        attachmentIds: attachmentsEnabled ? state.composer.attachmentIds : [],
        mode: modeControlsEnabled ? state.composer.mode : "agent",
        goalMode: modeControlsEnabled ? state.composer.goalMode : false,
      });
      if (sent) {
        clearDraft();
      }
    } finally {
      setSendPending(false);
    }
  }

  return (
    <div ref={popovers.shellRef} className={`ds-composer-shell is-${variant}`}>
      {attachmentsEnabled ? (
        <ComposerAttachmentTray
          attachments={state.composer.attachments}
          removalDisabled={attachmentRemovalDisabled}
          onRemoveAttachment={(id) => void attachments.removeAttachment(id)}
        />
      ) : null}
      <textarea
        ref={textareaRef}
        value={draftText}
        onChange={handleDraftChange}
        onKeyDown={handleKeyDown}
        onPaste={attachmentsEnabled ? attachments.handlePaste : undefined}
        placeholder={composerPlaceholder}
        aria-label={composerPlaceholder}
        disabled={disabled}
      />
      <ComposerToolbar
        variant={variant}
        disabled={disabled}
        runtimeBusy={runtimeBusy}
        sendPending={sendPending}
        sendDisabled={sendDisabled}
        attachmentPending={attachmentsEnabled ? attachments.attachmentPending : false}
        attachmentPendingCount={attachmentsEnabled ? attachments.attachmentPendingCount : 0}
        fileInputRef={attachments.fileInputRef}
        attachmentsEnabled={attachmentsEnabled}
        modelPickerEnabled={modelPickerEnabled}
        modeControlsEnabled={modeControlsEnabled}
        menuOpen={attachmentsEnabled || modeControlsEnabled ? popovers.menuOpen : false}
        pickerOpen={modelPickerEnabled ? popovers.pickerOpen : false}
        onImageSelected={(event) => {
          void attachments.handleImageSelected(event);
          popovers.closeMenu();
        }}
        onToggleMenu={popovers.toggleMenu}
        onCloseMenu={popovers.closeMenu}
        onTogglePicker={popovers.togglePicker}
        onInterrupt={onInterrupt}
        onSend={() => void sendDraft()}
      />
    </div>
  );
}

export function shouldCloseComposerPopoversOnLock({
  controlsLocked,
  menuOpen,
  pickerOpen,
}: {
  controlsLocked: boolean;
  menuOpen: boolean;
  pickerOpen: boolean;
}): boolean {
  return controlsLocked && (menuOpen || pickerOpen);
}
