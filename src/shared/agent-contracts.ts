export type LlmProtocol = "openai-compatible" | "anthropic-compatible";

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
  model_provide: string;
  model: string;
  base_url: string;
  OPENAI_API_KEY: string;
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

/** A conversation lineage marker. See design.md D4. */
export type ThreadRelation = "primary" | "fork" | "side";

export type ThreadGoalStatus = "active" | "complete" | "blocked";

export interface ThreadGoal {
  text: string;
  status: ThreadGoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedAt?: string;
  summary?: string;
}

export type ThreadStatus = "active" | "archived";

/** A persisted conversation. */
export interface ThreadRecord {
  id: string;
  title: string;
  workspace: string; // absolute path; empty for write-mode
  mode: "code" | "write";
  status: ThreadStatus;
  relation: ThreadRelation;
  parentThreadId?: string;
  forkedAt?: string; // ISO timestamp
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  approvalPolicy: "auto" | "on-request" | "untrusted" | "never";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  goal?: ThreadGoal;
}

/** A lightweight row in the index.json listing. */
export interface ThreadSummary {
  id: string;
  title: string;
  workspace: string;
  status: ThreadStatus;
  relation: ThreadRelation;
  mode: "code" | "write";
  updatedAt: string;
}

export interface ThreadCreateInput {
  title?: string;
  workspace: string;
  mode: "code" | "write";
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
  mode?: "code" | "write";
  includeArchived?: boolean;
  archivedOnly?: boolean;
}

// ----------------------------------------------------------------------------

export type TurnStatus =
  | "in-flight"
  | "completed"
  | "failed"
  | "interrupted"
  | "needs_continuation";
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

export type ItemKind = Item["kind"];

// ============================================================================
// Runtime events (emitted on the bus, forwarded to subscribers via IPC)
// ============================================================================

export interface TurnStartedEvent {
  kind: "turn_started";
  threadId: string;
  turnId: string;
  startedAt: string;
}

export interface TurnCompletedEvent {
  kind: "turn_completed";
  threadId: string;
  turnId: string;
  status: TurnStatus;
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

export type RuntimeEventKind = RuntimeEvent["kind"];

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

export interface TurnInterruptOptions {
  /** If true, force-stop the worker even if mid-HTTP-request. */
  force?: boolean;
}

// ============================================================================
// Approval
// ============================================================================

export interface ApprovalRespondRequest {
  approvalId: string;
  decision: "allow" | "deny";
  /** Optional reason recorded in the audit trail. */
  reason?: string;
}

// ============================================================================
// SSE subscription
// ============================================================================

export interface SseSubscribeRequest {
  threadId: string;
  /** Optional client-generated stream id; surfaced in events for correlation. */
  streamId?: string;
  /** Resume from this event index. */
  sinceIndex?: number;
}

export interface SseUnsubscribeRequest {
  threadId: string;
  streamId?: string;
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
  /** If true, write happens via git apply. Otherwise plain fs.writeFile. */
  viaGit?: boolean;
}

export interface WriteCompleteRequest {
  workspace: string;
  path: string;
  /** Text before the cursor. */
  prefix: string;
  /** Text after the cursor. */
  suffix: string;
  /** Force a fresh completion (skip local cache). */
  bypassCache?: boolean;
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

const ITEM_KINDS: ItemKind[] = [
  "user",
  "assistant",
  "reasoning",
  "tool",
  "compaction",
  "approval",
  "user_input",
  "plan",
  "system",
];

const RUNTIME_EVENT_KINDS: RuntimeEventKind[] = [
  "turn_started",
  "turn_completed",
  "turn_failed",
  "item_appended",
  "item_updated",
  "approval_requested",
  "tool_budget_reached",
  "goal_updated",
  "runtime_error",
];

export function isItem(value: unknown): value is Item {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === "string" && ITEM_KINDS.includes(v.kind as ItemKind);
}

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.kind === "string" && RUNTIME_EVENT_KINDS.includes(v.kind as RuntimeEventKind)
  );
}

export function isThreadRecord(value: unknown): value is ThreadRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.workspace === "string" &&
    (v.mode === "code" || v.mode === "write") &&
    (v.status === undefined || v.status === "active" || v.status === "archived") &&
    (v.relation === "primary" || v.relation === "fork" || v.relation === "side") &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}
