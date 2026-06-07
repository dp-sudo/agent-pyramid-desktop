import { randomUUID } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentStageEvent,
} from "../../shared/agent-contracts.js";
import { AgentRuntime } from "./agent-runtime.js";
import { JsonlThreadStore } from "../persistence/index.js";
import { RuntimeEventBus } from "../event-bus.js";
import { LlmWorkerPool } from "../infrastructure/llm-worker/worker-pool.js";
import type { LlmResponse } from "../domain/agent/types.js";

/**
 * Wraps the new AgentRuntime in the old single-run shape, so existing
 * callers (and the legacy `agentApi.run` IPC channel) keep working.
 */
export class LegacyRunAdapter {
  private readonly trace: AgentStageEvent[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly store: JsonlThreadStore,
    private readonly bus: RuntimeEventBus,
    private readonly pool: LlmWorkerPool,
  ) {}

  async runOnce(request: AgentRunRequest): Promise<AgentRunResponse> {
    const thread = await this.store.createThread({
      title: request.goal.slice(0, 60),
      workspace: "",
      mode: "code",
    });

    this.unsubscribe = this.bus.onThread(thread.id, (event) => {
      if (event.kind === "turn_completed" || event.kind === "turn_failed") {
        this.recordStage("act", "Run finalized", JSON.stringify(event));
      } else if (event.kind === "item_appended") {
        const item = event.item;
        if (item.kind === "assistant") {
          this.lastAssistantText = item.text;
        }
      }
    });

    // Inject the API key into the env so the runtime can read it.
    process.env.MINIMAX_API_KEY = request.apiKey;

    this.recordStage("observe", "Task observed", request.goal);
    const turn = await this.runtime.startTurn({
      threadId: thread.id,
      text: request.goal,
      model: request.model,
    });

    // Wait for completion. The runtime emits turn_completed when done.
    const completion = await this.waitForTurn(turn.id);

    this.unsubscribe?.();
    this.unsubscribe = null;

    return {
      status: completion.status === "completed" ? "completed" : "failed",
      output: this.lastAssistantText ?? "",
      trace: this.trace,
      ...(this.lastUsage
        ? {
            usage: {
              inputTokens: this.lastUsage.inputTokens,
              outputTokens: this.lastUsage.outputTokens,
              totalTokens: this.lastUsage.totalTokens,
            },
          }
        : {}),
    };
  }

  private lastAssistantText = "";
  private lastUsage: LlmResponse["usage"] | null = null;
  private completionDeferred: {
    resolve: (turn: { status: string }) => void;
    reject: (error: Error) => void;
  } | null = null;

  private waitForTurn(turnId: string): Promise<{ status: string }> {
    return new Promise((resolve, reject) => {
      const off = this.bus.onKind("turn_completed", (event) => {
        if (event.kind === "turn_completed" && event.turnId === turnId) {
          off();
          resolve({ status: event.status });
        }
      });
      const offFail = this.bus.onKind("turn_failed", (event) => {
        if (event.kind === "turn_failed" && event.turnId === turnId) {
          offFail();
          reject(new Error(event.message));
        }
      });
      // Safety timeout: 5 minutes.
      setTimeout(() => {
        off();
        offFail();
        resolve({ status: "failed" });
      }, 5 * 60 * 1000).unref();
    });
  }

  private recordStage(
    stage: AgentStageEvent["stage"],
    title: string,
    detail: string,
  ): void {
    this.trace.push({
      stage,
      title,
      detail,
      timestamp: new Date().toISOString(),
    });
  }
}

void randomUUID; // import retained for future adapter use
