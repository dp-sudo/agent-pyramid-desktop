import {
  DEFAULT_RUNTIME_PREFERENCES,
  MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MCP_SERVER_TRANSPORTS,
  RUNTIME_TOOL_NAMES,
  THREAD_MODES,
  isIsoTimestampString,
  isRuntimeCompactionStrategy,
  isRuntimePermissionRuleEffect,
  isRuntimePermissionRuleMatch,
  isRuntimePermissionRuleTool,
  isRuntimeToolName,
  isThreadApprovalPolicy,
  isThreadMode,
  isThreadSandboxMode,
  type RuntimePermissionRule,
  type McpServerConfig,
  type RuntimeApprovalExperiencePreferences,
  type RuntimeCommandPreferences,
  type RuntimeCompactionPreferences,
  type RuntimePreferences,
  type RuntimePreferencesUpdate,
  type RuntimeSkillsPreferences,
  type RuntimeToolAvailabilityPreferences,
} from "../../shared/agent-contracts.js";
import { toMcpNameSegment } from "../../shared/mcp-names.js";

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
  if (update.skills !== undefined) {
    parsed.skills = parseSkillsPreferencesUpdate(update.skills);
  }
  if (update.permissionRules !== undefined) {
    parsed.permissionRules = parseRuntimePermissionRules(update.permissionRules);
  }
  if (update.mcpServers !== undefined) {
    parsed.mcpServers = parseMcpServerConfigs(update.mcpServers);
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
    skills: normalizeSkillsPreferences(value.skills),
    permissionRules: normalizeRuntimePermissionRules(value.permissionRules),
    mcpServers: normalizeMcpServerConfigs(value.mcpServers),
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
    skills: update.skills
      ? { ...current.skills, ...update.skills, extraRoots: update.skills.extraRoots ?? current.skills.extraRoots }
      : current.skills,
    ...(update.permissionRules !== undefined
      ? { permissionRules: cloneRuntimePermissionRules(update.permissionRules) }
      : {}),
    ...(update.mcpServers !== undefined
      ? { mcpServers: cloneMcpServerConfigs(update.mcpServers) }
      : {}),
  };
}

export function cloneRuntimePreferences(value: RuntimePreferences): RuntimePreferences {
  return {
    ...value,
    toolAvailability: cloneToolAvailability(value.toolAvailability),
    approvalExperience: { ...value.approvalExperience },
    command: { ...value.command },
    compaction: { ...value.compaction },
    skills: { ...value.skills, extraRoots: [...value.skills.extraRoots] },
    permissionRules: cloneRuntimePermissionRules(value.permissionRules),
    mcpServers: cloneMcpServerConfigs(value.mcpServers),
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

function normalizeSkillsPreferences(value: unknown): RuntimeSkillsPreferences {
  const defaults = DEFAULT_RUNTIME_PREFERENCES.skills;
  if (!isRecord(value)) return { ...defaults, extraRoots: [...defaults.extraRoots] };
  return {
    enabled: booleanOrDefault(value.enabled, defaults.enabled),
    activeLimit: integerInRangeOrDefault(
      value.activeLimit,
      MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
      MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
      defaults.activeLimit,
    ),
    instructionBudgetBytes: integerInRangeOrDefault(
      value.instructionBudgetBytes,
      MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      defaults.instructionBudgetBytes,
    ),
    extraRoots: Array.isArray(value.extraRoots)
      ? normalizeStoredStringList(value.extraRoots)
      : [...defaults.extraRoots],
  };
}

function parseSkillsPreferencesUpdate(
  value: unknown,
): Partial<RuntimeSkillsPreferences> {
  if (!isRecord(value)) {
    throw new Error("skills must be an object.");
  }
  const parsed: Partial<RuntimeSkillsPreferences> = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new Error("skills.enabled must be a boolean.");
    }
    parsed.enabled = value.enabled;
  }
  if (value.activeLimit !== undefined) {
    parsed.activeLimit = requiredIntegerInRange(
      value.activeLimit,
      MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
      MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
      "skills.activeLimit",
    );
  }
  if (value.instructionBudgetBytes !== undefined) {
    parsed.instructionBudgetBytes = requiredIntegerInRange(
      value.instructionBudgetBytes,
      MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      "skills.instructionBudgetBytes",
    );
  }
  if (value.extraRoots !== undefined) {
    const roots = parseStringArray(value.extraRoots, "skills.extraRoots")
      .map((entry) => entry.trim())
      .filter(Boolean);
    parsed.extraRoots = Array.from(new Set(roots));
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("skills must include at least one field.");
  }
  return parsed;
}

