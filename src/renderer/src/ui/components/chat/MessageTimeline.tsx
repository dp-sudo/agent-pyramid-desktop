import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  useWorkbench,
} from "../../store/WorkbenchContext";
import { RUNTIME_READ_ONLY_TOOL_NAMES, type Item } from "../../../../../shared/agent-contracts";
import { ChatBlock, type ApprovalPendingDecision } from "./ChatBlock";
import { InitialSessionUsageHeatmap } from "./InitialSessionUsageHeatmap";
import { getTimelineItemTurnId, groupTimelineTurns, sortTimelineItems } from "./timeline-model";

interface MessageTimelineProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingApprovalResponses?: Record<string, ApprovalPendingDecision>;
}

const TIMELINE_BOTTOM_STICKY_THRESHOLD_PX = 96;
const TIMELINE_INITIAL_TURN_LIMIT = 80;

export function MessageTimeline({
  onApprove,
  pendingApprovalResponses = {},
}: MessageTimelineProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [processOpenByTurnId, setProcessOpenByTurnId] = useState<Record<string, boolean>>({});
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const visibleItemState = useMemo(
    () => getVisibleTimelineItems(state.items, showAllTurns),
    [showAllTurns, state.items],
  );
  const turns = useMemo(
    () => groupTimelineTurns(visibleItemState.visibleItems, { sorted: true }),
    [visibleItemState.visibleItems],
  );
  const activeInFlightTurn = getActiveThreadInFlightTurn(state);
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

  useEffect(() => {
    setShowAllTurns(false);
  }, [state.activeThreadId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    setShowJumpToBottom(false);
  }, [state.items, activeInFlightTurn?.id]);

  function handleScroll(): void {
    const element = scrollRef.current;
    if (!element) return;
    const shouldStick = shouldStickToTimelineBottom({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      threshold: TIMELINE_BOTTOM_STICKY_THRESHOLD_PX,
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

  if (state.items.length === 0) {
    return (
      <div className="ds-message-timeline-empty">
        <InitialSessionUsageHeatmap />
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="ds-message-timeline" onScroll={handleScroll}>
      <div className="ds-message-timeline-content">
        {visibleItemState.hiddenTurnCount > 0 ? (
          <button
            type="button"
            className="ds-message-show-older"
            onClick={() => setShowAllTurns(true)}
          >
            {t("chat.showOlderTurns", { count: visibleItemState.hiddenTurnCount })}
          </button>
        ) : null}
        {turns.map((turn) => {
          const isActiveTurn = activeInFlightTurn?.id === turn.id;
          const processItems = showReadOnlyToolRecords
            ? turn.processItems
            : turn.processItems.filter((item) =>
                shouldShowTimelineProcessItem(item, showReadOnlyToolRecords),
              );
          const processCount = processItems.length;
          const hasProcess = processCount > 0;
          const processOpen = isTimelineProcessOpen({
            turnId: turn.id,
            activeTurnId: activeInFlightTurn?.id ?? null,
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
                    {isActiveTurn ? <span className="ds-shiny-text">{t("chat.running")}</span> : null}
                  </summary>
                  {processOpen ? (
                    <div className="ds-work-process-body">
                      {processItems.map((item) => (
                        <ChatBlock
                          key={item.id}
                          item={item}
                          nested
                          {...(item.turnId === activeInFlightTurn?.id ? { isLive: true } : {})}
                          {...(onApprove ? { onApprove } : {})}
                          approvalPendingDecision={getApprovalPendingDecision(
                            item,
                            pendingApprovalResponses,
                          )}
                        />
                      ))}
                    </div>
                  ) : null}
                </details>
              ) : null}

              {turn.assistantItems.map((item) => (
                <ChatBlock
                  key={item.id}
                  item={item}
                  {...(item.turnId === activeInFlightTurn?.id ? { isLive: true } : {})}
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
      {showJumpToBottom ? (
        <button
          type="button"
          className="ds-message-jump-bottom"
          onClick={jumpToBottom}
          aria-label={t("chat.jumpToLatest")}
        >
          {t("chat.jumpToLatest")}
        </button>
      ) : null}
    </div>
  );
}

export function getApprovalPendingDecision(
  item: Item,
  pendingApprovalResponses: Record<string, ApprovalPendingDecision>,
): ApprovalPendingDecision {
  return item.kind === "approval"
    ? pendingApprovalResponses[item.approvalId] ?? null
    : null;
}

const READ_ONLY_TOOL_RECORD_NAMES = new Set<string>(RUNTIME_READ_ONLY_TOOL_NAMES);

function isReadOnlyToolRecord(
  item: ReturnType<typeof groupTimelineTurns>[number]["processItems"][number],
): boolean {
  return item.kind === "tool" && READ_ONLY_TOOL_RECORD_NAMES.has(item.name);
}

export function shouldShowTimelineProcessItem(
  item: ReturnType<typeof groupTimelineTurns>[number]["processItems"][number],
  showReadOnlyToolRecords: boolean,
): boolean {
  if (showReadOnlyToolRecords) return true;
  if (!isReadOnlyToolRecord(item)) return true;
  return item.kind === "tool" && item.status === "failed";
}

export function shouldStickToTimelineBottom({
  scrollTop,
  scrollHeight,
  clientHeight,
  threshold = TIMELINE_BOTTOM_STICKY_THRESHOLD_PX,
}: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold?: number;
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function shouldShowTimelineJumpToBottom(shouldStickToBottom: boolean): boolean {
  return !shouldStickToBottom;
}

export function getTimelineBottomScrollTop(scrollHeight: number): number {
  return Math.max(0, scrollHeight);
}

// Windowing happens before turn grouping so old large turns do not build
// Markdown/tool block models during the initial Code timeline render.
export function getVisibleTimelineItems(
  items: readonly Item[],
  showAll: boolean,
  limit = TIMELINE_INITIAL_TURN_LIMIT,
): { visibleItems: Item[]; hiddenTurnCount: number } {
  const normalizedLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const sortedItems = sortTimelineItems(items);
  if (showAll || sortedItems.length === 0) {
    return { visibleItems: sortedItems, hiddenTurnCount: 0 };
  }

  const visibleTurnIds = new Set<string>();
  let startIndex = sortedItems.length;

  for (let index = sortedItems.length - 1; index >= 0; index -= 1) {
    const turnId = getTimelineItemTurnId(sortedItems[index]);
    if (!visibleTurnIds.has(turnId)) {
      if (visibleTurnIds.size >= normalizedLimit) break;
      visibleTurnIds.add(turnId);
    }
    startIndex = index;
  }

  if (startIndex === 0) {
    return { visibleItems: sortedItems, hiddenTurnCount: 0 };
  }

  const hiddenTurnIds = new Set<string>();
  for (let index = 0; index < startIndex; index += 1) {
    const turnId = getTimelineItemTurnId(sortedItems[index]);
    if (!visibleTurnIds.has(turnId)) {
      hiddenTurnIds.add(turnId);
    }
  }

  return {
    visibleItems: sortedItems.slice(startIndex),
    hiddenTurnCount: hiddenTurnIds.size,
  };
}

export function isTimelineProcessOpen({
  turnId,
  activeTurnId,
  openByTurnId,
}: {
  turnId: string;
  activeTurnId: string | null;
  openByTurnId: Record<string, boolean>;
}): boolean {
  const explicit = openByTurnId[turnId];
  if (explicit !== undefined) return explicit;
  return turnId === activeTurnId;
}

export function shouldRecordTimelineProcessToggle({
  currentOpen,
  nextOpen,
}: {
  currentOpen: boolean;
  nextOpen: boolean;
}): boolean {
  return currentOpen !== nextOpen;
}
