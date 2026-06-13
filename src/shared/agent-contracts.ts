import type { IpcErrorCode } from "./ipc-errors.js";

export const LLM_PROTOCOLS = ["openai-compatible", "anthropic-compatible"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];
export const DEFAULT_LLM_PROTOCOL: LlmProtocol = "openai-compatible";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTimestampString(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export const MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export const AGENT_AUTONOMY_LEVELS = ["conservative", "balanced", "deep"] as const;
export type AgentAutonomyLevel = (typeof AGENT_AUTONOMY_LEVELS)[number];

export interface ModelConfig {
  model_provide: string;
  model: string;
  protocol: LlmProtocol;
  base_url: string;
  OPENAI_API_KEY: string;
  model_context_window: number;
  model_auto_compact_token_limit: number;
  max_tokens: number;
  thinking: boolean;
  model_reasoning_effort: ModelReasoningEffort;
  agent_autonomy: AgentAutonomyLevel;
}

export interface ModelConfigUpdate {
  model_provide?: string;
  model?: string;
  protocol?: LlmProtocol;
  base_url?: string;
  OPENAI_API_KEY?: string;
  model_context_window?: number;
  model_auto_compact_token_limit?: number;
  max_tokens?: number;
  thinking?: boolean;
  model_reasoning_effort?: ModelReasoningEffort;
  agent_autonomy?: AgentAutonomyLevel;
}

export interface ModelConfigProfile {
  id: string;
  name: string;
  config: ModelConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigProfilesState {
  activeProfileId: string;
  profiles: ModelConfigProfile[];
}

export interface ModelConfigProfileCreateRequest {
  name: string;
  config: ModelConfigUpdate;
  activate?: boolean;
}

export interface ModelConfigProfileUpdateRequest {
  id: string;
  name?: string;
  config?: ModelConfigUpdate;
}

export interface ModelConfigProfileDeleteRequest {
  id: string;
}

export interface ModelConfigProfileActivateRequest {
  id: string;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model_provide: "MiniMax",
  model: "MiniMax-M3",
  protocol: DEFAULT_LLM_PROTOCOL,
  base_url: "https://api.minimaxi.com/v1",
  OPENAI_API_KEY: "",
  model_context_window: 256000,
  model_auto_compact_token_limit: 230400,
  max_tokens: 65536,
  thinking: true,
  model_reasoning_effort: "medium",
  agent_autonomy: "balanced",
};

export const DEFAULT_DEEPSEEK_MODEL_CONFIG: ModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  model_provide: "DeepSeek",
  model: "deepseek-v4-flash",
  base_url: "https://api.deepseek.com",
};

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    typeof value === "string" &&
    MODEL_REASONING_EFFORTS.includes(value as ModelReasoningEffort)
  );
}

export function isAgentAutonomyLevel(value: unknown): value is AgentAutonomyLevel {
  return (
    typeof value === "string" &&
    AGENT_AUTONOMY_LEVELS.includes(value as AgentAutonomyLevel)
  );
}

// ============================================================================
// Threading + multi-turn
// ============================================================================

/** Thread field domains are exported so IPC, persistence, and guards cannot drift. */
export const THREAD_RELATIONS = ["primary", "fork", "side"] as const;
export type ThreadRelation = (typeof THREAD_RELATIONS)[number];

export const THREAD_GOAL_STATUSES = ["active", "complete", "blocked"] as const;
export type ThreadGoalStatus = (typeof THREAD_GOAL_STATUSES)[number];

export const THREAD_STATUSES = ["active", "archived"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_MODES = ["code", "write"] as const;
export type ThreadMode = (typeof THREAD_MODES)[number];

export const THREAD_APPROVAL_POLICIES = [
  "auto",
  "on-request",
  "untrusted",
  "never",
] as const;
export type ThreadApprovalPolicy = (typeof THREAD_APPROVAL_POLICIES)[number];

export const THREAD_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type ThreadSandboxMode = (typeof THREAD_SANDBOX_MODES)[number];

export const DEFAULT_THREAD_RELATION: ThreadRelation = "primary";
export const DEFAULT_THREAD_MODE: ThreadMode = "code";
export const DEFAULT_THREAD_STATUS: ThreadStatus = "active";
export const DEFAULT_THREAD_APPROVAL_POLICY: ThreadApprovalPolicy = "on-request";
export const DEFAULT_THREAD_SANDBOX_MODE: ThreadSandboxMode = "workspace-write";
export const DEFAULT_THREAD_LIST_RELATIONS: readonly ThreadRelation[] = ["primary", "fork"];

export interface ThreadGoal {
  text: string;
  status: ThreadGoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedAt?: string;
  summary?: string;
}

/** A persisted conversation. */
export interface ThreadRecord {
  id: string;
  title: string;
  workspace: string; // absolute workspace path for code and write flows
  mode: ThreadMode;
  status: ThreadStatus;
  relation: ThreadRelation;
  parentThreadId?: string;
  forkedAt?: string; // ISO timestamp
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  approvalPolicy: ThreadApprovalPolicy;
  sandboxMode: ThreadSandboxMode;
  goal?: ThreadGoal;
}

export function isLlmProtocol(value: unknown): value is LlmProtocol {
  return typeof value === "string" && LLM_PROTOCOLS.includes(value as LlmProtocol);
}

/** A lightweight row in the index.json listing. */
export interface ThreadSummary {
  id: string;
  title: string;
  workspace: string;
  status: ThreadStatus;
  relation: ThreadRelation;
  mode: ThreadMode;
  updatedAt: string;
}

export interface ThreadCreateInput {
  title?: string;
  workspace: string;
  mode: ThreadMode;
  relation?: ThreadRelation;
  parentThreadId?: string;
  approvalPolicy?: ThreadApprovalPolicy;
  sandboxMode?: ThreadSandboxMode;
}

export interface ThreadUpdatePatch {
  title?: string;
  approvalPolicy?: ThreadRecord["approvalPolicy"];
  sandboxMode?: ThreadRecord["sandboxMode"];
  status?: ThreadStatus;
  goal?: ThreadGoal | null;
}

export interface ThreadListFilter {
  include?: ThreadRelation[]; // default excludes 'side'
  search?: string; // case-insensitive title match
  mode?: ThreadMode;
  includeArchived?: boolean;
  archivedOnly?: boolean;
}

export function isThreadRelation(value: unknown): value is ThreadRelation {
  return typeof value === "string" && THREAD_RELATIONS.includes(value as ThreadRelation);
}

export function isThreadGoalStatus(value: unknown): value is ThreadGoalStatus {
  return typeof value === "string" && THREAD_GOAL_STATUSES.includes(value as ThreadGoalStatus);
}

export function isThreadStatus(value: unknown): value is ThreadStatus {
  return typeof value === "string" && THREAD_STATUSES.includes(value as ThreadStatus);
}

export function isThreadMode(value: unknown): value is ThreadMode {
  return typeof value === "string" && THREAD_MODES.includes(value as ThreadMode);
}

export function isThreadApprovalPolicy(value: unknown): value is ThreadApprovalPolicy {
  return typeof value === "string" &&
    THREAD_APPROVAL_POLICIES.includes(value as ThreadApprovalPolicy);
}

export function isThreadSandboxMode(value: unknown): value is ThreadSandboxMode {
  return typeof value === "string" && THREAD_SANDBOX_MODES.includes(value as ThreadSandboxMode);
}

// ============================================================================
// Runtime preferences
// ============================================================================

export const RUNTIME_TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_files",
  "rg_search",
  "edit_file",
  "write_file",
  "delete_file",
  "apply_patch",
  "rollback_file",
  "run_command",
  "shell_command",
  "git_bash_command",
  "powershell_command",
  "wsl_command",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_commit",
  "package_scripts",
  "package_install",
  "package_test",
  "package_build",
  "run_lint",
  "run_format",
  "run_tests",
  "run_build",
  "start_command_session",
  "read_command_session",
  "write_command_session",
  "stop_command_session",
  "detect_shell_environment",
  "diagnose_workspace",
  "diagnose_file",
  "list_skills",
  "run_skill",
  "create_plan",
  "update_goal",
] as const;
export type RuntimeToolName = (typeof RUNTIME_TOOL_NAMES)[number];

