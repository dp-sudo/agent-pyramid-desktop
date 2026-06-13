export type SkillRunAs = "inline" | "subagent";

export type SkillScope = "project" | "custom" | "builtin";

export type SkillTriggerKind = "manual" | "keyword" | "command" | "prompt-pattern" | "file-extension";

export type SkillTrigger = {
  manual: boolean;
  keywords: string[];
  commands: string[];
  promptPatterns: string[];
  fileTypes: string[];
};

export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  trigger: SkillTrigger;
  allowedTools: string[];
  priority: number;
  runAs: SkillRunAs;
  model?: string;
  effort?: string;
};

export type Skill = SkillManifest & {
  rootDir: string;
  skillPath: string;
  body: string;
  scope: SkillScope;
  references: SkillReference[];
};

export type SkillReference = {
  name: string;
  path: string;
  content: string;
};

export type ParsedSkillMarkdown = {
  manifest: SkillManifest;
  body: string;
  frontmatter: Record<string, string>;
};

export type SkillMatchInput = {
  text?: string;
  command?: string;
  filePaths?: readonly string[];
};

export type SkillActivation = {
  skillId: string;
  reason: string;
  score: number;
};

export type SkillMatch = SkillActivation & {
  skill: Skill;
};

export type SkillValidationError = {
  root: string;
  message: string;
};

export type SkillRoot = {
  path: string;
  scope: SkillScope;
  missingIsError: boolean;
};

export type SkillLoadResult = {
  skills: Skill[];
  validationErrors: SkillValidationError[];
  roots: SkillRoot[];
};

export type SkillTurnResolution = {
  activeSkillIds: string[];
  activations: SkillActivation[];
  instructions: string[];
  injectedBytes: number;
  validationErrors: SkillValidationError[];
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
