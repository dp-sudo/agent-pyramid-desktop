import { ipcMain } from "electron";
import { GOAL_UPDATE_CHANNEL } from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type { GoalUpdateRequest, ThreadGoalStatus } from "../../shared/agent-contracts.js";
import { err, isThreadGoalStatus, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";

export function registerGoalHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(GOAL_UPDATE_CHANNEL, async (_event, request: GoalUpdateRequest) => {
    try {
      const parsed = parseGoalUpdateRequest(request);
      return ok(await runtime.updateThreadGoal(parsed.threadId, parsed.update));
    } catch (error) {
      return err(IPC_ERROR_CODES.GOAL_UPDATE_FAILED, messageOf(error));
    }
  });
}

// IPC is a trust boundary: validate unknown renderer payloads before applying goal state.
export function parseGoalUpdateRequest(request: unknown): {
  threadId: string;
  update: {
    goal?: string | null;
    status?: ThreadGoalStatus;
    summary?: string;
  };
} {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Goal update request must be an object.");
  }
  const value = request as Record<string, unknown>;
  if (typeof value.threadId !== "string" || !value.threadId.trim()) {
    throw new Error("Goal update requires threadId.");
  }
  if (value.clear !== undefined && typeof value.clear !== "boolean") {
    throw new Error("Goal update clear must be a boolean.");
  }
  if (value.goal !== undefined && value.goal !== null && typeof value.goal !== "string") {
    throw new Error("Goal update goal must be a string or null.");
  }
  if (value.clear === true && ("goal" in value || "status" in value || "summary" in value)) {
    throw new Error("Goal update clear cannot be combined with goal, status, or summary.");
  }
  if (value.goal === null && ("status" in value || "summary" in value)) {
    throw new Error("Goal update clear cannot be combined with status or summary.");
  }
  if (typeof value.goal === "string" && !value.goal.trim()) {
    throw new Error("Goal update goal must be a non-empty string or null.");
  }
  if (value.status !== undefined && !isThreadGoalStatus(value.status)) {
    throw new Error("Goal update status must be active, complete, or blocked.");
  }
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new Error("Goal update summary must be a string.");
  }
  if (typeof value.summary === "string" && !value.summary.trim()) {
    throw new Error("Goal update summary must be a non-empty string.");
  }
  const update = {
    ...(value.clear === true ? { goal: null } : value.goal !== undefined
      ? { goal: value.goal === null ? null : value.goal.trim() }
      : {}),
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary.trim() } : {}),
  };
  if (Object.keys(update).length === 0) {
    throw new Error("Goal update must include at least one of goal, status, or summary.");
  }
  return {
    threadId: value.threadId.trim(),
    update,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