export const RUNTIME_READ_ONLY_TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_files",
  "rg_search",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "package_scripts",
  "read_command_session",
  "detect_shell_environment",
  "diagnose_file",
  "list_skills",
  "run_skill",
] as const satisfies readonly RuntimeToolName[];
export type RuntimeReadOnlyToolName = (typeof RUNTIME_READ_ONLY_TOOL_NAMES)[number];

export const RUNTIME_COMPACTION_STRATEGIES = [
  "balanced",
  "recent-only",
  "preserve-tools",
  "aggressive",
] as const;
export type RuntimeCompactionStrategy = (typeof RUNTIME_COMPACTION_STRATEGIES)[number];

export interface RuntimeToolAvailabilityPreferences {
  code: Record<RuntimeToolName, boolean>;
  write: Record<RuntimeToolName, boolean>;
}

export interface RuntimeApprovalExperiencePreferences {
  showDiffByDefault: boolean;
  autoScrollOnRequest: boolean;
  showReadOnlyToolRecords: boolean;
  showFailureToasts: boolean;
}

export interface RuntimeCommandPreferences {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RuntimeCompactionPreferences {
  enabled: boolean;
  strategy: RuntimeCompactionStrategy;
}

export interface RuntimeSkillsPreferences {
  enabled: boolean;
  activeLimit: number;
  instructionBudgetBytes: number;
  extraRoots: string[];
}

export type RuntimeSkillScope = "project" | "custom" | "builtin";
export type RuntimeSkillRunAs = "inline" | "subagent";

export interface RuntimeSkillTriggerSummary {
  manual: boolean;
  keywords: string[];
  commands: string[];
  promptPatterns: string[];
  fileTypes: string[];
}

export interface RuntimeSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  runAs: RuntimeSkillRunAs;
  scope: RuntimeSkillScope;
  priority: number;
  rootDir: string;
  skillPath: string;
  allowedTools: string[];
  trigger: RuntimeSkillTriggerSummary;
  referenceCount: number;
  referenceNames: string[];
}

export interface RuntimeSkillRootSummary {
  path: string;
  scope: RuntimeSkillScope;
  missingIsError: boolean;
}

export interface RuntimeSkillValidationSummary {
  root: string;
  message: string;
}

export interface SkillListRequest {
  workspace: string;
}

export interface SkillListResponse {
  workspace: string;
  enabled: boolean;
  skills: RuntimeSkillCatalogEntry[];
  roots: RuntimeSkillRootSummary[];
  validationErrors: RuntimeSkillValidationSummary[];
}

export const MCP_SERVER_TRANSPORTS = ["stdio", "streamable-http"] as const;
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number];
export const MCP_SERVER_STATUSES = [
  "disconnected",
  "connecting",
  "cached",
  "lazy",
  "connected",
  "failed",
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpServerTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  readOnlyTools: string[];
  createdAt: string;
  updatedAt: string;
}

export type McpServerConfigUpdate = Partial<
  Pick<
    McpServerConfig,
    | "name"
    | "transport"
    | "command"
    | "args"
    | "env"
    | "cwd"
    | "url"
    | "headers"
    | "enabled"
    | "readOnlyTools"
  >
>;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpPromptArgumentInfo {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: McpPromptArgumentInfo[];
}

export interface McpPromptMessage {
  role: string;
  content: unknown;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContent[];
}

export interface McpServerStatusRecord {
  id: string;
  name: string;
  transport: McpServerTransport;
  enabled: boolean;
  status: McpServerStatus;
  toolCount: number;
  tools: McpToolInfo[];
  promptCount: number;
  prompts: McpPromptInfo[];
  resourceCount: number;
  resources: McpResourceInfo[];
  lastStartupDurationMs?: number;
  startupSuccessCount?: number;
  startupFailureCount?: number;
  lastConnectedAt?: string;
  lastError?: string;
}

export const RUNTIME_PERMISSION_RULE_TOOLS = ["command", "write", "mcp"] as const;
export type RuntimePermissionRuleTool = (typeof RUNTIME_PERMISSION_RULE_TOOLS)[number];

export const RUNTIME_PERMISSION_RULE_EFFECTS = ["allow", "ask", "deny"] as const;
export type RuntimePermissionRuleEffect = (typeof RUNTIME_PERMISSION_RULE_EFFECTS)[number];

export interface RuntimePermissionRule {
  id: string;
  tool: RuntimePermissionRuleTool;
  pattern: string;
  effect: RuntimePermissionRuleEffect;
}

