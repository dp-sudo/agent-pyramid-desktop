import type { ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Item } from "../../../../../shared/agent-contracts";
import { ChatBlock } from "../chat/ChatBlock";
import {
  FloatingComposer,
  type FloatingComposerRequestPayload,
} from "../composer";

export interface WriteAssistantPanelProps {
  activePath: string | null;
  activeTurnId: string | null;
  assistantBusy: boolean;
  assistantItems: Item[];
  assistantMessagesRef: RefObject<HTMLDivElement | null>;
  composerDisabled: boolean;
  onRequestSend: (payload: FloatingComposerRequestPayload) => Promise<boolean>;
  onInterrupt: () => void;
}

export function WriteAssistantPanel({
  activePath,
  activeTurnId,
  assistantBusy,
  assistantItems,
  assistantMessagesRef,
  composerDisabled,
  onRequestSend,
  onInterrupt,
}: WriteAssistantPanelProps): ReactElement {
  const { t } = useTranslation();

  return (
    <aside className="ds-write-assistant">
      <div className="ds-write-assistant-header">
        <div>
          <strong>{t("write.assistantTitle")}</strong>
          <span>
            {activePath
              ? t("write.assistantCurrentFile", { path: activePath })
              : t("write.assistantNoFile")}
          </span>
        </div>
        {assistantBusy ? <span className="ds-shiny-text">{t("chat.running")}</span> : null}
      </div>
      <div ref={assistantMessagesRef} className="ds-write-assistant-messages">
        {assistantItems.length > 0 ? (
          assistantItems.map((item) => (
            <ChatBlock
              key={item.id}
              item={item}
              {...(item.turnId === activeTurnId ? { isLive: true } : {})}
            />
          ))
        ) : (
          <div className="ds-write-assistant-empty">{t("write.assistantEmpty")}</div>
        )}
      </div>
      <div className="ds-write-assistant-composer">
        <FloatingComposer
          variant="write"
          placeholder={t("composer.writePlaceholder")}
          disabled={composerDisabled}
          onRequestSend={onRequestSend}
          onInterrupt={onInterrupt}
        />
      </div>
    </aside>
  );
}
