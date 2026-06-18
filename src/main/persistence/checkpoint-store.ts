import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  CheckpointFileOperation,
  CheckpointFileSummary,
  CheckpointMeta,
  ThreadRecord,
} from "../../shared/agent-contracts.js";
import { isIsoTimestampString } from "../../shared/agent-contracts.js";
import { isSamePath } from "../application/path-utils.js";
import { warnMalformedJsonlLine } from "./jsonl-replay.js";
import { writeUtf8TextFileNoFollow } from "../application/tools/text-file.js";
import {
  assertNoSymlinkInPath,
  getErrorCode,
  resolveWorkspacePathForAccess,
  resolveWorkspaceRoot,
} from "../application/tools/workspace-policy.js";

const CHECKPOINTS_DIRNAME = "checkpoints";
const TMP_SUFFIX = ".tmp";

interface CheckpointFileSnapshot extends CheckpointFileSummary {
  beforeContent: string | null;
  afterContent: string | null;
}

interface CheckpointRecord {
  threadId: string;
  turnId: string;
  workspace: string;
  prompt: string;
  createdAt: string;
  files: CheckpointFileSnapshot[];
}

export interface CheckpointBeginInput {
  threadId: string;
  turnId: string;
  workspace: string;
  prompt: string;
  createdAt?: string;
}

export interface CheckpointSnapshotInput {
  threadId: string;
  turnId: string;
  workspace: string;
  toolName: string;
  relativePath: string;
  operation: CheckpointFileOperation;
  beforeContent: string | null;
  afterContent: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface CheckpointRestoreResult {
  restoredPaths: string[];
  deletedPaths: string[];
}

export interface CheckpointFileSnapshotLookupInput {
  threadId: string;
  workspace: string;
  relativePath: string;
}

export interface CheckpointDiscardFileSnapshotsInput {
  threadId: string;
  turnId: string;
  workspace: string;
  relativePaths: string[];
}

export interface CheckpointFileSnapshotLookupResult {
  threadId: string;
  turnId: string;
  workspace: string;
  toolName: string;
  relativePath: string;
  operation: CheckpointFileOperation;
  beforeContent: string | null;
  afterContent: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  createdAt: string;
}

/**
 * Persistent edit snapshots live outside messages.jsonl so rewind can restore
 * workspace files without changing the thread item schema. Each mutation rewrites
 * one thread's JSONL under a per-thread mutex, and restore rechecks the live
 * workspace boundary before touching disk.
 */
export class CheckpointStore {
  private readonly checkpointsDir: string;
  private readonly mutexes = new Map<string, Promise<unknown>>();

  constructor(userDataDir: string) {
    this.checkpointsDir = path.join(userDataDir, CHECKPOINTS_DIRNAME);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.checkpointsDir, { recursive: true });
  }

  async beginTurn(input: CheckpointBeginInput): Promise<void> {
    const record = normalizeBeginInput(input);
    await this.serialized(record.threadId, async () => {
      const records = await this.readRecords(record.threadId);
      const existing = records.find((candidate) => candidate.turnId === record.turnId);
      if (existing) {
        existing.workspace = record.workspace;
        existing.prompt = record.prompt;
        existing.createdAt = record.createdAt;
      } else {
        records.push({ ...record, files: [] });
      }
      await this.writeRecords(record.threadId, sortRecords(records));
    });
  }