export interface RuntimePreferences {
  defaultApprovalPolicy: ThreadApprovalPolicy;
  defaultSandboxMode: ThreadSandboxMode;
  toolAvailability: RuntimeToolAvailabilityPreferences;
  codeDefaultModelProfileId: string | null;
  writeDefaultModelProfileId: string | null;
  approvalExperience: RuntimeApprovalExperiencePreferences;
  command: RuntimeCommandPreferences;
  compaction: RuntimeCompactionPreferences;
  skills: RuntimeSkillsPreferences;
  permissionRules: RuntimePermissionRule[];
  mcpServers: McpServerConfig[];
}

export interface RuntimePreferencesUpdate {
  defaultApprovalPolicy?: ThreadApprovalPolicy;
  defaultSandboxMode?: ThreadSandboxMode;
  toolAvailability?: Partial<Record<ThreadMode, Partial<Record<RuntimeToolName, boolean>>>>;
  codeDefaultModelProfileId?: string | null;
  writeDefaultModelProfileId?: string | null;
  approvalExperience?: Partial<RuntimeApprovalExperiencePreferences>;
  command?: Partial<RuntimeCommandPreferences>;
  compaction?: Partial<RuntimeCompactionPreferences>;
  skills?: Partial<RuntimeSkillsPreferences>;
  permissionRules?: RuntimePermissionRule[];
  mcpServers?: McpServerConfig[];
}

export const DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS = 30_000;
export const MIN_RUNTIME_COMMAND_TIMEOUT_MS = 100;
export const MAX_RUNTIME_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES = 32 * 1024;
export const MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES = 1_024;
export const MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_RUNTIME_SKILLS_ACTIVE_LIMIT = 3;
export const MIN_RUNTIME_SKILLS_ACTIVE_LIMIT = 0;
export const MAX_RUNTIME_SKILLS_ACTIVE_LIMIT = 16;
export const DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES = 24_000;
export const MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES = 1_024;
export const MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES = 128 * 1024;

export const DEFAULT_RUNTIME_TOOL_AVAILABILITY: RuntimeToolAvailabilityPreferences = {
  code: {
    list_files: true,
    read_file: true,
    search_files: true,
    rg_search: true,
    edit_file: true,
    write_file: true,
    delete_file: true,
    apply_patch: true,
    rollback_file: true,
    run_command: true,
    shell_command: true,
    git_bash_command: true,
    powershell_command: true,
    wsl_command: true,
    git_status: true,
    git_diff: true,
    git_log: true,
    git_branch: true,
    git_commit: true,
    package_scripts: true,
    package_install: true,
    package_test: true,
    package_build: true,
    run_lint: true,
    run_format: true,
    run_tests: true,
    run_build: true,
    start_command_session: true,
    read_command_session: true,
    write_command_session: true,
    stop_command_session: true,
    detect_shell_environment: true,
    diagnose_workspace: true,
    diagnose_file: true,
    list_skills: true,
    run_skill: true,
    create_plan: true,
    update_goal: true,
  },
  write: {
    list_files: true,
    read_file: true,
    search_files: true,
    rg_search: true,
    edit_file: false,
    write_file: false,
    delete_file: false,
    apply_patch: false,
    rollback_file: false,
    run_command: false,
    shell_command: false,
    git_bash_command: false,
    powershell_command: false,
    wsl_command: false,
    git_status: false,
    git_diff: false,
    git_log: false,
    git_branch: false,
    git_commit: false,
    package_scripts: false,
    package_install: false,
    package_test: false,
    package_build: false,
    run_lint: false,
    run_format: false,
    run_tests: false,
    run_build: false,
    start_command_session: false,
    read_command_session: false,
    write_command_session: false,
    stop_command_session: false,
    detect_shell_environment: false,
    diagnose_workspace: false,
    diagnose_file: false,
    list_skills: true,
    run_skill: true,
    create_plan: true,
    update_goal: true,
  },
};

export const DEFAULT_RUNTIME_PREFERENCES: RuntimePreferences = {
  defaultApprovalPolicy: DEFAULT_THREAD_APPROVAL_POLICY,
  defaultSandboxMode: DEFAULT_THREAD_SANDBOX_MODE,
  toolAvailability: DEFAULT_RUNTIME_TOOL_AVAILABILITY,
  codeDefaultModelProfileId: null,
  writeDefaultModelProfileId: null,
  approvalExperience: {
    showDiffByDefault: true,
    autoScrollOnRequest: true,
    showReadOnlyToolRecords: true,
    showFailureToasts: true,
  },
  command: {
    timeoutMs: DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  },
  compaction: {
    enabled: true,
    strategy: "balanced",
  },
  skills: {
    enabled: true,
    activeLimit: DEFAULT_RUNTIME_SKILLS_ACTIVE_LIMIT,
    instructionBudgetBytes: DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
    extraRoots: [],
  },
  permissionRules: [],
  mcpServers: [],
};

export function isRuntimeToolName(value: unknown): value is RuntimeToolName {
  return typeof value === "string" && RUNTIME_TOOL_NAMES.includes(value as RuntimeToolName);
}

export function isRuntimeCompactionStrategy(
  value: unknown,
): value is RuntimeCompactionStrategy {
  return typeof value === "string" &&
    RUNTIME_COMPACTION_STRATEGIES.includes(value as RuntimeCompactionStrategy);
}

export function isRuntimePermissionRuleTool(
  value: unknown,
): value is RuntimePermissionRuleTool {
  return typeof value === "string" &&
    RUNTIME_PERMISSION_RULE_TOOLS.includes(value as RuntimePermissionRuleTool);
}

export function isRuntimePermissionRuleEffect(
  value: unknown,
): value is RuntimePermissionRuleEffect {
  return typeof value === "string" &&
    RUNTIME_PERMISSION_RULE_EFFECTS.includes(value as RuntimePermissionRuleEffect);
}

export function isMcpServerTransport(value: unknown): value is McpServerTransport {
  return typeof value === "string" &&
    MCP_SERVER_TRANSPORTS.includes(value as McpServerTransport);
}

export function isMcpServerStatus(value: unknown): value is McpServerStatus {
  return typeof value === "string" &&
    MCP_SERVER_STATUSES.includes(value as McpServerStatus);
}

export function isRuntimePreferences(value: unknown): value is RuntimePreferences {
  if (!isRecord(value)) return false;
  return isThreadApprovalPolicy(value.defaultApprovalPolicy) &&
    isThreadSandboxMode(value.defaultSandboxMode) &&
    isRuntimeToolAvailabilityPreferences(value.toolAvailability) &&
    isNullableString(value.codeDefaultModelProfileId) &&
    isNullableString(value.writeDefaultModelProfileId) &&
    isRuntimeApprovalExperiencePreferences(value.approvalExperience) &&
    isRuntimeCommandPreferences(value.command) &&
    isRuntimeCompactionPreferences(value.compaction) &&
    isRuntimeSkillsPreferences(value.skills) &&
    isRuntimePermissionRules(value.permissionRules) &&
    isMcpServerConfigs(value.mcpServers);
}

