import { ipcMain } from "electron";
import { APPROVAL_RESPOND_CHANNEL } from "../../shared/ipc.js";
import type { ApprovalRespondRequest } from "../../shared/agent-contracts.js";
import { ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";

export function registerApprovalHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(APPROVAL_RESPOND_CHANNEL, async (_event, request: ApprovalRespondRequest) => {
    runtime.respondApproval(request);
    return ok({ approvalId: request.approvalId, decision: request.decision });
  });
}
