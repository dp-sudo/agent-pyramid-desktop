import {
  DEFAULT_RUNTIME_PREFERENCES,
  MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
  RUNTIME_TOOL_NAMES,
  THREAD_MODES,
  isRuntimeCompactionStrategy,
  isRuntimeToolName,
  isThreadApprovalPolicy,
  isThreadMode,
  isThreadSandboxMode,
  type RuntimeApprovalExperiencePreferences,
  type RuntimeCommandPreferences,
  type RuntimeCompactionPreferences,
  type RuntimePreferences,
  type RuntimePreferencesUpdate,
  type RuntimeToolAvailabilityPreferences,
} from "../../shared/agent-contracts.js";

// Runtime preferences are persisted inside the shared app config file, but IPC
// and tests also call this parser directly. Keep parsing and stored-shape
// normalization together so every entry point rejects malformed controls the
// same way.
export function parseRuntimePreferencesUpdate(
  update: unknown,
): RuntimePreferencesUpdate {
  if (!isRecord(update)) {
    throw new Error("Runtime preferences update must be an object.");
  }
  const parsed: RuntimePreferencesUpdate = {};
  if (update.defaultApprovalPolicy !== undefined) {
    if (!isThreadApprovalPolicy(update.defaultApprovalPolicy)) {
      throw new Error("defaultApprovalPolicy is invalid.");
    }
    parsed.defaultApprovalPolicy = update.defaultApprovalPolicy;
  }
  if (update.defaultSandboxMode !== undefined) {
    if (!isThreadSandboxMode(update.defaultSandboxMode)) {
      throw new Error("defaultSandboxMode is invalid.");
    }
    parsed.defaultSandboxMode = update.defaultSandboxMode;
  }
  if (update.toolAvailability !== undefined) {
    parsed.toolAvailability = parseRuntimeToolAvailabilityUpdate(update.toolAvailability);
  }
  if (update.codeDefaultModelProfileId !== undefined) {
    parsed.codeDefaultModelProfileId = parseNullableProfileId(
      update.codeDefaultModelProfileId,
      "codeDefaultModelProfileId",
    );
  }
  if (update.writeDefaultModelProfileId !== undefined) {
    parsed.writeDefaultModelProfileId = parseNullableProfileId(
      update.writeDefaultModelProfileId,
      "writeDefaultModelProfileId",
    );
  }
  if (update.approvalExperience !== undefined) {
    parsed.approvalExperience = parseApprovalExperienceUpdate(update.approvalExperience);
  }
  if (update.command !== undefined) {
    parsed.command = parseCommandPreferencesUpdate(update.command);
  }
  if (update.compaction !== undefined) {
    parsed.compaction = parseCompactionPreferencesUpdate(update.compaction);
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("Runtime preferences update must include at least one field.");
  }
  return parsed;
}

export function normalizeRuntimePreferences(value: unknown): RuntimePreferences {
  if (!isRecord(value)) {
    return cloneRuntimePreferences(DEFAULT_RUNTIME_PREFERENCES);
  }
  return {
    defaultApprovalPolicy: isThreadApprovalPolicy(value.defaultApprovalPolicy)
      ? value.defaultApprovalPolicy
      : DEFAULT_RUNTIME_PREFERENCES.defaultApprovalPolicy,
    defaultSandboxMode: isThreadSandboxMode(value.defaultSandboxMode)
      ? value.defaultSandboxMode
      : DEFAULT_RUNTIME_PREFERENCES.defaultSandboxMode,
    toolAvailability: normalizeToolAvailability(value.toolAvailability),
    codeDefaultModelProfileId: normalizeNullableProfileId(value.codeDefaultModelProfileId),
    writeDefaultModelProfileId: normalizeNullableProfileId(value.writeDefaultModelProfileId),
    approvalExperience: normalizeApprovalExperience(value.approvalExperience),
    command: normalizeCommandPreferences(value.command),
    compaction: normalizeCompactionPreferences(value.compaction),
  };
}

