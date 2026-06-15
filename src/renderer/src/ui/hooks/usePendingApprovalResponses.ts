import { useCallback, useEffect, useRef, useState } from "react";
import type { Item } from "../../../../shared/agent-contracts";
import type {
  ApprovalPendingDecision,
  ApprovalResponseChoice,
} from "../components/chat/ChatBlock";

interface PendingApprovalResponsesState {
  pendingApprovalResponses: Record<string, ApprovalPendingDecision>;
  beginApprovalResponse(
    approvalId: string,
    response: ApprovalResponseChoice,
  ): boolean;
  clearApprovalResponse(approvalId: string): void;
}

export function usePendingApprovalResponses(
  items: readonly Item[],
): PendingApprovalResponsesState {
  const pendingApprovalResponsesRef = useRef<Record<string, ApprovalPendingDecision>>({});
  const [pendingApprovalResponses, setPendingApprovalResponses] = useState<
    Record<string, ApprovalPendingDecision>
  >({});

  useEffect(() => {
    const nextPending = clearResolvedApprovalResponses(
      pendingApprovalResponsesRef.current,
      items,
    );
    if (nextPending === pendingApprovalResponsesRef.current) return;
    pendingApprovalResponsesRef.current = nextPending;
    setPendingApprovalResponses(nextPending);
  }, [items]);

  const beginApprovalResponse = useCallback(
    (approvalId: string, response: ApprovalResponseChoice): boolean => {
      const nextPending = beginPendingApprovalResponse(
        pendingApprovalResponsesRef.current,
        approvalId,
        response,
      );
      if (!nextPending) return false;
      pendingApprovalResponsesRef.current = nextPending;
      setPendingApprovalResponses(nextPending);
      return true;
    },
    [],
  );

  const clearApprovalResponse = useCallback((approvalId: string): void => {
    const next = { ...pendingApprovalResponsesRef.current };
    delete next[approvalId];
    pendingApprovalResponsesRef.current = next;
    setPendingApprovalResponses(next);
  }, []);

  return {
    pendingApprovalResponses,
    beginApprovalResponse,
    clearApprovalResponse,
  };
}

export function beginPendingApprovalResponse(
  current: Record<string, ApprovalPendingDecision>,
  approvalId: string,
  response: ApprovalResponseChoice,
): Record<string, ApprovalPendingDecision> | null {
  if (current[approvalId]) return null;
  return {
    ...current,
    [approvalId]: response,
  };
}

export function clearResolvedApprovalResponses(
  current: Record<string, ApprovalPendingDecision>,
  items: readonly Item[],
): Record<string, ApprovalPendingDecision> {
  let next: Record<string, ApprovalPendingDecision> | null = null;
  for (const item of items) {
    if (
      item.kind !== "approval" ||
      item.decision === undefined ||
      current[item.approvalId] === undefined
    ) {
      continue;
    }
    const source: Record<string, ApprovalPendingDecision> = next ?? current;
    const remaining: Record<string, ApprovalPendingDecision> = { ...source };
    delete remaining[item.approvalId];
    next = remaining;
  }
  return next ?? current;
}