export function isSkillListResponse(value: unknown): value is SkillListResponse {
  if (!isRecord(value)) return false;
  return hasString(value, "workspace") &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.skills) &&
    value.skills.every(isRuntimeSkillCatalogEntry) &&
    Array.isArray(value.roots) &&
    value.roots.every(isRuntimeSkillRootSummary) &&
    Array.isArray(value.validationErrors) &&
    value.validationErrors.every(isRuntimeSkillValidationSummary);
}

// ----------------------------------------------------------------------------

export type TurnStatus =
  | "in-flight"
  | "completed"
  | "failed"
  | "interrupted"
  | "needs_continuation";
export type TerminalTurnStatus = Exclude<TurnStatus, "in-flight">;
export type TurnMode = "agent" | "plan";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheHitRate?: number | null;
}

export interface TurnRecord {
  id: string;
  threadId: string;
  status: TurnStatus;
  startedAt: string;
  completedAt?: string;
  model: string;
  reasoningEffort?: ModelReasoningEffort;
  modelProfileId?: string;
  mode: TurnMode;
  goalMode?: boolean;
  usage?: TokenUsage;
}

// ============================================================================
// Items: the in-thread content stream
// ============================================================================

export interface AttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface AttachmentCreateRequest {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export const SUPPORTED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type SupportedAttachmentMimeType = (typeof SUPPORTED_ATTACHMENT_MIME_TYPES)[number];
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export function normalizeSupportedAttachmentMimeType(
  mimeType: string,
): SupportedAttachmentMimeType | null {
  const normalized = mimeType.trim().toLowerCase();
  return SUPPORTED_ATTACHMENT_MIME_TYPES.includes(normalized as SupportedAttachmentMimeType)
    ? (normalized as SupportedAttachmentMimeType)
    : null;
}

export function isAttachmentRecord(value: unknown): value is AttachmentRecord {
  if (!isRecord(value)) return false;
  const size = value.size;
  return isUuidString(value.id) &&
    hasString(value, "name") &&
    typeof value.mimeType === "string" &&
    normalizeSupportedAttachmentMimeType(value.mimeType) !== null &&
    typeof size === "number" &&
    Number.isInteger(size) &&
    size >= 0 &&
    size <= MAX_ATTACHMENT_BYTES &&
    isIsoTimestampString(value.createdAt);
}

export interface AttachmentDeleteRequest {
  id: string;
}

export interface AttachmentDeleteResponse {
  id: string;
}

export interface UserItem {
  kind: "user";
  id: string;
  threadId: string;
  turnId: string;
  text: string;
  displayText?: string; // shown in timeline if text contains injected context
  attachmentIds?: string[];
  attachments?: AttachmentRecord[];
  createdAt: string;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  threadId: string;
  turnId: string;
  text: string;
  truncated?: boolean;
  createdAt: string;
}

export interface ReasoningItem {
  kind: "reasoning";
  id: string;
  threadId: string;
  turnId: string;
  text: string;
  createdAt: string;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  threadId: string;
  turnId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
}

export interface FileDiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

export interface FileDiffPreview {
  kind: "file_diff";
  path: string;
  operation: "create" | "update" | "delete";
  added: number;
  removed: number;
  lines: FileDiffLine[];
}

export interface MultiFileDiffPreview {
  kind: "multi_file_diff";
  files: FileDiffPreview[];
  added: number;
  removed: number;
}

export type ApprovalPreview = FileDiffPreview | MultiFileDiffPreview;

export interface CompactionItem {
  kind: "compaction";
  id: string;
  threadId: string;
  turnId: string;
  summary: string;
  replacedItemCount: number;
  createdAt: string;
}

export interface ApprovalItem {
  kind: "approval";
  id: string;
  threadId: string;
  turnId: string;
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview?: ApprovalPreview;
  decision?: "allow" | "deny";
  resolvedAt?: string;
  createdAt: string;
}

export interface UserInputItem {
  kind: "user_input";
  id: string;
  threadId: string;
  turnId: string;
  question: string;
  options?: string[];
  answer?: string;
  createdAt: string;
}

export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface PlanItem {
  kind: "plan";
  id: string;
  threadId: string;
  turnId: string;
  title?: string;
  steps: PlanStep[];
  createdAt: string;
}

export interface SystemItem {
  kind: "system";
  id: string;
  threadId: string;
  turnId?: string;
  text: string;
  level: "info" | "warn" | "error";
  createdAt: string;
}

export type Item =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | CompactionItem
  | ApprovalItem
  | UserInputItem
  | PlanItem
  | SystemItem;

export const ITEM_KINDS = [
  "user",
  "assistant",
  "reasoning",
  "tool",
  "compaction",
  "approval",
  "user_input",
  "plan",
  "system",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

// ============================================================================
// Runtime events (emitted on the bus, forwarded to subscribers via IPC)
// ============================================================================

export interface TurnStartedEvent {
  kind: "turn_started";
  threadId: string;
  turnId: string;
  startedAt: string;
  turn: TurnRecord;
}

export interface TurnCompletedEvent {
  kind: "turn_completed";
  threadId: string;
  turnId: string;
  status: TerminalTurnStatus;
  completedAt: string;
  usage?: TurnRecord["usage"];
}

export interface TurnFailedEvent {
  kind: "turn_failed";
  threadId: string;
  turnId: string;
  message: string;
  failedAt: string;
}

export interface ItemAppendedEvent {
  kind: "item_appended";
  threadId: string;
  turnId: string;
  item: Item;
}

export interface ItemUpdatedEvent {
  kind: "item_updated";
  threadId: string;
  turnId: string;
  item: Item;
}

export interface ApprovalRequestedEvent {
  kind: "approval_requested";
  threadId: string;
  turnId: string;
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview?: ApprovalPreview;
}

export const TOOL_PROGRESS_STREAMS = ["stdout", "stderr"] as const;
export type ToolProgressStream = (typeof TOOL_PROGRESS_STREAMS)[number];

export interface ToolProgressEvent {
  kind: "tool_progress";
  threadId: string;
  turnId: string;
  toolCallId: string;
  chunk: string;
  stream: ToolProgressStream;
  seq: number;
}

export interface McpServerConnectionEvent {
  kind: "mcp_server_connection";
  serverId: string;
  serverName: string;
  status: McpServerStatus;
  toolCount: number;
  occurredAt: string;
  message?: string;
}

export interface McpToolListChangedEvent {
  kind: "mcp_tool_list_changed";
  serverId: string;
  serverName: string;
  toolCount: number;
  tools: McpToolInfo[];
  occurredAt: string;
}

export interface McpSurfaceChangedEvent {
  kind: "mcp_surface_changed";
  serverId: string;
  serverName: string;
  promptCount: number;
  resourceCount: number;
  occurredAt: string;
}

export interface RuntimeErrorEvent {
  kind: "runtime_error";
  threadId?: string;
  turnId?: string;
  code:
    | "worker_crashed"
    | "worker_timeout"
    | "provider_http"
    | "provider_error"
    | "schema_invalid"
    | "tool_not_found"
    | "tool_failed"
    | "approval_timeout"
    | "persistence_error"
    | "internal";
  message: string;
}

export interface ToolBudgetReachedEvent {
  kind: "tool_budget_reached";
  threadId: string;
  turnId: string;
  maxToolRounds: number;
  attemptedToolCalls: number;
  message: string;
  reachedAt: string;
}

export interface GoalUpdatedEvent {
  kind: "goal_updated";
  threadId: string;
  goal?: ThreadGoal;
}

export type RuntimeEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemAppendedEvent
  | ItemUpdatedEvent
  | ApprovalRequestedEvent
  | ToolProgressEvent
  | McpServerConnectionEvent
  | McpToolListChangedEvent
  | McpSurfaceChangedEvent
  | ToolBudgetReachedEvent
  | GoalUpdatedEvent
  | RuntimeErrorEvent;

export const RUNTIME_EVENT_KINDS = [
  "turn_started",
  "turn_completed",
  "turn_failed",
  "item_appended",
  "item_updated",
  "approval_requested",
  "tool_progress",
  "mcp_server_connection",
  "mcp_tool_list_changed",
  "mcp_surface_changed",
  "tool_budget_reached",
  "goal_updated",
  "runtime_error",
] as const;
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

// ============================================================================
// Turn start payload
// ============================================================================

export interface TurnStartRequest {
  threadId: string;
  text: string;
  displayText?: string;
  model?: string;
  modelProfileId?: string;
  reasoningEffort?: TurnRecord["reasoningEffort"];
  attachmentIds?: string[];
  mode?: TurnMode;
  goalMode?: boolean;
}

// ============================================================================
// Approval
// ============================================================================

export interface ApprovalRespondRequest {
  approvalId: string;
  decision: "allow" | "deny";
}

// ============================================================================
// SSE subscription
// ============================================================================

export interface SseSubscribeRequest {
  threadId: string;
}

export interface SseUnsubscribeRequest {
  threadId: string;
}

// ============================================================================
// Goal
// ============================================================================

export interface GoalUpdateRequest {
  threadId: string;
  goal?: string | null;
  clear?: boolean;
  status?: ThreadGoalStatus;
  summary?: string;
}

// ============================================================================
// Usage
// ============================================================================

export interface UsageDailyRequest {
  days?: number;
}

export interface UsageDailyBucket {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number | null;
  turns: number;
}

// ============================================================================
// Workspace picker
// ============================================================================

export interface WorkspacePickDirectoryResponse {
  canceled: boolean;
  path: string | null;
}

// ============================================================================
// Write-mode file services
// ============================================================================

export interface WriteFileEntry {
  path: string; // workspace-relative, forward slashes
  size: number;
  modifiedAt: string;
}

export interface WriteListRequest {
  workspace: string;
  /** Glob substring, case-insensitive. */
  search?: string;
}

export interface WriteGetRequest {
  workspace: string;
  path: string;
}

export interface WritePutRequest {
  workspace: string;
  path: string;
  content: string;
}

export interface WriteCreateRequest {
  workspace: string;
  path: string;
  content?: string;
}

export interface WriteRenameRequest {
  workspace: string;
  path: string;
  newPath: string;
}

export interface WriteDeleteRequest {
  workspace: string;
  path: string;
}

export interface WriteCompleteRequest {
  workspace: string;
  path: string;
  /** Text before the cursor. */
  prefix: string;
  /** Text after the cursor. */
  suffix: string;
}

export interface WriteCompleteResponse {
  completion: string;
  /** 0..1 confidence score; renderer may use this to decide whether to show ghost text. */
  score: number;
  /** Truncated flag: model hit token limit. */
  truncated: boolean;
}

// ============================================================================
// Checkpoints / rewind
// ============================================================================

export type CheckpointFileOperation = "create" | "update" | "delete" | "rollback";

export interface CheckpointFileSummary {
  path: string;
  operation: CheckpointFileOperation;
  toolName: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  createdAt: string;
}

export interface CheckpointMeta {
  threadId: string;
  turnId: string;
  workspace: string;
  prompt: string;
  createdAt: string;
  files: CheckpointFileSummary[];
  canRewindCode: boolean;
  canRewindSession: boolean;
}

export interface CheckpointListRequest {
  threadId: string;
}

export interface CheckpointListResponse {
  threadId: string;
  checkpoints: CheckpointMeta[];
}

export interface CheckpointRewindRequest {
  threadId: string;
  turnId: string;
  rewindSession?: boolean;
}

export interface CheckpointRewindResponse {
  threadId: string;
  turnId: string;
  rewindSession: boolean;
  restoredPaths: string[];
  deletedPaths: string[];
  itemsRemoved: number;
  eventsRemoved: number;
  checkpointsRemoved: number;
}

// ============================================================================
// MCP external tool host
// ============================================================================

export interface McpServerListResponse {
  servers: McpServerStatusRecord[];
}

export interface McpServerConnectRequest {
  serverId: string;
}

export interface McpServerDisconnectRequest {
  serverId: string;
}

export interface McpServerToolsRequest {
  serverId?: string;
}

export interface McpServerToolsResponse {
  servers: Array<{
    serverId: string;
    serverName: string;
    tools: McpToolInfo[];
  }>;
}

export interface McpServerRefreshToolsRequest {
  serverId: string;
}

export interface McpServerPromptsRequest {
  serverId?: string;
}

export interface McpServerPromptsResponse {
  servers: Array<{
    serverId: string;
    serverName: string;
    prompts: McpPromptInfo[];
  }>;
}

export interface McpPromptGetRequest {
  serverId: string;
  name: string;
  arguments?: Record<string, string>;
}

export interface McpServerResourcesRequest {
  serverId?: string;
}

export interface McpServerResourcesResponse {
  servers: Array<{
    serverId: string;
    serverName: string;
    resources: McpResourceInfo[];
  }>;
}

export interface McpResourceReadRequest {
  serverId: string;
  uri: string;
}

// ============================================================================
// Generic IPC envelope
// ============================================================================

export interface IpcOk<T> {
  ok: true;
  value: T;
}

export interface IpcErr {
  ok: false;
  code: IpcErrorCode;
  message: string;
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

export function ok<T>(value: T): IpcOk<T> {
  return { ok: true, value };
}

export function err(code: IpcErrorCode, message: string): IpcErr {
  return { ok: false, code, message };
}

// ============================================================================
// Type guards (TypeScript-native validation, zod-equivalent for runtime checks)
// ============================================================================

type ExactUnion<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<T extends true> = T;
export type AgentContractKindAssertions = [
  AssertTrue<ExactUnion<Item["kind"], ItemKind>>,
  AssertTrue<ExactUnion<RuntimeEvent["kind"], RuntimeEventKind>>,
];

export function isItemKind(value: unknown): value is ItemKind {
  return typeof value === "string" && ITEM_KINDS.includes(value as ItemKind);
}

export function isRuntimeEventKind(value: unknown): value is RuntimeEventKind {
  return typeof value === "string" &&
    RUNTIME_EVENT_KINDS.includes(value as RuntimeEventKind);
}

export function isToolProgressStream(value: unknown): value is ToolProgressStream {
  return typeof value === "string" &&
    TOOL_PROGRESS_STREAMS.includes(value as ToolProgressStream);
}

export function isItem(value: unknown): value is Item {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!hasBaseItemFields(v) || !isItemKind(v.kind)) return false;
  switch (v.kind) {
    case "user":
      return hasString(v, "turnId") &&
        hasString(v, "text") &&
        isOptionalString(v.displayText) &&
        isOptionalStringArray(v.attachmentIds) &&
        isOptionalAttachmentRecords(v.attachments);
    case "assistant":
      return hasString(v, "turnId") &&
        hasString(v, "text") &&
        isOptionalBoolean(v.truncated);
    case "reasoning":
      return hasString(v, "turnId") && hasString(v, "text");
    case "tool":
      return hasString(v, "turnId") &&
        hasString(v, "toolCallId") &&
        hasString(v, "name") &&
        isRecord(v.args) &&
        isToolStatus(v.status);
    case "compaction":
      return hasString(v, "turnId") &&
        hasString(v, "summary") &&
        isNonNegativeInteger(v.replacedItemCount);
    case "approval":
      return hasString(v, "turnId") &&
        hasString(v, "approvalId") &&
        hasString(v, "toolName") &&
        isRecord(v.args) &&
        isOptionalApprovalPreview(v.preview) &&
        isOptionalApprovalDecision(v.decision) &&
        isOptionalIsoTimestampString(v.resolvedAt);
    case "user_input":
      return hasString(v, "turnId") &&
        hasString(v, "question") &&
        isOptionalStringArray(v.options) &&
        isOptionalString(v.answer);
    case "plan":
      return hasString(v, "turnId") &&
        isOptionalString(v.title) &&
        Array.isArray(v.steps) &&
        v.steps.every(isPlanStep);
    case "system":
      return isOptionalString(v.turnId) &&
        hasString(v, "text") &&
        isSystemLevel(v.level);
    default:
      return false;
  }
}

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!isRuntimeEventKind(v.kind)) {
    return false;
  }
  switch (v.kind) {
    case "turn_started":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isIsoTimestampString(v.startedAt) &&
        isTurnStartedEventConsistent(v);
    case "turn_completed":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isTerminalTurnStatus(v.status) &&
        isIsoTimestampString(v.completedAt) &&
        isOptionalTokenUsage(v.usage);
    case "turn_failed":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        hasString(v, "message") &&
        isIsoTimestampString(v.failedAt);
    case "item_appended":
    case "item_updated":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isItemRuntimeEventConsistent(v);
    case "approval_requested":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        hasString(v, "approvalId") &&
        hasString(v, "toolName") &&
        isRecord(v.args) &&
        isOptionalApprovalPreview(v.preview);
    case "tool_progress":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        hasString(v, "toolCallId") &&
        hasString(v, "chunk") &&
        isToolProgressStream(v.stream) &&
        isPositiveInteger(v.seq);
    case "mcp_server_connection":
      return hasString(v, "serverId") &&
        hasString(v, "serverName") &&
        isMcpServerStatus(v.status) &&
        isNonNegativeInteger(v.toolCount) &&
        isIsoTimestampString(v.occurredAt) &&
        isOptionalString(v.message);
    case "mcp_tool_list_changed":
      return hasString(v, "serverId") &&
        hasString(v, "serverName") &&
        isNonNegativeInteger(v.toolCount) &&
        Array.isArray(v.tools) &&
        v.tools.every(isMcpToolInfo) &&
        v.tools.length === v.toolCount &&
        isIsoTimestampString(v.occurredAt);
    case "mcp_surface_changed":
      return hasString(v, "serverId") &&
        hasString(v, "serverName") &&
        isNonNegativeInteger(v.promptCount) &&
        isNonNegativeInteger(v.resourceCount) &&
        isIsoTimestampString(v.occurredAt);
    case "tool_budget_reached":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isPositiveInteger(v.maxToolRounds) &&
        isPositiveInteger(v.attemptedToolCalls) &&
        hasString(v, "message") &&
        isIsoTimestampString(v.reachedAt);
    case "goal_updated":
      return hasString(v, "threadId") &&
        (v.goal === undefined || isThreadGoal(v.goal));
    case "runtime_error":
      return isOptionalString(v.threadId) &&
        isOptionalString(v.turnId) &&
        isRuntimeErrorCode(v.code) &&
        hasString(v, "message");
    default:
      return false;
  }
}

