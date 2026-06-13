import { ipcMain } from "electron";
import {
  err,
  ok,
  type RuntimeSkillCatalogEntry,
  type RuntimeSkillRootSummary,
  type RuntimeSkillValidationSummary,
  type SkillListRequest,
  type SkillListResponse,
} from "../../shared/agent-contracts.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import { SKILL_LIST_CHANNEL } from "../../shared/ipc.js";
import type { Skill } from "../../shared/skills/index.js";
import type { RuntimePreferencesStore } from "../persistence/runtime-preferences-store.js";
import type { SkillService } from "../skills/skill-service.js";

export function registerSkillHandlers(
  skillService: SkillService,
  runtimePreferencesStore: RuntimePreferencesStore,
): void {
  // Settings uses this read-only catalog to diagnose discovery without exposing
  // full skill bodies or reference contents across the preload boundary.
  ipcMain.handle(SKILL_LIST_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseSkillListRequest(request);
      const preferences = await runtimePreferencesStore.get();
      const loaded = await skillService.loadWorkspaceSkills(parsed.workspace, preferences.skills);
      const response: SkillListResponse = {
        workspace: parsed.workspace,
        enabled: preferences.skills.enabled,
        skills: loaded.skills.map(toCatalogEntry),
        roots: loaded.roots.map((root): RuntimeSkillRootSummary => ({
          path: root.path,
          scope: root.scope,
          missingIsError: root.missingIsError,
        })),
        validationErrors: loaded.validationErrors.map(
          (warning): RuntimeSkillValidationSummary => ({
            root: warning.root,
            message: warning.message,
          }),
        ),
      };
      return ok(response);
    } catch (error) {
      return err(IPC_ERROR_CODES.SKILL_LIST_FAILED, messageOf(error));
    }
  });
}

export function parseSkillListRequest(value: unknown): SkillListRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Skill list request must be an object.");
  }
  const workspace = (value as { workspace?: unknown }).workspace;
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new Error("Skill list workspace must be a non-empty string.");
  }
  if (workspace.includes("\0")) {
    throw new Error("Skill list workspace cannot contain NUL bytes.");
  }
  return { workspace: workspace.trim() };
}

function toCatalogEntry(skill: Skill): RuntimeSkillCatalogEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    runAs: skill.runAs,
    scope: skill.scope,
    priority: skill.priority,
    rootDir: skill.rootDir,
    skillPath: skill.skillPath,
    allowedTools: [...skill.allowedTools],
    trigger: {
      manual: skill.trigger.manual,
      keywords: [...skill.trigger.keywords],
      commands: [...skill.trigger.commands],
      promptPatterns: [...skill.trigger.promptPatterns],
      fileTypes: [...skill.trigger.fileTypes],
    },
    referenceCount: skill.references.length,
    referenceNames: skill.references.map((reference) => reference.name),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
