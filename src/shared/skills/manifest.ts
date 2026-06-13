import {
  SkillError,
  type ParsedSkillMarkdown,
  type SkillManifest,
  type SkillRunAs,
  type SkillTrigger,
} from "./types.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

export type SkillMarkdownParseOptions = {
  fallbackName?: string;
};

/**
 * SKILL.md is the authoring boundary for skills. The parser accepts the
 * Claude-style name/description body and optional Kun/Reasonix-inspired
 * trigger/tool fields, then returns a normalized manifest plus markdown body.
 */
export function parseSkillMarkdown(
  markdown: string,
  sourcePath: string,
  options: SkillMarkdownParseOptions = {},
): ParsedSkillMarkdown {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/^\uFEFF/u, "");
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (!match) {
    throw new SkillError(
      "skill_manifest_invalid",
      `Skill manifest at ${sourcePath} must start with YAML frontmatter.`,
      sourcePath,
    );
  }

  const frontmatter = parseFlatFrontmatter(match[1] ?? "", sourcePath);
  const body = normalized.slice(match[0].length).trim();
  const manifest = parseSkillManifest(frontmatter, sourcePath, {
    ...options,
    fallbackDescription: firstMarkdownParagraph(body),
  });
  return { manifest, body, frontmatter };
}

type SkillManifestParseOptions = SkillMarkdownParseOptions & {
  fallbackDescription?: string;
};

export function parseSkillManifest(
  frontmatter: Record<string, string>,
  sourcePath: string,
  options: SkillManifestParseOptions = {},
): SkillManifest {
  const rawName = frontmatter.name?.trim() || options.fallbackName?.trim() || "";
  if (!rawName) {
    throw new SkillError(
      "skill_manifest_invalid",
      `Skill manifest at ${sourcePath} is missing required field "name".`,
      sourcePath,
    );
  }
  const name = stripQuotes(rawName);
  const id = normalizeSkillId(frontmatter.id || name);
  const description = stripQuotes(
    frontmatter.description?.trim() || options.fallbackDescription?.trim() || "",
  );
  const trigger = parseSkillTrigger(frontmatter, id, sourcePath);
  const allowedTools = uniqueStrings([
    ...parseListField(frontmatter.allowedTools),
    ...parseListField(frontmatter["allowed-tools"]),
  ]);
  const runAs = parseRunAs(frontmatter.runAs || frontmatter.runas, frontmatter.context, frontmatter.agent);
  return {
    id,
    name,
    description,
    version: stripQuotes(frontmatter.version || "0.0.0"),
    trigger,
    allowedTools,
    priority: parseInteger(frontmatter.priority, 0, sourcePath, "priority"),
    runAs,
    ...(frontmatter.model?.trim() ? { model: stripQuotes(frontmatter.model) } : {}),
    ...(frontmatter.effort?.trim() ? { effort: stripQuotes(frontmatter.effort) } : {}),
  };
}

export function parseSkillTrigger(
  frontmatterOrRawValue: Record<string, string> | string,
  skillIdOrSourcePath: string,
  maybeSourcePath?: string,
): SkillTrigger {
  const empty = createEmptyTrigger();
  if (typeof frontmatterOrRawValue === "string") {
    applyLegacyTrigger(empty, frontmatterOrRawValue, skillIdOrSourcePath);
    return ensureDefaultCommand(empty, normalizeSkillId(skillIdOrSourcePath));
  }

  const sourcePath = maybeSourcePath ?? skillIdOrSourcePath;
  const skillId = normalizeSkillId(skillIdOrSourcePath);
  const trigger = createEmptyTrigger();
  if (frontmatterOrRawValue.trigger?.trim()) {
    applyLegacyTrigger(trigger, frontmatterOrRawValue.trigger, sourcePath);
  }
  trigger.keywords.push(...parseListField(frontmatterOrRawValue.keywords));
  trigger.commands.push(...parseListField(frontmatterOrRawValue.commands));
  trigger.promptPatterns.push(
    ...parseListField(frontmatterOrRawValue.promptPatterns),
    ...parseListField(frontmatterOrRawValue["prompt-patterns"]),
  );
  trigger.fileTypes.push(
    ...parseListField(frontmatterOrRawValue.fileTypes),
    ...parseListField(frontmatterOrRawValue["file-types"]),
  );
  if (frontmatterOrRawValue.manual?.trim() === "true") {
    trigger.manual = true;
  }
  return normalizeTrigger(ensureDefaultCommand(trigger, skillId));
}

