import type { ReactElement } from "react";
import {
  WriteWorkspaceView,
  type WriteAssistantPromptPayload,
} from "../write/WriteWorkspaceView";
import type { ApprovalPendingDecision } from "../chat/ChatBlock";
import { WorkbenchErrorToast } from "./WorkbenchErrorToast";

export interface WriteWorkbenchStageProps {
  onApprove: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingApprovalResponses: Record<string, ApprovalPendingDecision>;
  onWorkspaceSelected: (workspace: string) => boolean | void | Promise<boolean | void>;
  onSendAssistantPrompt: (payload: WriteAssistantPromptPayload) => Promise<boolean>;
  onInterruptAssistant: () => void;
  assistantBusy: boolean;
  toastMessage: string | null;
  toastEnabled: boolean;
  onDismissToast: () => void;
}

export function WriteWorkbenchStage({
  onApprove,
  pendingApprovalResponses,
  onWorkspaceSelected,
  onSendAssistantPrompt,
  onInterruptAssistant,
  assistantBusy,
  toastMessage,
  toastEnabled,
  onDismissToast,
}: WriteWorkbenchStageProps): ReactElement {
  return (
    <>
      <WriteWorkspaceView
        onApprove={onApprove}
        pendingApprovalResponses={pendingApprovalResponses}
        onWorkspaceSelected={onWorkspaceSelected}
        onSendAssistantPrompt={onSendAssistantPrompt}
        onInterruptAssistant={onInterruptAssistant}
        assistantBusy={assistantBusy}
      />
      <WorkbenchErrorToast
        message={toastMessage}
        enabled={toastEnabled}
        onDismiss={onDismissToast}
        floating
      />
    </>
  );
}
