import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Item } from "../../../../../shared/agent-contracts";
import { useWorkbench } from "../../store/WorkbenchContext";
import {
  ApprovalCard,
  type ApprovalPendingDecision,
  type ApprovalResponseChoice,
} from "./ChatBlock";

interface PendingApprovalPanelProps {
  onApprove?: (approvalId: string, response: ApprovalResponseChoice) => Promise<void>;
  pendingApprovalResponses?: Record<string, ApprovalPendingDecision>;
}

export function PendingApprovalPanel({
  onApprove,
  pendingApprovalResponses = {},
}: PendingApprovalPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const approvals = getPendingApprovalsForThread(state.items, state.activeThreadId);
  const panelRef = useRef<HTMLElement | null>(null);
  const approvalSignature = pendingApprovalSignature(approvals);
  const autoScrollOnRequest =
    state.runtimePreferences.approvalExperience.autoScrollOnRequest;

  useEffect(() => {
    if (!shouldAutoScrollPendingApprovals(autoScrollOnRequest, approvalSignature)) {
      return;
    }
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [approvalSignature, autoScrollOnRequest]);

  if (approvals.length === 0) return null;

  return (
    <section ref={panelRef} className="ds-pending-approval-panel" aria-live="polite">
      <div className="ds-pending-approval-title">
        <span>{t("approvals.pendingTitle")}</span>
        <span>{approvals.length}</span>
      </div>
      <div className="ds-pending-approval-list">
        {approvals.map((item) => (
          <ApprovalCard
            key={item.id}
            item={item}
            onApprove={onApprove}
            pendingDecision={pendingApprovalResponses[item.approvalId] ?? null}
          />
        ))}
      </div>
    </section>
  );
}

export function getPendingApprovalsForThread(
  items: Item[],
  threadId: string | null,
): Array<Extract<Item, { kind: "approval" }>> {
  if (!threadId) return [];
  return items.filter(
    (item): item is Extract<Item, { kind: "approval" }> =>
      item.kind === "approval" &&
      item.threadId === threadId &&
      item.decision === undefined,
  );
}

export function pendingApprovalSignature(
  approvals: Array<Extract<Item, { kind: "approval" }>>,
): string {
  return approvals.map((item) => item.approvalId || item.id).join("|");
}

export function shouldAutoScrollPendingApprovals(
  autoScrollOnRequest: boolean,
  approvalSignature: string,
): boolean {
  return autoScrollOnRequest && approvalSignature.length > 0;
}
