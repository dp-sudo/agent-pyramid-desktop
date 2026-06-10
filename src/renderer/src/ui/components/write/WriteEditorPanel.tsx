import type { KeyboardEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";

export type WriteStatus = "idle" | "loading" | "saving" | "saved" | "error";

export interface WriteEditorPanelProps {
  content: string;
  savedContent: string;
  completion: string;
  status: WriteStatus;
  errorMessage: string | null;
  activePath: string | null;
  saveDisabled: boolean;
  onContentChange: (content: string) => void;
  onEditorKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSave: () => void;
}

export function WriteEditorPanel({
  content,
  savedContent,
  completion,
  status,
  errorMessage,
  activePath,
  saveDisabled,
  onContentChange,
  onEditorKeyDown,
  onSave,
}: WriteEditorPanelProps): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="ds-write-editor">
      <div className="ds-write-editor-frame">
        <textarea
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          onKeyDown={onEditorKeyDown}
          placeholder={t("write.editorPlaceholder")}
          aria-label={t("write.editorPlaceholder")}
        />
        {completion ? <div className="ds-write-ghost">{completion}</div> : null}
      </div>
      <div className="ds-write-status">
        {status === "saving" ? t("write.saving") : null}
        {status === "saved" ? t("write.saved") : null}
        {status === "error" ? `${t("write.error")}: ${errorMessage ?? ""}` : null}
        {status === "idle" && activePath ? t("write.activeFile", { path: activePath }) : null}
        {status === "idle" && !activePath ? t("write.noActiveFile") : null}
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
