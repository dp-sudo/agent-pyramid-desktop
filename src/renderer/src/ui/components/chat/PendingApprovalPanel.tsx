import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Item } from "../../../../../shared/agent-contracts";
import { useWorkbench } from "../../store/WorkbenchContext";
import { ApprovalCard } from "./ChatBlock";

interface PendingApprovalPanelProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}

export function PendingApprovalPanel({
  onApprove,
}: PendingApprovalPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const approvals = getPendingApprovalsForThread(state.items, state.activeThreadId);
  if (approvals.length === 0) return null;

  return (
    <section className="ds-pending-approval-panel" aria-live="polite">
      <div className="ds-pending-approval-title">
        <span>{t("approvals.pendingTitle")}</span>
        <span>{approvals.length}</span>
      </div>
      <div className="ds-pending-approval-list">
        {approvals.map((item) => (
          <ApprovalCard key={item.id} item={item} onApprove={onApprove} />
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
