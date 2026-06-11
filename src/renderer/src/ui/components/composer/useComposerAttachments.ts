import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useWorkbench,
  type ComposerAttachment,
} from "../../store/WorkbenchContext";
import type { WorkbenchBasicPreferences } from "../../preferences";
import {
  MAX_ATTACHMENT_BYTES,
  normalizeSupportedAttachmentMimeType,
} from "../../../../../shared/agent-contracts";
import { formatBytes } from "../../format";

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

export interface ComposerAttachmentsState {
  fileInputRef: RefObject<HTMLInputElement | null>;
  attachmentPending: boolean;
  attachmentPendingCount: number;
  handleImageSelected(event: ChangeEvent<HTMLInputElement>): Promise<void>;
  handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void;
  removeAttachment(id: string): Promise<void>;
}

export function useComposerAttachments({
  disabled,
  runtimeBusy,
  sendPending,
  enabled,
}: {
  disabled: boolean;
  runtimeBusy: boolean;
  sendPending: boolean;
  enabled: boolean;
}): ComposerAttachmentsState {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const trackedPreviewUrlsRef = useRef(new Set<string>());
  const [attachmentPendingCount, setAttachmentPendingCount] = useState(0);
  const attachmentPending = attachmentPendingCount > 0;

  useEffect(() => {
    if (!enabled) return undefined;
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
  }, [enabled, state.composer.attachments]);

  useEffect(() => {
    if (!enabled) return undefined;
    return () => {
      for (const previewUrl of trackedPreviewUrlsRef.current) {
        revokeTrackedPreviewUrl(previewUrl);
      }
      trackedPreviewUrlsRef.current.clear();
    };
  }, [enabled]);

  async function handleImageSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!enabled) return;
    if (!canAddComposerImageFromSource(state.basicPreferences, "picker")) return;
    const imageFiles = files.map(toComposerImageFile).filter(isComposerImageFile);
    if (imageFiles.length !== files.length) {
      actions.setError(t("composer.unsupportedImage"));
    }
    await addImageFiles(imageFiles, "picker");
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    if (!enabled) return;
    const files = getClipboardImageFiles(event.clipboardData.items);
    if (files.length === 0) return;
    if (!canAddComposerImageFromSource(state.basicPreferences, "paste")) return;
    void addImageFiles(files, "paste");
  }

  async function addImageFiles(
    files: ComposerImageFile[],
    source: ComposerImageSource,
  ): Promise<void> {
    if (files.length === 0) return;
    if (!enabled) return;
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

    setAttachmentPendingCount((count) =>
      nextAttachmentPendingCount(count, acceptedFiles.length, "add"),
    );
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
      setAttachmentPendingCount((count) =>
        nextAttachmentPendingCount(count, acceptedFiles.length, "remove"),
      );
    }
  }

  async function removeAttachment(id: string): Promise<void> {
    if (isAttachmentRemovalDisabled({
      disabled,
      runtimeBusy,
      sendPending,
      attachmentPending,
    })) {
      return;
    }
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

  return {
    fileInputRef,
    attachmentPending,
    attachmentPendingCount,
    handleImageSelected,
    handlePaste,
    removeAttachment,
  };
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

export function nextAttachmentPendingCount(
  currentCount: number,
  processedFileCount: number,
  operation: "add" | "remove",
): number {
  const normalizedCurrentCount = Math.max(0, currentCount);
  const normalizedProcessedFileCount = Math.max(0, processedFileCount);
  return operation === "add"
    ? normalizedCurrentCount + normalizedProcessedFileCount
    : Math.max(0, normalizedCurrentCount - normalizedProcessedFileCount);
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
