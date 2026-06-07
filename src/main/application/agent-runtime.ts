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
    return {
      protocol: "openai-compatible",
      provider: modelConfig.model_provide,
      model: turn.model,
      apiKey: this.resolveApiKey(modelConfig),
      baseUrl: modelConfig.base_url,
      systemPrompt: this.buildSystemPrompt(turn, thread),
      messages,
      tools: this.listToolDefinitionsForTurn(turn, thread),
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
              : JSON.stringify(item.result ?? null),
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

  private buildSystemPrompt(turn: TurnRecord, thread: ThreadRecord): string {
    const parts = [SYSTEM_PROMPT];
    if (turn.mode === "plan") {
      parts.push(PLAN_MODE_INSTRUCTION);
    }
    if (turn.goalMode || thread.goal?.status === "active") {
      parts.push(GOAL_MODE_INSTRUCTION);
      if (thread.goal) {
        parts.push(`Current thread goal: ${thread.goal.text}`);
      }
    }
    return parts.join("\n\n");
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
