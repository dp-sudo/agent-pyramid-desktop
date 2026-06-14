import type {
  RuntimePermissionRule,
  RuntimePreferences,
  RuntimePreferencesUpdate,
} from "../../../shared/agent-contracts";
import { cloneMcpServerConfig } from "./settings-mcp-model";
import { createRuntimePreferenceId } from "./settings-runtime-model";

export type RuntimeSaveState = "idle" | "loading" | "saving" | "saved" | "error";

export interface RuntimeCommandDraft {
  timeoutMs: string;
  maxOutputBytes: string;
}

export interface RuntimeSkillsDraft {
  activeLimit: string;
  instructionBudgetBytes: string;
  extraRoots: string;
}

export function toRuntimeCommandDraft(
  command: RuntimePreferences["command"],
): RuntimeCommandDraft {
  return {
    timeoutMs: String(command.timeoutMs),
    maxOutputBytes: String(command.maxOutputBytes),
  };
}

export function toRuntimeSkillsDraft(
  skills: RuntimePreferences["skills"],
): RuntimeSkillsDraft {
  return {
    activeLimit: String(skills.activeLimit),
    instructionBudgetBytes: String(skills.instructionBudgetBytes),
    extraRoots: formatRuntimeSkillsExtraRoots(skills.extraRoots),
  };
}

export function formatRuntimeSkillsExtraRoots(roots: readonly string[]): string {
  return roots.join("\n");
}

export function toPermissionRulePatternDrafts(
  rules: readonly RuntimePermissionRule[],
): Record<string, string> {
  return Object.fromEntries(rules.map((rule) => [rule.id, rule.pattern]));
}

export function shouldDisableRuntimePreferenceControls(
  hasAgentApi: boolean,
  runtimeSaveState: RuntimeSaveState,
): boolean {
  return !hasAgentApi || runtimeSaveState === "loading" || runtimeSaveState === "saving";
}

export function mergeRuntimePreferencesUpdates(
  current: RuntimePreferencesUpdate | null,
  update: RuntimePreferencesUpdate,
): RuntimePreferencesUpdate {
  if (!current) {
    return cloneRuntimePreferencesUpdate(update);
  }
  return {
    ...current,
    ...update,
    ...(current.toolAvailability || update.toolAvailability
      ? {
          toolAvailability: {
            ...current.toolAvailability,
            ...update.toolAvailability,
            code: {
              ...current.toolAvailability?.code,
              ...update.toolAvailability?.code,
            },
            write: {
              ...current.toolAvailability?.write,
              ...update.toolAvailability?.write,
            },
          },
        }
      : {}),
    ...(current.approvalExperience || update.approvalExperience
      ? {
          approvalExperience: {
            ...current.approvalExperience,
            ...update.approvalExperience,
          },
        }
      : {}),
    ...(current.command || update.command
      ? { command: { ...current.command, ...update.command } }
      : {}),
    ...(current.compaction || update.compaction
      ? { compaction: { ...current.compaction, ...update.compaction } }
      : {}),
    ...(current.skills || update.skills
      ? {
          skills: {
            ...current.skills,
            ...update.skills,
            ...(update.skills?.extraRoots
              ? { extraRoots: [...update.skills.extraRoots] }
              : current.skills?.extraRoots
                ? { extraRoots: [...current.skills.extraRoots] }
                : {}),
          },
        }
      : {}),
    ...(update.permissionRules !== undefined
      ? { permissionRules: clonePermissionRules(update.permissionRules) }
      : current.permissionRules !== undefined
        ? { permissionRules: clonePermissionRules(current.permissionRules) }
        : {}),
    ...(update.mcpServers !== undefined
      ? { mcpServers: update.mcpServers.map(cloneMcpServerConfig) }
      : current.mcpServers !== undefined
        ? { mcpServers: current.mcpServers.map(cloneMcpServerConfig) }
        : {}),
  };
}

export function createDefaultPermissionRule(): RuntimePermissionRule {
  return {
    id: createRuntimePreferenceId(),
    tool: "command",
    pattern: "npm test*",
    effect: "ask",
  };
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function clearDeletedDefaultProfileReferences(
  preferences: RuntimePreferences,
  deletedProfileId: string,
): RuntimePreferences {
  const codeDefaultModelProfileId =
    preferences.codeDefaultModelProfileId === deletedProfileId
      ? null
      : preferences.codeDefaultModelProfileId;
  const writeDefaultModelProfileId =
    preferences.writeDefaultModelProfileId === deletedProfileId
      ? null
      : preferences.writeDefaultModelProfileId;
  if (
    codeDefaultModelProfileId === preferences.codeDefaultModelProfileId &&
    writeDefaultModelProfileId === preferences.writeDefaultModelProfileId
  ) {
    return preferences;
  }
  return {
    ...preferences,
    codeDefaultModelProfileId,
    writeDefaultModelProfileId,
  };
}

export function resolveRuntimePreferencesAfterProfileActivationRefreshFailure(
  preferences: RuntimePreferences,
): RuntimePreferences {
  return preferences;
}

function cloneRuntimePreferencesUpdate(
  update: RuntimePreferencesUpdate,
): RuntimePreferencesUpdate {
  return mergeRuntimePreferencesUpdates({}, update);
}

function clonePermissionRules(
  rules: readonly RuntimePermissionRule[],
): RuntimePermissionRule[] {
  return rules.map((rule) => ({ ...rule }));
}
