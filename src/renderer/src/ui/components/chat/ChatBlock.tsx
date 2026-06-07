import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Item } from "../../../../../shared/agent-contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { summarizeToolItem } from "./timeline-model";

interface ChatBlockProps {
  item: Item;
  isLive?: boolean;
  nested?: boolean;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => void;
}

export function ChatBlock({ item, isLive, nested, onApprove }: ChatBlockProps): ReactElement {
  const { t } = useTranslation();
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
            <AssistantMarkdown text={item.text || (isLive ? "..." : "")} streaming={isLive} />
          </div>
        </div>
      );
    case "reasoning":
      return (
        <div className={`ds-process-entry ${nested ? "is-nested" : ""}`}>
          <div className="ds-process-entry-title">{t("chat.reasoningLabel")}</div>
          <div className="ds-process-entry-detail ds-process-reasoning">
            <AssistantMarkdown text={item.text} streaming={isLive} />
          </div>
        </div>
      );
    case "tool":
      return <ToolBlock item={item} nested={nested} />;
    case "approval":
      return (
        <div className={`ds-message-block ${nested ? "is-nested" : ""}`}>
          <div className="ds-approval-block">
            <div>
              <strong>{item.toolName}</strong>
              {item.decision ? (
                <span style={{ marginLeft: 8, color: "var(--ds-text-faint)" }}>
                  ({t(`approvals.${item.decision}`)})
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
                  {t("approvals.allow")}
                </button>
                <button
                  className="ds-approval-deny"
                  onClick={() => onApprove(item.approvalId, "deny")}
                >
                  {t("approvals.deny")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      );
    case "user_input":
      return (
        <div className={`ds-message-block ${nested ? "is-nested" : ""}`}>
          <div className="ds-system-bubble">{t("chat.userInputLabel")}: {item.question}</div>
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
        <div className={`ds-message-block ${nested ? "is-nested" : ""}`}>
          <div className="ds-system-bubble">
            {t("chat.compactedItems", { count: item.replacedItemCount })}
          </div>
        </div>
      );
    case "system":
      return (
        <div className={`ds-message-block system ${nested ? "is-nested" : ""}`}>
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

function ToolBlock({
  item,
  nested,
}: {
  item: Extract<Item, { kind: "tool" }>;
  nested?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const display = summarizeToolItem(item, t);
  return (
    <details className={`ds-process-entry ds-process-tool is-${display.tone} ${nested ? "is-nested" : ""}`}>
      <summary className="ds-process-entry-summary">
        <span className="ds-process-entry-title">{display.title}</span>
        <span className="ds-process-entry-status">{display.statusText}</span>
      </summary>
      {display.detail ? (
        <pre className="ds-process-entry-detail">{display.detail}</pre>
      ) : null}
    </details>
  );
}
