import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  LlmRequest,
  LlmResponse,
  AgentToolCall,
} from "../domain/agent/types.js";
import type { ToolRegistry } from "../domain/agent/ports.js";
import { JsonlThreadStore } from "../persistence/index.js";
import { ModelConfigStore } from "../persistence/model-config-store.js";
import { LlmWorkerPool } from "../infrastructure/llm-worker/worker-pool.js";
import { RuntimeEventBus } from "../event-bus.js";
import type {
  ApprovalItem,
  ApprovalRespondRequest,
  AssistantItem,
  Item,
  ModelConfig,
  ThreadRecord,
  ToolItem,
  TurnRecord,
  TurnStartRequest,
  UserItem,
} from "../../shared/agent-contracts.js";

interface RuntimeDeps {
  store: JsonlThreadStore;
  modelConfigStore: ModelConfigStore;
  pool: LlmWorkerPool;
  bus: RuntimeEventBus;
  registry: ToolRegistry;
}

interface PendingApproval {
  approvalId: string;
  threadId: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (decision: "allow" | "deny") => void;
}

const SYSTEM_PROMPT = [
  "You are the runtime assistant in the Agent Pyramid desktop app.",
  "Stay concise, explain actions, and only call tools when needed.",
].join(" ");

/**
 * Multi-turn runtime. Holds per-turn state, orchestrates worker pool,
 * enforces tool policy, persists items + events, and emits bus events.
 */