export function isThreadRecord(value: unknown): value is ThreadRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isUuidString(v.id) &&
    typeof v.title === "string" &&
    v.title.trim().length > 0 &&
    isAbsolutePathString(v.workspace) &&
    isThreadMode(v.mode) &&
    (v.status === undefined || isThreadStatus(v.status)) &&
    isThreadRelation(v.relation) &&
    isThreadParentRelationValid(v) &&
    (v.approvalPolicy === undefined || isThreadApprovalPolicy(v.approvalPolicy)) &&
    (v.sandboxMode === undefined || isThreadSandboxMode(v.sandboxMode)) &&
    (v.forkedAt === undefined || isIsoTimestampString(v.forkedAt)) &&
    (v.goal === undefined || isThreadGoal(v.goal)) &&
    isIsoTimestampString(v.createdAt) &&
    isIsoTimestampString(v.updatedAt)
  );
}

function isThreadParentRelationValid(value: Record<string, unknown>): boolean {
  if (value.parentThreadId !== undefined && !isUuidString(value.parentThreadId)) {
    return false;
  }
  return value.relation !== "fork" || isUuidString(value.parentThreadId);
}

function isAbsolutePathString(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function isRuntimeToolAvailabilityPreferences(
  value: unknown,
): value is RuntimeToolAvailabilityPreferences {
  if (!isRecord(value)) return false;
  return THREAD_MODES.every((mode) => {
    const byMode = value[mode];
    if (!isRecord(byMode)) return false;
    return RUNTIME_TOOL_NAMES.every((toolName) => typeof byMode[toolName] === "boolean");
  });
}

function isRuntimeApprovalExperiencePreferences(
  value: unknown,
): value is RuntimeApprovalExperiencePreferences {
  if (!isRecord(value)) return false;
  return typeof value.showDiffByDefault === "boolean" &&
    typeof value.autoScrollOnRequest === "boolean" &&
    typeof value.showReadOnlyToolRecords === "boolean" &&
    typeof value.showFailureToasts === "boolean";
}

function isRuntimeCommandPreferences(value: unknown): value is RuntimeCommandPreferences {
  if (!isRecord(value)) return false;
  return isIntegerInRange(
    value.timeoutMs,
    MIN_RUNTIME_COMMAND_TIMEOUT_MS,
    MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  ) &&
    isIntegerInRange(
      value.maxOutputBytes,
      MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
      MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
    );
}

function isRuntimeCompactionPreferences(
  value: unknown,
): value is RuntimeCompactionPreferences {
  if (!isRecord(value)) return false;
  return typeof value.enabled === "boolean" &&
    isRuntimeCompactionStrategy(value.strategy);
}

function isRuntimeSkillsPreferences(value: unknown): value is RuntimeSkillsPreferences {
  if (!isRecord(value)) return false;
  return typeof value.enabled === "boolean" &&
    isIntegerInRange(
      value.activeLimit,
      MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
      MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
    ) &&
    isIntegerInRange(
      value.instructionBudgetBytes,
      MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
    ) &&
    Array.isArray(value.extraRoots) &&
    value.extraRoots.every((entry) => typeof entry === "string" && !entry.includes("\0"));
}

function isRuntimeSkillScope(value: unknown): value is RuntimeSkillScope {
  return value === "project" || value === "custom" || value === "builtin";
}

function isRuntimeSkillRunAs(value: unknown): value is RuntimeSkillRunAs {
  return value === "inline" || value === "subagent";
}

function isRuntimeSkillTriggerSummary(
  value: unknown,
): value is RuntimeSkillTriggerSummary {
  if (!isRecord(value)) return false;
  return typeof value.manual === "boolean" &&
    Array.isArray(value.keywords) &&
    value.keywords.every(isStringWithoutNul) &&
    Array.isArray(value.commands) &&
    value.commands.every(isStringWithoutNul) &&
    Array.isArray(value.promptPatterns) &&
    value.promptPatterns.every(isStringWithoutNul) &&
    Array.isArray(value.fileTypes) &&
    value.fileTypes.every(isStringWithoutNul);
}

function isRuntimeSkillCatalogEntry(value: unknown): value is RuntimeSkillCatalogEntry {
  if (!isRecord(value)) return false;
  return hasNonBlankString(value, "id") &&
    hasNonBlankString(value, "name") &&
    hasString(value, "description") &&
    hasNonBlankString(value, "version") &&
    isRuntimeSkillRunAs(value.runAs) &&
    isRuntimeSkillScope(value.scope) &&
    Number.isInteger(value.priority) &&
    hasString(value, "rootDir") &&
    hasString(value, "skillPath") &&
    Array.isArray(value.allowedTools) &&
    value.allowedTools.every(isStringWithoutNul) &&
    isRuntimeSkillTriggerSummary(value.trigger) &&
    isNonNegativeInteger(value.referenceCount) &&
    Array.isArray(value.referenceNames) &&
    value.referenceNames.every(isStringWithoutNul);
}

function isRuntimeSkillRootSummary(value: unknown): value is RuntimeSkillRootSummary {
  if (!isRecord(value)) return false;
  return hasString(value, "path") &&
    isRuntimeSkillScope(value.scope) &&
    typeof value.missingIsError === "boolean";
}

function isRuntimeSkillValidationSummary(
  value: unknown,
): value is RuntimeSkillValidationSummary {
  if (!isRecord(value)) return false;
  return hasString(value, "root") && hasString(value, "message");
}

function isRuntimePermissionRules(value: unknown): value is RuntimePermissionRule[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const rule of value) {
    if (!isRecord(rule)) return false;
    const id = rule.id;
    const pattern = rule.pattern;
    if (typeof id !== "string" || !id.trim() || ids.has(id)) {
      return false;
    }
    if (
      !isRuntimePermissionRuleTool(rule.tool) ||
      typeof pattern !== "string" ||
      !pattern.trim() ||
      pattern.includes("\0") ||
      !isRuntimePermissionRuleEffect(rule.effect)
    ) {
      return false;
    }
    ids.add(id);
  }
  return true;
}

