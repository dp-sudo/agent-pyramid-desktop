import type { ReactElement } from "react";
import { WriteWorkspaceView } from "../write/WriteWorkspaceView";
import type { WriteAssistantPromptPayload } from "../write/write-workspace-model";
import type {
  ApprovalPendingDecision,
  ApprovalResponseChoice,
  UserInputResponseChoice,
} from "../chat/ChatBlock";
import { WorkbenchErrorToast } from "./WorkbenchErrorToast";
import type { ThreadSummary } from "../../../../../shared/agent-contracts";

export interface WriteWorkbenchStageProps {
  onApprove: (approvalId: string, response: ApprovalResponseChoice) => Promise<void>;
  pendingApprovalResponses: Record<string, ApprovalPendingDecision>;
  onUserInputRespond?: (
    userInputId: string,
    response: UserInputResponseChoice,
  ) => Promise<void>;
  onWorkspaceSelected: (workspace: string) => boolean | void | Promise<boolean | void>;
  onSendAssistantPrompt: (payload: WriteAssistantPromptPayload) => Promise<boolean>;
  onInterruptAssistant: () => void;
  assistantBusy: boolean;
  writeThreads: ThreadSummary[];
  onSelectWriteThread: (id: string) => void | Promise<void>;
  onNewWriteThread: () => void | Promise<void>;
  onDeleteWriteThread: (id: string) => void | Promise<void>;
  onArchiveWriteThread: (id: string) => void | Promise<void>;
  onRestoreWriteThread: (id: string) => void | Promise<void>;
  showArchivedThreads: boolean;
  onToggleArchivedThreads: () => void;
  toastMessage: string | null;
  toastEnabled: boolean;
  onDismissToast: () => void;
}

export function WriteWorkbenchStage({
  onApprove,
  pendingApprovalResponses,
  onUserInputRespond,
  onWorkspaceSelected,
  onSendAssistantPrompt,
  onInterruptAssistant,
  assistantBusy,
  writeThreads,
  onSelectWriteThread,
  onNewWriteThread,
  onDeleteWriteThread,
  onArchiveWriteThread,
  onRestoreWriteThread,
  showArchivedThreads,
  onToggleArchivedThreads,
  toastMessage,
  toastEnabled,
  onDismissToast,
}: WriteWorkbenchStageProps): ReactElement {
  return (
    <>
      <WriteWorkspaceView
        onApprove={onApprove}
        pendingApprovalResponses={pendingApprovalResponses}
        onUserInputRespond={onUserInputRespond}
        onWorkspaceSelected={onWorkspaceSelected}
        onSendAssistantPrompt={onSendAssistantPrompt}
        onInterruptAssistant={onInterruptAssistant}
        assistantBusy={assistantBusy}
        writeThreads={writeThreads}
        onSelectWriteThread={onSelectWriteThread}
        onNewWriteThread={onNewWriteThread}
        onDeleteWriteThread={onDeleteWriteThread}
        onArchiveWriteThread={onArchiveWriteThread}
        onRestoreWriteThread={onRestoreWriteThread}
        showArchivedThreads={showArchivedThreads}
        onToggleArchivedThreads={onToggleArchivedThreads}
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
