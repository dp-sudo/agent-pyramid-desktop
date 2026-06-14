import type { ThreadGoal } from "../../shared/agent-contracts.js";
import { isThreadGoalStatus } from "../../shared/agent-contracts.js";

export interface ThreadGoalUpdate {
  goal?: string | null;
  status?: ThreadGoal["status"];
  summary?: string;
}

/**
 * Normalizes runtime goal updates before AgentRuntime reads or writes thread
 * state. IPC and tool parsing keep their own boundary-specific messages; this
 * module preserves the runtime update invariants used by persisted ThreadGoal.
 */
export function normalizeThreadGoalUpdate(update: ThreadGoalUpdate): ThreadGoalUpdate {
  const normalized: ThreadGoalUpdate = {};
  if (update.goal !== undefined) {
    if (update.goal === null) {
      if (update.status !== undefined || update.summary !== undefined) {
        throw new Error("Goal clear cannot be combined with status or summary.");
      }
      normalized.goal = null;
    } else {
      if (typeof update.goal !== "string" || !update.goal.trim()) {
        throw new Error("Goal text is required.");
      }
      normalized.goal = update.goal.trim();
    }
  }
  if (update.status !== undefined) {
    if (!isThreadGoalStatus(update.status)) {
      throw new Error("Goal status must be active, complete, or blocked.");
    }
    normalized.status = update.status;
  }
  if (update.summary !== undefined) {
    if (typeof update.summary !== "string" || !update.summary.trim()) {
      throw new Error("Goal summary must be a non-empty string.");
    }
    normalized.summary = update.summary.trim();
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("Goal update must include at least one of goal, status, or summary.");
  }
  return normalized;
}
