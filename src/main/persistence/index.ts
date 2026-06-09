import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import type {
  Item,
  RuntimeEvent,
  ThreadCreateInput,
  ThreadListFilter,
  ThreadRelation,
  ThreadRecord,
  ThreadSummary,
  ThreadUpdatePatch,
} from "../../shared/agent-contracts.js";
import {
  DEFAULT_THREAD_APPROVAL_POLICY,
  DEFAULT_THREAD_LIST_RELATIONS,
  DEFAULT_THREAD_MODE,
  DEFAULT_THREAD_RELATION,
  DEFAULT_THREAD_SANDBOX_MODE,
  DEFAULT_THREAD_STATUS,
  THREAD_APPROVAL_POLICIES,
  THREAD_GOAL_STATUSES,
  THREAD_MODES,
  THREAD_RELATIONS,
  THREAD_SANDBOX_MODES,
  THREAD_STATUSES,
  isItem,
  isIsoTimestampString,
  isRuntimeEvent,
  isUuidString,
} from "../../shared/agent-contracts.js";

const THREADS_DIRNAME = "threads";
const INDEX_FILENAME = "index.json";
const THREAD_FILENAME = "thread.json";
const MESSAGES_FILENAME = "messages.jsonl";
const EVENTS_FILENAME = "events.jsonl";
const TMP_SUFFIX = ".tmp";

export class JsonlThreadStore {
  private readonly threadsDir: string;
  private readonly indexPath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private indexQueue: Promise<unknown> = Promise.resolve();
  /** Per-thread serial write queue. Same-thread writes run serially. */
  private readonly mutexes = new Map<string, Promise<unknown>>();

  constructor(userDataDir: string) {
    this.threadsDir = path.join(userDataDir, THREADS_DIRNAME);
    this.indexPath = path.join(this.threadsDir, INDEX_FILENAME);
  }

  /** 2.2 init: ensure directories, read or initialize index. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.threadsDir, { recursive: true });
        if (!existsSync(this.indexPath)) {
          await this.atomicWriteJson(this.indexPath, [] as ThreadSummary[]);
        }
        this.initialized = true;
      })();
    }
    try {
      await this.initPromise;
    } finally {
      if (!this.initialized) {
        this.initPromise = null;
      }
    }
  }

  /** 2.3 createThread */
  async createThread(input: ThreadCreateInput): Promise<ThreadRecord> {
    await this.init();
    const title = optionalTrimmedString(input.title, "title") || "New thread";
    const workspace = requiredAbsolutePath(input.workspace, "workspace");
    const mode = assertEnum(input.mode, THREAD_MODES, "mode");
    const relation =
      input.relation === undefined
        ? DEFAULT_THREAD_RELATION
        : assertEnum(input.relation, THREAD_RELATIONS, "relation");
    const parentThreadId =
      input.parentThreadId === undefined
        ? undefined
        : assertSafeId(input.parentThreadId, "parentThreadId");
    if (relation === "fork" && !parentThreadId) {
      throw new Error("parentThreadId is required for fork threads.");
    }
    const approvalPolicy =
      input.approvalPolicy === undefined
        ? DEFAULT_THREAD_APPROVAL_POLICY
        : assertEnum(input.approvalPolicy, THREAD_APPROVAL_POLICIES, "approvalPolicy");
    const sandboxMode =
      input.sandboxMode === undefined
        ? DEFAULT_THREAD_SANDBOX_MODE
        : assertEnum(input.sandboxMode, THREAD_SANDBOX_MODES, "sandboxMode");
    const now = new Date().toISOString();
    const record: ThreadRecord = {
      id: randomUUID(),
      title,
      workspace,
      mode,
      status: DEFAULT_THREAD_STATUS,
      relation,
      ...(parentThreadId ? { parentThreadId } : {}),
      createdAt: now,
      updatedAt: now,
      approvalPolicy,
      sandboxMode,
    };
    if (relation === "fork" && parentThreadId) {
      record.forkedAt = now;
    }
    const threadDir = this.threadDir(record.id);
    try {
      await fs.mkdir(threadDir, { recursive: true });
      await this.atomicWriteJson(this.threadPath(record.id), record);
      await fs.writeFile(this.messagesPath(record.id), "", { flag: "a" });
      await fs.writeFile(this.eventsPath(record.id), "", { flag: "a" });
      await this.appendToIndex(this.toSummary(record));
    } catch (error) {
      await fs.rm(threadDir, { recursive: true, force: true });
      throw error;
    }
    return record;
  }

