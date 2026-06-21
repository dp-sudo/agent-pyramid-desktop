import { isIsoTimestampString } from "./contract-primitives.js";
import {
  isAttachmentRecord,
  type AttachmentRecord,
} from "./attachment-contracts.js";
import {
  isModelReasoningEffort,
  type ModelReasoningEffort,
} from "./model-config-contracts.js";
import {
  isHttpUrl,
  isMcpServerConfigs,
  isMcpServerStatus,
  isMcpToolInfo,
  redactMcpServerConfigForRenderer,
  type McpPromptInfo,
  type McpPromptResult,
  type McpResourceInfo,
  type McpResourceReadResult,
  type McpServerConfig,
  type McpServerStatus,
  type McpServerStatusRecord,
  type McpServerTransport,
  type McpToolInfo,
} from "./mcp-contracts.js";
import {
  RUNTIME_TOOL_NAMES,
  RUNTIME_TOOL_MANIFEST,
  isRuntimeToolName,
  type RuntimeToolName,
} from "./runtime-tool-contracts.js";
import {
  DEFAULT_THREAD_APPROVAL_POLICY,
  DEFAULT_THREAD_SANDBOX_MODE,
  THREAD_MODES,
  isThreadApprovalPolicy,
  isThreadGoal,
  isThreadSandboxMode,
  type ThreadApprovalPolicy,
  type ThreadGoal,
  type ThreadGoalStatus,
  type ThreadMode,
  type ThreadSandboxMode,
} from "./thread-contracts.js";

export * from "./contract-primitives.js";
export * from "./attachment-contracts.js";
export * from "./ipc-result.js";
export * from "./mcp-contracts.js";
export * from "./model-config-contracts.js";
export * from "./runtime-tool-contracts.js";
export * from "./thread-contracts.js";

// ============================================================================
// Runtime preferences
// ============================================================================

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

export const RUNTIME_PERMISSION_RULE_TOOLS = ["command", "write", "mcp"] as const;
export type RuntimePermissionRuleTool = (typeof RUNTIME_PERMISSION_RULE_TOOLS)[number];

export const RUNTIME_PERMISSION_RULE_EFFECTS = ["allow", "ask", "deny"] as const;
export type RuntimePermissionRuleEffect = (typeof RUNTIME_PERMISSION_RULE_EFFECTS)[number];

export const RUNTIME_PERMISSION_RULE_MATCHES = ["glob", "exact"] as const;
export type RuntimePermissionRuleMatch = (typeof RUNTIME_PERMISSION_RULE_MATCHES)[number];

export const RUNTIME_PERMISSION_RULE_SCOPES = ["workspace"] as const;
export type RuntimePermissionRuleScopeKind = (typeof RUNTIME_PERMISSION_RULE_SCOPES)[number];

export interface RuntimePermissionRuleScope {
  kind: RuntimePermissionRuleScopeKind;
  workspace: string;
}

