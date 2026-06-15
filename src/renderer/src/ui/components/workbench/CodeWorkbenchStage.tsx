import type { ReactElement } from "react";
import { MessageTimeline } from "../chat/MessageTimeline";
import { PendingApprovalPanel } from "../chat/PendingApprovalPanel";
import type {
  ApprovalPendingDecision,
  ApprovalResponseChoice,
} from "../chat/ChatBlock";
import {
  FloatingComposer,
  type FloatingComposerRequestPayload,
} from "../composer";
import { RightInspector } from "../inspector/RightInspector";
import { WorkbenchTopBar } from "../topbar/WorkbenchTopBar";
import { WorkbenchErrorToast } from "./WorkbenchErrorToast";

export interface CodeWorkbenchStageProps {
  onApprove: (approvalId: string, response: ApprovalResponseChoice) => Promise<void>;
  pendingApprovalResponses: Record<string, ApprovalPendingDecision>;
  onComposerRequestSend: (payload: FloatingComposerRequestPayload) => Promise<boolean>;
  onInterrupt: () => void;
  composerDisabled: boolean;
  toastMessage: string | null;
  toastEnabled: boolean;
  onDismissToast: () => void;
}

export function CodeWorkbenchStage({
  onApprove,
  pendingApprovalResponses,
  onComposerRequestSend,
  onInterrupt,
  composerDisabled,
  toastMessage,
  toastEnabled,
  onDismissToast,
}: CodeWorkbenchStageProps): ReactElement {
  return (
    <section className="ds-chat-stage">
      <div className="ds-chat-topbar-frame">
        <WorkbenchTopBar />
      </div>
      <div className="ds-chat-stage-body">
        <div className="ds-chat-column ds-chat-column-inset">
          <MessageTimeline
            onApprove={onApprove}
            pendingApprovalResponses={pendingApprovalResponses}
          />
          <div className="ds-chat-composer-dock">
            <div className="ds-chat-composer-frame">
              <PendingApprovalPanel
                onApprove={onApprove}
                pendingApprovalResponses={pendingApprovalResponses}
              />
              <FloatingComposer
                onRequestSend={onComposerRequestSend}
                onInterrupt={onInterrupt}
                disabled={composerDisabled}
              />
              <WorkbenchErrorToast
                message={toastMessage}
                enabled={toastEnabled}
                onDismiss={onDismissToast}
              />
            </div>
          </div>
        </div>
        <RightInspector />
      </div>
    </section>
  );
}
