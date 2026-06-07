// ============================================================================
// Legacy single-run contract (kept for backward compatibility)
// ============================================================================

/**
 * @deprecated since 1.4 — use ThreadRecord + turn.start.
 * Kept so external callers (and the existing `agentApi.run` IPC surface) still
 * work. Internally `runOnce` translates this into the new multi-turn flow.
 */
export type LlmProtocol = "openai-compatible" | "anthropic-compatible";

/**
 * @deprecated since 1.4
 */
export type AgentRunStatus = "completed" | "failed";

/**
 * @deprecated since 1.4
 */
export interface AgentRunRequest {
  goal: string;
  protocol: LlmProtocol;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

/**
 * @deprecated since 1.4
 */
export interface AgentStageEvent {
  stage: "observe" | "reason" | "act";
  title: string;
  detail: string;
  timestamp: string;
}

/**
 * @deprecated since 1.4
 */
export interface AgentRunResponse {
  status: AgentRunStatus;
  output: string;
  reasoning?: string;
  trace: AgentStageEvent[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// Threading + multi-turn
// ============================================================================

/** A conversation lineage marker. See design.md D4. */
export type ThreadRelation = "primary" | "fork" | "side";

/** A persisted conversation. */
export interface ThreadRecord {
  id: string;
  title: string;
  workspace: string; // absolute path; empty for write-mode
  mode: "code" | "write";
  relation: ThreadRelation;
  parentThreadId?: string;
  forkedAt?: string; // ISO timestamp
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  approvalPolicy: "auto" | "on-request" | "untrusted" | "never";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
}

/** A lightweight row in the index.json listing. */
export interface ThreadSummary {
  id: string;
  title: string;
  workspace: string;
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
}

export interface ThreadListFilter {
  include?: ThreadRelation[]; // default excludes 'side'
  search?: string; // case-insensitive title match
  mode?: "code" | "write";
}

// ----------------------------------------------------------------------------

export type TurnStatus = "in-flight" | "completed" | "failed" | "interrupted";

export interface TurnRecord {
  id: string;
  threadId: string;
  status: TurnStatus;
  startedAt: string;
  completedAt?: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
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

export interface ApprovalRequestedEvent {
  kind: "approval_requested";
  threadId: string;
  turnId: string;
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
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
    | "approval_timeout"
    | "persistence_error"
    | "internal";
  message: string;
}

export type RuntimeEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemAppendedEvent
  | ApprovalRequestedEvent
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
  reasoningEffort?: TurnRecord["reasoningEffort"];
  attachmentIds?: string[];
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
  "system",
];

const RUNTIME_EVENT_KINDS: RuntimeEventKind[] = [
  "turn_started",
  "turn_completed",
  "turn_failed",
  "item_appended",
  "approval_requested",
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
    (v.relation === "primary" || v.relation === "fork" || v.relation === "side") &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}
