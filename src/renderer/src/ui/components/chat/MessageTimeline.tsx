import type { ReactElement } from "react";
import { useWorkbench } from "../../store/WorkbenchContext";
import { ChatBlock } from "./ChatBlock";

interface MessageTimelineProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => void;
}

export function MessageTimeline({ onApprove }: MessageTimelineProps): ReactElement {
  const { state } = useWorkbench();
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
        {state.activeThreadId ? "No messages yet." : "Select a thread to start."}
      </div>
    );
  }
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 24px",
      }}
    >
      {state.items.map((item) => {
        const isLive =
          item.kind === "assistant" &&
          state.inFlightTurn !== null &&
          item.turnId === state.inFlightTurn.id;
        return (
          <ChatBlock
            key={item.id}
            item={item}
            {...(isLive ? { isLive: true } : {})}
            {...(onApprove ? { onApprove } : {})}
          />
        );
      })}
    </div>
  );
}
