import { ipcMain } from "electron";
import { GOAL_UPDATE_CHANNEL } from "../../shared/ipc.js";
import type { GoalUpdateRequest } from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";

export function registerGoalHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(GOAL_UPDATE_CHANNEL, async (_event, request: GoalUpdateRequest) => {
    try {
      return ok(await runtime.updateThreadGoal(request.threadId, {
        goal: request.clear ? null : request.goal,
        status: request.status,
        summary: request.summary,
      }));
    } catch (error) {
      return err("GOAL_UPDATE_FAILED", messageOf(error));
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
