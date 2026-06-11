import { useEffect, useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ApprovalPreview, FileDiffLine, Item } from "../../../../../shared/agent-contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { summarizeToolItem } from "./timeline-model";
import { useWorkbench } from "../../store/WorkbenchContext";

export const TOOL_DETAIL_PREVIEW_MAX_CHARS = 4000;
export const TOOL_DETAIL_PREVIEW_MAX_LINES = 80;
const REASONING_COLLAPSED_PREVIEW_MAX_CHARS = 180;

interface ChatBlockProps {
  item: Item;
  isLive?: boolean;
  nested?: boolean;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  approvalPendingDecision?: ApprovalPendingDecision;
}

export type ApprovalPendingDecision = "allow" | "deny" | null;

export function ChatBlock({
  item,
  isLive,
  nested,
  onApprove,
  approvalPendingDecision,
}: ChatBlockProps): ReactElement {
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
            <AssistantMarkdownWithPreferences
              text={item.text || (isLive ? "..." : "")}
              streaming={isLive}
            />
          </div>
        </div>
      );
    case "reasoning":
      return (
        <ReasoningBlock
          item={item}
          isLive={isLive}
          nested={nested}
        />
      );
    case "tool":
      return <ToolBlock item={item} nested={nested} />;
    case "approval":
      return (
        <ApprovalBlock
          item={item}
          nested={nested}
          onApprove={onApprove}
          pendingDecision={approvalPendingDecision ?? null}
        />
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
      // Exhaustive switch: if a new Item kind is added without handling here,
      // TypeScript will fail to compile because `item` no longer narrows to
      // `never`. The runtime fallback still keeps the renderer from crashing
      // if a malformed item somehow reaches this branch.
      return renderUnknownItemKind(item);
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
  const { state } = useWorkbench();
  const defaultOpen = isReasoningOpenByDefault(
    Boolean(isLive),
    state.basicPreferences.openReasoningByDefault,
  );
  const [open, setOpen] = useState(defaultOpen);
  const [userControlledOpen, setUserControlledOpen] = useState(false);

  useEffect(() => {
    setOpen((current) =>
      resolveNextReasoningOpenState({
        currentOpen: current,
        defaultOpen,
        userControlled: userControlledOpen,
      }),
    );
  }, [defaultOpen, userControlledOpen]);

  return (
    <details
      className={`ds-process-entry ds-process-reasoning-entry ${nested ? "is-nested" : ""}`}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (!shouldRecordReasoningToggle({
          currentOpen: open,
          nextOpen,
        })) return;
        setUserControlledOpen(true);
        setOpen(nextOpen);
      }}
    >
      <summary className="ds-process-entry-summary">
        <span className="ds-process-entry-title">{t("chat.reasoningLabel")}</span>
        {!open ? (
          <span className="ds-process-reasoning-preview">
            {getReasoningCollapsedPreview(item.text)}
          </span>
        ) : null}
      </summary>
      {open ? (
        <div className="ds-process-entry-detail ds-process-reasoning">
          <AssistantMarkdownWithPreferences
            text={item.text}
            streaming={isLive}
          />
        </div>
      ) : null}
    </details>
  );
}

function AssistantMarkdownWithPreferences({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}): ReactElement {
  const { state } = useWorkbench();
  return (
    <AssistantMarkdown
      text={text}
      streaming={streaming}
      codeBlockCollapseLineThreshold={
        state.basicPreferences.codeBlockCollapseLineThreshold
      }
    />
  );
}

export function isReasoningOpenByDefault(
  isLive: boolean,
  openCompletedByDefault = false,
): boolean {
  return isLive || openCompletedByDefault;
}

export function resolveNextReasoningOpenState({
  currentOpen,
  defaultOpen,
  userControlled,
}: {
  currentOpen: boolean;
  defaultOpen: boolean;
  userControlled: boolean;
}): boolean {
  return userControlled ? currentOpen : defaultOpen;
}

export function shouldRecordReasoningToggle({
  currentOpen,
  nextOpen,
}: {
  currentOpen: boolean;
  nextOpen: boolean;
}): boolean {
  return currentOpen !== nextOpen;
}

export function getReasoningCollapsedPreview(
  text: string,
  maxChars = REASONING_COLLAPSED_PREVIEW_MAX_CHARS,
): string {
  const normalizedMaxChars = Math.max(1, Math.floor(Number.isFinite(maxChars) ? maxChars : 1));
  const preview = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (preview.length <= normalizedMaxChars) return preview;
  return `${preview.slice(0, normalizedMaxChars).trimEnd()}...`;
}

function ApprovalBlock({
  item,
  nested,
  onApprove,
  pendingDecision,
}: {
  item: Extract<Item, { kind: "approval" }>;
  nested?: boolean;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingDecision?: ApprovalPendingDecision;
}): ReactElement {
  return (
    <div className={`ds-message-block ${nested ? "is-nested" : ""}`}>
      <ApprovalCard item={item} onApprove={onApprove} pendingDecision={pendingDecision ?? null} />
    </div>
  );
}

