import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import { ChatBlock } from "./ChatBlock";
import { InitialSessionUsageHeatmap } from "./InitialSessionUsageHeatmap";
import { groupTimelineTurns } from "./timeline-model";

interface MessageTimelineProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => void;
}

export function MessageTimeline({ onApprove }: MessageTimelineProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const turns = useMemo(() => groupTimelineTurns(state.items), [state.items]);

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
    <div className="ds-message-timeline">
      <div className="ds-message-timeline-content">
        {turns.map((turn) => {
          const isActiveTurn = state.inFlightTurn?.id === turn.id;
          const processCount = turn.processItems.length;
          const hasProcess = processCount > 0;
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
                <details className="ds-work-process" open={isActiveTurn}>
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
