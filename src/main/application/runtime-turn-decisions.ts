import type { AgentMessage } from "../domain/agent/types.js";
import type {
  ModelConfigProfile,
  ModelConfigProfilesState,
  RuntimePreferences,
  ThreadRecord,
  TurnRecord,
  TurnStartRequest,
} from "../../shared/agent-contracts.js";
import type { SkillTurnResolution } from "../../shared/skills/index.js";

export const PLAN_MODE_INSTRUCTION = [
  "Plan mode is active.",
  "First create a concise plan with the create_plan tool.",
  "Do not perform irreversible work while planning.",
].join(" ");

export const GOAL_MODE_INSTRUCTION = [
  "Goal mode is active for this thread.",
  "Keep the thread goal in mind across turns.",
  "Use update_goal when the goal text, completion state, or blocked state changes.",
].join(" ");

export function resolveTurnModelProfile(
  state: ModelConfigProfilesState,
  request: TurnStartRequest,
  threadMode: ThreadRecord["mode"],
  preferences: RuntimePreferences,
): ModelConfigProfile {
  const profiles = state.profiles;
  if (request.modelProfileId) {
    const selected = profiles.find((profile) => profile.id === request.modelProfileId);
    if (!selected) {
      throw new Error(`Model config profile ${request.modelProfileId} not found.`);
    }
    return selected;
  }

  const modeDefaultProfileId = threadMode === "write"
    ? preferences.writeDefaultModelProfileId
    : preferences.codeDefaultModelProfileId;
  if (modeDefaultProfileId) {
    const selected = profiles.find((profile) => profile.id === modeDefaultProfileId);
    if (selected) return selected;
  }

  const selected = request.model
    ? profiles.find((profile) => profile.config.model === request.model)
    : profiles.find((profile) => profile.id === state.activeProfileId);
  if (selected) return selected;

  const active = profiles.find((profile) => profile.id === state.activeProfileId);
  if (active) return active;

  const fallback = profiles[0];
  if (!fallback) {
    throw new Error("No model config profile is available.");
  }
  return fallback;
}

export function buildRuntimeContextMessages(input: {
  turn: TurnRecord;
  thread: ThreadRecord;
  skillResolution: SkillTurnResolution | null;
}): AgentMessage[] {
  const parts: string[] = [];
  if (input.turn.mode === "plan") {
    parts.push(PLAN_MODE_INSTRUCTION);
  }
  if (input.turn.goalMode || input.thread.goal?.status === "active") {
    parts.push(GOAL_MODE_INSTRUCTION);
    if (input.thread.goal) {
      parts.push(`Current thread goal: ${input.thread.goal.text}`);
    }
  }
  if (input.skillResolution && input.skillResolution.instructions.length > 0) {
    parts.push([
      "Matched Agent Skills are active for this turn.",
      "Follow each Active Skill instruction when it is relevant to the user's request.",
      ...input.skillResolution.instructions,
    ].join("\n\n"));
  }
  if (parts.length === 0) return [];
  return [{ role: "system", content: parts.join("\n\n") }];
}