function normalizeRuntimePermissionRules(value: unknown): RuntimePermissionRule[] {
  if (value === undefined) {
    return [];
  }
  return parseRuntimePermissionRules(value);
}

function parseRuntimePermissionRules(value: unknown): RuntimePermissionRule[] {
  if (!Array.isArray(value)) {
    throw new Error("permissionRules must be an array.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => parseRuntimePermissionRule(entry, index, ids));
}

function parseRuntimePermissionRule(
  value: unknown,
  index: number,
  ids: Set<string>,
): RuntimePermissionRule {
  if (!isRecord(value)) {
    throw new Error(`permissionRules[${index}] must be an object.`);
  }
  const id = parsePermissionRuleId(value.id, index, ids);
  const tool = value.tool;
  if (!isRuntimePermissionRuleTool(tool)) {
    throw new Error(`permissionRules[${index}].tool is invalid.`);
  }
  const pattern = parsePermissionRulePattern(value.pattern, index);
  const effect = value.effect;
  if (!isRuntimePermissionRuleEffect(effect)) {
    throw new Error(`permissionRules[${index}].effect is invalid.`);
  }
  const match = value.match;
  if (match !== undefined && !isRuntimePermissionRuleMatch(match)) {
    throw new Error(`permissionRules[${index}].match is invalid.`);
  }
  return { id, tool, pattern, effect, ...(match ? { match } : {}) };
}

function parsePermissionRuleId(value: unknown, index: number, ids: Set<string>): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`permissionRules[${index}].id must be a non-empty string.`);
  }
  const id = value.trim();
  if (id.includes("\0")) {
    throw new Error(`permissionRules[${index}].id cannot contain NUL bytes.`);
  }
  if (ids.has(id)) {
    throw new Error(`permissionRules[${index}].id is duplicated.`);
  }
  ids.add(id);
  return id;
}

function parsePermissionRulePattern(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`permissionRules[${index}].pattern must be a non-empty string.`);
  }
  const pattern = value.trim();
  if (pattern.includes("\0")) {
    throw new Error(`permissionRules[${index}].pattern cannot contain NUL bytes.`);
  }
  return pattern;
}

function cloneRuntimePermissionRules(
  value: readonly RuntimePermissionRule[],
): RuntimePermissionRule[] {
  return value.map((rule) => ({ ...rule }));
}

