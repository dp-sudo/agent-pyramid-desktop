export type SkillTriggerKind = "manual" | "keyword" | "command" | "file-extension";

export type SkillTrigger = {
  kind: SkillTriggerKind;
  value: string;
};

export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  trigger: SkillTrigger;
};

export type Skill = SkillManifest & {
  rootDir: string;
  skillPath: string;
  body: string;
};

export type ParsedSkillMarkdown = {
  manifest: SkillManifest;
  body: string;
  frontmatter: Record<string, string>;
};

export type SkillMatchInput = {
  text?: string;
  command?: string;
  filePath?: string;
};

export type SkillErrorCode =
  | "skills_root_not_found"
  | "skill_manifest_not_found"
  | "skill_manifest_invalid"
  | "skill_duplicate_id";

export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
    readonly filePath?: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}