  async recordFileSnapshot(input: CheckpointSnapshotInput): Promise<void> {
    const snapshot = normalizeSnapshotInput(input);
    const access = snapshot.beforeContent === null ? "write" : "read";
    await resolveWorkspacePathForAccess(snapshot.workspace, snapshot.relativePath, access);
    await assertNoSymlinkInPath(snapshot.workspace, snapshot.relativePath, access, "Checkpoint restore");

    await this.serialized(snapshot.threadId, async () => {
      const records = await this.readRecords(snapshot.threadId);
      let record = records.find((candidate) => candidate.turnId === snapshot.turnId);
      if (!record) {
        record = {
          threadId: snapshot.threadId,
          turnId: snapshot.turnId,
          workspace: snapshot.workspace,
          prompt: "",
          createdAt: new Date().toISOString(),
          files: [],
        };
        records.push(record);
      }
      if (!isSamePath(record.workspace, snapshot.workspace)) {
        throw new Error(`Checkpoint workspace changed for turn ${snapshot.turnId}.`);
      }
      if (record.files.some((file) => file.path === snapshot.relativePath)) {
        return;
      }
      record.files.push({
        path: snapshot.relativePath,
        operation: snapshot.operation,
        toolName: snapshot.toolName,
        beforeContent: snapshot.beforeContent,
        afterContent: snapshot.afterContent,
        beforeSha256: snapshot.beforeSha256,
        afterSha256: snapshot.afterSha256,
        createdAt: new Date().toISOString(),
      });
      await this.writeRecords(snapshot.threadId, sortRecords(records));
    });
  }

  async discardFileSnapshots(input: CheckpointDiscardFileSnapshotsInput): Promise<number> {
    const threadId = normalizeSafeId(input.threadId, "threadId");
    const turnId = normalizeSafeId(input.turnId, "turnId");
    const workspace = resolveWorkspaceRoot(input.workspace);
    const relativePaths = [...new Set(input.relativePaths.map(normalizeRelativePath))];
    if (relativePaths.length === 0) return 0;

    return this.serialized(threadId, async () => {
      const records = await this.readRecords(threadId);
      const record = records.find((candidate) => candidate.turnId === turnId);
      if (!record) return 0;
      if (!isSamePath(record.workspace, workspace)) {
        throw new Error(`Checkpoint workspace changed for turn ${turnId}.`);
      }
      const targets = new Set(relativePaths);
      const beforeCount = record.files.length;
      record.files = record.files.filter((file) => !targets.has(file.path));
      const discarded = beforeCount - record.files.length;
      if (discarded > 0) {
        await this.writeRecords(threadId, sortRecords(records));
      }
      return discarded;
    });
  }

  async list(threadId: string): Promise<CheckpointMeta[]> {
    const records = sortRecords(await this.readRecords(threadId));
    const canRewindCodeByIndex = computeSuffixCodeAvailability(records);
    return records.map((record, index) => ({
      threadId: record.threadId,
      turnId: record.turnId,
      workspace: record.workspace,
      prompt: record.prompt,
      createdAt: record.createdAt,
      files: record.files.map(toFileSummary),
      canRewindCode: canRewindCodeByIndex[index] ?? false,
      canRewindSession: true,
    }));
  }

