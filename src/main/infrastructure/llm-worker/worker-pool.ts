import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  WorkerChatRequest,
  WorkerErrorCode,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import type { LlmRequest, LlmResponse, LlmStreamChunk } from "../../domain/agent/types.js";
import type { ThreadRecord } from "../../../shared/agent-contracts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_FILE = resolveWorkerFile();

interface PoolEntry {
  worker: WorkerLike;
  activeRequests: number;
  index: number;
}

interface WorkerLike {
  on(event: "message", listener: (message: WorkerOutbound) => void): WorkerLike;
  on(event: "error", listener: (error: Error) => void): WorkerLike;
  on(event: "exit", listener: (code: number) => void): WorkerLike;
  off(event: "message", listener: (message: WorkerOutbound) => void): WorkerLike;
  off(event: "error", listener: (error: Error) => void): WorkerLike;
  off(event: "exit", listener: (code: number) => void): WorkerLike;
  postMessage(message: WorkerInbound): void;
  terminate(): Promise<number>;
}

type WorkerFactory = (filename: string) => WorkerLike;
export type LlmWorkerErrorCode = WorkerErrorCode | "worker_crashed";

export class LlmWorkerError extends Error {
  constructor(
    message: string,
    readonly code: LlmWorkerErrorCode,
  ) {
    super(message);
    this.name = "LlmWorkerError";
  }
}

export function isLlmWorkerError(error: unknown): error is LlmWorkerError {
  return error instanceof LlmWorkerError;
}

/**
 * Routes chat requests to N workers. Same `threadId` always lands on the
 * same worker so cancellation and provider-side caches remain thread-affine.
 * AgentRuntime owns same-thread in-flight gating.
 */
export class LlmWorkerPool {
  private readonly workers: PoolEntry[] = [];
  private readonly threadToWorker = new Map<string, PoolEntry>();
  private readonly threadToCancel = new Map<string, WorkerInbound>();
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;

  constructor(
    private readonly size = 1,
    private readonly workerFactory: WorkerFactory = (filename) => new Worker(filename),
    // Pool-level crash notifications fire for worker "error"/"exit" events that
    // are NOT tied to a specific in-flight request (those reject per-request).
    // Lets the composition root surface crashes on the runtime event bus.
    private readonly onWorkerCrash?: (detail: { index: number; error: unknown }) => void,
  ) {
    if (size < 1) throw new Error("Worker pool size must be >= 1");
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.size; i += 1) {
      const entry = this.createEntry(i);
      this.workers.push(entry);
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
          reject(new LlmWorkerError(raw.message, raw.code ?? "internal"));
        }
      };

      const errorHandler = (error: Error): void => {
        cleanup();
        reject(new LlmWorkerError(error.message, "worker_crashed"));
      };

      const exitHandler = (code: number): void => {
        cleanup();
        reject(new LlmWorkerError(
          `LLM worker exited before completing request ${requestId} with code ${code}.`,
          "worker_crashed",
        ));
      };

      const cleanup = (): void => {
        entry.worker.off("message", messageHandler);
        entry.worker.off("error", errorHandler);
        entry.worker.off("exit", exitHandler);
        entry.activeRequests = Math.max(0, entry.activeRequests - 1);
        if (this.threadToCancel.get(thread.id) === cancelMsg) {
          this.threadToCancel.delete(thread.id);
        }
      };

      entry.worker.on("message", messageHandler);
      entry.worker.on("error", errorHandler);
      entry.worker.on("exit", exitHandler);
      this.threadToCancel.set(thread.id, cancelMsg);
      try {
        entry.worker.postMessage(chatMsg);
      } catch (error) {
        cleanup();
        reject(new LlmWorkerError(
          error instanceof Error ? error.message : String(error),
          "worker_crashed",
        ));
      }
    });
  }

  /** Cancel the in-flight chat on the worker assigned to `threadId`. */
  cancel(threadId: string): void {
    const entry = this.threadToWorker.get(threadId);
    if (!entry) return;
    const cancelMsg = this.threadToCancel.get(threadId);
    if (cancelMsg) {
      try {
        entry.worker.postMessage(cancelMsg);
      } catch (error) {
        if (this.threadToCancel.get(threadId) === cancelMsg) {
          this.threadToCancel.delete(threadId);
        }
        console.warn(`[llm-worker] failed to post cancel for thread ${threadId}:`, error);
      }
    }
  }

  /** Electron can reach shutdown from multiple lifecycle events; terminate each worker once. */
  async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    const entries = [...this.workers];
    this.destroyPromise = Promise.all(
      entries.map(async (entry) => {
        await entry.worker.terminate();
      }),
    ).then(() => undefined).finally(() => {
      this.workers.length = 0;
      this.threadToWorker.clear();
      this.threadToCancel.clear();
    });
    return this.destroyPromise;
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

  private createEntry(index: number): PoolEntry {
    const worker = this.workerFactory(WORKER_FILE);
    const entry: PoolEntry = { worker, activeRequests: 0, index };
    worker.on("error", (error) => {
      console.error(`[llm-worker ${index}] error:`, error);
      this.onWorkerCrash?.({ index, error });
    });
    worker.on("exit", (code) => {
      if (this.destroyed) return;
      if (code !== 0) {
        console.error(`[llm-worker ${index}] exited with code ${code}`);
        this.onWorkerCrash?.({ index, error: new Error(`LLM worker ${index} exited with code ${code}`) });
      }
      this.replaceExitedEntry(entry);
    });
    return entry;
  }

  private replaceExitedEntry(entry: PoolEntry): void {
    // A dead worker must not keep thread affinity; future turns need a live
    // replacement while the current chat's exit listener rejects its promise.
    this.releaseThreadMappingsForEntry(entry);
    const index = this.workers.indexOf(entry);
    if (index < 0) return;
    try {
      this.workers[index] = this.createEntry(entry.index);
    } catch (error) {
      console.error(`[llm-worker ${entry.index}] replacement failed:`, error);
      this.workers.splice(index, 1);
    }
  }

  private releaseThreadMappingsForEntry(entry: PoolEntry): void {
    for (const [threadId, mappedEntry] of this.threadToWorker) {
      if (mappedEntry !== entry) continue;
      this.threadToWorker.delete(threadId);
      this.threadToCancel.delete(threadId);
    }
  }
}

export function resolveWorkerFile(): string {
  const candidates = [
    path.join(__dirname, "llm-worker.js"),
    path.join(__dirname, "worker.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
