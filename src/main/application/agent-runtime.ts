import { randomUUID } from "node:crypto";
import type {
  AgentContentBlock,
  AgentMessage,
  AgentToolDefinition,
  AgentToolResult,
  LlmRequest,
  LlmResponse,
  AgentToolCall,
  LlmStreamChunk,
} from "../domain/agent/types.js";
import type { ToolRegistry } from "../domain/agent/ports.js";
import { JsonlThreadStore } from "../persistence/index.js";
import { AttachmentStore } from "../persistence/attachment-store.js";
import { ModelConfigStore } from "../persistence/model-config-store.js";
import { LlmWorkerPool } from "../infrastructure/llm-worker/worker-pool.js";
import { RuntimeEventBus } from "../event-bus.js";
import type {
  ApprovalItem,
  ApprovalRespondRequest,
  AssistantItem,
  Item,
  ModelConfig,
  ModelConfigProfile,
  ModelConfigProfilesState,
  ReasoningItem,
  SystemItem,
  ThreadRecord,
  ThreadGoal,
  ToolItem,
  TurnRecord,
  TurnStartRequest,
  PlanItem,
  PlanStep,
  UserItem,
} from "../../shared/agent-contracts.js";

interface RuntimeDeps {
  store: JsonlThreadStore;
  attachmentStore: AttachmentStore;
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
  "Use the provided structured tools for workspace inspection; do not write <tool_call>, <tool_result>, or raw tool JSON in assistant text.",
  "Final answers should be clean Markdown meant for the user. Tool calls and tool results are shown by the runtime UI.",
].join(" ");

const PLAN_MODE_INSTRUCTION = [
  "Plan mode is active.",
  "First create a concise plan with the create_plan tool.",
  "Do not perform irreversible work while planning.",
].join(" ");

const GOAL_MODE_INSTRUCTION = [
  "Goal mode is active for this thread.",
  "Keep the thread goal in mind across turns.",
  "Use update_goal when the goal text, completion state, or blocked state changes.",
].join(" ");

const INTERNAL_TOOL_NAMES = new Set(["echo"]);
const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search_files"]);
const MAX_TOOL_ROUNDS = 6;
const CONTEXT_BUDGET_SAFETY_RATIO = 0.95;
const TOOL_RESULT_MAX_LINES = 320;
const TOOL_RESULT_MAX_BYTES = 32 * 1024;
const TIGHT_TOOL_RESULT_MAX_LINES = 120;
const TIGHT_TOOL_RESULT_MAX_BYTES = 8 * 1024;
const TOOL_ARGUMENT_STRING_MAX_BYTES = 8 * 1024;
const TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES = 2 * 1024;
const TOOL_ARGUMENT_ARRAY_MAX_ITEMS = 80;
const TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS = 24;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const MIN_TEXT_COMPACTION_BYTES = 512;
const MAX_PROGRESSIVE_COMPACTION_PASSES = 24;

/**
 * Multi-turn runtime. Holds per-turn state, orchestrates worker pool,
 * enforces tool policy, persists items + events, and emits bus events.
 */
