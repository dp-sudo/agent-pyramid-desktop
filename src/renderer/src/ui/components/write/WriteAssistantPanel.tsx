import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Item } from "../../../../../shared/agent-contracts";
import { ChatBlock, type ApprovalPendingDecision } from "../chat/ChatBlock";
import {
  getApprovalPendingDecision,
  getTimelineBottomScrollTop,
  isTimelineProcessOpen,
  shouldRecordTimelineProcessToggle,
  shouldShowTimelineJumpToBottom,
  shouldShowTimelineProcessItem,
  shouldStickToTimelineBottom,
} from "../chat/MessageTimeline";
import { PendingApprovalPanel } from "../chat/PendingApprovalPanel";
import { groupTimelineTurns } from "../chat/timeline-model";
import {
  FloatingComposer,
  type FloatingComposerRequestPayload,
} from "../composer";
import { useWorkbench } from "../../store/WorkbenchContext";

const WRITE_ASSISTANT_BOTTOM_STICKY_THRESHOLD_PX = 72;

export interface WriteAssistantPanelProps {
  activePath: string | null;
  activeTurnId: string | null;
  assistantBusy: boolean;
  assistantItems: Item[];
  composerDisabled: boolean;
  onRequestSend: (payload: FloatingComposerRequestPayload) => Promise<boolean>;
  onInterrupt: () => void;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingApprovalResponses?: Record<string, ApprovalPendingDecision>;
}

export function WriteAssistantPanel({
  activePath,
  activeTurnId,
  assistantBusy,
  assistantItems,
  composerDisabled,
  onRequestSend,
  onInterrupt,
  onApprove,
  pendingApprovalResponses = {},
}: WriteAssistantPanelProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [processOpenByTurnId, setProcessOpenByTurnId] = useState<Record<string, boolean>>({});
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const turns = useMemo(() => groupTimelineTurns(assistantItems), [assistantItems]);
  const showReadOnlyToolRecords =
    state.runtimePreferences.approvalExperience.showReadOnlyToolRecords;

  useLayoutEffect(() => {
    const visibleTurnIds = new Set(turns.map((turn) => turn.id));
    setProcessOpenByTurnId((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([turnId]) => visibleTurnIds.has(turnId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [turns]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    setShowJumpToBottom(false);
  }, [assistantItems, activeTurnId, assistantBusy]);

  function handleScroll(): void {
    const element = scrollRef.current;
    if (!element) return;
    const shouldStick = shouldStickToTimelineBottom({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      threshold: WRITE_ASSISTANT_BOTTOM_STICKY_THRESHOLD_PX,
    });
    stickToBottomRef.current = shouldStick;
    setShowJumpToBottom(shouldShowTimelineJumpToBottom(shouldStick));
  }

  function jumpToBottom(): void {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = getTimelineBottomScrollTop(element.scrollHeight);
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }

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
      <div ref={scrollRef} className="ds-write-assistant-messages" onScroll={handleScroll}>
        {turns.length > 0 ? (
          <div className="ds-write-assistant-timeline">
            {turns.map((turn) => {
              const isActiveTurn = activeTurnId === turn.id;
              const processItems = showReadOnlyToolRecords
                ? turn.processItems
                : turn.processItems.filter((item) =>
                    shouldShowTimelineProcessItem(item, showReadOnlyToolRecords),
                  );
              const processCount = processItems.length;
              const hasProcess = processCount > 0;
              const processOpen = isTimelineProcessOpen({
                turnId: turn.id,
                activeTurnId,
                openByTurnId: processOpenByTurnId,
              });
              const processLabel =
                processCount === 1
                  ? t("chat.workProcessOne")
                  : t("chat.workProcessMany", { count: processCount });

              return (
                <section key={turn.id} className="ds-message-turn">
                  {turn.user ? (
                    <ChatBlock
                      item={turn.user}
                      {...(onApprove ? { onApprove } : {})}
                      approvalPendingDecision={getApprovalPendingDecision(
                        turn.user,
                        pendingApprovalResponses,
                      )}
                    />
                  ) : null}

                  {hasProcess ? (
                    <details
                      className="ds-work-process"
                      open={processOpen}
                      onToggle={(event) => {
                        const open = event.currentTarget.open;
                        if (!shouldRecordTimelineProcessToggle({
                          currentOpen: processOpen,
                          nextOpen: open,
                        })) return;
                        setProcessOpenByTurnId((current) => ({
                          ...current,
                          [turn.id]: open,
                        }));
                      }}
                    >
                      <summary className="ds-work-process-summary">
                        <span>{processLabel}</span>
                        {isActiveTurn ? (
                          <span className="ds-shiny-text">{t("chat.running")}</span>
                        ) : null}
                      </summary>
                      <div className="ds-work-process-body">
                        {processItems.map((item) => (
                          <ChatBlock
                            key={item.id}
                            item={item}
                            nested
                            {...(item.turnId === activeTurnId ? { isLive: true } : {})}
                            {...(onApprove ? { onApprove } : {})}
                            approvalPendingDecision={getApprovalPendingDecision(
                              item,
                              pendingApprovalResponses,
                            )}
                          />
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {turn.assistantItems.map((item) => (
                    <ChatBlock
                      key={item.id}
                      item={item}
                      {...(item.turnId === activeTurnId ? { isLive: true } : {})}
                      {...(onApprove ? { onApprove } : {})}
                      approvalPendingDecision={getApprovalPendingDecision(
                        item,
                        pendingApprovalResponses,
                      )}
                    />
                  ))}

                  {turn.followupItems.map((item) => (
                    <ChatBlock
                      key={item.id}
                      item={item}
                      {...(onApprove ? { onApprove } : {})}
                      approvalPendingDecision={getApprovalPendingDecision(
                        item,
                        pendingApprovalResponses,
                      )}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="ds-write-assistant-empty">{t("write.assistantEmpty")}</div>
        )}
        {showJumpToBottom ? (
          <button
            type="button"
            className="ds-message-jump-bottom ds-write-assistant-jump-bottom"
            onClick={jumpToBottom}
            aria-label={t("chat.jumpToLatest")}
          >
            {t("chat.jumpToLatest")}
          </button>
        ) : null}
      </div>
      <div className="ds-write-assistant-composer">
        <PendingApprovalPanel
          onApprove={onApprove}
          pendingApprovalResponses={pendingApprovalResponses}
        />
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
