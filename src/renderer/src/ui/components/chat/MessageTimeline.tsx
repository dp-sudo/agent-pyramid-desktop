import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import { ChatBlock } from "./ChatBlock";
import { InitialSessionUsageHeatmap } from "./InitialSessionUsageHeatmap";
import { groupTimelineTurns } from "./timeline-model";

interface MessageTimelineProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}

const TIMELINE_BOTTOM_STICKY_THRESHOLD_PX = 96;

export function MessageTimeline({ onApprove }: MessageTimelineProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [processOpenByTurnId, setProcessOpenByTurnId] = useState<Record<string, boolean>>({});
  const turns = useMemo(() => groupTimelineTurns(state.items), [state.items]);

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
  }, [state.items, state.inFlightTurn?.id]);

  function handleScroll(): void {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = shouldStickToTimelineBottom({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      threshold: TIMELINE_BOTTOM_STICKY_THRESHOLD_PX,
    });
  }

  if (state.items.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ds-text-faint)",
        }}
      >
        <InitialSessionUsageHeatmap />
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="ds-message-timeline" onScroll={handleScroll}>
      <div className="ds-message-timeline-content">
        {turns.map((turn) => {
          const isActiveTurn = state.inFlightTurn?.id === turn.id;
          const processCount = turn.processItems.length;
          const hasProcess = processCount > 0;
          const processOpen = isTimelineProcessOpen({
            turnId: turn.id,
            activeTurnId: state.inFlightTurn?.id ?? null,
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
                />
              ) : null}

              {hasProcess ? (
                <details
                  className="ds-work-process"
                  open={processOpen}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
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
                  <div className="ds-work-process-body">
                    {turn.processItems.map((item) => (
                      <ChatBlock
                        key={item.id}
                        item={item}
                        nested
                        {...(item.turnId === state.inFlightTurn?.id ? { isLive: true } : {})}
                        {...(onApprove ? { onApprove } : {})}
                      />
                    ))}
                  </div>
                </details>
              ) : null}

              {turn.assistantItems.map((item) => (
                <ChatBlock
                  key={item.id}
                  item={item}
                  {...(item.turnId === state.inFlightTurn?.id ? { isLive: true } : {})}
                  {...(onApprove ? { onApprove } : {})}
                />
              ))}

              {turn.followupItems.map((item) => (
                <ChatBlock
                  key={item.id}
                  item={item}
                  {...(onApprove ? { onApprove } : {})}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
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