function normalizeMcpServerConfigs(value: unknown): McpServerConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    console.warn(
      "[runtime-preferences] ignored malformed mcpServers field:",
      "mcpServers must be an array.",
    );
    return [];
  }
  const parsed: McpServerConfig[] = [];
  let ids = new Set<string>();
  let names = new Set<string>();
  let nameSegments = new Set<string>();
  for (const [index, entry] of value.entries()) {
    try {
      // Stored preferences are recovery-oriented: one damaged MCP server record
      // must not prevent the rest of the runtime preferences from loading.
      const nextIds = new Set(ids);
      const nextNames = new Set(names);
      const nextNameSegments = new Set(nameSegments);
      const config = parseMcpServerConfig(entry, index, nextIds, nextNames, nextNameSegments);
      parsed.push(config);
      ids = nextIds;
      names = nextNames;
      nameSegments = nextNameSegments;
    } catch (error) {
      console.warn(
        `[runtime-preferences] skipped malformed mcpServers[${index}] entry:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return parsed;
}

function parseMcpServerConfigs(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("mcpServers must be an array.");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const nameSegments = new Set<string>();
  return value.map((entry, index) =>
    parseMcpServerConfig(entry, index, ids, names, nameSegments)
  );
}

function parseMcpServerConfig(
  value: unknown,
  index: number,
  ids: Set<string>,
  names: Set<string>,
  nameSegments: Set<string>,
): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`mcpServers[${index}] must be an object.`);
  }
  const id = parseUniqueNonBlankString(value.id, `mcpServers[${index}].id`, ids);
  const name = parseUniqueMcpServerName(
    value.name,
    `mcpServers[${index}].name`,
    names,
    nameSegments,
  );
  if (value.transport !== undefined && !MCP_SERVER_TRANSPORTS.includes(value.transport as never)) {
    throw new Error(`mcpServers[${index}].transport is invalid.`);
  }
  const transport = value.transport === "streamable-http" ? "streamable-http" : "stdio";
  const command = value.command !== undefined
    ? parseNonBlankString(value.command, `mcpServers[${index}].command`)
    : undefined;
  const url = value.url !== undefined
    ? parseHttpUrl(value.url, `mcpServers[${index}].url`)
    : undefined;
  if (transport === "stdio" && command === undefined) {
    throw new Error(`mcpServers[${index}].command must be a non-empty string.`);
  }
  if (transport === "streamable-http" && url === undefined) {
    throw new Error(`mcpServers[${index}].url must be an http or https URL.`);
  }
  const createdAt = parseIsoTimestamp(value.createdAt, `mcpServers[${index}].createdAt`);
  const updatedAt = parseIsoTimestamp(value.updatedAt, `mcpServers[${index}].updatedAt`);
  return {
    id,
    name,
    transport,
    ...(command !== undefined ? { command } : {}),
    args: parseStringArray(value.args, `mcpServers[${index}].args`),
    env: parseStringRecord(value.env, `mcpServers[${index}].env`),
    ...(value.cwd !== undefined
      ? { cwd: parseNonBlankString(value.cwd, `mcpServers[${index}].cwd`) }
      : {}),
    ...(url !== undefined ? { url } : {}),
    headers: value.headers === undefined
      ? {}
      : parseStringRecord(value.headers, `mcpServers[${index}].headers`),
    enabled: parseBoolean(value.enabled, `mcpServers[${index}].enabled`),
    readOnlyTools: parseTrimmedNonBlankStringArray(
      value.readOnlyTools,
      `mcpServers[${index}].readOnlyTools`,
    ),
    createdAt,
    updatedAt,
  };
}

function cloneMcpServerConfigs(value: readonly McpServerConfig[]): McpServerConfig[] {
  return value.map((server) => ({
    ...server,
    args: [...server.args],
    env: { ...server.env },
    headers: { ...server.headers },
    readOnlyTools: [...server.readOnlyTools],
  }));
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

function parseUniqueNonBlankString(value: unknown, field: string, seen: Set<string>): string {
  const parsed = parseNonBlankString(value, field);
  if (seen.has(parsed)) {
    throw new Error(`${field} is duplicated.`);
  }
  seen.add(parsed);
  return parsed;
}

function parseUniqueMcpServerName(
  value: unknown,
  field: string,
  seenNames: Set<string>,
  seenSegments: Set<string>,
): string {
  const parsed = parseUniqueNonBlankString(value, field, seenNames);
  const segment = toMcpNameSegment(parsed);
  if (seenSegments.has(segment)) {
    throw new Error(`${field} conflicts with another MCP server namespace segment.`);
  }
  seenSegments.add(segment);
  return parsed;
}

function parseNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const parsed = value.trim();
  if (parsed.includes("\0")) {
    throw new Error(`${field} cannot contain NUL bytes.`);
  }
  return parsed;
}

function parseHttpUrl(value: unknown, field: string): string {
  const parsed = parseNonBlankString(value, field);
  try {
    const url = new URL(parsed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return parsed;
    }
  } catch (error) {
    void error;
    // Fall through to the shared error below.
  }
  throw new Error(`${field} must be an http or https URL.`);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${field}[${index}] must be a string.`);
    }
    if (entry.includes("\0")) {
      throw new Error(`${field}[${index}] cannot contain NUL bytes.`);
    }
    return entry;
  });
}

function parseTrimmedNonBlankStringArray(value: unknown, field: string): string[] {
  return parseStringArray(value, field).map((entry, index) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${field}[${index}] must be a non-empty string.`);
    }
    return trimmed;
  });
}

function normalizeStoredStringList(value: readonly unknown[]): string[] {
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.includes("\0")) continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parsed.push(trimmed);
  }
  return parsed;
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const parsed: Record<string, string> = {};
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const parsedKey = parseNonBlankString(key, `${field} key`);
    if (keys.has(parsedKey)) {
      throw new Error(`${field}.${parsedKey} key is duplicated.`);
    }
    keys.add(parsedKey);
    if (typeof entry !== "string") {
      throw new Error(`${field}.${parsedKey} must be a string.`);
    }
    if (entry.includes("\0")) {
      throw new Error(`${field}.${parsedKey} cannot contain NUL bytes.`);
    }
    parsed[parsedKey] = entry;
  }
  return parsed;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function parseIsoTimestamp(value: unknown, field: string): string {
  if (!isIsoTimestampString(value)) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return value;
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