function isMcpServerConfigs(value: unknown): value is McpServerConfig[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const server of value) {
    if (!isMcpServerConfig(server)) return false;
    const idKey = server.id.trim();
    const nameKey = server.name.trim();
    if (ids.has(idKey) || names.has(nameKey)) return false;
    ids.add(idKey);
    names.add(nameKey);
  }
  return true;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isRecord(value)) return false;
  const baseValid = isNonBlankStringWithoutNul(value.id) &&
    isNonBlankStringWithoutNul(value.name) &&
    isMcpServerTransport(value.transport) &&
    (value.command === undefined || isNonBlankStringWithoutNul(value.command)) &&
    Array.isArray(value.args) &&
    value.args.every(isStringWithoutNul) &&
    isStringRecordWithoutNul(value.env) &&
    (value.cwd === undefined || isNonBlankStringWithoutNul(value.cwd)) &&
    (value.url === undefined || isNonBlankStringWithoutNul(value.url)) &&
    isStringRecordWithoutNul(value.headers) &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.readOnlyTools) &&
    value.readOnlyTools.every(isNonBlankStringWithoutNul) &&
    isIsoTimestampString(value.createdAt) &&
    isIsoTimestampString(value.updatedAt);
  if (!baseValid) return false;
  if (value.transport === "stdio") {
    return isNonBlankStringWithoutNul(value.command);
  }
  return isHttpUrl(value.url);
}

