import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerAttachment } from "../../store/WorkbenchContext";
import {
  formatBytes,
  getAttachmentThumbnailSrc,
} from "./useComposerAttachments";

export function ComposerAttachmentTray({
  attachments,
  removalDisabled,
  onRemoveAttachment,
}: {
  attachments: ComposerAttachment[];
  removalDisabled: boolean;
  onRemoveAttachment(id: string): void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (attachments.length === 0) return null;

  return (
    <div className="ds-composer-attachments">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="ds-composer-attachment"
          title={`${attachment.name} - ${formatBytes(attachment.size)}`}
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
            onClick={() => onRemoveAttachment(attachment.id)}
            disabled={removalDisabled}
            title={t("composer.removeAttachment")}
            aria-label={t("composer.removeAttachment")}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