export interface RuntimePermissionRule {
  id: string;
  tool: RuntimePermissionRuleTool;
  pattern: string;
  effect: RuntimePermissionRuleEffect;
  match?: RuntimePermissionRuleMatch;
  scope?: RuntimePermissionRuleScope;
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

export function toRendererRuntimePreferences(
  preferences: RuntimePreferences,
): RuntimePreferences {
  return {
    ...preferences,
    toolAvailability: {
      code: { ...preferences.toolAvailability.code },
      write: { ...preferences.toolAvailability.write },
    },
    approvalExperience: { ...preferences.approvalExperience },
    command: { ...preferences.command },
    compaction: { ...preferences.compaction },
    skills: {
      ...preferences.skills,
      extraRoots: [...preferences.skills.extraRoots],
    },
    permissionRules: preferences.permissionRules.map((rule) => ({
      ...rule,
      ...(rule.scope ? { scope: { ...rule.scope } } : {}),
    })),
    mcpServers: preferences.mcpServers.map(redactMcpServerConfigForRenderer),
  };
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

export const DEFAULT_RUNTIME_TOOL_AVAILABILITY: RuntimeToolAvailabilityPreferences =
  Object.fromEntries([
    [
      "code",
      Object.fromEntries(
        RUNTIME_TOOL_MANIFEST.map((tool) => [tool.name, tool.codeDefaultEnabled]),
      ),
    ],
    [
      "write",
      Object.fromEntries(
        RUNTIME_TOOL_MANIFEST.map((tool) => [tool.name, tool.writeDefaultEnabled]),
      ),
    ],
  ]) as unknown as RuntimeToolAvailabilityPreferences;

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

export function isRuntimePermissionRuleMatch(
  value: unknown,
): value is RuntimePermissionRuleMatch {
  return typeof value === "string" &&
    RUNTIME_PERMISSION_RULE_MATCHES.includes(value as RuntimePermissionRuleMatch);
}

export function isRuntimePermissionRuleScopeKind(
  value: unknown,
): value is RuntimePermissionRuleScopeKind {
  return typeof value === "string" &&
    RUNTIME_PERMISSION_RULE_SCOPES.includes(value as RuntimePermissionRuleScopeKind);
}

export function isRuntimePermissionRuleScope(
  value: unknown,
): value is RuntimePermissionRuleScope {
  if (!isRecord(value)) return false;
  const workspace = value.workspace;
  return isRuntimePermissionRuleScopeKind(value.kind) &&
    hasNonBlankString(value, "workspace") &&
    typeof workspace === "string" &&
    !workspace.includes("\0");
}

export function isApprovalDecisionScope(value: unknown): value is ApprovalDecisionScope {
  return typeof value === "string" &&
    APPROVAL_DECISION_SCOPES.includes(value as ApprovalDecisionScope);
}

export function isRuntimePreferences(value: unknown): value is RuntimePreferences {
  if (!isRecord(value)) return false;
  return isThreadApprovalPolicy(value.defaultApprovalPolicy) &&
    isThreadSandboxMode(value.defaultSandboxMode) &&
    isRuntimeToolAvailabilityPreferences(value.toolAvailability) &&
    isNullableProfileId(value.codeDefaultModelProfileId) &&
    isNullableProfileId(value.writeDefaultModelProfileId) &&
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

export interface RuntimeToolCatalogSnapshot {
  fingerprint: string;
  toolCount: number;
  toolNames: string[];
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
  toolCatalog?: RuntimeToolCatalogSnapshot;
}

// ============================================================================
// Items: the in-thread content stream
// ============================================================================

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

export const TOOL_FAILURE_CODES = [
  "tool_unavailable",
  "tool_not_registered",
  "tool_schema_invalid",
  "tool_repeat_suppressed",
  "tool_policy_denied",
  "tool_approval_denied",
  "tool_interrupted",
  "tool_sandbox_unavailable",
  "tool_execution_failed",
  "tool_budget_exhausted",
] as const;
export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];

export interface ToolFailureResult {
  code: ToolFailureCode;
  message: string;
  denied?: boolean;
  suppressed?: boolean;
  reason?: string;
  count?: number;
  threshold?: number;
}

export function isToolFailureCode(value: unknown): value is ToolFailureCode {
  return typeof value === "string" && TOOL_FAILURE_CODES.includes(value as ToolFailureCode);
}

export function isToolFailureResult(value: unknown): value is ToolFailureResult {
  if (!isRecord(value)) return false;
  return isToolFailureCode(value.code) &&
    hasString(value, "message") &&
    isOptionalBoolean(value.denied) &&
    isOptionalBoolean(value.suppressed) &&
    isOptionalString(value.reason) &&
    isOptionalTokenCount(value.count) &&
    isOptionalTokenCount(value.threshold);
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
  scope?: ApprovalDecisionScope;
  resolvedAt?: string;
  createdAt: string;
}

export interface UserInputItem {
  kind: "user_input";
  id: string;
  threadId: string;
  turnId: string;
  userInputId?: string;
  question: string;
  options?: string[];
  answer?: string;
  cancelled?: boolean;
  resolvedAt?: string;
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

export const APPROVAL_DECISION_SCOPES = ["once", "session", "persist_rule"] as const;
export type ApprovalDecisionScope = (typeof APPROVAL_DECISION_SCOPES)[number];

export interface ApprovalRespondRequest {
  approvalId: string;
  decision: "allow" | "deny";
  scope?: ApprovalDecisionScope;
}

export interface ApprovalRespondResponse {
  approvalId: string;
  decision: "allow" | "deny";
  scope?: ApprovalDecisionScope;
  accepted: boolean;
  reason?: "not_pending";
}

// ============================================================================
// User input
// ============================================================================

export interface UserInputRespondRequest {
  userInputId: string;
  answer?: string;
  cancelled?: boolean;
}

export interface UserInputRespondResponse {
  userInputId: string;
  accepted: boolean;
  answer?: string;
  cancelled?: boolean;
  reason?: "not_pending";
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

export interface SseSubscribeGlobalResponse {
  subscribed: true;
}

export interface SseUnsubscribeGlobalResponse {
  unsubscribed: boolean;
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
  threadId: string;
  /** Glob substring, case-insensitive. */
  search?: string;
}

export interface WriteGetRequest {
  threadId: string;
  path: string;
}

export interface WritePutRequest {
  threadId: string;
  path: string;
  content: string;
}

export interface WriteCreateRequest {
  threadId: string;
  path: string;
  content?: string;
}

export interface WriteRenameRequest {
  threadId: string;
  path: string;
  newPath: string;
}

export interface WriteDeleteRequest {
  threadId: string;
  path: string;
}

export interface WriteCompleteRequest {
  threadId: string;
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
  skippedPaths: string[];
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
        isOptionalApprovalDecisionScope(v.scope) &&
        isOptionalIsoTimestampString(v.resolvedAt);
    case "user_input":
      return hasString(v, "turnId") &&
        isOptionalString(v.userInputId) &&
        hasString(v, "question") &&
        isOptionalStringArray(v.options) &&
        isOptionalString(v.answer) &&
        isOptionalBoolean(v.cancelled) &&
        isOptionalIsoTimestampString(v.resolvedAt);
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
  if (
    typeof value.enabled !== "boolean" ||
    !isIntegerInRange(
      value.activeLimit,
      MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
      MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
    ) ||
    !isIntegerInRange(
      value.instructionBudgetBytes,
      MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
    ) ||
    !Array.isArray(value.extraRoots)
  ) {
    return false;
  }
  const roots = new Set<string>();
  for (const entry of value.extraRoots) {
    if (typeof entry !== "string" || entry.includes("\0")) return false;
    const trimmed = entry.trim();
    if (!trimmed || trimmed !== entry || roots.has(trimmed)) return false;
    roots.add(trimmed);
  }
  return true;
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
    if (typeof id !== "string") {
      return false;
    }
    const normalizedId = id.trim();
    if (
      !normalizedId ||
      normalizedId.includes("\0") ||
      ids.has(normalizedId) ||
      !isRuntimePermissionRuleTool(rule.tool) ||
      typeof pattern !== "string" ||
      !pattern.trim() ||
      pattern.includes("\0") ||
      !isRuntimePermissionRuleEffect(rule.effect) ||
      (rule.match !== undefined && !isRuntimePermissionRuleMatch(rule.match)) ||
      (rule.scope !== undefined && !isRuntimePermissionRuleScope(rule.scope))
    ) {
      return false;
    }
    ids.add(normalizedId);
  }
  return true;
}

// Model `base_url` is the LLM provider endpoint. Unlike MCP URLs (which the
// user fully controls), a malicious base_url can leak the `Authorization:
// Bearer` API key to an attacker-influenced host (see H-1). We require http(s)
// and reject file:/data:/javascript:/blob:/ftp: unconditionally. Plain `http:`
// is only accepted for loopback hosts and only behind an explicit opt-in flag
// (AGENT_ALLOW_INSECURE_BASE_URL=1); this keeps local dev/test providers
// usable without weakening the production default.
export function isAllowedModelBaseUrl(
  value: unknown,
  options: { allowInsecureLocalhost?: boolean } = {},
): value is string {
  if (!isNonBlankStringWithoutNul(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    void error;
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  if (!options.allowInsecureLocalhost) return false;
  const host = parsed.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isNullableProfileId(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
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
    isOptionalTokenUsage(value.usage) &&
    isOptionalRuntimeToolCatalogSnapshot(value.toolCatalog);
}

function isOptionalRuntimeToolCatalogSnapshot(
  value: unknown,
): value is RuntimeToolCatalogSnapshot | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return hasNonBlankString(value, "fingerprint") &&
    isNonNegativeInteger(value.toolCount) &&
    Array.isArray(value.toolNames) &&
    value.toolNames.every((name) => typeof name === "string" && name.trim().length > 0) &&
    value.toolNames.length === value.toolCount;
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
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (!isNonBlankStringWithoutNul(key) || !isStringWithoutNul(entry)) return false;
    const normalizedKey = key.trim();
    if (keys.has(normalizedKey)) return false;
    keys.add(normalizedKey);
  }
  return true;
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

function isOptionalApprovalDecisionScope(value: unknown): boolean {
  return value === undefined || isApprovalDecisionScope(value);
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