export class AgentRuntime {
  private readonly inFlight = new Map<string, TurnRecord>(); // turnId -> record
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly deps: RuntimeDeps) {}

  isThreadInFlight(threadId: string): boolean {
    return Array.from(this.inFlight.values()).some(
      (turn) => turn.threadId === threadId && turn.status === "in-flight",
    );
  }

  async startTurn(request: TurnStartRequest): Promise<TurnRecord> {
    const thread = await this.deps.store.getThread(request.threadId);
    if (!thread) throw new Error(`Thread ${request.threadId} not found`);
    if (thread.status === "archived") {
      throw new Error("RUNTIME_THREAD_ARCHIVED");
    }

    if (this.isThreadInFlight(request.threadId)) {
      throw new Error("RUNTIME_TURN_BUSY");
    }
    const modelProfiles = await this.deps.modelConfigStore.listProfiles();
    const selectedProfile = this.resolveModelProfile(modelProfiles, request);
    const modelConfig = selectedProfile.config;
    const attachmentIds = request.attachmentIds ?? [];
    const attachments = await this.resolveAttachmentRecords(attachmentIds);

    const turn: TurnRecord = {
      id: randomUUID(),
      threadId: request.threadId,
      status: "in-flight",
      startedAt: new Date().toISOString(),
      model: modelConfig.model,
      reasoningEffort: request.reasoningEffort ?? modelConfig.model_reasoning_effort,
      modelProfileId: selectedProfile.id,
      mode: request.mode ?? "agent",
      goalMode: request.goalMode ?? Boolean(thread.goal && thread.goal.status === "active"),
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
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
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
    void this.runTurn(turn, thread, request.text, attachmentIds, modelConfig);
    return turn;
  }

  async interruptTurn(turnId: string): Promise<void> {
    const turn = this.inFlight.get(turnId);
    if (!turn) return;
    this.resolvePendingApprovalsForTurn(turnId, "deny");
    this.deps.pool.cancel(turn.threadId);
    const item: SystemItem = {
      kind: "system",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      text: "Interrupted by user",
      level: "warn",
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, item);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item,
    });
    await this.markTurnStatus(turn, "interrupted");
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

  async updateThreadGoal(
    threadId: string,
    update: {
      goal?: string | null;
      status?: ThreadGoal["status"];
      summary?: string;
    },
  ): Promise<ThreadRecord> {
    const thread = await this.deps.store.getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const now = new Date().toISOString();
    let nextGoal: ThreadGoal | undefined;
    if (update.goal === null) {
      nextGoal = undefined;
    } else {
      const current = thread.goal;
      const status = update.status ?? current?.status ?? "active";
      const text = update.goal ?? current?.text;
      if (!text?.trim()) {
        throw new Error("Goal text is required.");
      }
      nextGoal = {
        text: text.trim(),
        status,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        ...(status === "complete" ? { completedAt: now } : {}),
        ...(status === "blocked" ? { blockedAt: now } : {}),
        ...(update.summary ? { summary: update.summary } : current?.summary ? { summary: current.summary } : {}),
      };
    }

    const nextThread = await this.deps.store.updateThread(threadId, {
      goal: nextGoal ?? null,
    });
    this.deps.bus.emit("goal_updated", {
      kind: "goal_updated",
      threadId,
      ...(nextGoal ? { goal: nextGoal } : {}),
    });
    return nextThread;
  }

  // --------------------------------------------------------------------------

  private async runTurn(
    turn: TurnRecord,
    thread: ThreadRecord,
    userText: string,
    attachmentIds: string[],
    modelConfig: ModelConfig,
  ): Promise<void> {
    try {
      const history = await this.collectHistory(thread, turn.id);
      const messages: AgentMessage[] = [
        ...history,
        ...this.buildRuntimeContextMessages(turn, thread),
        { role: "user", content: await this.buildUserContent(userText, attachmentIds) },
      ];

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const request = this.buildLlmRequest(turn, thread, messages, modelConfig);
        const streamState: {
          assistantItem: AssistantItem | null;
          reasoningItem: ReasoningItem | null;
        } = {
          assistantItem: null,
          reasoningItem: null,
        };
        let response: LlmResponse;
        try {
          response = await this.deps.pool.chat({ id: thread.id }, request, (chunk) => {
            if (turn.status !== "in-flight") return;
            this.applyStreamChunk(turn, chunk, streamState);
          });
        } catch (error) {
          if (turn.status === "interrupted") {
            await this.persistInterruptedStream(turn, streamState);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.deps.bus.emit("runtime_error", {
            kind: "runtime_error",
            threadId: turn.threadId,
            turnId: turn.id,
            code: "internal",
            message,
          });
          await this.markTurnStatus(turn, "failed");
          return;
        }

        const assistantText = await this.persistModelOutput(turn, response, streamState);
        if (turn.status !== "in-flight") {
          return;
        }
        turn.usage = response.usage ?? turn.usage;

        if (response.toolCalls.length === 0) {
          await this.markTurnStatus(turn, "completed");
          return;
        }

        if (round >= MAX_TOOL_ROUNDS) {
          await this.appendSystemItem(
            turn,
            "Tool call round limit reached before the model produced a final answer.",
            "error",
          );
          await this.markTurnStatus(turn, "failed");
          return;
        }

        messages.push({
          role: "assistant",
          content: assistantText,
          toolCalls: response.toolCalls,
        });

        for (const call of response.toolCalls) {
          const result = await this.executeToolCall(turn, thread, call);
          messages.push({
            role: "tool",
            content: result.content,
            toolCallId: result.toolCallId,
          });
          if (turn.status !== "in-flight") {
            return;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.bus.emit("turn_failed", {
        kind: "turn_failed",
        threadId: turn.threadId,
        turnId: turn.id,
        message,
        failedAt: new Date().toISOString(),
      });
      await this.markTurnStatus(turn, "failed");
    }
  }

  private buildLlmRequest(
    turn: TurnRecord,
    thread: ThreadRecord,
    messages: AgentMessage[],
    modelConfig: ModelConfig,
  ): LlmRequest {
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.listToolDefinitionsForTurn(turn, thread);
    return {
      protocol: "openai-compatible",
      provider: modelConfig.model_provide,
      model: turn.model,
      apiKey: this.resolveApiKey(modelConfig),
      baseUrl: modelConfig.base_url,
      systemPrompt,
      messages: prepareMessagesForRequest(messages, {
        systemPrompt,
        tools,
        tokenLimit: modelConfig.model_auto_compact_token_limit,
      }),
      tools,
      maxTokens: modelConfig.max_tokens,
      temperature: 1,
      thinking: modelConfig.thinking,
      reasoningEffort: turn.reasoningEffort ?? modelConfig.model_reasoning_effort,
    };
  }

  private async persistInterruptedStream(
    turn: TurnRecord,
    streamState: {
      assistantItem: AssistantItem | null;
      reasoningItem: ReasoningItem | null;
    },
  ): Promise<void> {
    if (streamState.reasoningItem?.text.trim()) {
      await this.deps.store.appendItem(turn.threadId, streamState.reasoningItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: streamState.reasoningItem,
      });
    }
    if (streamState.assistantItem?.text.trim()) {
      const interruptedAssistantItem: AssistantItem = {
        ...streamState.assistantItem,
        truncated: true,
      };
      await this.deps.store.appendItem(turn.threadId, interruptedAssistantItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: interruptedAssistantItem,
      });
    }
  }

  private async persistModelOutput(
    turn: TurnRecord,
    response: LlmResponse,
    streamState: {
      assistantItem: AssistantItem | null;
      reasoningItem: ReasoningItem | null;
    },
  ): Promise<string> {
    if (streamState.reasoningItem?.text.trim()) {
      await this.deps.store.appendItem(turn.threadId, streamState.reasoningItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: streamState.reasoningItem,
      });
    } else if (response.reasoning?.trim()) {
      const finalReasoningItem: ReasoningItem = {
        kind: "reasoning",
        id: randomUUID(),
        threadId: turn.threadId,
        turnId: turn.id,
        text: response.reasoning,
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.appendItem(turn.threadId, finalReasoningItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: finalReasoningItem,
      });
    }

    if (streamState.assistantItem?.text.trim()) {
      const finalAssistantItem: AssistantItem = {
        ...streamState.assistantItem,
        ...(turn.status === "interrupted" ? { truncated: true } : {}),
      };
      await this.deps.store.appendItem(turn.threadId, finalAssistantItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: finalAssistantItem,
      });
      return finalAssistantItem.text;
    }

    if (response.text) {
      const finalAssistantItem: AssistantItem = {
        kind: "assistant",
        id: randomUUID(),
        threadId: turn.threadId,
        turnId: turn.id,
        text: response.text,
        ...(turn.status === "interrupted" ? { truncated: true } : {}),
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.appendItem(turn.threadId, finalAssistantItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: finalAssistantItem,
      });
      return finalAssistantItem.text;
    }

    return "";
  }

  private applyStreamChunk(
    turn: TurnRecord,
    chunk: LlmStreamChunk,
    state: {
      assistantItem: AssistantItem | null;
      reasoningItem: ReasoningItem | null;
    },
  ): void {
    if (chunk.kind === "text_delta") {
      const assistantItem =
        state.assistantItem ??
        ({
          kind: "assistant",
          id: randomUUID(),
          threadId: turn.threadId,
          turnId: turn.id,
          text: "",
          createdAt: new Date().toISOString(),
        } satisfies AssistantItem);
      state.assistantItem = assistantItem;
      assistantItem.text += chunk.text;
      this.deps.bus.emit("item_updated", {
        kind: "item_updated",
        threadId: turn.threadId,
        turnId: turn.id,
        item: assistantItem,
      });
      return;
    }

    if (chunk.kind === "reasoning_delta") {
      const reasoningItem =
        state.reasoningItem ??
        ({
          kind: "reasoning",
          id: randomUUID(),
          threadId: turn.threadId,
          turnId: turn.id,
          text: "",
          createdAt: new Date().toISOString(),
        } satisfies ReasoningItem);
      state.reasoningItem = reasoningItem;
      reasoningItem.text += chunk.text;
      this.deps.bus.emit("item_updated", {
        kind: "item_updated",
        threadId: turn.threadId,
        turnId: turn.id,
        item: reasoningItem,
      });
      return;
    }

    if (chunk.kind === "usage") {
      turn.usage = chunk.usage;
    }
  }

  private async executeToolCall(
    turn: TurnRecord,
    thread: ThreadRecord,
    call: AgentToolCall,
  ): Promise<AgentToolResult> {
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

    if (!this.isToolAllowedForTurn(call.name, turn, thread)) {
      toolItem.status = "failed";
      toolItem.result = { message: `Tool "${call.name}" is not available in this turn.` };
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "internal",
        message: `Tool "${call.name}" is not available in this turn.`,
      });
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    // Approval gate: only `auto` policy runs immediately.
    if (this.requiresApproval(call.name, turn, thread)) {
      const approval = await this.requestApproval(turn, call);
      if (approval === "deny") {
        toolItem.status = "failed";
        toolItem.result = { denied: true };
        await this.deps.store.appendItem(turn.threadId, toolItem);
        this.emitToolItemUpdated(turn, toolItem);
        return {
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(toolItem.result),
        };
      }
    }

    try {
      const content = await this.deps.registry.execute(call, {
        threadId: turn.threadId,
        turnId: turn.id,
        workspace: thread.workspace,
      });
      toolItem.status = "completed";
      toolItem.result = content;
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      if (call.name === "create_plan") {
        await this.appendPlanItem(turn, content.content);
      }
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toolItem.status = "failed";
      toolItem.result = {
        message,
      };
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "tool_failed",
        message: `${call.name}: ${message}`,
      });
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }
  }

  private listToolDefinitionsForTurn(
    turn: TurnRecord,
    thread: ThreadRecord,
  ): AgentToolDefinition[] {
    return this.deps.registry
      .listDefinitions()
      .filter((definition) => this.isToolAllowedForTurn(definition.name, turn, thread));
  }

  private isToolAllowedForTurn(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
  ): boolean {
    if (INTERNAL_TOOL_NAMES.has(name)) {
      return false;
    }
    if (name === "create_plan") {
      return turn.mode === "plan";
    }
    if (name === "update_goal") {
      return Boolean(turn.goalMode || thread.goal?.status === "active");
    }
    return true;
  }

  private requiresApproval(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
  ): boolean {
    if (READ_ONLY_TOOL_NAMES.has(name)) {
      return false;
    }
    return !(
      (name === "create_plan" || name === "update_goal") &&
      this.isToolAllowedForTurn(name, turn, thread)
    );
  }

  private emitToolItemUpdated(turn: TurnRecord, item: ToolItem): void {
    this.deps.bus.emit("item_updated", {
      kind: "item_updated",
      threadId: turn.threadId,
      turnId: turn.id,
      item,
    });
  }

  private async requestApproval(
    turn: TurnRecord,
    call: AgentToolCall,
  ): Promise<"allow" | "deny"> {
    const approvalId = randomUUID();
    const pendingItem: ApprovalItem = {
      kind: "approval",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      approvalId,
      toolName: call.name,
      args: call.arguments,
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, pendingItem);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item: pendingItem,
    });

    return new Promise<"allow" | "deny">((resolve) => {
      this.pendingApprovals.set(approvalId, {
        approvalId,
        threadId: turn.threadId,
        turnId: turn.id,
        toolName: call.name,
        args: call.arguments,
        resolve: (decision) => {
          const item: ApprovalItem = {
            ...pendingItem,
            kind: "approval",
            decision,
            resolvedAt: new Date().toISOString(),
          };
          void this.deps.store.appendItem(turn.threadId, item);
          this.deps.bus.emit("item_updated", {
            kind: "item_updated",
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

  private resolvePendingApprovalsForTurn(
    turnId: string,
    decision: "allow" | "deny",
  ): void {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.turnId !== turnId) continue;
      pending.resolve(decision);
      this.pendingApprovals.delete(approvalId);
    }
  }

  private async collectHistory(
    thread: ThreadRecord,
    excludeTurnId?: string,
  ): Promise<AgentMessage[]> {
    const out: AgentMessage[] = [];
    const items: Item[] = [];
    const itemIndexById = new Map<string, number>();
    for await (const item of this.deps.store.replayItems(thread.id)) {
      if ("turnId" in item && item.turnId === excludeTurnId) {
        continue;
      }
      const existingIndex = itemIndexById.get(item.id);
      if (existingIndex === undefined) {
        itemIndexById.set(item.id, items.length);
        items.push(item);
      } else {
        items[existingIndex] = item;
      }
    }

    for (const item of items) {
      if (item.kind === "user") {
        out.push({
          role: "user",
          content: await this.buildUserContent(item.text, item.attachmentIds ?? []),
        });
      } else if (item.kind === "assistant") {
        out.push({ role: "assistant", content: item.text });
      } else if (item.kind === "tool") {
        if (item.status !== "completed" && item.status !== "failed") {
          continue;
        }
        out.push({
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: item.toolCallId,
              name: item.name,
              arguments: item.args,
            },
          ],
        });
        out.push({
          role: "tool",
          content:
            typeof item.result === "object" && item.result && "content" in item.result
              ? String((item.result as { content: unknown }).content)
              : stableStringify(item.result ?? null),
          toolCallId: item.toolCallId,
        });
      }
    }
    return out;
  }

  private async appendSystemItem(
    turn: TurnRecord,
    text: string,
    level: SystemItem["level"],
  ): Promise<void> {
    const item: SystemItem = {
      kind: "system",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      text,
      level,
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, item);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item,
    });
  }

  private resolveModelProfile(
    state: ModelConfigProfilesState,
    request: TurnStartRequest,
  ): ModelConfigProfile {
    const profiles = state.profiles;
    if (request.modelProfileId) {
      const selected = profiles.find((profile) => profile.id === request.modelProfileId);
      if (!selected) {
        throw new Error(`Model config profile ${request.modelProfileId} not found.`);
      }
      return selected;
    }

    const selected = request.model
      ? profiles.find((profile) => profile.config.model === request.model)
      : profiles.find((profile) => profile.id === state.activeProfileId);
    if (selected) return selected;

    const active = profiles.find((profile) => profile.id === state.activeProfileId);
    if (active) return active;

    const fallback = profiles[0];
    if (!fallback) {
      throw new Error("No model config profile is available.");
    }
    return fallback;
  }

  private async resolveAttachmentRecords(
    attachmentIds: string[],
  ): Promise<NonNullable<UserItem["attachments"]>> {
    const attachments: NonNullable<UserItem["attachments"]> = [];
    for (const id of attachmentIds) {
      const attachment = await this.deps.attachmentStore.get(id);
      if (!attachment) {
        throw new Error(`Attachment ${id} not found.`);
      }
      const { dataBase64: _dataBase64, ...record } = attachment;
      void _dataBase64;
      attachments.push(record);
    }
    return attachments;
  }

  private async buildUserContent(
    text: string,
    attachmentIds: string[],
  ): Promise<string | AgentContentBlock[]> {
    if (attachmentIds.length === 0) return text;
    const blocks: AgentContentBlock[] = [{ type: "text", text }];
    for (const id of attachmentIds) {
      const attachment = await this.deps.attachmentStore.get(id);
      if (!attachment) {
        throw new Error(`Attachment ${id} not found.`);
      }
      blocks.push({
        type: "image",
        mimeType: attachment.mimeType,
        dataBase64: attachment.dataBase64,
      });
    }
    return blocks;
  }

  private buildSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  private buildRuntimeContextMessages(turn: TurnRecord, thread: ThreadRecord): AgentMessage[] {
    const parts: string[] = [];
    if (turn.mode === "plan") {
      parts.push(PLAN_MODE_INSTRUCTION);
    }
    if (turn.goalMode || thread.goal?.status === "active") {
      parts.push(GOAL_MODE_INSTRUCTION);
      if (thread.goal) {
        parts.push(`Current thread goal: ${thread.goal.text}`);
      }
    }
    if (parts.length === 0) return [];
    return [{ role: "system", content: parts.join("\n\n") }];
  }

  private async appendPlanItem(turn: TurnRecord, rawContent: string): Promise<void> {
    const parsed = parsePlanToolContent(rawContent);
    const item: PlanItem = {
      kind: "plan",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      ...(parsed.title ? { title: parsed.title } : {}),
      steps: parsed.steps,
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, item);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item,
    });
  }

  private resolveApiKey(config: ModelConfig): string {
    if (config.OPENAI_API_KEY) {
      return config.OPENAI_API_KEY;
    }
    const provider = config.model_provide.trim().toLowerCase();
    if (provider === "deepseek") {
      return process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
    }
    if (provider === "minimax") {
      return process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || "";
    }
    return process.env.OPENAI_API_KEY || "";
  }

  private async markTurnStatus(
    turn: TurnRecord,
    status: TurnRecord["status"],
  ): Promise<void> {
    turn.status = status;
    turn.completedAt = new Date().toISOString();
    const event = {
      kind: "turn_completed",
      threadId: turn.threadId,
      turnId: turn.id,
      status,
      completedAt: turn.completedAt,
      ...(turn.usage ? { usage: turn.usage } : {}),
    } as const;
    try {
      await this.deps.store.appendEvent(turn.threadId, event);
    } catch (error) {
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "persistence_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.deps.bus.emit("turn_completed", event);
    this.inFlight.delete(turn.id);
  }
}