  // Single-file rollback may need restart-safe evidence, but checkpoint records
  // are turn/file snapshots rather than a full edit stack. Return only the
  // newest same-thread/workspace snapshot; callers still verify the live file
  // matches `afterSha256` before restoring `beforeContent`.
  async latestFileSnapshot(
    input: CheckpointFileSnapshotLookupInput,
  ): Promise<CheckpointFileSnapshotLookupResult | null> {
    const threadId = normalizeSafeId(input.threadId, "threadId");
    const workspace = resolveWorkspaceRoot(input.workspace);
    const relativePath = normalizeRelativePath(input.relativePath);
    const records = sortRecords(await this.readRecords(threadId));

    for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex -= 1) {
      const record = records[recordIndex];
      if (!isSamePath(record.workspace, workspace)) {
        continue;
      }
      for (let fileIndex = record.files.length - 1; fileIndex >= 0; fileIndex -= 1) {
        const file = record.files[fileIndex];
        if (file.path !== relativePath) {
          continue;
        }
        return {
          threadId: record.threadId,
          turnId: record.turnId,
          workspace: record.workspace,
          toolName: file.toolName,
          relativePath: file.path,
          operation: file.operation,
          beforeContent: file.beforeContent,
          afterContent: file.afterContent,
          beforeSha256: file.beforeSha256,
          afterSha256: file.afterSha256,
          createdAt: file.createdAt,
        };
      }
    }
    return null;
  }

  async restoreCode(thread: ThreadRecord, turnId: string): Promise<CheckpointRestoreResult> {
    const records = sortRecords(await this.readRecords(thread.id));
    const startIndex = records.findIndex((record) => record.turnId === turnId);
    if (startIndex < 0) {
      throw new Error(`Checkpoint turn ${turnId} was not found.`);
    }

    const snapshots = collectEarliestSnapshots(records.slice(startIndex));
    const restorePlan = [];
    for (const snapshot of snapshots) {
      if (!isSamePath(snapshot.record.workspace, thread.workspace)) {
        throw new Error(`Checkpoint workspace does not match the current thread: ${snapshot.file.path}`);
      }
      const target = await resolveWorkspacePathForAccess(thread.workspace, snapshot.file.path, "write");
      await assertNoSymlinkInPath(thread.workspace, snapshot.file.path, "write", "Checkpoint restore");
      restorePlan.push({ target, file: snapshot.file });
    }

    const restoredPaths: string[] = [];
    const deletedPaths: string[] = [];
    for (const entry of restorePlan) {
      if (entry.file.beforeContent === null) {
        const target = await resolveRestoreTarget(thread.workspace, entry.file.path, "write");
        await fs.rm(target, { force: true });
        deletedPaths.push(entry.file.path);
        continue;
      }
      await fs.mkdir(path.dirname(entry.target), { recursive: true });
      const target = await resolveRestoreTarget(thread.workspace, entry.file.path, "write");
      await writeUtf8TextFileNoFollow(target, entry.file.beforeContent, {
        label: "Checkpoint restore",
        relativePath: entry.file.path,
      });
      restoredPaths.push(entry.file.path);
    }
    return { restoredPaths, deletedPaths };
  }

  async pruneFromTurn(threadId: string, turnId: string): Promise<number> {
    return this.serialized(threadId, async () => {
      const records = sortRecords(await this.readRecords(threadId));
      const startIndex = records.findIndex((record) => record.turnId === turnId);
      if (startIndex < 0) {
        throw new Error(`Checkpoint turn ${turnId} was not found.`);
      }
      const next = records.slice(0, startIndex);
      await this.writeRecords(threadId, next);
      return records.length - next.length;
    });
  }

  private async readRecords(threadId: string): Promise<CheckpointRecord[]> {
    const target = this.threadPath(threadId);
    if (!existsSync(target)) return [];
    const raw = await fs.readFile(target, "utf8");
    const records: CheckpointRecord[] = [];
    let lineNo = 0;
    for (const line of raw.split(/\r?\n/)) {
      lineNo += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isCheckpointRecord(parsed)) {
          throw new Error("Invalid checkpoint JSONL record shape.");
        }
        records.push(parsed);
      } catch (error) {
        warnMalformedJsonlLine("checkpoint", lineNo, target, error);
      }
    }
    return records;
  }

  private async writeRecords(threadId: string, records: CheckpointRecord[]): Promise<void> {
    await fs.mkdir(this.checkpointsDir, { recursive: true });
    const target = this.threadPath(threadId);
    const tmp = target + TMP_SUFFIX;
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(content ? `${content}\n` : "", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  }

  private threadPath(threadId: string): string {
    return path.join(this.checkpointsDir, `${normalizeSafeId(threadId, "threadId")}.jsonl`);
  }

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
}

