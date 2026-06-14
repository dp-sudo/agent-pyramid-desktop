import type { AgentTool, AgentToolBaseContext } from "../../domain/agent/types";
import type { ThreadGoalStatus } from "../../../shared/agent-contracts.js";

export interface GoalToolDeps {
  updateGoal(
    threadId: string,
    update: {
      goal?: string | null;
      status?: ThreadGoalStatus;
      summary?: string;
    },
  ): Promise<void>;
}

export function createGoalTools(deps: GoalToolDeps): AgentTool[] {
  return [
    {
      definition: {
        name: "update_goal",
        description:
          "Update the active thread goal text, status, or summary when goal mode is enabled.",
        inputSchema: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              description: "New non-empty goal text.",
            },
            clear: {
              type: "boolean",
              description: "Set true to clear the current goal. Do not combine with goal, status, or summary.",
            },
            status: {
              type: "string",
              enum: ["active", "complete", "blocked"],
              description: "Current goal status.",
            },
            summary: {
              type: "string",
              description: "Short completion or blocked summary.",
            },
          },
        },
      },
      execute: (input, context) => executeUpdateGoal(input, deps, context),
    },
  ];
}

async function executeUpdateGoal(
  input: Record<string, unknown>,
  deps: GoalToolDeps,
  context: AgentToolBaseContext,
): Promise<string> {
  const update = parseGoalUpdate(input);
  await deps.updateGoal(context.threadId, update);
  return JSON.stringify({ updated: true });
}

function parseGoalUpdate(input: Record<string, unknown>): {
  goal?: string | null;
  status?: ThreadGoalStatus;
  summary?: string;
} {
  const update: {
    goal?: string | null;
    status?: ThreadGoalStatus;
    summary?: string;
  } = {};
  if ("clear" in input) {
    if (input.clear !== true && input.clear !== false) {
      throw new Error("clear must be a boolean.");
    }
    if (input.clear === true) {
      if ("goal" in input || "status" in input || "summary" in input) {
        throw new Error("clear cannot be combined with goal, status, or summary.");
      }
      return { goal: null };
    }
  }
  if ("goal" in input) {
    if (typeof input.goal !== "string" || !input.goal.trim()) {
      throw new Error("goal must be a non-empty string. Use clear: true to clear the goal.");
    }
    update.goal = input.goal.trim();
  }
  if ("status" in input) {
    update.status = parseGoalStatus(input.status);
  }
  if ("summary" in input && typeof input.summary !== "string") {
    throw new Error("summary must be a string.");
  }
  if (typeof input.summary === "string") {
    const summary = input.summary.trim();
    if (!summary) {
      throw new Error("summary must be a non-empty string.");
    }
    update.summary = summary;
  }
  if (
    update.goal === undefined &&
    update.status === undefined &&
    update.summary === undefined
  ) {
    throw new Error("update_goal requires at least one of goal, status, or summary.");
  }
  return update;
}

function parseGoalStatus(value: unknown): ThreadGoalStatus {
  if (value === "active" || value === "complete" || value === "blocked") {
    return value;
  }
  throw new Error("goal status must be active, complete, or blocked.");
}
