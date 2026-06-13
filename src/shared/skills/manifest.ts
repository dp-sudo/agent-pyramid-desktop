import {
  SkillError,
  type ParsedSkillMarkdown,
  type SkillManifest,
  type SkillTrigger,
  type SkillTriggerKind,
} from "./types.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

export function parseSkillMarkdown(markdown: string, sourcePath: string): ParsedSkillMarkdown {
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
  const manifest = parseSkillManifest(frontmatter, sourcePath);
  const body = normalized.slice(match[0].length).trim();
  return { manifest, body, frontmatter };
}

export function parseSkillManifest(
  frontmatter: Record<string, string>,
  sourcePath: string,
): SkillManifest {
  const name = requiredFrontmatterField(frontmatter, "name", sourcePath);
  const description = requiredFrontmatterField(frontmatter, "description", sourcePath);
  const trigger = parseSkillTrigger(
    requiredFrontmatterField(frontmatter, "trigger", sourcePath),
    sourcePath,
  );
  return {
    id: normalizeSkillId(frontmatter.id || name),
    name,
    description,
    trigger,
  };
}

export function parseSkillTrigger(rawValue: string, sourcePath: string): SkillTrigger {
  const raw = stripQuotes(rawValue).trim();
  if (!raw) {
    throw new SkillError(
      "skill_manifest_invalid",
      `Skill manifest at ${sourcePath} has an empty trigger field.`,
      sourcePath,
    );
  }

  const typedMatch = /^(manual|keyword|command|file-extension):(.+)$/iu.exec(raw);
  if (typedMatch) {
    const kind = typedMatch[1]?.toLowerCase() as SkillTriggerKind | undefined;
    const value = typedMatch[2]?.trim() ?? "";
    if (!kind || !value) {
      throw new SkillError(
        "skill_manifest_invalid",
        `Skill manifest at ${sourcePath} has an invalid trigger field.`,
        sourcePath,
      );
    }
    return { kind, value: normalizeTriggerValue(kind, value) };
  }

  if (raw === "manual") return { kind: "manual", value: "manual" };
  if (raw.startsWith("/")) return { kind: "command", value: raw };
  if (raw.startsWith(".")) return { kind: "file-extension", value: raw.toLowerCase() };
  return { kind: "keyword", value: raw };
}

export function normalizeSkillId(value: string): string {
  return value
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "skill";
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

function requiredFrontmatterField(
  fields: Record<string, string>,
  fieldName: "name" | "description" | "trigger",
  sourcePath: string,
): string {
  const value = fields[fieldName]?.trim() ?? "";
  if (!value) {
    throw new SkillError(
      "skill_manifest_invalid",
      `Skill manifest at ${sourcePath} is missing required field "${fieldName}".`,
      sourcePath,
    );
  }
  return stripQuotes(value);
}

function normalizeTriggerValue(kind: SkillTriggerKind, value: string): string {
  if (kind === "file-extension") {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  }
  return value.trim();
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
