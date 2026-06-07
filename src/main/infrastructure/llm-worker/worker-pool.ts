import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  WorkerChatRequest,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import type { LlmRequest, LlmResponse } from "../../domain/agent/types.js";
import { isThreadRecord, type ThreadRecord } from "../../../shared/agent-contracts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_FILE = path.join(__dirname, "worker.js");

interface PoolEntry {
  worker: Worker;
  busy: boolean;
}

/**
 * Routes chat requests to N workers. Same `threadId` always lands on the
 * same worker, guaranteeing turn-level serial execution per thread.
 */
export class LlmWorkerPool {
  private readonly workers: PoolEntry[] = [];
  private readonly threadToWorker = new Map<string, PoolEntry>();
  private destroyed = false;

  constructor(private readonly size = 1) {
    if (size < 1) throw new Error("Worker pool size must be >= 1");
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.size; i += 1) {
      const worker = new Worker(WORKER_FILE);
      const entry: PoolEntry = { worker, busy: false };
      this.workers.push(entry);
      worker.on("error", (error) => {
        console.error(`[llm-worker ${i}] error:`, error);
      });
      worker.on("exit", (code) => {
        if (!this.destroyed && code !== 0) {
          console.error(`[llm-worker ${i}] exited with code ${code}`);
        }
      });
    }
  }

  /**
   * Run a single chat completion. Returns the final LlmResponse.
   * Throws on worker error. The worker streams deltas via `onChunk`.
   */
  async chat(
    thread: Pick<ThreadRecord, "id">,
    request: LlmRequest,
    onChunk: (text: string) => void,
  ): Promise<LlmResponse> {
    if (this.destroyed) throw new Error("Worker pool is destroyed");

    const entry = this.acquireEntry(thread.id);
    const requestId = randomUUID();
    const chatMsg: WorkerChatRequest = { type: "chat", requestId, payload: request };
    const cancelMsg: WorkerInbound = { type: "cancel", requestId };

    return new Promise<LlmResponse>((resolve, reject) => {
      const messageHandler = (raw: WorkerOutbound): void => {
        if (raw.kind === "delta") {
          onChunk(raw.text);
          return;
        }
        if (raw.kind === "done") {
          cleanup();
          resolve(raw.response);
          return;
        }
        if (raw.kind === "error") {
          cleanup();
          reject(new Error(raw.message));
        }
      };

      const errorHandler = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        entry.worker.off("message", messageHandler);
        entry.worker.off("error", errorHandler);
        entry.busy = false;
      };

      entry.worker.on("message", messageHandler);
      entry.worker.on("error", errorHandler);
      entry.worker.postMessage(chatMsg);

      // Stash the cancel message so `cancel()` can fire it later.
      (entry as unknown as { pendingCancel?: WorkerInbound }).pendingCancel = cancelMsg;
    });
  }

  /** Cancel the in-flight chat on the worker assigned to `threadId`. */
  cancel(threadId: string): void {
    const entry = this.threadToWorker.get(threadId);
    if (!entry) return;
    const cancelMsg = (entry as unknown as { pendingCancel?: WorkerInbound }).pendingCancel;
    if (cancelMsg) {
      entry.worker.postMessage(cancelMsg);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all(
      this.workers.map(async (entry) => {
        await entry.worker.terminate();
      }),
    );
    this.workers.length = 0;
    this.threadToWorker.clear();
  }

  private acquireEntry(threadId: string): PoolEntry {
    const existing = this.threadToWorker.get(threadId);
    if (existing) return existing;

    // Round-robin assign idle workers, otherwise pick the first.
    const idle = this.workers.find((w) => !w.busy);
    const entry = idle ?? this.workers[0];
    if (!entry) throw new Error("No worker available");
    this.threadToWorker.set(threadId, entry);
    entry.busy = true;
    return entry;
  }
}

/** Type guard kept for symmetry with other validation helpers. */
export function assertThread(thread: unknown): asserts thread is ThreadRecord {
  if (!isThreadRecord(thread)) {
    throw new Error("Invalid thread record");
  }
}
