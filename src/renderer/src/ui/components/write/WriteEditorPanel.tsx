import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type UIEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";

export type WriteStatus = "idle" | "loading" | "saving" | "saved" | "error";
export type WritePreviewMode = "live" | "debounced" | "manual";
export type WritePreviewStatus = "live" | "updating" | "paused";
export type WriteSourceMode = "standard" | "large-document";

const WRITE_PREVIEW_LIVE_MAX_CHARS = 24000;
const WRITE_PREVIEW_MANUAL_MIN_CHARS = 120000;
const WRITE_PREVIEW_DEBOUNCE_MS = 450;
const WRITE_SOURCE_LARGE_DOCUMENT_MIN_CHARS = 60000;

export interface WriteEditorSelectionState {
  selectionStart: number;
  selectionEnd: number;
}

export interface WriteEditorPanelProps {
  content: string;
  savedContent: string;
  completion: string;
  selectionStart: number;
  selectionEnd: number;
  status: WriteStatus;
  errorMessage: string | null;
  activePath: string | null;
  saveDisabled: boolean;
  onContentChange: (content: string, selection?: WriteEditorSelectionState) => void;
  onSelectionChange: (selection: WriteEditorSelectionState) => void;
  onEditorKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSave: () => void;
}

interface WritePreviewSnapshot {
  path: string | null;
  text: string;
}

export interface WriteSourceTextareaPerformanceAttributes {
  wrap: "soft" | "off";
  spellCheck: boolean;
  autoCapitalize?: "off";
  autoComplete?: "off";
}

