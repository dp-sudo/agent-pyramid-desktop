import { randomUUID } from "node:crypto";
import type { PlanStep } from "../../shared/agent-contracts.js";
import { PLAN_STEP_STATUSES } from "../../shared/agent-contracts.js";

export interface ParsedPlanToolContent {
  title?: string;
  steps: PlanStep[];
}

/**
 * Converts create_plan tool JSON into the persisted timeline plan shape.
 * Runtime persistence and event ordering stay in AgentRuntime; this module owns
 * only the result parsing and defaulting rules.
 */
export function parsePlanToolContent(rawContent: string): ParsedPlanToolContent {
  const parsed = JSON.parse(rawContent) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("create_plan returned invalid JSON.");
  }
  const value = parsed as { title?: unknown; steps?: unknown };
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("create_plan returned no steps.");
  }
  return {
    ...(typeof value.title === "string" && value.title.trim()
      ? { title: value.title.trim() }
      : {}),
    steps: value.steps.map((step, index) => parsePlanStep(step, index)),
  };
}

function parsePlanStep(value: unknown, index: number): PlanStep {
  if (!value || typeof value !== "object") {
    throw new Error(`Plan step ${index + 1} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new Error(`Plan step ${index + 1} requires title.`);
  }
  return {
    id: randomUUID(),
    title: raw.title.trim(),
    status: isPlanStepStatus(raw.status) ? raw.status : "pending",
  };
}

function isPlanStepStatus(value: unknown): value is PlanStep["status"] {
  return typeof value === "string" && PLAN_STEP_STATUSES.includes(value as PlanStep["status"]);
}