export class AgentRuntime {
  private readonly inFlight = new Map<string, TurnRecord>(); // turnId -> record
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly deps: RuntimeDeps) {}

  async startTurn(request: TurnStartRequest): Promise<TurnRecord> {
    const thread = await this.deps.store.getThread(request.threadId);
    if (!thread) throw new Error(`Thread ${request.threadId} not found`);

    const busy = Array.from(this.inFlight.values()).some(
      (t) => t.threadId === request.threadId && t.status === "in-flight",
    );
    if (busy) {
      throw new Error("RUNTIME_TURN_BUSY");
    }
    const modelConfig = await this.deps.modelConfigStore.get();

    const turn: TurnRecord = {
      id: randomUUID(),
      threadId: request.threadId,
      status: "in-flight",
      startedAt: new Date().toISOString(),
      model: request.model ?? modelConfig.model,
      reasoningEffort: request.reasoningEffort ?? modelConfig.model_reasoning_effort,
    };
    this.inFlight.set(turn.id, turn);

    // Append the user item first.
    const userItem: UserItem = {
      kind: "user",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      text: request.text,
      ...(request.displayText ? { displayText: request.displayText } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, userItem);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item: userItem,
    });
    this.deps.bus.emit("turn_started", {
      kind: "turn_started",
      threadId: turn.threadId,
      turnId: turn.id,
      startedAt: turn.startedAt,
    });

    // Run the loop in the background; return the turn record immediately.
    void this.runTurn(turn, thread, request.text, modelConfig);
    return turn;
  }

  async interruptTurn(turnId: string): Promise<void> {
    const turn = this.inFlight.get(turnId);
    if (!turn) return;
    this.deps.pool.cancel(turn.threadId);
    this.markTurnStatus(turn, "interrupted");
  }

  resumeThread(threadId: string): Promise<ThreadRecord | null> {
    return this.deps.store.getThread(threadId);
  }

  respondApproval(approval: ApprovalRespondRequest): void {
    const pending = this.pendingApprovals.get(approval.approvalId);
    if (!pending) return;
    pending.resolve(approval.decision);
    this.pendingApprovals.delete(approval.approvalId);
  }

  // --------------------------------------------------------------------------

  private async runTurn(
    turn: TurnRecord,
    thread: ThreadRecord,
    userText: string,
    modelConfig: ModelConfig,
  ): Promise<void> {
    try {
      const history = await this.collectHistory(thread);
      const messages: AgentMessage[] = [
        ...history,
        { role: "user", content: userText },
      ];

      const request: LlmRequest = {
        protocol: "openai-compatible",
        model: turn.model,
        apiKey: this.resolveApiKey(modelConfig),
        baseUrl: modelConfig.base_url,
        systemPrompt: SYSTEM_PROMPT,
        messages,
        tools: this.deps.registry.listDefinitions(),
        maxTokens: modelConfig.max_tokens,
        temperature: 1,
        thinking: modelConfig.thinking,
      };

      let response: LlmResponse;
      let assistantText = "";
      try {
        response = await this.deps.pool.chat({ id: thread.id }, request, (chunk) => {
          assistantText += chunk;
          // We persist the full text on completion; no per-delta item.
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.bus.emit("runtime_error", {
          kind: "runtime_error",
          threadId: turn.threadId,
          turnId: turn.id,
          code: "internal",
          message,
        });
        this.markTurnStatus(turn, "failed");
        return;
      }

      if (response.text) {
        const assistantItem: AssistantItem = {
          kind: "assistant",
          id: randomUUID(),
          threadId: turn.threadId,
          turnId: turn.id,
          text: response.text,
          ...(turn.status === "interrupted" ? { truncated: true } : {}),
          createdAt: new Date().toISOString(),
        };
        await this.deps.store.appendItem(turn.threadId, assistantItem);
        this.deps.bus.emit("item_appended", {
          kind: "item_appended",
          threadId: turn.threadId,
          turnId: turn.id,
          item: assistantItem,
        });
      }

      // Execute tool calls. Each policy is consulted.
      for (const call of response.toolCalls) {
        await this.executeToolCall(turn, call);
      }

      turn.usage = response.usage;
      this.markTurnStatus(turn, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.bus.emit("turn_failed", {
        kind: "turn_failed",
        threadId: turn.threadId,
        turnId: turn.id,
        message,
        failedAt: new Date().toISOString(),
      });
      this.markTurnStatus(turn, "failed");
    }
  }

  private async executeToolCall(turn: TurnRecord, call: AgentToolCall): Promise<void> {
    const toolItem: ToolItem = {
      kind: "tool",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      toolCallId: call.id,
      name: call.name,
      args: call.arguments,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, toolItem);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item: toolItem,
    });

    // Approval gate: only `auto` policy runs immediately.
    if (turn && this.requiresApproval(call.name, turn)) {
      const approval = await this.requestApproval(turn, call);
      if (approval === "deny") {
        toolItem.status = "failed";
        toolItem.result = { denied: true };
        await this.deps.store.appendItem(turn.threadId, toolItem);
        return;
      }
    }

    try {
      const content = await this.deps.registry.execute(call);
      toolItem.status = "completed";
      toolItem.result = { content };
      await this.deps.store.appendItem(turn.threadId, toolItem);
    } catch (error) {
      toolItem.status = "failed";
      toolItem.result = {
        message: error instanceof Error ? error.message : String(error),
      };
      await this.deps.store.appendItem(turn.threadId, toolItem);
    }
  }

  private requiresApproval(_name: string, _turn: TurnRecord): boolean {
    // For the initial implementation, every tool call asks for approval.
    // A future enhancement can map tool name -> policy.
    return true;
  }

  private requestApproval(
    turn: TurnRecord,
    call: AgentToolCall,
  ): Promise<"allow" | "deny"> {
    const approvalId = randomUUID();
    return new Promise<"allow" | "deny">((resolve) => {
      this.pendingApprovals.set(approvalId, {
        approvalId,
        threadId: turn.threadId,
        turnId: turn.id,
        toolName: call.name,
        args: call.arguments,
        resolve: (decision) => {
          const item: ApprovalItem = {
            kind: "approval",
            id: randomUUID(),
            threadId: turn.threadId,
            turnId: turn.id,
            approvalId,
            toolName: call.name,
            args: call.arguments,
            decision,
            resolvedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          };
          void this.deps.store.appendItem(turn.threadId, item);
          this.deps.bus.emit("item_appended", {
            kind: "item_appended",
            threadId: turn.threadId,
            turnId: turn.id,
            item,
          });
          resolve(decision);
        },
      });
      this.deps.bus.emit("approval_requested", {
        kind: "approval_requested",
        threadId: turn.threadId,
        turnId: turn.id,
        approvalId,
        toolName: call.name,
        args: call.arguments,
      });
    });
  }

  private async collectHistory(thread: ThreadRecord): Promise<AgentMessage[]> {
    const out: AgentMessage[] = [];
    for await (const item of this.deps.store.replayItems(thread.id)) {
      if (item.kind === "user") {
        out.push({ role: "user", content: item.text });
      } else if (item.kind === "assistant") {
        out.push({ role: "assistant", content: item.text });
      } else if (item.kind === "tool") {
        out.push({
          role: "tool",
          content:
            typeof item.result === "object" && item.result && "content" in item.result
              ? String((item.result as { content: unknown }).content)
              : JSON.stringify(item.result ?? null),
          toolCallId: item.toolCallId,
        });
      }
    }
    return out;
  }

  private resolveApiKey(config: ModelConfig): string {
    return config.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || "";
  }

  private markTurnStatus(turn: TurnRecord, status: TurnRecord["status"]): void {
    turn.status = status;
    turn.completedAt = new Date().toISOString();
    this.deps.bus.emit("turn_completed", {
      kind: "turn_completed",
      threadId: turn.threadId,
      turnId: turn.id,
      status,
      completedAt: turn.completedAt,
    });
    this.inFlight.delete(turn.id);
  }
}
