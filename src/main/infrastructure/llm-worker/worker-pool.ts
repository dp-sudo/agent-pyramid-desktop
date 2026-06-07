import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  WorkerChatRequest,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import type { LlmRequest, LlmResponse, LlmStreamChunk } from "../../domain/agent/types.js";
import { isThreadRecord, type ThreadRecord } from "../../../shared/agent-contracts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_FILE = path.join(__dirname, "llm-worker.js");

interface PoolEntry {
  worker: Worker;
  activeRequests: number;
}

/**
 * Routes chat requests to N workers. Same `threadId` always lands on the
 * same worker, guaranteeing turn-level serial execution per thread.
 */
export class LlmWorkerPool {
  private readonly workers: PoolEntry[] = [];
  private readonly threadToWorker = new Map<string, PoolEntry>();
  private readonly threadToCancel = new Map<string, WorkerInbound>();
  private destroyed = false;

  constructor(private readonly size = 1) {
    if (size < 1) throw new Error("Worker pool size must be >= 1");
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.size; i += 1) {
      const worker = new Worker(WORKER_FILE);
      const entry: PoolEntry = { worker, activeRequests: 0 };
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
    onChunk: (chunk: LlmStreamChunk) => void,
  ): Promise<LlmResponse> {
    if (this.destroyed) throw new Error("Worker pool is destroyed");

    const entry = this.acquireEntry(thread.id);
    entry.activeRequests += 1;
    const requestId = randomUUID();
    const chatMsg: WorkerChatRequest = { type: "chat", requestId, payload: request };
    const cancelMsg: WorkerInbound = { type: "cancel", requestId };

    return new Promise<LlmResponse>((resolve, reject) => {
      const messageHandler = (raw: WorkerOutbound): void => {
        if (raw.requestId !== requestId) return;
        if (raw.kind === "delta") {
          onChunk(raw.chunk);
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
        entry.activeRequests = Math.max(0, entry.activeRequests - 1);
        this.threadToCancel.delete(thread.id);
      };

      entry.worker.on("message", messageHandler);
      entry.worker.on("error", errorHandler);
      entry.worker.postMessage(chatMsg);
      this.threadToCancel.set(thread.id, cancelMsg);
    });
  }

  /** Cancel the in-flight chat on the worker assigned to `threadId`. */
  cancel(threadId: string): void {
    const entry = this.threadToWorker.get(threadId);
    if (!entry) return;
    const cancelMsg = this.threadToCancel.get(threadId);
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
    this.threadToCancel.clear();
  }

  private acquireEntry(threadId: string): PoolEntry {
    const existing = this.threadToWorker.get(threadId);
    if (existing) return existing;

    const entry = this.workers.reduce<PoolEntry | null>((best, candidate) => {
      if (!best) return candidate;
      return candidate.activeRequests < best.activeRequests ? candidate : best;
    }, null);
    if (!entry) throw new Error("No worker available");
    this.threadToWorker.set(threadId, entry);
    return entry;
  }
}

/** Type guard kept for symmetry with other validation helpers. */
export function assertThread(thread: unknown): asserts thread is ThreadRecord {
  if (!isThreadRecord(thread)) {
    throw new Error("Invalid thread record");
  }
}
