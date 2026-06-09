import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ApprovalPreview, FileDiffLine, Item } from "../../../../../shared/agent-contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { summarizeToolItem } from "./timeline-model";
import { useWorkbench } from "../../store/WorkbenchContext";

interface ChatBlockProps {
  item: Item;
  isLive?: boolean;
  nested?: boolean;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
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
      return <ReasoningBlock item={item} isLive={isLive} nested={nested} />;
    case "tool":
      return <ToolBlock item={item} nested={nested} />;
    case "approval":
      return <ApprovalBlock item={item} nested={nested} onApprove={onApprove} />;
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

function ReasoningBlock({
  item,
  isLive,
  nested,
}: {
  item: Extract<Item, { kind: "reasoning" }>;
  isLive?: boolean;
  nested?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => isReasoningOpenByDefault(Boolean(isLive)));
  return (
    <details
      className={`ds-process-entry ds-process-reasoning-entry ${nested ? "is-nested" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="ds-process-entry-summary">
        <span className="ds-process-entry-title">{t("chat.reasoningLabel")}</span>
      </summary>
      <div className="ds-process-entry-detail ds-process-reasoning">
        <AssistantMarkdown text={item.text} streaming={isLive} />
      </div>
    </details>
  );
}

export function isReasoningOpenByDefault(isLive: boolean): boolean {
  return isLive;
}

function ApprovalBlock({
  item,
  nested,
  onApprove,
}: {
  item: Extract<Item, { kind: "approval" }>;
  nested?: boolean;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}): ReactElement {
  return (
    <div className={`ds-message-block ${nested ? "is-nested" : ""}`}>
      <ApprovalCard item={item} onApprove={onApprove} />
    </div>
  );
}

export function ApprovalCard({
  item,
  onApprove,
}: {
  item: Extract<Item, { kind: "approval" }>;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const [pendingDecision, setPendingDecision] = useState<"allow" | "deny" | null>(null);
  const canRespond = canRespondToApproval(item.decision, pendingDecision, Boolean(onApprove));
  const statusText = approvalStatusText(item.decision, pendingDecision, t);
  const showDiffByDefault =
    state.runtimePreferences.approvalExperience.showDiffByDefault;

  async function respond(decision: "allow" | "deny"): Promise<void> {
    if (!canRespond || !onApprove) return;
    setPendingDecision(decision);
    try {
      await onApprove(item.approvalId, decision);
    } finally {
      setPendingDecision(null);
    }
  }

  return (
    <div className={`ds-approval-block ${pendingDecision ? "is-pending" : ""}`}>
      <div className="ds-approval-header">
        <strong>{item.toolName}</strong>
        {statusText ? <span>{statusText}</span> : null}
      </div>
      {item.preview ? (
        <ApprovalPreviewBlock preview={item.preview} defaultOpen={showDiffByDefault} />
      ) : null}
      <pre className="ds-approval-args">{JSON.stringify(item.args, null, 2)}</pre>
      {item.decision === undefined && onApprove ? (
        <div className="ds-approval-actions">
          <button
            type="button"
            className="ds-approval-allow"
            disabled={!canRespond}
            onClick={() => void respond("allow")}
          >
            {pendingDecision === "allow" ? t("approvals.submitting") : t("approvals.allow")}
          </button>
          <button
            type="button"
            className="ds-approval-deny"
            disabled={!canRespond}
            onClick={() => void respond("deny")}
          >
            {pendingDecision === "deny" ? t("approvals.submitting") : t("approvals.deny")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ApprovalPreviewBlock({
  preview,
  defaultOpen,
}: {
  preview: ApprovalPreview;
  defaultOpen: boolean;
}): ReactElement {
  if (preview.kind === "file_diff") {
    return <FileDiffPreviewBlock preview={preview} defaultOpen={defaultOpen} />;
  }
  if (preview.kind === "multi_file_diff") {
    return (
      <div className="ds-diff-preview-list">
        {preview.files.map((file) => (
          <FileDiffPreviewBlock key={file.path} preview={file} defaultOpen={defaultOpen} />
        ))}
      </div>
    );
  }
  return <></>;
}

function FileDiffPreviewBlock({
  preview,
  defaultOpen,
}: {
  preview: Extract<ApprovalPreview, { kind: "file_diff" }>;
  defaultOpen: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <details className="ds-diff-preview" open={defaultOpen}>
      <summary className="ds-diff-preview-header">
        <span>{preview.path}</span>
        <span>
          {t(`approvals.diff.${preview.operation}`)} · +{preview.added} / -{preview.removed}
        </span>
      </summary>
      <div className="ds-diff-preview-lines">
        {preview.lines.map((line, index) => (
          <DiffLine key={`${index}:${line.type}:${line.text}`} line={line} />
        ))}
      </div>
    </details>
  );
}

function DiffLine({ line }: { line: FileDiffLine }): ReactElement {
  const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  return (
    <div className={`ds-diff-line is-${line.type}`}>
      <span>{prefix}</span>
      <code>{line.text || " "}</code>
    </div>
  );
}

export function canRespondToApproval(
  decision: "allow" | "deny" | undefined,
  pendingDecision: "allow" | "deny" | null,
  hasHandler: boolean,
): boolean {
  return decision === undefined && pendingDecision === null && hasHandler;
}

export function approvalStatusText(
  decision: "allow" | "deny" | undefined,
  pendingDecision: "allow" | "deny" | null,
  t: (key: string) => string,
): string {
  if (pendingDecision) return t("approvals.submitting");
  return decision ? t(`approvals.${decision}`) : "";
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
