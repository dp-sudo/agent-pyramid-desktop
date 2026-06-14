import {
  MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
} from "../../../shared/agent-contracts";

export type RuntimeCommandDraftField = "timeoutMs" | "maxOutputBytes";
export type RuntimeSkillsDraftField = "activeLimit" | "instructionBudgetBytes";
export type SettingsTranslator = (key: string, options?: Record<string, unknown>) => string;

type RuntimeCommandDraftValidationResult =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

type RuntimeSkillsNumericDraftValidationResult =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

type RuntimeSkillsExtraRootsDraftValidationResult =
  | { ok: true; value: string[] }
  | { ok: false; message: string };

type McpServerEnvDraftResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string };

export function validateRuntimeCommandDraft(
  field: RuntimeCommandDraftField,
  raw: string,
  t: SettingsTranslator,
): RuntimeCommandDraftValidationResult {
  const label = field === "timeoutMs"
    ? t("settings.fields.commandTimeout")
    : t("settings.fields.commandMaxOutput");
  const min = field === "timeoutMs"
    ? MIN_RUNTIME_COMMAND_TIMEOUT_MS
    : MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
  const max = field === "timeoutMs"
    ? MAX_RUNTIME_COMMAND_TIMEOUT_MS
    : MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: t("settings.errors.positiveInteger", { field: label }),
    };
  }
  if (parsed < min || parsed > max) {
    return {
      ok: false,
      message: t("settings.errors.integerRange", { field: label, min, max }),
    };
  }
  return { ok: true, value: parsed };
}

export function validateRuntimeSkillsNumericDraft(
  field: RuntimeSkillsDraftField,
  raw: string,
  t: SettingsTranslator,
): RuntimeSkillsNumericDraftValidationResult {
  const label = field === "activeLimit"
    ? t("settings.fields.skillsActiveLimit")
    : t("settings.fields.skillsInstructionBudgetBytes");
  const min = field === "activeLimit"
    ? MIN_RUNTIME_SKILLS_ACTIVE_LIMIT
    : MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES;
  const max = field === "activeLimit"
    ? MAX_RUNTIME_SKILLS_ACTIVE_LIMIT
    : MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES;
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return {
      ok: false,
      message: t("settings.errors.nonNegativeInteger", { field: label }),
    };
  }
  if (parsed < min || parsed > max) {
    return {
      ok: false,
      message: t("settings.errors.integerRange", { field: label, min, max }),
    };
  }
  return { ok: true, value: parsed };
}

export function parseRuntimeSkillsExtraRootsDraft(
  raw: string,
  t: SettingsTranslator,
): RuntimeSkillsExtraRootsDraftValidationResult {
  const roots = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const invalidIndex = roots.findIndex((root) => root.includes("\0"));
  if (invalidIndex >= 0) {
    return {
      ok: false,
      message: t("settings.errors.skillsExtraRootNul", { index: invalidIndex + 1 }),
    };
  }
  return { ok: true, value: Array.from(new Set(roots)) };
}

export function parseMcpServerEnvDraft(
  raw: string,
  t: SettingsTranslator,
): McpServerEnvDraftResult {
  return parseMcpServerStringRecordDraft(raw, t, "env");
}

export function parseMcpServerStringRecordDraft(
  raw: string,
  t: SettingsTranslator,
  kind: "env" | "headers",
): McpServerEnvDraftResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };
  const objectError = kind === "headers"
    ? t("settings.errors.mcpHeadersObject")
    : t("settings.errors.mcpEnvObject");
  const jsonError = kind === "headers"
    ? t("settings.errors.mcpHeadersJson")
    : t("settings.errors.mcpEnvJson");
  const duplicateKeyError = kind === "headers"
    ? t("settings.errors.mcpHeadersDuplicateKey")
    : t("settings.errors.mcpEnvDuplicateKey");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: objectError };
    }
    const env: Record<string, string> = {};
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim() || key.includes("\0") || typeof value !== "string" || value.includes("\0")) {
        return { ok: false, message: objectError };
      }
      const parsedKey = key.trim();
      if (keys.has(parsedKey)) {
        return { ok: false, message: duplicateKeyError };
      }
      keys.add(parsedKey);
      env[parsedKey] = value;
    }
    return { ok: true, value: env };
  } catch (error) {
    void error;
    return { ok: false, message: jsonError };
  }
}

export function splitWhitespaceList(value: string): string[] {
  return value.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
}

export function splitCommaList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function createRuntimePreferenceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
