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
  ThreadRecord,
  ThreadSummary,
  ThreadUpdatePatch,
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
  /** Per-thread serial write queue. Same-thread writes run serially. */
  private readonly mutexes = new Map<string, Promise<unknown>>();

  constructor(private readonly userDataDir: string) {
    this.threadsDir = path.join(userDataDir, THREADS_DIRNAME);
    this.indexPath = path.join(this.threadsDir, INDEX_FILENAME);
  }

  /** 2.2 init: ensure directories, read or initialize index. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.threadsDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      await this.atomicWriteJson(this.indexPath, [] as ThreadSummary[]);
    }
    this.initialized = true;
  }

  /** 2.3 createThread */
  async createThread(input: ThreadCreateInput): Promise<ThreadRecord> {
    await this.init();
    const now = new Date().toISOString();
    const record: ThreadRecord = {
      id: randomUUID(),
      title: input.title?.trim() || "New thread",
      workspace: input.workspace,
      mode: input.mode,
      relation: input.relation ?? "primary",
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      createdAt: now,
      updatedAt: now,
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    };
    if (input.relation === "fork" && input.parentThreadId) {
      record.forkedAt = now;
    }
    const threadDir = this.threadDir(record.id);
    await fs.mkdir(threadDir, { recursive: true });
    await this.atomicWriteJson(this.threadPath(record.id), record);
    await fs.writeFile(this.messagesPath(record.id), "", { flag: "a" });
    await fs.writeFile(this.eventsPath(record.id), "", { flag: "a" });
    await this.appendToIndex(this.toSummary(record));
    return record;
  }

  /** 2.4 getThread / listThreads */
  async getThread(id: string): Promise<ThreadRecord | null> {
    await this.init();
    try {
      const raw = await fs.readFile(this.threadPath(id), "utf8");
      return JSON.parse(raw) as ThreadRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listThreads(filter: ThreadListFilter = {}): Promise<ThreadSummary[]> {
    await this.init();
    const indexRaw = await fs.readFile(this.indexPath, "utf8");
    const all = JSON.parse(indexRaw) as ThreadSummary[];
    const include = filter.include ?? ["primary", "fork"];
    const search = filter.search?.trim().toLowerCase() ?? "";
    return all
      .filter((row) => include.includes(row.relation))
      .filter((row) => (filter.mode ? row.mode === filter.mode : true))
      .filter((row) =>
        search.length > 0 ? row.title.toLowerCase().includes(search) : true,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /** 2.5 appendItem / appendEvent with per-thread mutex + fsync. */
  async appendItem(threadId: string, item: Item): Promise<void> {
    return this.serialized(threadId, async () => {
      await this.appendJsonl(this.messagesPath(threadId), item);
    });
  }

  async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    return this.serialized(threadId, async () => {
      await this.appendJsonl(this.eventsPath(threadId), event);
    });
  }

  /** 2.6 replay: readline-based, skips malformed lines. */
  async *replayItems(threadId: string): AsyncIterable<Item> {
    yield* this.replayJsonl<Item>(this.messagesPath(threadId), "messages");
  }

  async *replayEvents(threadId: string): AsyncIterable<RuntimeEvent> {
    yield* this.replayJsonl<RuntimeEvent>(this.eventsPath(threadId), "events");
  }

  /** 2.7 updateThread: atomic write + index update. */
  async updateThread(id: string, patch: ThreadUpdatePatch): Promise<ThreadRecord> {
    return this.serialized(id, async () => {
      const current = await this.getThread(id);
      if (!current) {
        throw new Error(`Thread ${id} not found`);
      }
      const next: ThreadRecord = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.approvalPolicy ? { approvalPolicy: patch.approvalPolicy } : {}),
        ...(patch.sandboxMode ? { sandboxMode: patch.sandboxMode } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(this.threadPath(id), next);
      await this.replaceInIndex(this.toSummary(next));
      return next;
    });
  }

  /** 2.8 forkThread */
  async forkThread(parentId: string): Promise<ThreadRecord> {
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
    const indexRaw = await fs.readFile(this.indexPath, "utf8");
    const all = JSON.parse(indexRaw) as ThreadSummary[];
    const next = all.filter((row) => row.id !== id);
    await this.atomicWriteJson(this.indexPath, next);
    await fs.rm(this.threadDir(id), { recursive: true, force: true });
  }

  // --------------------------------------------------------------------------

  private toSummary(record: ThreadRecord): ThreadSummary {
    return {
      id: record.id,
      title: record.title,
      workspace: record.workspace,
      relation: record.relation,
      mode: record.mode,
      updatedAt: record.updatedAt,
    };
  }

  private threadDir(id: string): string {
    return path.join(this.threadsDir, id);
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
    const raw = await fs.readFile(this.indexPath, "utf8");
    const all = JSON.parse(raw) as ThreadSummary[];
    const dedup = all.filter((row) => row.id !== summary.id);
    dedup.push(summary);
    await this.atomicWriteJson(this.indexPath, dedup);
  }

  private async replaceInIndex(summary: ThreadSummary): Promise<void> {
    const raw = await fs.readFile(this.indexPath, "utf8");
    const all = JSON.parse(raw) as ThreadSummary[];
    const next = all.map((row) => (row.id === summary.id ? summary : row));
    await this.atomicWriteJson(this.indexPath, next);
  }

  private async *replayJsonl<T>(
    target: string,
    label: "messages" | "events",
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
          yield JSON.parse(trimmed) as T;
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
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(
      threadId,
      previous.then(() => next),
    );
    try {
      await previous;
      return await work();
    } finally {
      release();
      // Garbage-collect the slot once the chain drains.
      if (this.mutexes.get(threadId) === previous.then(() => next)) {
        // No-op; the next call will replace it.
      }
      // Best-effort cleanup after a microtask.
      queueMicrotask(() => {
        const current = this.mutexes.get(threadId);
        if (current && (current as Promise<unknown>).then) {
          // We can't reliably compare, so leave it. Map will not grow unbounded
          // for any realistic app — at most one entry per active threadId.
          void current;
        }
      });
    }
  }
}
