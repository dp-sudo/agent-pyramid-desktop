import type { ReactElement } from "react";
import {
  WriteWorkspaceView,
  type WriteAssistantPromptPayload,
} from "../write/WriteWorkspaceView";
import { WorkbenchErrorToast } from "./WorkbenchErrorToast";

export interface WriteWorkbenchStageProps {
  onWorkspaceSelected: (workspace: string) => boolean | void | Promise<boolean | void>;
  onSendAssistantPrompt: (payload: WriteAssistantPromptPayload) => Promise<boolean>;
  onInterruptAssistant: () => void;
  assistantBusy: boolean;
  toastMessage: string | null;
  toastEnabled: boolean;
  onDismissToast: () => void;
}

export function WriteWorkbenchStage({
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
