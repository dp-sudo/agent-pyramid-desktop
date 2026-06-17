import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeSkillId, parseSkillMarkdown } from "./manifest.js";
import {
  SkillError,
  type Skill,
  type SkillLoadResult,
  type SkillMatch,
  type SkillMatchInput,
  type SkillReference,
  type SkillRoot,
  type SkillScope,
  type SkillTurnResolution,
  type SkillValidationError,
} from "./types.js";

const SKILL_FILE_NAME = "SKILL.md";
const REFERENCES_DIR_NAME = "references";

export type LoadSkillsOptions = {
  scope?: SkillScope;
  missingRootIsError?: boolean;
};

export type ResolveSkillsOptions = {
  activeLimit: number;
  instructionBudgetBytes: number;
};

export class SkillRegistry {
  private readonly skillsById = new Map<string, Skill>();

  constructor(skills: readonly Skill[] = []) {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  register(skill: Skill): void {
    if (this.skillsById.has(skill.id)) {
      throw new SkillError(
        "skill_duplicate_id",
        `Skill "${skill.id}" is already registered.`,
        skill.skillPath,
      );
    }
    this.skillsById.set(skill.id, skill);
  }

  listSkills(): Skill[] {
    return [...this.skillsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getSkill(id: string): Skill | undefined {
    return this.skillsById.get(normalizeSkillId(id));
  }

  matchSkill(input: SkillMatchInput): Skill[] {
    return this.matchSkills(input).map((match) => match.skill);
  }

  matchSkills(input: SkillMatchInput): SkillMatch[] {
    const matches = this.listSkills()
      .map((skill) => matchSkill(skill, input))
      .filter((match): match is SkillMatch => Boolean(match));
    return matches.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  }

  resolveTurn(input: SkillMatchInput, options: ResolveSkillsOptions): SkillTurnResolution {
    const activeMatches = this.matchSkills(input).slice(0, Math.max(0, options.activeLimit));
    const instructions: string[] = [];
    const activeSkillIds: string[] = [];
    let injectedBytes = 0;
    for (const match of activeMatches) {
      const instruction = formatSkillInstruction(match);
      const bytes = Buffer.byteLength(instruction, "utf8");
      if (injectedBytes + bytes > options.instructionBudgetBytes) continue;
      instructions.push(instruction);
      activeSkillIds.push(match.skill.id);
      injectedBytes += bytes;
    }
    return {
      activeSkillIds,
      activations: activeMatches
        .filter((match) => activeSkillIds.includes(match.skill.id))
        .map(({ skillId, reason, score }) => ({ skillId, reason, score })),
      instructions,
      injectedBytes,
      validationErrors: [],
    };
  }
}

export async function loadSkills(rootDir: string, options: LoadSkillsOptions = {}): Promise<Skill[]> {
  return (await loadSkillsFromRoots([{
    path: rootDir,
    scope: options.scope ?? "project",
    missingIsError: options.missingRootIsError ?? true,
  }])).skills;
}

export async function loadSkillsFromRoots(roots: readonly SkillRoot[]): Promise<SkillLoadResult> {
  const skills: Skill[] = [];
  const validationErrors: SkillValidationError[] = [];
  for (const root of roots) {
    const resolvedRoot = path.resolve(root.path);
    const candidates = await discoverSkillDirectories(resolvedRoot, root.missingIsError)
      .catch((error: unknown) => {
        validationErrors.push({ root: resolvedRoot, message: errorMessage(error) });
        return [];
      });
    for (const candidate of candidates) {
      const loaded = await loadSkillFromDirectory(candidate, { scope: root.scope })
        .catch((error: unknown) => {
          validationErrors.push({ root: candidate, message: errorMessage(error) });
          return null;
        });
      if (loaded) skills.push(loaded);
    }
  }
  const unique = new Map<string, Skill>();
  for (const skill of skills.sort(compareSkillPriority)) {
    if (!unique.has(skill.id)) {
      unique.set(skill.id, skill);
    } else {
      validationErrors.push({
        root: skill.rootDir,
        message: `Duplicate skill id "${skill.id}" ignored; earlier root has priority.`,
      });
    }
  }
  return {
    skills: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    validationErrors,
    roots: [...roots],
  };
}

export async function loadSkillFromDirectory(
  skillDir: string,
  options: { scope?: SkillScope } = {},
): Promise<Skill> {
  const rootDir = path.resolve(skillDir);
  await assertDirectory(rootDir);
  const skillPath = path.join(rootDir, SKILL_FILE_NAME);
  const markdown = await readFile(skillPath, "utf8").catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new SkillError(
        "skill_manifest_not_found",
        `Skill package at ${rootDir} is missing ${SKILL_FILE_NAME}.`,
        skillPath,
      );
    }
    throw error;
  });
  const parsed = parseSkillMarkdown(markdown, skillPath, {
    fallbackName: path.basename(rootDir),
  });
  const references = await loadSkillReferences(rootDir);
  return {
    ...parsed.manifest,
    rootDir,
    skillPath,
    body: appendReferences(parsed.body, references),
    scope: options.scope ?? "project",
    references,
  };
}