  /** 2.4 getThread / listThreads */
  async getThread(id: string): Promise<ThreadRecord | null> {
    await this.init();
    assertSafeId(id, "Thread id");
    try {
      const raw = await fs.readFile(this.threadPath(id), "utf8");
      return this.normalizeThreadRecord(JSON.parse(raw) as ThreadRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listThreads(filter: ThreadListFilter = {}): Promise<ThreadSummary[]> {
    await this.init();
    const indexRaw = await fs.readFile(this.indexPath, "utf8");
    const all = (JSON.parse(indexRaw) as ThreadSummary[]).map((row) =>
      this.normalizeThreadSummary(row),
    );
    const include = normalizeRelationFilter(filter.include);
    const mode =
      filter.mode === undefined ? undefined : assertEnum(filter.mode, THREAD_MODES, "mode");
    const search = optionalTrimmedString(filter.search, "search").toLowerCase();
    const includeArchived = optionalBoolean(filter.includeArchived, "includeArchived");
    const archivedOnly = optionalBoolean(filter.archivedOnly, "archivedOnly");
    return all
      .filter((row) => include.includes(row.relation))
      .filter((row) => (mode ? row.mode === mode : true))
      .filter((row) => {
        const status = row.status ?? DEFAULT_THREAD_STATUS;
        if (archivedOnly) return status === "archived";
        if (includeArchived) return true;
        return status !== "archived";
      })
      .filter((row) =>
        search.length > 0 ? row.title.toLowerCase().includes(search) : true,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /** 2.5 appendItem / appendEvent with per-thread mutex + fsync. */
  async appendItem(threadId: string, item: Item): Promise<void> {
    assertSafeId(threadId, "Thread id");
    if (!isItem(item)) {
      throw new Error("Item shape is invalid.");
    }
    if (item.threadId !== threadId) {
      throw new Error("Item threadId does not match target thread.");
    }
    return this.serialized(threadId, async () => {
      await this.appendJsonl(this.messagesPath(threadId), item);
      await this.touchThreadActivity(threadId, item.createdAt);
    });
  }

  async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    assertSafeId(threadId, "Thread id");
    if (!isRuntimeEvent(event)) {
      throw new Error("Runtime event shape is invalid.");
    }
    if (!("threadId" in event) || event.threadId !== threadId) {
      throw new Error("Runtime event threadId does not match target thread.");
    }
    return this.serialized(threadId, async () => {
      await this.appendJsonl(this.eventsPath(threadId), event);
    });
  }

  /** 2.6 replay: readline-based, skips malformed lines. */
  async *replayItems(threadId: string): AsyncIterable<Item> {
    assertSafeId(threadId, "Thread id");
    yield* this.replayJsonl<Item>(this.messagesPath(threadId), "messages", isItem);
  }

  async *replayEvents(threadId: string): AsyncIterable<RuntimeEvent> {
    assertSafeId(threadId, "Thread id");
    yield* this.replayJsonl<RuntimeEvent>(
      this.eventsPath(threadId),
      "events",
      isRuntimeEvent,
    );
  }

  /** 2.7 updateThread: atomic write + index update. */
  async updateThread(id: string, patch: ThreadUpdatePatch): Promise<ThreadRecord> {
    assertSafeId(id, "Thread id");
    const normalizedPatch = normalizeThreadPatch(patch);
    return this.serialized(id, async () => {
      const current = await this.getThread(id);
      if (!current) {
        throw new Error(`Thread ${id} not found`);
      }
      const next: ThreadRecord = {
        ...current,
        ...(normalizedPatch.title !== undefined ? { title: normalizedPatch.title } : {}),
        ...(normalizedPatch.approvalPolicy
          ? { approvalPolicy: normalizedPatch.approvalPolicy }
          : {}),
        ...(normalizedPatch.sandboxMode ? { sandboxMode: normalizedPatch.sandboxMode } : {}),
        ...(normalizedPatch.status ? { status: normalizedPatch.status } : {}),
        ...(normalizedPatch.goal === null
          ? { goal: undefined }
          : normalizedPatch.goal
            ? { goal: normalizedPatch.goal }
            : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(this.threadPath(id), next);
      await this.replaceInIndex(this.toSummary(next));
      return next;
    });
  }

  /** 2.8 forkThread */
  async forkThread(parentId: string): Promise<ThreadRecord> {
    assertSafeId(parentId, "Thread id");
    const parent = await this.getThread(parentId);
    if (!parent) throw new Error(`Parent thread ${parentId} not found`);
    return this.createThread({
      title: `${parent.title} (fork)`,
      workspace: parent.workspace,
      mode: parent.mode,
      relation: "fork",
      parentThreadId: parentId,
    });
  }

  /** 2.9 deleteThread */
  async deleteThread(id: string): Promise<void> {
    await this.init();
    assertSafeId(id, "Thread id");
    await this.serializedIndex(async () => {
      const indexRaw = await fs.readFile(this.indexPath, "utf8");
      const all = JSON.parse(indexRaw) as ThreadSummary[];
      const next = all.filter((row) => row.id !== id);
      await this.atomicWriteJson(this.indexPath, next);
    });
    await fs.rm(this.threadDir(id), { recursive: true, force: true });
  }

  // --------------------------------------------------------------------------

  private toSummary(record: ThreadRecord): ThreadSummary {
    return {
      id: record.id,
      title: record.title,
      workspace: record.workspace,
      status: record.status ?? DEFAULT_THREAD_STATUS,
      relation: record.relation,
      mode: record.mode,
      updatedAt: record.updatedAt,
    };
  }

  private normalizeThreadRecord(record: ThreadRecord): ThreadRecord {
    const {
      goal: rawGoal,
      parentThreadId: rawParentThreadId,
      forkedAt: rawForkedAt,
      ...base
    } = record;
    const goal = normalizeStoredGoal(rawGoal);
    const relation = assertEnum(record.relation, THREAD_RELATIONS, "relation");
    const parentThreadId =
      rawParentThreadId === undefined
        ? undefined
        : assertSafeId(rawParentThreadId, "parentThreadId");
    if (relation === "fork" && !parentThreadId) {
      throw new Error("parentThreadId is required for fork threads.");
    }
    return {
      ...base,
      id: assertSafeId(record.id, "id"),
      title: requiredTrimmedString(record.title, "title"),
      workspace: requiredAbsolutePath(record.workspace, "workspace"),
      mode: normalizeStoredThreadMode(record.mode),
      status: normalizeStoredThreadStatus(record.status),
      relation,
      ...(parentThreadId !== undefined ? { parentThreadId } : {}),
      ...(rawForkedAt !== undefined
        ? { forkedAt: requiredIsoTimestampString(rawForkedAt, "forkedAt") }
        : {}),
      createdAt: requiredIsoTimestampString(record.createdAt, "createdAt"),
      updatedAt: requiredIsoTimestampString(record.updatedAt, "updatedAt"),
      approvalPolicy: normalizeStoredApprovalPolicy(record.approvalPolicy),
      sandboxMode: normalizeStoredSandboxMode(record.sandboxMode),
      ...(goal !== undefined ? { goal } : {}),
    };
  }

  private normalizeThreadSummary(summary: ThreadSummary): ThreadSummary {
    return {
      ...summary,
      id: assertSafeId(summary.id, "id"),
      title: requiredTrimmedString(summary.title, "title"),
      workspace: requiredAbsolutePath(summary.workspace, "workspace"),
      mode: normalizeStoredThreadMode(summary.mode),
      status: normalizeStoredThreadStatus(summary.status),
      relation: assertEnum(summary.relation, THREAD_RELATIONS, "relation"),
      updatedAt: requiredIsoTimestampString(summary.updatedAt, "updatedAt"),
    };
  }

  private async touchThreadActivity(threadId: string, timestamp: string): Promise<void> {
    const current = await this.getThread(threadId);
    if (!current) {
      throw new Error(`Thread ${threadId} not found`);
    }
    const updatedAt = Date.parse(timestamp) > Date.parse(current.updatedAt)
      ? timestamp
      : current.updatedAt;
    if (updatedAt === current.updatedAt) return;
    const next: ThreadRecord = { ...current, updatedAt };
    await this.atomicWriteJson(this.threadPath(threadId), next);
    await this.replaceInIndex(this.toSummary(next));
  }

  private threadDir(id: string): string {
    return path.join(this.threadsDir, assertSafeId(id, "Thread id"));
  }

  private threadPath(id: string): string {
    return path.join(this.threadDir(id), THREAD_FILENAME);
  }

  private messagesPath(id: string): string {
    return path.join(this.threadDir(id), MESSAGES_FILENAME);
  }

  private eventsPath(id: string): string {
    return path.join(this.threadDir(id), EVENTS_FILENAME);
  }

  private async atomicWriteJson(target: string, value: unknown): Promise<void> {
    const tmp = target + TMP_SUFFIX;
    const data = JSON.stringify(value, null, 2);
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  }

  private async appendJsonl(target: string, value: unknown): Promise<void> {
    const line = JSON.stringify(value) + "\n";
    const handle = await fs.open(target, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async appendToIndex(summary: ThreadSummary): Promise<void> {
    await this.serializedIndex(async () => {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const all = JSON.parse(raw) as ThreadSummary[];
      const dedup = all.filter((row) => row.id !== summary.id);
      dedup.push(summary);
      await this.atomicWriteJson(this.indexPath, dedup);
    });
  }

  private async replaceInIndex(summary: ThreadSummary): Promise<void> {
    await this.serializedIndex(async () => {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const all = JSON.parse(raw) as ThreadSummary[];
      const next = all.map((row) => (row.id === summary.id ? summary : row));
      await this.atomicWriteJson(this.indexPath, next);
    });
  }

  private async *replayJsonl<T>(
    target: string,
    label: "messages" | "events",
    validate: (value: unknown) => value is T,
  ): AsyncIterable<T> {
    if (!existsSync(target)) return;
    const stream = createReadStream(target, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    try {
      for await (const line of rl) {
        lineNo += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!validate(parsed)) {
            throw new Error(`Invalid ${label} JSONL record shape.`);
          }
          yield parsed;
        } catch (error) {
          console.warn(
            `[persistence] skipped malformed ${label} line ${lineNo} in ${target}:`,
            (error as Error).message,
          );
        }
      }
    } finally {
      rl.close();
      stream.close();
    }
  }

  /** 2.10 Per-thread serial mutex. */
  private async serialized<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(threadId) ?? Promise.resolve();
    const tail = previous.then(work, work);
    this.mutexes.set(threadId, tail);
    return tail.finally(() => {
      if (this.mutexes.get(threadId) === tail) {
        this.mutexes.delete(threadId);
      }
    });
  }

  private serializedIndex<T>(work: () => Promise<T>): Promise<T> {
    const next = this.indexQueue.then(work, work);
    this.indexQueue = next.catch(() => undefined);
    return next;
  }
}

function assertSafeId(value: string, label: string): string {
  if (!isUuidString(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} is invalid.`);
  }
  return value as T;
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function requiredIsoTimestampString(value: unknown, field: string): string {
  const trimmed = requiredTrimmedString(value, field);
  if (!isIsoTimestampString(trimmed)) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return trimmed;
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const trimmed = requiredTrimmedString(value, field);
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  return trimmed;
}

function optionalTrimmedString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function normalizeRelationFilter(value: unknown): ThreadRelation[] {
  if (value === undefined) return [...DEFAULT_THREAD_LIST_RELATIONS];
  if (!Array.isArray(value)) {
    throw new Error("include must be an array.");
  }
  return value.map((relation) => assertEnum(relation, THREAD_RELATIONS, "include"));
}

// Code/Write mode was added after early thread records existed; missing mode
// replays as Code so legacy sessions keep the stricter Code tool boundary.
function normalizeStoredThreadMode(value: unknown): ThreadRecord["mode"] {
  if (value === undefined) return DEFAULT_THREAD_MODE;
  return assertEnum(value, THREAD_MODES, "mode");
}

function normalizeStoredThreadStatus(value: unknown): ThreadRecord["status"] {
  if (value === undefined) return DEFAULT_THREAD_STATUS;
  return assertEnum(value, THREAD_STATUSES, "status");
}

function normalizeStoredApprovalPolicy(value: unknown): ThreadRecord["approvalPolicy"] {
  if (value === undefined) return DEFAULT_THREAD_APPROVAL_POLICY;
  return assertEnum(value, THREAD_APPROVAL_POLICIES, "approvalPolicy");
}

function normalizeStoredSandboxMode(value: unknown): ThreadRecord["sandboxMode"] {
  if (value === undefined) return DEFAULT_THREAD_SANDBOX_MODE;
  return assertEnum(value, THREAD_SANDBOX_MODES, "sandboxMode");
}

function normalizeStoredGoal(value: unknown): ThreadRecord["goal"] {
  if (value === undefined) return undefined;
  return normalizeGoalObject(value);
}

function normalizeThreadPatch(patch: ThreadUpdatePatch): ThreadUpdatePatch {
  if (!patch || typeof patch !== "object") {
    throw new Error("patch is required.");
  }
  const normalized: ThreadUpdatePatch = {
    ...(patch.title !== undefined
      ? { title: optionalTrimmedString(patch.title, "title") || "New thread" }
      : {}),
    ...(patch.approvalPolicy !== undefined
      ? {
          approvalPolicy: assertEnum(
            patch.approvalPolicy,
            THREAD_APPROVAL_POLICIES,
            "approvalPolicy",
          ),
        }
      : {}),
    ...(patch.sandboxMode !== undefined
      ? { sandboxMode: assertEnum(patch.sandboxMode, THREAD_SANDBOX_MODES, "sandboxMode") }
      : {}),
    ...(patch.status !== undefined
      ? { status: assertEnum(patch.status, THREAD_STATUSES, "status") }
      : {}),
    ...(patch.goal !== undefined ? { goal: normalizeGoal(patch.goal) } : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error("Thread update patch must include at least one field.");
  }
  return normalized;
}

function normalizeGoal(value: ThreadUpdatePatch["goal"]): ThreadUpdatePatch["goal"] {
  if (value === null) return null;
  return normalizeGoalObject(value);
}

function normalizeGoalObject(value: unknown): NonNullable<ThreadRecord["goal"]> {
  if (!value || typeof value !== "object") {
    throw new Error("goal must be an object.");
  }
  const goal = value as Partial<NonNullable<ThreadRecord["goal"]>>;
  const text = requiredTrimmedString(goal.text, "goal.text");
  const status = assertEnum(goal.status, THREAD_GOAL_STATUSES, "goal.status");
  const createdAt = requiredIsoTimestampString(goal.createdAt, "goal.createdAt");
  const updatedAt = requiredIsoTimestampString(goal.updatedAt, "goal.updatedAt");
  return {
    text,
    status,
    createdAt,
    updatedAt,
    ...(goal.completedAt !== undefined
      ? { completedAt: requiredIsoTimestampString(goal.completedAt, "goal.completedAt") }
      : {}),
    ...(goal.blockedAt !== undefined
      ? { blockedAt: requiredIsoTimestampString(goal.blockedAt, "goal.blockedAt") }
      : {}),
    ...(goal.summary !== undefined
      ? { summary: optionalTrimmedString(goal.summary, "goal.summary") }
      : {}),
  };
}
