export type LlmProtocol = "openai-compatible" | "anthropic-compatible";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export const MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export const AGENT_AUTONOMY_LEVELS = ["conservative", "balanced", "deep"] as const;
export type AgentAutonomyLevel = (typeof AGENT_AUTONOMY_LEVELS)[number];

export interface ModelConfig {
  model_provide: string;
  model: string;
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
    hasString(value, "createdAt");
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

export type PlanStepStatus = "pending" | "in_progress" | "completed";

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

export interface RuntimeErrorEvent {
  kind: "runtime_error";
  threadId?: string;
  turnId?: string;
  code:
    | "worker_crashed"
    | "worker_timeout"
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
// Generic IPC envelope
// ============================================================================

export interface IpcOk<T> {
  ok: true;
  value: T;
}

export interface IpcErr {
  ok: false;
  code: string;
  message: string;
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

export function ok<T>(value: T): IpcOk<T> {
  return { ok: true, value };
}

export function err(code: string, message: string): IpcErr {
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
type _ItemKindContract = AssertTrue<ExactUnion<Item["kind"], ItemKind>>;
type _RuntimeEventKindContract = AssertTrue<
  ExactUnion<RuntimeEvent["kind"], RuntimeEventKind>
>;

export function isItemKind(value: unknown): value is ItemKind {
  return typeof value === "string" && ITEM_KINDS.includes(value as ItemKind);
}

export function isRuntimeEventKind(value: unknown): value is RuntimeEventKind {
  return typeof value === "string" &&
    RUNTIME_EVENT_KINDS.includes(value as RuntimeEventKind);
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
        isOptionalString(v.resolvedAt);
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
        hasString(v, "startedAt") &&
        isTurnRecord(v.turn);
    case "turn_completed":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isTerminalTurnStatus(v.status) &&
        hasString(v, "completedAt") &&
        isOptionalTokenUsage(v.usage);
    case "turn_failed":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        hasString(v, "message") &&
        hasString(v, "failedAt");
    case "item_appended":
    case "item_updated":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isItem(v.item);
    case "approval_requested":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        hasString(v, "approvalId") &&
        hasString(v, "toolName") &&
        isRecord(v.args) &&
        isOptionalApprovalPreview(v.preview);
    case "tool_budget_reached":
      return hasString(v, "threadId") &&
        hasString(v, "turnId") &&
        isPositiveInteger(v.maxToolRounds) &&
        isPositiveInteger(v.attemptedToolCalls) &&
        hasString(v, "message") &&
        hasString(v, "reachedAt");
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
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.workspace === "string" &&
    isThreadMode(v.mode) &&
    (v.status === undefined || isThreadStatus(v.status)) &&
    isThreadRelation(v.relation) &&
    (v.approvalPolicy === undefined || isThreadApprovalPolicy(v.approvalPolicy)) &&
    (v.sandboxMode === undefined || isThreadSandboxMode(v.sandboxMode)) &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

function hasBaseItemFields(value: Record<string, unknown>): boolean {
  return hasString(value, "kind") &&
    hasString(value, "id") &&
    hasString(value, "threadId") &&
    hasString(value, "createdAt");
}

function isTurnRecord(value: unknown): value is TurnRecord {
  if (!isRecord(value)) return false;
  return hasString(value, "id") &&
    hasString(value, "threadId") &&
    isTurnStatus(value.status) &&
    hasString(value, "startedAt") &&
    hasString(value, "model") &&
    (value.reasoningEffort === undefined || isModelReasoningEffort(value.reasoningEffort)) &&
    hasString(value, "mode") &&
    (value.mode === "agent" || value.mode === "plan") &&
    isOptionalBoolean(value.goalMode) &&
    isOptionalTokenUsage(value.usage);
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  if (!isRecord(value)) return false;
  return hasString(value, "text") &&
    isThreadGoalStatus(value.status) &&
    hasString(value, "createdAt") &&
    hasString(value, "updatedAt") &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.blockedAt) &&
    isOptionalString(value.summary);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
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

function isCacheHitRate(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
}

function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isSystemLevel(value: unknown): value is SystemItem["level"] {
  return value === "info" || value === "warn" || value === "error";
}

function isRuntimeErrorCode(value: unknown): value is RuntimeErrorEvent["code"] {
  return value === "worker_crashed" ||
    value === "worker_timeout" ||
    value === "schema_invalid" ||
    value === "tool_not_found" ||
    value === "tool_failed" ||
    value === "approval_timeout" ||
    value === "persistence_error" ||
    value === "internal";
}
