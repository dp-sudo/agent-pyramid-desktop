import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getActiveThreadInFlightTurn,
  useWorkbench,
} from "../../store/WorkbenchContext";
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

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state.items, activeInFlightTurn?.id]);

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
          const isActiveTurn = activeInFlightTurn?.id === turn.id;
          const processItems = showReadOnlyToolRecords
            ? turn.processItems
            : turn.processItems.filter((item) => !isReadOnlyToolRecord(item));
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
                    {processItems.map((item) => (
                      <ChatBlock
                        key={item.id}
                        item={item}
                        nested
                        {...(item.turnId === activeInFlightTurn?.id ? { isLive: true } : {})}
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
                  {...(item.turnId === activeInFlightTurn?.id ? { isLive: true } : {})}
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

const READ_ONLY_TOOL_RECORD_NAMES = new Set([
  "list_files",
  "read_file",
  "search_files",
  "diagnose_file",
]);

function isReadOnlyToolRecord(
  item: ReturnType<typeof groupTimelineTurns>[number]["processItems"][number],
): boolean {
  return item.kind === "tool" && READ_ONLY_TOOL_RECORD_NAMES.has(item.name);
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
