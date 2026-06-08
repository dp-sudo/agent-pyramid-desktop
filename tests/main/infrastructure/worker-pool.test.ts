import { describe, expect, it, vi } from "vitest";
import { LlmWorkerPool } from "../../../src/main/infrastructure/llm-worker/worker-pool";
import type { WorkerInbound, WorkerOutbound } from "../../../src/main/infrastructure/llm-worker/protocol";
import type { LlmRequest } from "../../../src/main/domain/agent/types";

const baseRequest: LlmRequest = {
  protocol: "openai-compatible",
  provider: "MiniMax",
  model: "MiniMax-M3",
  apiKey: "",
  baseUrl: "https://api.example.test/v1",
  systemPrompt: "system",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  maxTokens: 128,
  temperature: 0.2,
  thinking: false,
  reasoningEffort: "medium",
};

type FakeWorkerEvent = "message" | "error" | "exit";
interface FakeWorkerEventMap {
  message: WorkerOutbound;
  error: Error;
  exit: number;
}
type FakeWorkerListener<K extends FakeWorkerEvent> = (
  payload: FakeWorkerEventMap[K],
) => void;

class FakeWorker {
  readonly posted: WorkerInbound[] = [];
  private readonly messageListeners = new Set<FakeWorkerListener<"message">>();
  private readonly errorListeners = new Set<FakeWorkerListener<"error">>();
  private readonly exitListeners = new Set<FakeWorkerListener<"exit">>();

  on<K extends FakeWorkerEvent>(event: K, listener: FakeWorkerListener<K>): this {
    this.listenersFor(event).add(listener);
    return this;
  }

  off<K extends FakeWorkerEvent>(event: K, listener: FakeWorkerListener<K>): this {
    this.listenersFor(event).delete(listener);
    return this;
  }

  postMessage(message: WorkerInbound): void {
    this.posted.push(message);
  }

  async terminate(): Promise<number> {
    this.emit("exit", 0);
    return 0;
  }

  emit<K extends FakeWorkerEvent>(event: K, payload: FakeWorkerEventMap[K]): void {
    for (const listener of [...this.listenersFor(event)]) {
      listener(payload);
    }
  }

  listenerCount(event: FakeWorkerEvent): number {
    return this.listenersFor(event).size;
  }

  private listenersFor<K extends FakeWorkerEvent>(event: K): Set<FakeWorkerListener<K>> {
    if (event === "message") {
      return this.messageListeners as Set<FakeWorkerListener<K>>;
    }
    if (event === "error") {
      return this.errorListeners as Set<FakeWorkerListener<K>>;
    }
    return this.exitListeners as Set<FakeWorkerListener<K>>;
  }
}

function createPoolWithWorker(worker: FakeWorker): LlmWorkerPool {
  return new LlmWorkerPool(1, () => worker);
}

describe("LlmWorkerPool", () => {
  it("resolves chat responses and cleans request listeners", async () => {
    const worker = new FakeWorker();
    const pool = createPoolWithWorker(worker);
    await pool.start();
    const baselineExitListeners = worker.listenerCount("exit");

    const promise = pool.chat({ id: "thread-1" }, baseRequest, vi.fn());
    const chat = worker.posted.find((message) => message.type === "chat");
    if (!chat || chat.type !== "chat") throw new Error("Expected chat message.");

    worker.emit("message", {
      kind: "done",
      requestId: chat.requestId,
      response: {
        text: "done",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    } satisfies WorkerOutbound);

    await expect(promise).resolves.toMatchObject({ text: "done" });
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(1);
    expect(worker.listenerCount("exit")).toBe(baselineExitListeners);
  });

  it("rejects in-flight chats when the worker exits before responding", async () => {
    const worker = new FakeWorker();
    const pool = createPoolWithWorker(worker);
    await pool.start();

    const promise = pool.chat({ id: "thread-1" }, baseRequest, vi.fn());
    worker.emit("exit", 9);

    await expect(promise).rejects.toThrow("LLM worker exited before completing request");
    expect(worker.listenerCount("message")).toBe(0);
  });

  it("replaces exited workers and clears stale thread affinity", async () => {
    const firstWorker = new FakeWorker();
    const replacementWorker = new FakeWorker();
    const workers = [firstWorker, replacementWorker];
    const pool = new LlmWorkerPool(1, () => {
      const worker = workers.shift();
      if (!worker) throw new Error("No fake worker available.");
      return worker;
    });
    await pool.start();

    const firstPromise = pool.chat({ id: "thread-1" }, baseRequest, vi.fn());
    firstWorker.emit("exit", 9);
    await expect(firstPromise).rejects.toThrow("LLM worker exited before completing request");

    const secondPromise = pool.chat({ id: "thread-1" }, baseRequest, vi.fn());
    const chat = replacementWorker.posted.find((message) => message.type === "chat");
    if (!chat || chat.type !== "chat") throw new Error("Expected replacement chat message.");

    replacementWorker.emit("message", {
      kind: "done",
      requestId: chat.requestId,
      response: {
        text: "recovered",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    } satisfies WorkerOutbound);

    await expect(secondPromise).resolves.toMatchObject({ text: "recovered" });
    expect(firstWorker.posted).toHaveLength(1);
    expect(replacementWorker.posted).toHaveLength(1);
  });

  it("posts cancel messages for the in-flight thread request", async () => {
    const worker = new FakeWorker();
    const pool = createPoolWithWorker(worker);
    await pool.start();

    const promise = pool.chat({ id: "thread-1" }, baseRequest, vi.fn());
    pool.cancel("thread-1");

    expect(worker.posted.map((message) => message.type)).toEqual(["chat", "cancel"]);

    const chat = worker.posted[0];
    if (chat.type !== "chat") throw new Error("Expected chat message.");
    worker.emit("message", {
      kind: "error",
      requestId: chat.requestId,
      message: "cancelled",
      code: "internal",
    } satisfies WorkerOutbound);

    await expect(promise).rejects.toThrow("cancelled");
  });
});