export function WriteEditorPanel({
  content,
  savedContent,
  completion,
  selectionStart,
  selectionEnd,
  status,
  errorMessage,
  activePath,
  saveDisabled,
  onContentChange,
  onSelectionChange,
  onEditorKeyDown,
  onSave,
}: WriteEditorPanelProps): ReactElement {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaValueRef = useRef(content);
  const textareaPathRef = useRef(activePath);
  const [scrollTop, setScrollTop] = useState(0);
  const [previewSnapshot, setPreviewSnapshot] = useState<WritePreviewSnapshot>(() => ({
    path: activePath,
    text: getInitialWritePreviewSnapshot(content),
  }));
  const previewSnapshotRef = useRef(previewSnapshot);
  const sourceMode = getWriteSourceMode(content.length);
  const sourcePerformanceAttributes = getWriteSourceTextareaPerformanceAttributes(sourceMode);
  const completionStyle = useMemo(
    () => completion
      ? getWriteCompletionGhostStyle({
          content,
          selectionStart,
          scrollTop,
        })
      : null,
    [completion, content, selectionStart, scrollTop],
  );
  const previewMode = getWritePreviewMode(content.length);
  const previewSnapshotText = previewSnapshot.path === activePath
    ? previewSnapshot.text
    : getInitialWritePreviewSnapshot(content);
  const previewText = previewMode === "live" ? content : previewSnapshotText;
  const previewStatus = getWritePreviewStatus({
    mode: previewMode,
    content,
    previewText,
  });
  const previewHasContent = hasWritePreviewContent(previewText);
  const sourceHasContent = hasWriteSourceContentHint(content);

  // Preview rendering is intentionally snapshot-based: large Markdown should
  // not force react-markdown/remark-gfm to parse the whole document on every
  // source keystroke.
  useEffect(() => {
    previewSnapshotRef.current = previewSnapshot;
  }, [previewSnapshot]);

  useEffect(() => {
    const nextSnapshot = getInitialWritePreviewSnapshot(content);
    const nextRecord = { path: activePath, text: nextSnapshot };
    previewSnapshotRef.current = nextRecord;
    setPreviewSnapshot(nextRecord);
  }, [activePath]);

  useEffect(() => {
    if (previewMode === "manual") return undefined;
    if (previewMode === "live") {
      if (
        previewSnapshotRef.current.path !== activePath ||
        previewSnapshotRef.current.text !== content
      ) {
        const nextRecord = { path: activePath, text: content };
        previewSnapshotRef.current = nextRecord;
        setPreviewSnapshot(nextRecord);
      }
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const nextRecord = { path: activePath, text: content };
      previewSnapshotRef.current = nextRecord;
      setPreviewSnapshot(nextRecord);
    }, WRITE_PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activePath, content, previewMode]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (shouldSyncWriteSourceTextarea({
      activePath,
      previousActivePath: textareaPathRef.current,
      domValue: textarea.value,
      lastKnownDomValue: textareaValueRef.current,
      nextContent: content,
    })) {
      textarea.value = content;
      textareaValueRef.current = content;
    }
    textareaPathRef.current = activePath;
  }, [activePath, content]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement !== textarea) return;
    const start = Math.min(Math.max(0, selectionStart), content.length);
    const end = Math.min(Math.max(0, selectionEnd), content.length);
    textarea.setSelectionRange(start, end);
  }, [content, selectionEnd, selectionStart]);

  function readSelection(target: HTMLTextAreaElement): WriteEditorSelectionState {
    return {
      selectionStart: target.selectionStart,
      selectionEnd: target.selectionEnd,
    };
  }

  function handleContentChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    textareaValueRef.current = event.target.value;
    onContentChange(event.target.value, readSelection(event.target));
  }

  function handleSelectionChange(): void {
    const textarea = textareaRef.current;
    if (!textarea) return;
    onSelectionChange(readSelection(textarea));
  }

  function handleScroll(event: UIEvent<HTMLTextAreaElement>): void {
    setScrollTop(event.currentTarget.scrollTop);
  }

  function refreshPreview(): void {
    const nextRecord = { path: activePath, text: content };
    previewSnapshotRef.current = nextRecord;
    setPreviewSnapshot(nextRecord);
  }

  const statusText = getWriteStatusText({
    activePath,
    errorMessage,
    status,
    t,
  });

  return (
    <section className="ds-write-editor">
      <div className="ds-write-editor-split">
        <div className="ds-write-editor-frame">
          <div className="ds-write-panel-label">{t("write.sourceLabel")}</div>
          <textarea
            ref={textareaRef}
            defaultValue={content}
            data-source-mode={sourceMode}
            {...sourcePerformanceAttributes}
            onChange={handleContentChange}
            onClick={handleSelectionChange}
            onKeyDown={onEditorKeyDown}
            onKeyUp={handleSelectionChange}
            onScroll={handleScroll}
            onSelect={handleSelectionChange}
            placeholder={t("write.editorPlaceholder")}
            aria-label={t("write.editorPlaceholder")}
          />
          {completion ? (
            <div className="ds-write-ghost" style={completionStyle ?? undefined}>
              <span>{completion}</span>
              <small>{t("write.completionHint")}</small>
            </div>
          ) : null}
        </div>
        <div className="ds-write-preview" aria-label={t("write.previewLabel")}>
          <div className="ds-write-panel-label">{t("write.previewLabel")}</div>
          {previewStatus !== "live" ? (
            <div className="ds-write-preview-controls" aria-live="polite">
              <span>
                {previewStatus === "updating"
                  ? t("write.previewUpdating")
                  : t("write.previewPaused")}
              </span>
              {previewStatus === "paused" ? (
                <button type="button" className="ds-pill" onClick={refreshPreview}>
                  {t("write.refreshPreview")}
                </button>
              ) : null}
            </div>
          ) : null}
          {previewHasContent ? (
            <AssistantMarkdown text={previewText} />
          ) : (
            <div className="ds-write-preview-empty">
              {sourceHasContent && previewStatus === "paused"
                ? t("write.previewPaused")
                : t("write.previewEmpty")}
            </div>
          )}
        </div>
      </div>
      <div className="ds-write-status">
        <span className={`ds-write-status-message is-${status}`}>{statusText}</span>
        <button
          type="button"
          className="ds-pill is-accent ds-write-save-button"
          onClick={onSave}
          disabled={saveDisabled}
        >
          {content !== savedContent ? t("write.save") : t("write.saved")}
        </button>
      </div>
    </section>
  );
}

