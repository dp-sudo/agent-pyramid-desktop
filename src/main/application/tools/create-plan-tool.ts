import type { AgentTool } from "../../domain/agent/types";
import {
  PLAN_STEP_STATUSES,
  type PlanStepStatus,
} from "../../../shared/agent-contracts.js";

export const createPlanTool: AgentTool = {
  definition: {
    name: "create_plan",
    description:
      "Create or replace the visible plan for the current turn. Use this in plan mode before proposing implementation steps.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional short title for the plan.",
        },
        steps: {
          type: "array",
          description: "Ordered plan steps.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "A concise step title.",
              },
              status: {
                type: "string",
                enum: [...PLAN_STEP_STATUSES],
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["steps"],
    },
  },
  execute: executeCreatePlan,
};

async function executeCreatePlan(input: Record<string, unknown>): Promise<string> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const steps = parseSteps(input.steps);
  return JSON.stringify({
    title: title || undefined,
    steps,
  });
}

function parseSteps(value: unknown): Array<{ title: string; status: PlanStepStatus }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("create_plan requires a non-empty steps array.");
  }
  return value.map((step, index) => {
    if (!step || typeof step !== "object") {
      throw new Error(`create_plan step ${index + 1} must be an object.`);
    }
    const raw = step as Record<string, unknown>;
    if (typeof raw.title !== "string" || !raw.title.trim()) {
      throw new Error(`create_plan step ${index + 1} requires title.`);
    }
    const status = parseStatus(raw.status);
    return {
      title: raw.title.trim(),
      status,
    };
  });
}

function parseStatus(value: unknown): PlanStepStatus {
  if (value === undefined) {
    return "pending";
  }
  if (typeof value === "string" && PLAN_STEP_STATUSES.includes(value as PlanStepStatus)) {
    return value as PlanStepStatus;
  }
  throw new Error("create_plan step status must be pending, in_progress, or completed.");
}