export function mergeRuntimePreferences(
  current: RuntimePreferences,
  update: RuntimePreferencesUpdate,
): RuntimePreferences {
  return {
    ...current,
    ...(update.defaultApprovalPolicy !== undefined
      ? { defaultApprovalPolicy: update.defaultApprovalPolicy }
      : {}),
    ...(update.defaultSandboxMode !== undefined
      ? { defaultSandboxMode: update.defaultSandboxMode }
      : {}),
    toolAvailability: update.toolAvailability
      ? mergeToolAvailability(current.toolAvailability, update.toolAvailability)
      : current.toolAvailability,
    ...(update.codeDefaultModelProfileId !== undefined
      ? { codeDefaultModelProfileId: update.codeDefaultModelProfileId }
      : {}),
    ...(update.writeDefaultModelProfileId !== undefined
      ? { writeDefaultModelProfileId: update.writeDefaultModelProfileId }
      : {}),
    approvalExperience: update.approvalExperience
      ? { ...current.approvalExperience, ...update.approvalExperience }
      : current.approvalExperience,
    command: update.command ? { ...current.command, ...update.command } : current.command,
    compaction: update.compaction
      ? { ...current.compaction, ...update.compaction }
      : current.compaction,
  };
}

export function cloneRuntimePreferences(value: RuntimePreferences): RuntimePreferences {
  return {
    ...value,
    toolAvailability: cloneToolAvailability(value.toolAvailability),
    approvalExperience: { ...value.approvalExperience },
    command: { ...value.command },
    compaction: { ...value.compaction },
  };
}

function normalizeToolAvailability(value: unknown): RuntimeToolAvailabilityPreferences {
  const base = cloneToolAvailability(DEFAULT_RUNTIME_PREFERENCES.toolAvailability);
  if (!isRecord(value)) return base;
  for (const mode of THREAD_MODES) {
    const byMode = value[mode];
    if (!isRecord(byMode)) continue;
    for (const toolName of RUNTIME_TOOL_NAMES) {
      const enabled = byMode[toolName];
      if (typeof enabled === "boolean") {
        base[mode][toolName] = enabled;
      }
    }
  }
  return base;
}

function mergeToolAvailability(
  current: RuntimeToolAvailabilityPreferences,
  update: RuntimePreferencesUpdate["toolAvailability"],
): RuntimeToolAvailabilityPreferences {
  const next = cloneToolAvailability(current);
  if (!update) return next;
  for (const mode of THREAD_MODES) {
    const byMode = update[mode];
    if (!byMode) continue;
    for (const [toolName, enabled] of Object.entries(byMode)) {
      if (isRuntimeToolName(toolName) && typeof enabled === "boolean") {
        next[mode][toolName] = enabled;
      }
    }
  }
  return next;
}

function parseRuntimeToolAvailabilityUpdate(
  value: unknown,
): RuntimePreferencesUpdate["toolAvailability"] {
  if (!isRecord(value)) {
    throw new Error("toolAvailability must be an object.");
  }
  const parsed: RuntimePreferencesUpdate["toolAvailability"] = {};
  for (const [mode, byMode] of Object.entries(value)) {
    if (!isThreadMode(mode)) {
      throw new Error("toolAvailability mode is invalid.");
    }
    if (!isRecord(byMode)) {
      throw new Error("toolAvailability mode value must be an object.");
    }
    const parsedTools: Partial<Record<string, boolean>> = {};
    for (const [toolName, enabled] of Object.entries(byMode)) {
      if (!isRuntimeToolName(toolName)) {
        throw new Error("toolAvailability tool name is invalid.");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("toolAvailability tool value must be a boolean.");
      }
      parsedTools[toolName] = enabled;
    }
    if (Object.keys(parsedTools).length === 0) {
      throw new Error("toolAvailability mode must include at least one tool.");
    }
    parsed[mode] = parsedTools;
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("toolAvailability must include at least one mode.");
  }
  return parsed as RuntimePreferencesUpdate["toolAvailability"];
}

function normalizeApprovalExperience(value: unknown): RuntimeApprovalExperiencePreferences {
  const defaults = DEFAULT_RUNTIME_PREFERENCES.approvalExperience;
  if (!isRecord(value)) return { ...defaults };
  return {
    showDiffByDefault: booleanOrDefault(value.showDiffByDefault, defaults.showDiffByDefault),
    autoScrollOnRequest: booleanOrDefault(value.autoScrollOnRequest, defaults.autoScrollOnRequest),
    showReadOnlyToolRecords: booleanOrDefault(
      value.showReadOnlyToolRecords,
      defaults.showReadOnlyToolRecords,
    ),
    showFailureToasts: booleanOrDefault(value.showFailureToasts, defaults.showFailureToasts),
  };
}