export function getWriteStatusText({
  activePath,
  errorMessage,
  status,
  t,
}: {
  activePath: string | null;
  errorMessage: string | null;
  status: WriteStatus;
  t: (key: string, options?: Record<string, unknown>) => string;
}): string {
  if (status === "saving") return t("write.saving");
  if (status === "saved") return t("write.saved");
  if (status === "error") return `${t("write.error")}: ${errorMessage ?? ""}`;
  if (activePath) return t("write.activeFile", { path: activePath });
  return t("write.noActiveFile");
}

export function getWriteCompletionGhostStyle({
  content,
  selectionStart,
  scrollTop,
  lineHeightPx = 22.4,
  paddingTopPx = 24,
  minTopPx = 42,
  maxTopPx = 420,
}: {
  content: string;
  selectionStart: number;
  scrollTop: number;
  lineHeightPx?: number;
  paddingTopPx?: number;
  minTopPx?: number;
  maxTopPx?: number;
}): { top: string } {
  const caret = Math.min(Math.max(0, selectionStart), content.length);
  const lineIndex = countWriteNewlinesBeforeCaret(content, caret);
  const rawTop = paddingTopPx + lineIndex * lineHeightPx - scrollTop + lineHeightPx;
  const clampedTop = Math.min(maxTopPx, Math.max(minTopPx, rawTop));
  return { top: `${Math.round(clampedTop)}px` };
}

export function getWritePreviewMode(
  contentLength: number,
  {
    liveMaxChars = WRITE_PREVIEW_LIVE_MAX_CHARS,
    manualMinChars = WRITE_PREVIEW_MANUAL_MIN_CHARS,
  }: {
    liveMaxChars?: number;
    manualMinChars?: number;
  } = {},
): WritePreviewMode {
  if (contentLength >= manualMinChars) return "manual";
  if (contentLength > liveMaxChars) return "debounced";
  return "live";
}

export function getInitialWritePreviewSnapshot(content: string): string {
  return getWritePreviewMode(content.length) === "manual" ? "" : content;
}

export function getWritePreviewStatus({
  mode,
  content,
  previewText,
}: {
  mode: WritePreviewMode;
  content: string;
  previewText: string;
}): WritePreviewStatus {
  if (mode === "live" || content === previewText) return "live";
  return mode === "debounced" ? "updating" : "paused";
}

export function hasWritePreviewContent(text: string): boolean {
  return /\S/.test(text);
}

export function hasWriteSourceContentHint(text: string): boolean {
  return text.length > 0;
}

export function countWriteNewlinesBeforeCaret(content: string, caret: number): number {
  const normalizedCaret = Math.min(Math.max(0, caret), content.length);
  let count = 0;
  for (let index = 0; index < normalizedCaret; index += 1) {
    if (content.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export function getWriteSourceMode(
  contentLength: number,
  largeDocumentMinChars = WRITE_SOURCE_LARGE_DOCUMENT_MIN_CHARS,
): WriteSourceMode {
  return contentLength >= largeDocumentMinChars ? "large-document" : "standard";
}

export function getWriteSourceTextareaPerformanceAttributes(
  mode: WriteSourceMode,
): WriteSourceTextareaPerformanceAttributes {
  if (mode === "large-document") {
    return {
      wrap: "off",
      spellCheck: false,
      autoCapitalize: "off",
      autoComplete: "off",
    };
  }
  return {
    wrap: "soft",
    spellCheck: true,
  };
}

export function shouldSyncWriteSourceTextarea({
  activePath,
  previousActivePath,
  domValue,
  lastKnownDomValue,
  nextContent,
}: {
  activePath: string | null;
  previousActivePath: string | null;
  domValue: string;
  lastKnownDomValue: string;
  nextContent: string;
}): boolean {
  if (activePath !== previousActivePath) return true;
  if (domValue === nextContent) return false;
  return domValue === lastKnownDomValue;
}