function normalizeBeginInput(input: CheckpointBeginInput): Omit<CheckpointRecord, "files"> {
  return {
    threadId: normalizeSafeId(input.threadId, "threadId"),
    turnId: normalizeSafeId(input.turnId, "turnId"),
    workspace: resolveWorkspaceRoot(input.workspace),
    prompt: input.prompt,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function normalizeSnapshotInput(input: CheckpointSnapshotInput): CheckpointSnapshotInput {
  return {
    threadId: normalizeSafeId(input.threadId, "threadId"),
    turnId: normalizeSafeId(input.turnId, "turnId"),
    workspace: resolveWorkspaceRoot(input.workspace),
    toolName: requiredString(input.toolName, "toolName"),
    relativePath: normalizeRelativePath(input.relativePath),
    operation: normalizeOperation(input.operation),
    beforeContent: normalizeNullableContent(input.beforeContent, "beforeContent"),
    afterContent: normalizeNullableContent(input.afterContent, "afterContent"),
    beforeSha256: normalizeNullableSha(input.beforeSha256, "beforeSha256"),
    afterSha256: normalizeNullableSha(input.afterSha256, "afterSha256"),
  };
}

function toFileSummary(file: CheckpointFileSnapshot): CheckpointFileSummary {
  return {
    path: file.path,
    operation: file.operation,
    toolName: file.toolName,
    beforeSha256: file.beforeSha256,
    afterSha256: file.afterSha256,
    createdAt: file.createdAt,
  };
}

function sortRecords(records: CheckpointRecord[]): CheckpointRecord[] {
  return [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function computeSuffixCodeAvailability(records: readonly CheckpointRecord[]): boolean[] {
  const availability = new Array<boolean>(records.length);
  let hasFiles = false;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    hasFiles = hasFiles || records[index].files.length > 0;
    availability[index] = hasFiles;
  }
  return availability;
}

function collectEarliestSnapshots(
  records: readonly CheckpointRecord[],
): Array<{ record: CheckpointRecord; file: CheckpointFileSnapshot }> {
  const seen = new Set<string>();
  const snapshots: Array<{ record: CheckpointRecord; file: CheckpointFileSnapshot }> = [];
  for (const record of records) {
    for (const file of record.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      snapshots.push({ record, file });
    }
  }
  return snapshots;
}

async function resolveRestoreTarget(
  workspace: string,
  relativePath: string,
  access: "read" | "write",
): Promise<string> {
  const target = await resolveWorkspacePathForAccess(workspace, relativePath, access);
  await assertNoSymlinkInPath(workspace, relativePath, access, "Checkpoint restore");
  return target;
}

function normalizeRelativePath(value: string): string {
  const raw = requiredString(value, "relativePath").replace(/\\/g, "/");
  if (raw.includes("\0") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("Checkpoint path is invalid.");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Checkpoint path escapes workspace.");
  }
  return normalized;
}

function normalizeOperation(value: unknown): CheckpointFileOperation {
  if (value === "create" || value === "update" || value === "delete" || value === "rollback") {
    return value;
  }
  throw new Error("Checkpoint file operation is invalid.");
}

function normalizeNullableContent(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or null.`);
  }
  return value;
}

function normalizeNullableSha(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  throw new Error(`${field} must be a sha256 string or null.`);
}

function normalizeSafeId(value: string, field: string): string {
  return requiredString(value, field).replace(/[^A-Za-z0-9_-]/g, "_");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function isCheckpointRecord(value: unknown): value is CheckpointRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.threadId === "string" &&
    typeof record.turnId === "string" &&
    typeof record.workspace === "string" &&
    typeof record.prompt === "string" &&
    typeof record.createdAt === "string" &&
    isIsoTimestampString(record.createdAt) &&
    Array.isArray(record.files) &&
    record.files.every(isCheckpointFileSnapshot);
}

function isCheckpointFileSnapshot(value: unknown): value is CheckpointFileSnapshot {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === "string" &&
    normalizeOperationOrNull(file.operation) !== null &&
    typeof file.toolName === "string" &&
    (typeof file.beforeContent === "string" || file.beforeContent === null) &&
    (typeof file.afterContent === "string" || file.afterContent === null) &&
    isShaOrNull(file.beforeSha256) &&
    isShaOrNull(file.afterSha256) &&
    typeof file.createdAt === "string" &&
    isIsoTimestampString(file.createdAt);
}

function normalizeOperationOrNull(value: unknown): CheckpointFileOperation | null {
  return value === "create" || value === "update" || value === "delete" || value === "rollback"
    ? value
    : null;
}

function isShaOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
}