export function ApprovalCard({
  item,
  onApprove,
  pendingDecision = null,
}: {
  item: Extract<Item, { kind: "approval" }>;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingDecision?: ApprovalPendingDecision;
}): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const canRespond = canRespondToApproval(item.decision, pendingDecision, Boolean(onApprove));
  const statusText = approvalStatusText(item.decision, pendingDecision, t);
  const showDiffByDefault =
    state.runtimePreferences.approvalExperience.showDiffByDefault;

  async function respond(decision: "allow" | "deny"): Promise<void> {
    if (!canRespond || !onApprove) return;
    await onApprove(item.approvalId, decision);
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
  const [open, setOpen] = useState(defaultOpen);
  const [userControlledOpen, setUserControlledOpen] = useState(false);

  useEffect(() => {
    setOpen((current) =>
      resolveNextApprovalDiffOpenState({
        currentOpen: current,
        defaultOpen,
        userControlled: userControlledOpen,
      }),
    );
  }, [defaultOpen, userControlledOpen]);

  return (
    <details
      className="ds-diff-preview"
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (!shouldRecordApprovalDiffToggle({
          currentOpen: open,
          nextOpen,
        })) return;
        setUserControlledOpen(true);
        setOpen(nextOpen);
      }}
    >
      <summary className="ds-diff-preview-header">
        <span>{preview.path}</span>
        <span>
          {t(`approvals.diff.${preview.operation}`)} | +{preview.added} / -{preview.removed}
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

export function resolveNextApprovalDiffOpenState({
  currentOpen,
  defaultOpen,
  userControlled,
}: {
  currentOpen: boolean;
  defaultOpen: boolean;
  userControlled: boolean;
}): boolean {
  return userControlled ? currentOpen : defaultOpen;
}

export function shouldRecordApprovalDiffToggle({
  currentOpen,
  nextOpen,
}: {
  currentOpen: boolean;
  nextOpen: boolean;
}): boolean {
  return currentOpen !== nextOpen;
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
  const detailId = useId();
  const [showFullDetail, setShowFullDetail] = useState(false);
  const hasLongDetail = isLongToolDetail(display.detail);
  const detailDisplay = resolveToolDetailDisplay(display.detail, showFullDetail);
  return (
    <details className={`ds-process-entry ds-process-tool is-${display.tone} ${nested ? "is-nested" : ""}`}>
      <summary className="ds-process-entry-summary">
        <span className="ds-process-entry-title">{display.title}</span>
        <span className="ds-process-entry-status">{display.statusText}</span>
      </summary>
      {display.detail ? (
        <div className="ds-process-entry-detail-frame">
          <pre
            id={detailId}
            className={`ds-process-entry-detail ${detailDisplay.truncated ? "is-truncated" : ""}`}
          >
            {detailDisplay.text}
          </pre>
          {detailDisplay.truncated ? (
            <small className="ds-process-entry-detail-note">
              {t("chat.toolDetailTruncated", {
                count: detailDisplay.hiddenCharCount,
              })}
            </small>
          ) : null}
          {hasLongDetail ? (
            <div className="ds-process-entry-detail-actions">
              <button
                type="button"
                aria-controls={detailId}
                aria-expanded={showFullDetail}
                onClick={() => setShowFullDetail((current) => !current)}
              >
                {showFullDetail
                  ? t("chat.collapseToolDetail")
                  : t("chat.expandToolDetail")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

export interface ToolDetailDisplay {
  text: string;
  truncated: boolean;
  hiddenCharCount: number;
}

export function isLongToolDetail(
  detail: string,
  maxChars = TOOL_DETAIL_PREVIEW_MAX_CHARS,
  maxLines = TOOL_DETAIL_PREVIEW_MAX_LINES,
): boolean {
  return resolveToolDetailDisplay(detail, false, maxChars, maxLines).truncated;
}

export function resolveToolDetailDisplay(
  detail: string,
  expanded: boolean,
  maxChars = TOOL_DETAIL_PREVIEW_MAX_CHARS,
  maxLines = TOOL_DETAIL_PREVIEW_MAX_LINES,
): ToolDetailDisplay {
  if (expanded) {
    return {
      text: detail,
      truncated: false,
      hiddenCharCount: 0,
    };
  }

  const charLimit = normalizeToolDetailLimit(maxChars, TOOL_DETAIL_PREVIEW_MAX_CHARS);
  const lineLimit = normalizeToolDetailLimit(maxLines, TOOL_DETAIL_PREVIEW_MAX_LINES);
  const charLimited = detail.length > charLimit ? detail.slice(0, charLimit) : detail;
  const lines = charLimited.split("\n");
  const lineLimited = lines.length > lineLimit
    ? lines.slice(0, lineLimit).join("\n")
    : charLimited;
  const text = lineLimited.trimEnd();
  const truncated = text.length < detail.length;
  return {
    text,
    truncated,
    hiddenCharCount: truncated ? detail.length - text.length : 0,
  };
}

function renderUnknownItemKind(_item: never): ReactElement {
  return (
    <div className="ds-message-block system">
      <div className="ds-system-bubble">unknown</div>
    </div>
  );
}

function normalizeToolDetailLimit(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}
