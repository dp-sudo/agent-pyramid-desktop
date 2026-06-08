import { ipcMain } from "electron";
import { GOAL_UPDATE_CHANNEL } from "../../shared/ipc.js";
import type { GoalUpdateRequest, ThreadGoalStatus } from "../../shared/agent-contracts.js";
import { err, isThreadGoalStatus, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";

export function registerGoalHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(GOAL_UPDATE_CHANNEL, async (_event, request: GoalUpdateRequest) => {
    try {
      const parsed = parseGoalUpdateRequest(request);
      return ok(await runtime.updateThreadGoal(parsed.threadId, parsed.update));
    } catch (error) {
      return err("GOAL_UPDATE_FAILED", messageOf(error));
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
  if (value.status !== undefined && !isThreadGoalStatus(value.status)) {
    throw new Error("Goal update status must be active, complete, or blocked.");
  }
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new Error("Goal update summary must be a string.");
  }
  return {
    threadId: value.threadId.trim(),
    update: {
      ...(value.clear === true ? { goal: null } : value.goal !== undefined ? { goal: value.goal } : {}),
      ...(value.status !== undefined ? { status: value.status } : {}),
      ...(value.summary !== undefined ? { summary: value.summary } : {}),
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
