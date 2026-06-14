import type {
  TurnMode,
  TurnRecord,
  TurnStartRequest,
} from "../../shared/agent-contracts.js";
import { isModelReasoningEffort } from "../../shared/agent-contracts.js";

export type NormalizedTurnStartRequest = Omit<TurnStartRequest, "attachmentIds"> & {
  attachmentIds: string[];
};

/**
 * Normalizes the untrusted renderer/API payload before AgentRuntime allocates a
 * turn. This keeps request shape checks at the runtime boundary while preserving
 * the public TurnStartRequest contract and existing error messages.
 */
export function normalizeTurnStartRequest(request: unknown): NormalizedTurnStartRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Turn start request must be an object.");
  }
  const value = request as Record<string, unknown>;
  const threadId = requiredString(value.threadId, "Turn threadId is required.");
  const text = requiredString(value.text, "Turn text is required.");
  const displayText = optionalString(value.displayText, "Turn displayText must be a string.");
  const model = optionalString(value.model, "Turn model must be a string.");
  const modelProfileId = optionalString(
    value.modelProfileId,
    "Turn modelProfileId must be a string.",
  );
  const reasoningEffort = resolveTurnReasoningEffort(value.reasoningEffort);
  const mode = resolveTurnMode(value.mode);
  const goalMode = resolveTurnGoalMode(value.goalMode);
  return {
    threadId,
    text,
    ...(displayText !== undefined ? { displayText } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelProfileId !== undefined ? { modelProfileId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    attachmentIds: resolveTurnAttachmentIds(value.attachmentIds),
    ...(mode !== undefined ? { mode } : {}),
    ...(goalMode !== undefined ? { goalMode } : {}),
  };
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function resolveTurnReasoningEffort(
  value: unknown,
): TurnRecord["reasoningEffort"] | undefined {
  if (value === undefined) return undefined;
  if (isModelReasoningEffort(value)) return value;
  throw new Error("Turn reasoningEffort is invalid.");
}

function resolveTurnMode(value: unknown): TurnMode | undefined {
  if (value === undefined) return undefined;
  if (value === "agent" || value === "plan") return value;
  throw new Error("Turn mode must be agent or plan.");
}

function resolveTurnGoalMode(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error("Turn goalMode must be a boolean.");
}

function resolveTurnAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Turn attachmentIds must be a string array.");
  }
  return value;
}
