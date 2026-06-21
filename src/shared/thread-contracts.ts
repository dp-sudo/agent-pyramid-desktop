import { isIsoTimestampString, isUuidString } from "./contract-primitives.js";

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
export const DEFAULT_THREAD_TITLE = "New thread";
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

export function isThreadRecord(value: unknown): value is ThreadRecord {
  if (!isRecord(value)) return false;
  return (
    isUuidString(value.id) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    isAbsolutePathString(value.workspace) &&
    isThreadMode(value.mode) &&
    (value.status === undefined || isThreadStatus(value.status)) &&
    isThreadRelation(value.relation) &&
    isThreadParentRelationValid(value) &&
    (value.approvalPolicy === undefined || isThreadApprovalPolicy(value.approvalPolicy)) &&
    (value.sandboxMode === undefined || isThreadSandboxMode(value.sandboxMode)) &&
    (value.forkedAt === undefined || isIsoTimestampString(value.forkedAt)) &&
    (value.goal === undefined || isThreadGoal(value.goal)) &&
    isIsoTimestampString(value.createdAt) &&
    isIsoTimestampString(value.updatedAt)
  );
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

function isThreadParentRelationValid(value: Record<string, unknown>): boolean {
  if (value.parentThreadId !== undefined && !isUuidString(value.parentThreadId)) {
    return false;
  }
  if (value.relation === "fork") {
    return isUuidString(value.parentThreadId);
  }
  return value.parentThreadId === undefined && value.forkedAt === undefined;
}

function isAbsolutePathString(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasNonBlankString(value: Record<string, unknown>, key: string): boolean {
  const text = value[key];
  return typeof text === "string" && text.trim().length > 0;
}

function isOptionalIsoTimestampString(value: unknown): value is string | undefined {
  return value === undefined || isIsoTimestampString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
