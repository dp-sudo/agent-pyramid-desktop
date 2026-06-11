import { ipcMain } from "electron";
import { APPROVAL_RESPOND_CHANNEL } from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type { ApprovalRespondRequest } from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";

export function registerApprovalHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(APPROVAL_RESPOND_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseApprovalRespondRequest(request);
      runtime.respondApproval(parsed);
      return ok({ approvalId: parsed.approvalId, decision: parsed.decision });
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
  return {
    approvalId: value.approvalId.trim(),
    decision: value.decision,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
