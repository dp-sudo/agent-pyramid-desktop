import type { ReactElement } from "react";
import type { Item } from "../../../../../shared/agent-contracts";

interface ChatBlockProps {
  item: Item;
  isLive?: boolean;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => void;
}

export function ChatBlock({ item, isLive, onApprove }: ChatBlockProps): ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <div className="ds-message-block user">
          <div className="ds-user-bubble">{item.displayText ?? item.text}</div>
          {item.attachments && item.attachments.length > 0 ? (
            <div className="ds-message-attachments">
              {item.attachments.map((attachment) => (
                <span key={attachment.id}>{attachment.name}</span>
              ))}
            </div>
          ) : null}
        </div>
      );
    case "assistant":
      return (
        <div className="ds-message-block assistant">
          <div className={`ds-assistant-bubble ${isLive ? "ds-shiny-text" : ""}`}>
            {item.text || (isLive ? "..." : "")}
          </div>
        </div>
      );
    case "reasoning":
      return (
        <div className="ds-message-block">
          <pre
            className="ds-tool-block"
            style={{ whiteSpace: "pre-wrap", color: "var(--ds-text-faint)" }}
          >
            {item.text}
          </pre>
        </div>
      );
    case "tool":
      return (
        <div className="ds-message-block tool">
          <div className="ds-tool-block">
            <strong style={{ color: "var(--ds-accent)" }}>{item.name}</strong>{" "}
            <span style={{ color: "var(--ds-text-faint)" }}>({item.status})</span>
            <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(item.args, null, 2)}
            </pre>
            {item.result !== undefined ? (
              <pre
                style={{
                  margin: "6px 0 0",
                  whiteSpace: "pre-wrap",
                  color: "var(--ds-text-muted)",
                }}
              >
                {JSON.stringify(item.result, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      );
    case "approval":
      return (
        <div className="ds-message-block">
          <div className="ds-approval-block">
            <div>
              <strong>{item.toolName}</strong>
              {item.decision ? (
                <span style={{ marginLeft: 8, color: "var(--ds-text-faint)" }}>
                  ({item.decision})
                </span>
              ) : null}
            </div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--ds-text-muted)" }}>
              {JSON.stringify(item.args, null, 2)}
            </pre>
            {item.decision === undefined && onApprove ? (
              <div className="ds-approval-actions">
                <button
                  className="ds-approval-allow"
                  onClick={() => onApprove(item.approvalId, "allow")}
                >
                  Allow
                </button>
                <button
                  className="ds-approval-deny"
                  onClick={() => onApprove(item.approvalId, "deny")}
                >
                  Deny
                </button>
              </div>
            ) : null}
          </div>
        </div>
      );
    case "user_input":
      return (
        <div className="ds-message-block">
          <div className="ds-system-bubble">user_input: {item.question}</div>
        </div>
      );
    case "plan":
      return (
        <div className="ds-message-block">
          <div className="ds-plan-block">
            {item.title ? <strong>{item.title}</strong> : null}
            <ol>
              {item.steps.map((step) => (
                <li key={step.id} className={`is-${step.status}`}>
                  {step.title}
                </li>
              ))}
            </ol>
          </div>
        </div>
      );
    case "compaction":
      return (
        <div className="ds-message-block">
          <div className="ds-system-bubble">
            compacted {item.replacedItemCount} items
          </div>
        </div>
      );
    case "system":
      return (
        <div className="ds-message-block system">
          <div className="ds-system-bubble">{item.text}</div>
        </div>
      );
    default: {
      const exhaustive: never = item;
      void exhaustive;
      return (
        <div className="ds-message-block system">
          <div className="ds-system-bubble">unknown</div>
        </div>
      );
    }
  }
}
