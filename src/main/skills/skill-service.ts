import path from "node:path";
import type { RuntimeSkillsPreferences } from "../../shared/agent-contracts.js";
import {
  SkillRegistry,
  createBuiltinSkills,
  loadSkillFromDirectory,
  loadSkills,
  loadSkillsFromRoots,
  type Skill,
  type SkillLoadResult,
  type SkillMatchInput,
  type SkillRoot,
  type SkillTurnResolution,
} from "../../shared/skills/node.js";

export const PROJECT_SKILL_ROOTS = [
  ".agent/skills",
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".reasonix/skills",
  "skills",
] as const;

export type SkillServiceResolveInput = SkillMatchInput & {
  workspace: string;
  preferences: RuntimeSkillsPreferences;
};

export class SkillService {
  private registry = new SkillRegistry();
  private lastLoadResult: SkillLoadResult = {
    skills: [],
    validationErrors: [],
    roots: [],
  };

  /**
   * Loads all SKILL.md packages from one root. This low-level method is kept for
   * tests and explicit tools; runtime turns usually use loadWorkspaceSkills().
   */
  async loadSkills(rootDir: string): Promise<Skill[]> {
    const skills = await loadSkills(rootDir);
    this.registry = new SkillRegistry(skills);
    this.lastLoadResult = {
      skills: this.registry.listSkills(),
      validationErrors: [],
      roots: [{ path: path.resolve(rootDir), scope: "project", missingIsError: true }],
    };
    return this.registry.listSkills();
  }

  /**
   * Loads one package directory directly; this keeps SKILL.md absence observable
   * instead of making discovery silently skip malformed packages.
   */
  async loadSkillDirectory(skillDir: string): Promise<Skill> {
    const loaded = await loadSkillFromDirectory(skillDir);
    const nextSkills = this.registry
      .listSkills()
      .filter((skill) => skill.id !== loaded.id);
    this.registry = new SkillRegistry([...nextSkills, loaded]);
    this.lastLoadResult = {
      skills: this.registry.listSkills(),
      validationErrors: [],
      roots: [{ path: loaded.rootDir, scope: loaded.scope, missingIsError: true }],
    };
    return loaded;
  }

  async loadWorkspaceSkills(
    workspace: string,
    preferences: RuntimeSkillsPreferences,
  ): Promise<SkillLoadResult> {
    if (!preferences.enabled) {
      this.registry = new SkillRegistry();
      this.lastLoadResult = { skills: [], validationErrors: [], roots: [] };
      return this.lastLoadResult;
    }
    const roots = skillRootsForWorkspace(workspace, preferences);
    const loaded = await loadSkillsFromRoots(roots);
    const skills = mergeBuiltinSkills(loaded.skills);
    this.registry = new SkillRegistry(skills);
    this.lastLoadResult = { ...loaded, skills: this.registry.listSkills() };
    return this.lastLoadResult;
  }

  async resolveTurn(input: SkillServiceResolveInput): Promise<SkillTurnResolution> {
    const loaded = await this.loadWorkspaceSkills(input.workspace, input.preferences);
    const resolution = this.registry.resolveTurn(input, {
      activeLimit: input.preferences.activeLimit,
      instructionBudgetBytes: input.preferences.instructionBudgetBytes,
    });
    return {
      ...resolution,
      validationErrors: loaded.validationErrors,
    };
  }

  listSkills(): Skill[] {
    return this.registry.listSkills();
  }

  getSkill(id: string): Skill | undefined {
    return this.registry.getSkill(id);
  }

  matchSkill(input: SkillMatchInput): Skill[] {
    return this.registry.matchSkill(input);
  }

  diagnostics(): SkillLoadResult {
    return {
      skills: this.lastLoadResult.skills,
      validationErrors: this.lastLoadResult.validationErrors,
      roots: this.lastLoadResult.roots,
    };
  }
}

function mergeBuiltinSkills(skills: readonly Skill[]): Skill[] {
  const unique = new Map<string, Skill>();
  for (const skill of [...skills, ...createBuiltinSkills()].sort(compareSkillScopePriority)) {
    if (!unique.has(skill.id)) {
      unique.set(skill.id, skill);
    }
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function compareSkillScopePriority(a: Skill, b: Skill): number {
  const scopeDelta = skillScopeRank(a) - skillScopeRank(b);
  return scopeDelta || b.priority - a.priority || a.id.localeCompare(b.id);
}

function skillScopeRank(skill: Skill): number {
  if (skill.scope === "project") return 0;
  if (skill.scope === "custom") return 1;
  return 2;
}

export function skillRootsForWorkspace(
  workspace: string,
  preferences: RuntimeSkillsPreferences,
): SkillRoot[] {
  if (!preferences.enabled) return [];
  const projectRoots = PROJECT_SKILL_ROOTS.map((relativeRoot) => ({
    path: path.resolve(workspace, relativeRoot),
    scope: "project" as const,
    missingIsError: false,
  }));
  const extraRoots = preferences.extraRoots
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => ({
      path: path.isAbsolute(root) ? path.resolve(root) : path.resolve(workspace, root),
      scope: "custom" as const,
      missingIsError: true,
    }));
  return uniqueRoots([...projectRoots, ...extraRoots]);
}

function uniqueRoots(roots: readonly SkillRoot[]): SkillRoot[] {
  const seen = new Set<string>();
  const out: SkillRoot[] = [];
  for (const root of roots) {
    const key = comparablePath(root.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

function comparablePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/gu, "").toLowerCase();
}