function isMcpToolInfo(value: unknown): value is McpToolInfo {
  if (!isRecord(value)) return false;
  return hasNonBlankString(value, "name") &&
    hasString(value, "description") &&
    isRecord(value.inputSchema) &&
    typeof value.readOnly === "boolean";
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonBlankStringWithoutNul(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function hasBaseItemFields(value: Record<string, unknown>): boolean {
  return hasString(value, "kind") &&
    hasString(value, "id") &&
    hasString(value, "threadId") &&
    isIsoTimestampString(value.createdAt);
}

function isTurnRecord(value: unknown): value is TurnRecord {
  if (!isRecord(value)) return false;
  return hasString(value, "id") &&
    hasString(value, "threadId") &&
    isTurnStatus(value.status) &&
    isIsoTimestampString(value.startedAt) &&
    isOptionalIsoTimestampString(value.completedAt) &&
    hasString(value, "model") &&
    (value.reasoningEffort === undefined || isModelReasoningEffort(value.reasoningEffort)) &&
    hasString(value, "mode") &&
    (value.mode === "agent" || value.mode === "plan") &&
    isOptionalBoolean(value.goalMode) &&
    isOptionalTokenUsage(value.usage);
}

function isTurnStartedEventConsistent(value: Record<string, unknown>): boolean {
  if (!isTurnRecord(value.turn)) return false;
  return value.threadId === value.turn.threadId &&
    value.turnId === value.turn.id &&
    value.startedAt === value.turn.startedAt;
}

function isItemRuntimeEventConsistent(value: Record<string, unknown>): boolean {
  if (!isItem(value.item)) return false;
  return value.threadId === value.item.threadId &&
    value.turnId === value.item.turnId;
}

export function isThreadGoal(value: unknown): value is ThreadGoal {
  if (!isRecord(value)) return false;
  return hasNonBlankString(value, "text") &&
    isThreadGoalStatus(value.status) &&
    isIsoTimestampString(value.createdAt) &&
    isIsoTimestampString(value.updatedAt) &&
    isOptionalIsoTimestampString(value.completedAt) &&
    isOptionalIsoTimestampString(value.blockedAt) &&
    (value.summary === undefined || hasNonBlankString(value, "summary"));
}

function isPlanStep(value: unknown): value is PlanStep {
  if (!isRecord(value)) return false;
  return hasString(value, "id") &&
    hasString(value, "title") &&
    isPlanStepStatus(value.status);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNonBlankString(value: Record<string, unknown>, key: string): boolean {
  const text = value[key];
  return typeof text === "string" && text.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringWithoutNul(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function isNonBlankStringWithoutNul(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isStringRecordWithoutNul(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) =>
    isNonBlankStringWithoutNul(key) && isStringWithoutNul(entry)
  );
}

function isOptionalIsoTimestampString(value: unknown): value is string | undefined {
  return value === undefined || isIsoTimestampString(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalTokenUsage(value: unknown): value is TokenUsage | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isOptionalTokenCount(value.inputTokens) &&
    isOptionalTokenCount(value.outputTokens) &&
    isOptionalTokenCount(value.totalTokens) &&
    isOptionalTokenCount(value.cacheHitTokens) &&
    isOptionalTokenCount(value.cacheMissTokens) &&
    (value.cacheHitRate === undefined ||
      value.cacheHitRate === null ||
      isCacheHitRate(value.cacheHitRate));
}

function isOptionalTokenCount(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isOptionalAttachmentRecords(value: unknown): value is AttachmentRecord[] | undefined {
  return value === undefined ||
    (Array.isArray(value) && value.every(isAttachmentRecord));
}

function isTurnStatus(value: unknown): value is TurnStatus {
  return value === "in-flight" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "needs_continuation";
}

function isTerminalTurnStatus(value: unknown): value is TerminalTurnStatus {
  return value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "needs_continuation";
}

function isToolStatus(value: unknown): value is ToolItem["status"] {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed";
}

function isOptionalApprovalDecision(value: unknown): boolean {
  return value === undefined || value === "allow" || value === "deny";
}

function isOptionalApprovalPreview(value: unknown): value is ApprovalPreview | undefined {
  return value === undefined || isApprovalPreview(value);
}

function isApprovalPreview(value: unknown): value is ApprovalPreview {
  if (!isRecord(value)) return false;
  if (value.kind === "file_diff") return isFileDiffPreview(value);
  if (value.kind !== "multi_file_diff") return false;
  return Array.isArray(value.files) &&
    value.files.every(isFileDiffPreview) &&
    isNonNegativeInteger(value.added) &&
    isNonNegativeInteger(value.removed);
}

function isFileDiffPreview(value: unknown): value is FileDiffPreview {
  if (!isRecord(value)) return false;
  return value.kind === "file_diff" &&
    hasString(value, "path") &&
    isFileDiffOperation(value.operation) &&
    isNonNegativeInteger(value.added) &&
    isNonNegativeInteger(value.removed) &&
    Array.isArray(value.lines) &&
    value.lines.every(isFileDiffLine);
}

function isFileDiffLine(value: unknown): value is FileDiffLine {
  if (!isRecord(value)) return false;
  return isFileDiffLineType(value.type) && hasString(value, "text");
}

function isFileDiffOperation(value: unknown): value is FileDiffPreview["operation"] {
  return value === "create" || value === "update" || value === "delete";
}

function isFileDiffLineType(value: unknown): value is FileDiffLine["type"] {
  return value === "context" || value === "added" || value === "removed";
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max;
}

function isCacheHitRate(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
}

function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && PLAN_STEP_STATUSES.includes(value as PlanStepStatus);
}

function isSystemLevel(value: unknown): value is SystemItem["level"] {
  return value === "info" || value === "warn" || value === "error";
}

function isRuntimeErrorCode(value: unknown): value is RuntimeErrorEvent["code"] {
  return value === "worker_crashed" ||
    value === "worker_timeout" ||
    value === "provider_http" ||
    value === "provider_error" ||
    value === "schema_invalid" ||
    value === "tool_not_found" ||
    value === "tool_failed" ||
    value === "approval_timeout" ||
    value === "persistence_error" ||
    value === "internal";
}
