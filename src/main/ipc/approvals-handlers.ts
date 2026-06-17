import { ipcMain } from "electron";
import { APPROVAL_RESPOND_CHANNEL } from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type { ApprovalRespondRequest, ApprovalRespondResponse } from "../../shared/agent-contracts.js";
import { err, isApprovalDecisionScope, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";
import { messageOfIpcError as messageOf } from "./ipc-result-handler.js";

export function registerApprovalHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(APPROVAL_RESPOND_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseApprovalRespondRequest(request);
      const response: ApprovalRespondResponse = runtime.respondApproval(parsed);
      return ok(response);
    } catch (error) {
      return err(IPC_ERROR_CODES.APPROVAL_RESPOND_FAILED, messageOf(error));
    }
  });
}

// Approval responses resolve suspended tool execution; validate the renderer IPC
// payload before it can affect runtime pending-approval state.
export function parseApprovalRespondRequest(request: unknown): ApprovalRespondRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Approval response request must be an object.");
  }
  const value = request as Record<string, unknown>;
  if (typeof value.approvalId !== "string" || !value.approvalId.trim()) {
    throw new Error("Approval response requires approvalId.");
  }
  if (value.decision !== "allow" && value.decision !== "deny") {
    throw new Error("Approval decision must be allow or deny.");
  }
  if (value.scope !== undefined && !isApprovalDecisionScope(value.scope)) {
    throw new Error("Approval scope is invalid.");
  }
  return {
    approvalId: value.approvalId.trim(),
    decision: value.decision,
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
  };
}
