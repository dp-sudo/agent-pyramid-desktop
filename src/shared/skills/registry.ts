import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseSkillMarkdown } from "./manifest.js";
import {
  SkillError,
  type Skill,
  type SkillMatchInput,
} from "./types.js";

const SKILL_FILE_NAME = "SKILL.md";

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
    return this.skillsById.get(id);
  }

  matchSkill(input: SkillMatchInput): Skill[] {
    return this.listSkills().filter((skill) => skillMatches(skill, input));
  }
}

export async function loadSkills(rootDir: string): Promise<Skill[]> {
  const resolvedRoot = path.resolve(rootDir);
  await assertDirectory(resolvedRoot);
  const skillDirs = await discoverSkillDirectories(resolvedRoot);
  const skills = await Promise.all(skillDirs.map((skillDir) => loadSkillFromDirectory(skillDir)));
  return new SkillRegistry(skills).listSkills();
}

export async function loadSkillFromDirectory(skillDir: string): Promise<Skill> {
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
  const parsed = parseSkillMarkdown(markdown, skillPath);
  return {
    ...parsed.manifest,
    rootDir,
    skillPath,
    body: parsed.body,
  };
}

async function discoverSkillDirectories(rootDir: string): Promise<string[]> {
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
  try {
    const dirStat = await stat(dir);
    if (!dirStat.isDirectory()) {
      throw new SkillError(
        "skills_root_not_found",
        `Skills root is not a directory: ${dir}`,
        dir,
      );
    }
  } catch (error) {
    if (error instanceof SkillError) throw error;
    if (nodeErrorCode(error) === "ENOENT") {
      throw new SkillError(
        "skills_root_not_found",
        `Skills root does not exist: ${dir}`,
        dir,
      );
    }
    throw error;
  }
}

function skillMatches(skill: Skill, input: SkillMatchInput): boolean {
  const text = input.text?.toLowerCase() ?? "";
  const command = input.command?.toLowerCase() ?? "";
  const filePath = input.filePath?.toLowerCase() ?? "";
  const triggerValue = skill.trigger.value.toLowerCase();

  if (text.includes(`$${skill.id}`) || text.includes(`@${skill.id}`)) return true;
  if (text.includes(`/skill:${skill.id}`)) return true;

  switch (skill.trigger.kind) {
    case "manual":
      return false;
    case "keyword":
      return text.includes(triggerValue);
    case "command":
      return command === triggerValue || text.startsWith(triggerValue);
    case "file-extension":
      return filePath.endsWith(triggerValue) || text.includes(triggerValue);
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
