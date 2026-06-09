import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  useWorkbench,
  type ComposerAttachment,
} from "../../store/WorkbenchContext";
import type { WorkbenchBasicPreferences } from "../../preferences";
import { Pill } from "../primitives/Pill";
import { FloatingComposerModelPicker } from "./FloatingComposerModelPicker";
import {
  MAX_ATTACHMENT_BYTES,
  normalizeSupportedAttachmentMimeType,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
  type ModelConfigProfile,
} from "../../../../../shared/agent-contracts";

interface FloatingComposerProps {
  onSend: (text: string) => Promise<boolean>;
  onInterrupt: () => void;
  disabled?: boolean;
}

const COMPOSER_IMAGE_ACCEPT = SUPPORTED_ATTACHMENT_MIME_TYPES.join(",");
const COMPOSER_THUMBNAIL_MAX_EDGE = 192;

export interface ComposerImageFile {
  file: File;
  mimeType: string;
}

interface ClipboardImageItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

type ComposerImageSource = "picker" | "paste";

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
  const trackedPreviewUrlsRef = useRef(new Set<string>());
  const [draftText, setDraftText] = useState(state.composer.text);
  const [sendPending, setSendPending] = useState(false);
  const [attachmentPendingCount, setAttachmentPendingCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const attachmentPending = attachmentPendingCount > 0;
  const attachmentRemovalDisabled = isAttachmentRemovalDisabled({
    disabled: Boolean(disabled),
    runtimeBusy,
    sendPending,
    attachmentPending,
  });
  const sendDisabled = !canSubmitComposerDraft({
    text: draftText,
    attachmentCount: state.composer.attachmentIds.length,
    disabled: Boolean(disabled),
    sendPending,
    attachmentPending,
  });

  useEffect(() => {
    setDraftText(state.composer.text);
  }, [state.composer.text]);

  useEffect(() => {
    const currentPreviewUrls = new Set(
      state.composer.attachments
        .map((attachment) => attachment.previewUrl)
        .filter(isBlobPreviewUrl),
    );
    for (const previewUrl of currentPreviewUrls) {
      trackedPreviewUrlsRef.current.add(previewUrl);
    }
    for (const previewUrl of Array.from(trackedPreviewUrlsRef.current)) {
      if (!currentPreviewUrls.has(previewUrl)) {
        revokeTrackedPreviewUrl(previewUrl);
        trackedPreviewUrlsRef.current.delete(previewUrl);
      }
    }
  }, [state.composer.attachments]);

  useEffect(() => {
    return () => {
      for (const previewUrl of trackedPreviewUrlsRef.current) {
        revokeTrackedPreviewUrl(previewUrl);
      }
      trackedPreviewUrlsRef.current.clear();
    };
  }, []);

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
    const attachmentIdToRemove = getDeleteShortcutAttachmentId({
      key: event.key,
      text: event.currentTarget.value,
      attachments: state.composer.attachments,
      removalDisabled: attachmentRemovalDisabled,
    });
    if (attachmentIdToRemove) {
      event.preventDefault();
      void removeAttachment(attachmentIdToRemove);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!runtimeBusy && !sendDisabled) {
        void sendDraft();
      }
    }
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const files = getClipboardImageFiles(event.clipboardData.items);
    if (files.length === 0) return;
    if (!canAddComposerImageFromSource(state.basicPreferences, "paste")) return;
    void addImageFiles(files, "paste");
  }

  async function sendDraft(): Promise<void> {
    const text = draftText.trim();
    if (
      !canSubmitComposerDraft({
        text,
        attachmentCount: state.composer.attachmentIds.length,
        disabled: Boolean(disabled),
        sendPending,
        attachmentPending,
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
    if (!canAddComposerImageFromSource(state.basicPreferences, "picker")) return;
    const imageFiles = files.map(toComposerImageFile).filter(isComposerImageFile);
    if (imageFiles.length !== files.length) {
      actions.setError(t("composer.unsupportedImage"));
    }
    await addImageFiles(imageFiles, "picker");
    setMenuOpen(false);
  }

  async function addImageFiles(
    files: ComposerImageFile[],
    source: ComposerImageSource,
  ): Promise<void> {
    if (files.length === 0) return;
    if (!canAddComposerImageFromSource(state.basicPreferences, source)) return;
    if (disabled || runtimeBusy || sendPending || attachmentPending) {
      actions.setError(t("composer.attachmentAddBlocked"));
      return;
    }
    const { acceptedFiles, rejectedCount } = partitionComposerImageFilesBySize(files);
    if (rejectedCount > 0) {
      actions.setError(t("composer.attachmentTooLarge", {
        limit: formatBytes(MAX_ATTACHMENT_BYTES),
      }));
    }
    if (acceptedFiles.length === 0) return;

    setAttachmentPendingCount((count) => count + acceptedFiles.length);
    try {
      for (const [index, imageFile] of acceptedFiles.entries()) {
        const previewUrl = createPreviewUrl(imageFile.file);
        try {
          const dataBase64 = await readFileAsBase64(imageFile.file);
          const result = await window.agentApi.attachments.create({
            name: getComposerImageAttachmentName(imageFile.file, index, source),
            mimeType: imageFile.mimeType,
            dataBase64,
          });
          if (!result.ok) {
            revokeTrackedPreviewUrl(previewUrl);
            actions.setError(result.message);
            continue;
          }
          const thumbnailUrl = await createThumbnailUrl(
            imageFile.file,
            previewUrl,
            COMPOSER_THUMBNAIL_MAX_EDGE,
          ).catch(() => undefined);
          if (thumbnailUrl) {
            revokeTrackedPreviewUrl(previewUrl);
          }
          actions.addComposerAttachment({
            ...result.value,
            ...(!thumbnailUrl && previewUrl ? { previewUrl } : {}),
            ...(thumbnailUrl ? { thumbnailUrl } : {}),
          });
        } catch (error) {
          revokeTrackedPreviewUrl(previewUrl);
          actions.setError(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      setAttachmentPendingCount((count) => Math.max(0, count - files.length));
    }
  }

  async function removeAttachment(id: string): Promise<void> {
    if (attachmentRemovalDisabled) return;
    const attachment = state.composer.attachments.find((item) => item.id === id);
    const result = await window.agentApi.attachments.delete(id);
    if (!result.ok) {
      actions.setError(result.message);
      return;
    }
    revokeTrackedPreviewUrl(attachment?.previewUrl);
    if (attachment?.previewUrl) trackedPreviewUrlsRef.current.delete(attachment.previewUrl);
    actions.removeComposerAttachment(id);
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
        accept={COMPOSER_IMAGE_ACCEPT}
        multiple
        hidden
        disabled={!state.basicPreferences.allowComposerImageUpload}
        onChange={(event) => void handleImageSelected(event)}
      />
      {state.composer.attachments.length > 0 ? (
        <div className="ds-composer-attachments">
          {state.composer.attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="ds-composer-attachment"
              title={`${attachment.name} · ${formatBytes(attachment.size)}`}
            >
              {getAttachmentThumbnailSrc(attachment) ? (
                <img src={getAttachmentThumbnailSrc(attachment)} alt={attachment.name} />
              ) : (
                <span className="ds-composer-attachment-fallback">
                  {attachment.name}
                </span>
              )}
              <button
                type="button"
                className="ds-composer-attachment-remove"
                onClick={() => void removeAttachment(attachment.id)}
                disabled={attachmentRemovalDisabled}
                title={t("composer.removeAttachment")}
                aria-label={t("composer.removeAttachment")}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        value={draftText}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          const nextText = event.target.value;
          setDraftText(nextText);
          actions.setComposerText(nextText);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={t("composer.placeholder")}
        aria-label={t("composer.placeholder")}
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
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            +
          </button>
          {menuOpen ? (
            <div className="ds-composer-popover is-menu">
              {state.basicPreferences.allowComposerImageUpload ? (
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
              ) : null}
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
            aria-label={t("composer.model")}
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
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
          {attachmentPending ? (
            <span className="ds-composer-status" role="status" aria-live="polite">
              {t("composer.attachmentsProcessing", { count: attachmentPendingCount })}
            </span>
          ) : null}
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

async function createThumbnailUrl(
  file: File,
  sourceUrl: string | undefined,
  maxEdge: number,
): Promise<string | undefined> {
  if (
    !sourceUrl ||
    typeof document === "undefined" ||
    typeof Image === "undefined"
  ) {
    return undefined;
  }

  const image = await loadImage(sourceUrl);
  const size = getContainSize(image.naturalWidth, image.naturalHeight, maxEdge);
  if (size.width <= 0 || size.height <= 0) return undefined;

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return undefined;

  context.drawImage(image, 0, 0, size.width, size.height);
  const outputType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  return canvas.toDataURL(outputType, 0.86);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image thumbnail."));
    image.src = src;
  });
}

function createPreviewUrl(file: File): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  return URL.createObjectURL(file);
}

export function getContainSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || maxEdge <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function getAttachmentThumbnailSrc(
  attachment: Pick<ComposerAttachment, "thumbnailUrl" | "previewUrl">,
): string | undefined {
  return attachment.thumbnailUrl ?? attachment.previewUrl;
}

function isBlobPreviewUrl(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("blob:");
}

function revokeTrackedPreviewUrl(previewUrl: string | undefined): void {
  if (!isBlobPreviewUrl(previewUrl)) return;
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(previewUrl);
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

export function normalizeSupportedComposerImageMimeType(
  mimeType: string,
): string | null {
  return normalizeSupportedAttachmentMimeType(mimeType);
}

function toComposerImageFile(file: File): ComposerImageFile | null {
  const mimeType = normalizeSupportedComposerImageMimeType(file.type);
  return mimeType ? { file, mimeType } : null;
}

export function getClipboardImageFiles(
  items: Iterable<ClipboardImageItemLike>,
): ComposerImageFile[] {
  const files: ComposerImageFile[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const mimeType = normalizeSupportedComposerImageMimeType(file.type || item.type);
    if (mimeType) {
      files.push({ file, mimeType });
    }
  }
  return files;
}

export function partitionComposerImageFilesBySize(
  files: ComposerImageFile[],
  maxBytes = MAX_ATTACHMENT_BYTES,
): { acceptedFiles: ComposerImageFile[]; rejectedCount: number } {
  const acceptedFiles = files.filter((imageFile) => imageFile.file.size <= maxBytes);
  return {
    acceptedFiles,
    rejectedCount: files.length - acceptedFiles.length,
  };
}

export function getComposerImageAttachmentName(
  file: Pick<File, "name" | "type">,
  index: number,
  source: ComposerImageSource,
): string {
  const safeName = file.name.trim().split(/[/\\]/).pop()?.trim();
  if (safeName) return safeName.slice(0, 180);
  const extension = getImageExtension(file.type);
  const prefix = source === "paste" ? "pasted-image" : "image";
  return `${prefix}-${index + 1}.${extension}`;
}

function getImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export function canAddComposerImageFromSource(
  preferences: Pick<
    WorkbenchBasicPreferences,
    "allowComposerImageUpload" | "allowComposerImagePaste"
  >,
  source: ComposerImageSource,
): boolean {
  return source === "picker"
    ? preferences.allowComposerImageUpload
    : preferences.allowComposerImagePaste;
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

export function isAttachmentRemovalDisabled({
  disabled,
  runtimeBusy,
  sendPending,
  attachmentPending = false,
}: {
  disabled: boolean;
  runtimeBusy: boolean;
  sendPending: boolean;
  attachmentPending?: boolean;
}): boolean {
  return disabled || runtimeBusy || sendPending || attachmentPending;
}

export function getDeleteShortcutAttachmentId({
  key,
  text,
  attachments,
  removalDisabled,
}: {
  key: string;
  text: string;
  attachments: ComposerAttachment[];
  removalDisabled: boolean;
}): string | null {
  if (removalDisabled) return null;
  if (key !== "Backspace" && key !== "Delete") return null;
  if (text.length > 0) return null;
  return attachments.at(-1)?.id ?? null;
}

function isComposerImageFile(
  value: ComposerImageFile | null,
): value is ComposerImageFile {
  return value !== null;
}
