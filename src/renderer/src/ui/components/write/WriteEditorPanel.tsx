import {
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
  const [scrollTop, setScrollTop] = useState(0);
  const completionStyle = useMemo(
    () => getWriteCompletionGhostStyle({
      content,
      selectionStart,
      scrollTop,
    }),
    [content, selectionStart, scrollTop],
  );

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
            value={content}
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
            <div className="ds-write-ghost" style={completionStyle}>
              <span>{completion}</span>
              <small>{t("write.completionHint")}</small>
            </div>
          ) : null}
        </div>
        <div className="ds-write-preview" aria-label={t("write.previewLabel")}>
          <div className="ds-write-panel-label">{t("write.previewLabel")}</div>
          {content.trim() ? (
            <AssistantMarkdown text={content} />
          ) : (
            <div className="ds-write-preview-empty">{t("write.previewEmpty")}</div>
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
  const lineIndex = content.slice(0, caret).split("\n").length - 1;
  const rawTop = paddingTopPx + lineIndex * lineHeightPx - scrollTop + lineHeightPx;
  const clampedTop = Math.min(maxTopPx, Math.max(minTopPx, rawTop));
  return { top: `${Math.round(clampedTop)}px` };
}