async function discoverSkillDirectories(
  rootDir: string,
  missingRootIsError: boolean,
): Promise<string[]> {
  const rootStatus = await pathStatus(rootDir);
  if (rootStatus === "missing" && !missingRootIsError) return [];
  if (rootStatus !== "directory") {
    throw new SkillError(
      "skills_root_not_found",
      rootStatus === "missing"
        ? `Skills root does not exist: ${rootDir}`
        : `Skills root is not a directory: ${rootDir}`,
      rootDir,
    );
  }
  if (await hasSkillFile(rootDir)) return [rootDir];

  const entries = await readdir(rootDir, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name);
    if (await hasSkillFile(candidate)) candidates.push(candidate);
  }
  return candidates.sort((a, b) => a.localeCompare(b));
}

async function pathStatus(target: string): Promise<"directory" | "file" | "missing"> {
  try {
    const targetStat = await stat(target);
    return targetStat.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

async function hasSkillFile(dir: string): Promise<boolean> {
  const skillPath = path.join(dir, SKILL_FILE_NAME);
  try {
    const fileStat = await stat(skillPath);
    return fileStat.isFile();
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertDirectory(dir: string): Promise<void> {
  const status = await pathStatus(dir);
  if (status !== "directory") {
    throw new SkillError(
      "skills_root_not_found",
      status === "missing" ? `Skills root does not exist: ${dir}` : `Skills root is not a directory: ${dir}`,
      dir,
    );
  }
}

async function loadSkillReferences(rootDir: string): Promise<SkillReference[]> {
  const referencesDir = path.join(rootDir, REFERENCES_DIR_NAME);
  const status = await pathStatus(referencesDir);
  if (status === "missing") return [];
  if (status !== "directory") return [];
  const entries = await readdir(referencesDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const references: SkillReference[] = [];
  for (const name of markdownFiles) {
    const referencePath = path.join(referencesDir, name);
    const content = (await readFile(referencePath, "utf8")).trim();
    if (!content) continue;
    references.push({ name: path.basename(name, path.extname(name)), path: referencePath, content });
  }
  return references;
}

function appendReferences(body: string, references: readonly SkillReference[]): string {
  if (references.length === 0) return body;
  const referenceBlocks = references.map((reference) =>
    [`## Reference: ${reference.name}`, reference.content].join("\n\n")
  );
  return [body, ...referenceBlocks].filter(Boolean).join("\n\n");
}

function matchSkill(skill: Skill, input: SkillMatchInput): SkillMatch | null {
  const text = input.text ?? "";
  const lowerText = text.toLowerCase();
  const command = input.command?.toLowerCase() ?? "";
  const fileTypes = fileTypesFrom(input.filePaths ?? [], text);
  const explicit = explicitSkillMention(skill, lowerText);
  if (explicit) return withSkill(skill, explicit, 1_000);

  const matchedCommand = skill.trigger.commands.find((candidate) => {
    const normalized = candidate.toLowerCase();
    return command === normalized || startsWithSkillToken(lowerText, normalized);
  });
  if (matchedCommand) return withSkill(skill, `command:${matchedCommand}`, 900);

  const matchedPattern = skill.trigger.promptPatterns.find((candidate) =>
    safePatternMatches(candidate, text)
  );
  if (matchedPattern) return withSkill(skill, `pattern:${matchedPattern}`, 600);

  const matchedKeyword = skill.trigger.keywords.find((candidate) =>
    lowerText.includes(candidate.toLowerCase())
  );
  if (matchedKeyword) return withSkill(skill, `keyword:${matchedKeyword}`, 500);

  const matchedFileType = skill.trigger.fileTypes.find((candidate) =>
    fileTypes.has(normalizeFileType(candidate))
  );
  if (matchedFileType) return withSkill(skill, `fileType:${matchedFileType}`, 300);

  return null;
}

function withSkill(skill: Skill, reason: string, score: number): SkillMatch {
  return {
    skill,
    skillId: skill.id,
    reason,
    score: score + skill.priority + scopeMatchBonus(skill),
  };
}

function scopeMatchBonus(skill: Skill): number {
  if (skill.scope === "project") return 20;
  if (skill.scope === "custom") return 10;
  return 0;
}

function explicitSkillMention(skill: Skill, lowerText: string): string | undefined {
  const id = skill.id.toLowerCase();
  const name = skill.name.toLowerCase();
  if (
    includesSkillToken(lowerText, `$${id}`) ||
    includesSkillToken(lowerText, `@${id}`) ||
    includesSkillToken(lowerText, `/skill:${id}`)
  ) {
    return "explicit:id";
  }
  if (
    name &&
    (includesSkillToken(lowerText, `$${name}`) ||
      includesSkillToken(lowerText, `@${name}`))
  ) {
    return "explicit:name";
  }
  return undefined;
}

function startsWithSkillToken(text: string, token: string): boolean {
  return text.startsWith(token) && isSkillTokenBoundary(text[token.length]);
}

function includesSkillToken(text: string, token: string): boolean {
  let index = text.indexOf(token);
  while (index >= 0) {
    const previous = index > 0 ? text[index - 1] : undefined;
    const next = text[index + token.length];
    if (isSkillTokenBoundary(previous) && isSkillTokenBoundary(next)) {
      return true;
    }
    index = text.indexOf(token, index + 1);
  }
  return false;
}

function isSkillTokenBoundary(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}_-]/u.test(char);
}

function safePatternMatches(pattern: string, prompt: string): boolean {
  try {
    return new RegExp(pattern, "iu").test(prompt);
  } catch (_error) {
    // Skill trigger patterns are optional match hints; malformed patterns fail closed
    // so one bad skill cannot block loading or matching the rest of the catalog.
    return false;
  }
}

function fileTypesFrom(paths: readonly string[], prompt: string): Set<string> {
  const out = new Set<string>();
  for (const filePath of paths) {
    const ext = path.extname(filePath);
    if (ext) out.add(normalizeFileType(ext));
  }
  for (const match of prompt.matchAll(/\.[a-z0-9]+/giu)) {
    out.add(normalizeFileType(match[0] ?? ""));
  }
  return out;
}

function normalizeFileType(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function formatSkillInstruction(match: SkillMatch): string {
  const skill = match.skill;
  if (skill.runAs === "subagent") {
    return [
      `Active Skill: ${skill.name} (${skill.id})`,
      `Activation: ${match.reason}`,
      skill.description ? `Description: ${skill.description}` : "",
      "Run mode: subagent",
      skill.allowedTools.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
      "Call run_skill with this skill id and concrete arguments when isolated subagent work is needed.",
      "Do not inline its SKILL.md body into the parent turn.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    `Active Skill: ${skill.name} (${skill.id})`,
    `Activation: ${match.reason}`,
    skill.description ? `Description: ${skill.description}` : "",
    `Run mode: ${skill.runAs}`,
    skill.allowedTools.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
    skill.body,
  ].filter(Boolean).join("\n\n");
}

function compareSkillPriority(a: Skill, b: Skill): number {
  const scopeDelta = skillScopeRank(a.scope) - skillScopeRank(b.scope);
  return scopeDelta || b.priority - a.priority || a.id.localeCompare(b.id);
}

function skillScopeRank(scope: SkillScope): number {
  if (scope === "project") return 0;
  if (scope === "custom") return 1;
  return 2;
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