function parsePlanToolContent(rawContent: string): { title?: string; steps: PlanStep[] } {
  const parsed = JSON.parse(rawContent) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("create_plan returned invalid JSON.");
  }
  const value = parsed as { title?: unknown; steps?: unknown };
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("create_plan returned no steps.");
  }
  return {
    ...(typeof value.title === "string" && value.title.trim()
      ? { title: value.title.trim() }
      : {}),
    steps: value.steps.map((step, index) => parsePlanStep(step, index)),
  };
}

function parsePlanStep(value: unknown, index: number): PlanStep {
  if (!value || typeof value !== "object") {
    throw new Error(`Plan step ${index + 1} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new Error(`Plan step ${index + 1} requires title.`);
  }
  const status =
    raw.status === "in_progress" || raw.status === "completed" || raw.status === "pending"
      ? raw.status
      : "pending";
  return {
    id: randomUUID(),
    title: raw.title.trim(),
    status,
  };
}

function prepareMessagesForRequest(
  messages: AgentMessage[],
  options: {
    systemPrompt: string;
    tools: AgentToolDefinition[];
    tokenLimit: number;
  },
): AgentMessage[] {
  const hygienic = applyRequestHistoryHygiene(messages);
  if (estimateRequestTokens(options.systemPrompt, hygienic, options.tools) <= options.tokenLimit) {
    return hygienic;
  }
  return trimOldestDynamicMessages(hygienic, options);
}

function applyRequestHistoryHygiene(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const completedToolCallIds = new Set(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => message.toolCallId as string),
  );
  const next = messages.map((message) => {
    if (message.role === "tool") {
      const content = compactToolResultContent(message.content);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      let toolCallsChanged = false;
      const toolCalls = message.toolCalls.map((call) => {
        if (!completedToolCallIds.has(call.id)) return call;
        const compactedArguments = compactToolArguments(call.arguments);
        if (compactedArguments === call.arguments) return call;
        changed = true;
        toolCallsChanged = true;
        return { ...call, arguments: compactedArguments };
      });
      return toolCallsChanged ? { ...message, toolCalls } : message;
    }

    return message;
  });
  return changed ? next : messages;
}

function trimOldestDynamicMessages(
  messages: AgentMessage[],
  options: {
    systemPrompt: string;
    tools: AgentToolDefinition[];
    tokenLimit: number;
  },
): AgentMessage[] {
  const segments = segmentMessagesForTrimming(messages);
  const lastUserSegmentIndex = findLastSegmentIndex(
    segments,
    (segment) => segment.some((message) => message.role === "user"),
  );
  const mandatoryStartIndex =
    lastUserSegmentIndex >= 0 ? lastUserSegmentIndex : Math.max(0, segments.length - 1);
  const keep = flattenSegments(segments.slice(mandatoryStartIndex));

  for (let index = mandatoryStartIndex - 1; index >= 0; index -= 1) {
    const candidate = [...segments[index], ...keep];
    if (estimateRequestTokens(options.systemPrompt, candidate, options.tools) > options.tokenLimit) {
      break;
    }
    keep.unshift(...segments[index]);
  }
  return keep.length > 0 ? keep : messages.slice(-1);
}

function segmentMessagesForTrimming(messages: AgentMessage[]): AgentMessage[][] {
  const segments: AgentMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "system") {
      const segment = [message];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role === "system") {
        segment.push(messages[cursor]);
        cursor += 1;
      }
      if (cursor < messages.length && messages[cursor].role === "user") {
        segment.push(messages[cursor]);
        segments.push(segment);
        index = cursor;
        continue;
      }
      segments.push(segment);
      index = cursor - 1;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      segments.push([message]);
      continue;
    }

    const expectedToolCallIds = new Set(message.toolCalls.map((call) => call.id));
    const segment = [message];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (candidate.role !== "tool" || !candidate.toolCallId || !expectedToolCallIds.has(candidate.toolCallId)) {
        break;
      }
      segment.push(candidate);
      cursor += 1;
    }
    segments.push(segment);
    index = cursor - 1;
  }
  return segments;
}

function findLastSegmentIndex(
  segments: AgentMessage[][],
  predicate: (segment: AgentMessage[]) => boolean,
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (predicate(segments[index])) return index;
  }
  return -1;
}

function flattenSegments(segments: AgentMessage[][]): AgentMessage[] {
  return segments.flatMap((segment) => segment);
}

function compactToolResultContent(content: AgentMessage["content"]): AgentMessage["content"] {
  if (typeof content === "string") {
    return compactToolResultText(content);
  }
  let changed = false;
  const blocks = content.map((block) => {
    if (block.type === "text") {
      const text = compactToolResultText(block.text);
      if (text !== block.text) changed = true;
      return { ...block, text };
    }
    changed = true;
    return {
      type: "text" as const,
      text: `[cache hygiene: omitted ${block.mimeType} attachment from historical tool result]`,
    };
  });
  return changed ? blocks : content;
}

function compactToolResultText(text: string): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  if (originalBytes <= TOOL_RESULT_MAX_BYTES && lines.length <= TOOL_RESULT_MAX_LINES) {
    return text;
  }

  const headCount = Math.min(80, Math.max(1, Math.floor(TOOL_RESULT_MAX_LINES * 0.25)));
  const tailCount = Math.min(120, Math.max(1, Math.floor(TOOL_RESULT_MAX_LINES * 0.35)));
  const signalLines = lines
    .slice(headCount, Math.max(headCount, lines.length - tailCount))
    .filter((line) => /\b(error|failed?|fatal|exception|warning|denied|timeout|not found|invalid)\b/i.test(line))
    .slice(0, Math.max(0, TOOL_RESULT_MAX_LINES - headCount - tailCount));
  const selected = [
    ...lines.slice(0, headCount),
    ...signalLines,
    ...lines.slice(Math.max(headCount, lines.length - tailCount)),
  ];
  const fitted = fitLinesToBytes(selected, TOOL_RESULT_MAX_BYTES);
  const omittedLines = Math.max(0, lines.length - fitted.length);
  const marker = `[cache hygiene: omitted ${omittedLines} historical tool result line(s); narrow the next read/search for details]`;
  return [...fitted, marker].join("\n");
}

function compactToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const compacted = compactArgumentValue(key, value);
    out[key] = compacted.value;
    changed ||= compacted.changed;
  }
  return changed ? out : args;
}

function compactArgumentValue(key: string, value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (isBase64Like(key, value)) {
      return {
        value: `[cache hygiene: omitted base64 argument, ${Buffer.byteLength(value, "utf8")} bytes]`,
        changed: true,
      };
    }
    if (Buffer.byteLength(value, "utf8") > TOOL_ARGUMENT_STRING_MAX_BYTES) {
      return {
        value: `${value.slice(0, 800)}\n[cache hygiene: omitted long argument tail]`,
        changed: true,
      };
    }
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const selected =
      value.length > TOOL_ARGUMENT_ARRAY_MAX_ITEMS
        ? [
            ...value.slice(0, Math.floor(TOOL_ARGUMENT_ARRAY_MAX_ITEMS * 0.75)),
            { cache_hygiene_omitted_items: value.length - TOOL_ARGUMENT_ARRAY_MAX_ITEMS },
            ...value.slice(-(TOOL_ARGUMENT_ARRAY_MAX_ITEMS - Math.floor(TOOL_ARGUMENT_ARRAY_MAX_ITEMS * 0.75))),
          ]
        : value;
    changed ||= selected !== value;
    const compacted = selected.map((item) => {
      const child = compactArgumentValue(key, item);
      changed ||= child.changed;
      return child.value;
    });
    return changed ? { value: compacted, changed: true } : { value, changed: false };
  }

  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    const child = compactArgumentValue(childKey, childValue);
    out[childKey] = child.value;
    changed ||= child.changed;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

function fitLinesToBytes(lines: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const nextBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + nextBytes > maxBytes) break;
    out.push(line);
    bytes += nextBytes;
  }
  return out;
}

function estimateRequestTokens(
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): number {
  return estimateTokens(
    JSON.stringify({
      systemPrompt,
      messages,
      tools,
    }),
  );
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

function isBase64Like(key: string, value: string): boolean {
  return (
    /(?:^|_)(?:data_)?base64$/i.test(key) ||
    /^data:[^;,]+;base64,/i.test(value)
  );
}