function parseApprovalExperienceUpdate(
  value: unknown,
): Partial<RuntimeApprovalExperiencePreferences> {
  if (!isRecord(value)) {
    throw new Error("approvalExperience must be an object.");
  }
  return parseBooleanObject(value, [
    "showDiffByDefault",
    "autoScrollOnRequest",
    "showReadOnlyToolRecords",
    "showFailureToasts",
  ], "approvalExperience");
}

function normalizeCommandPreferences(value: unknown): RuntimeCommandPreferences {
  const defaults = DEFAULT_RUNTIME_PREFERENCES.command;
  if (!isRecord(value)) return { ...defaults };
  return {
    timeoutMs: integerInRangeOrDefault(
      value.timeoutMs,
      MIN_RUNTIME_COMMAND_TIMEOUT_MS,
      MAX_RUNTIME_COMMAND_TIMEOUT_MS,
      defaults.timeoutMs,
    ),
    maxOutputBytes: integerInRangeOrDefault(
      value.maxOutputBytes,
      MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
      MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
      defaults.maxOutputBytes,
    ),
  };
}

function parseCommandPreferencesUpdate(
  value: unknown,
): Partial<RuntimeCommandPreferences> {
  if (!isRecord(value)) {
    throw new Error("command must be an object.");
  }
  const parsed: Partial<RuntimeCommandPreferences> = {};
  if (value.timeoutMs !== undefined) {
    parsed.timeoutMs = requiredIntegerInRange(
      value.timeoutMs,
      MIN_RUNTIME_COMMAND_TIMEOUT_MS,
      MAX_RUNTIME_COMMAND_TIMEOUT_MS,
      "command.timeoutMs",
    );
  }
  if (value.maxOutputBytes !== undefined) {
    parsed.maxOutputBytes = requiredIntegerInRange(
      value.maxOutputBytes,
      MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
      MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
      "command.maxOutputBytes",
    );
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("command must include at least one field.");
  }
  return parsed;
}

function normalizeCompactionPreferences(value: unknown): RuntimeCompactionPreferences {
  const defaults = DEFAULT_RUNTIME_PREFERENCES.compaction;
  if (!isRecord(value)) return { ...defaults };
  return {
    enabled: booleanOrDefault(value.enabled, defaults.enabled),
    strategy: isRuntimeCompactionStrategy(value.strategy) ? value.strategy : defaults.strategy,
  };
}

function parseCompactionPreferencesUpdate(
  value: unknown,
): Partial<RuntimeCompactionPreferences> {
  if (!isRecord(value)) {
    throw new Error("compaction must be an object.");
  }
  const parsed: Partial<RuntimeCompactionPreferences> = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new Error("compaction.enabled must be a boolean.");
    }
    parsed.enabled = value.enabled;
  }
  if (value.strategy !== undefined) {
    if (!isRuntimeCompactionStrategy(value.strategy)) {
      throw new Error("compaction.strategy is invalid.");
    }
    parsed.strategy = value.strategy;
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("compaction must include at least one field.");
  }
  return parsed;
}

function parseNullableProfileId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or null.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} cannot be blank.`);
  }
  return trimmed;
}

function normalizeNullableProfileId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBooleanObject<T extends string>(
  value: Record<string, unknown>,
  fields: readonly T[],
  label: string,
): Partial<Record<T, boolean>> {
  const parsed: Partial<Record<T, boolean>> = {};
  for (const field of fields) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "boolean") {
      throw new Error(`${label}.${field} must be a boolean.`);
    }
    parsed[field] = value[field];
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error(`${label} must include at least one field.`);
  }
  return parsed;
}

function cloneToolAvailability(
  value: RuntimeToolAvailabilityPreferences,
): RuntimeToolAvailabilityPreferences {
  return {
    code: { ...value.code },
    write: { ...value.write },
  };
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerInRangeOrDefault(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

function requiredIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