export function normalizeSkillId(value: string): string {
  return value
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "skill";
}

function createEmptyTrigger(): SkillTrigger {
  return {
    manual: false,
    keywords: [],
    commands: [],
    promptPatterns: [],
    fileTypes: [],
  };
}

function applyLegacyTrigger(trigger: SkillTrigger, rawValue: string, sourcePath: string): void {
  const raw = stripQuotes(rawValue).trim();
  if (!raw) {
    throw new SkillError(
      "skill_manifest_invalid",
      `Skill manifest at ${sourcePath} has an empty trigger field.`,
      sourcePath,
    );
  }

  const typedMatch = /^(manual|keyword|command|prompt-pattern|file-extension):(.+)$/iu.exec(raw);
  if (typedMatch) {
    const kind = typedMatch[1]?.toLowerCase();
    const value = typedMatch[2]?.trim() ?? "";
    if (!kind || !value) {
      throw new SkillError(
        "skill_manifest_invalid",
        `Skill manifest at ${sourcePath} has an invalid trigger field.`,
        sourcePath,
      );
    }
    addTriggerValue(trigger, kind, value);
    return;
  }

  if (raw === "manual") {
    trigger.manual = true;
  } else if (raw.startsWith("/")) {
    trigger.commands.push(raw);
  } else if (raw.startsWith(".")) {
    trigger.fileTypes.push(raw);
  } else {
    trigger.keywords.push(raw);
  }
}

function addTriggerValue(trigger: SkillTrigger, kind: string, value: string): void {
  if (kind === "manual") {
    trigger.manual = true;
  } else if (kind === "keyword") {
    trigger.keywords.push(value);
  } else if (kind === "command") {
    trigger.commands.push(value);
  } else if (kind === "prompt-pattern") {
    trigger.promptPatterns.push(value);
  } else if (kind === "file-extension") {
    trigger.fileTypes.push(value);
  }
}

function ensureDefaultCommand(trigger: SkillTrigger, skillId: string): SkillTrigger {
  if (skillId) {
    trigger.commands.push(`/${skillId}`);
  }
  return trigger;
}

function normalizeTrigger(trigger: SkillTrigger): SkillTrigger {
  return {
    manual: trigger.manual,
    keywords: uniqueStrings(trigger.keywords.map((entry) => entry.trim()).filter(Boolean)),
    commands: uniqueStrings(trigger.commands.map((entry) => entry.trim()).filter(Boolean)),
    promptPatterns: uniqueStrings(trigger.promptPatterns.map((entry) => entry.trim()).filter(Boolean)),
    fileTypes: uniqueStrings(
      trigger.fileTypes
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
        .map((entry) => entry.startsWith(".") ? entry : `.${entry}`),
    ),
  };
}

function parseFlatFrontmatter(yaml: string, sourcePath: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new SkillError(
        "skill_manifest_invalid",
        `Skill manifest at ${sourcePath} contains an invalid frontmatter line: ${line}`,
        sourcePath,
      );
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields[key] = stripQuotes(value);
  }
  return fields;
}

function parseListField(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return stripQuotes(value)
    .split(",")
    .map((entry) => stripQuotes(entry).trim())
    .filter(Boolean);
}

function parseRunAs(
  runAs: string | undefined,
  context: string | undefined,
  agent: string | undefined,
): SkillRunAs {
  const normalizedRunAs = stripQuotes(runAs ?? "").trim().toLowerCase();
  const normalizedContext = stripQuotes(context ?? "").trim().toLowerCase();
  if (normalizedRunAs === "subagent" || normalizedContext === "fork" || Boolean(agent?.trim())) {
    return "subagent";
  }
  return "inline";
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  sourcePath: string,
  fieldName: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new SkillError(
      "skill_manifest_invalid",
      `Skill manifest at ${sourcePath} field "${fieldName}" must be an integer.`,
      sourcePath,
    );
  }
  return parsed;
}

function firstMarkdownParagraph(markdown: string): string | undefined {
  return markdown
    .split(/\n{2,}/u)
    .map((block) => block.replace(/^#+\s*/u, "").trim())
    .find(Boolean);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
