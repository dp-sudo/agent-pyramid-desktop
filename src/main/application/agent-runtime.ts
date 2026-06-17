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
import { RuntimePreferencesStore } from "../persistence/runtime-preferences-store.js";
import { CheckpointStore } from "../persistence/checkpoint-store.js";
import { LlmWorkerPool, isLlmWorkerError } from "../infrastructure/llm-worker/worker-pool.js";
import { RuntimeEventBus } from "../event-bus.js";
import type { SkillService } from "../skills/skill-service.js";
import { FileReadStateStore } from "./tools/file-read-state.js";
import { FileHistoryStore } from "./tools/file-history-state.js";
import {
  AGENT_AUTONOMY_TOOL_ROUNDS,
  DEFAULT_AGENT_AUTONOMY,
  MAX_MAX_TOOL_ROUNDS,
  MIN_MAX_TOOL_ROUNDS,
  TOOL_BUDGET_CONTINUATION_MESSAGE,
  TOOL_ROUND_WARNING_THRESHOLD,
} from "./constants.js";
import { prepareMessagesForRequest } from "./context-compaction.js";
import { ToolCatalogService } from "./tool-catalog.js";
import type { ToolAccessPolicy } from "./tool-catalog.js";
import { ToolCallExecutor } from "./tool-call-executor.js";
import {
  normalizeTurnStartRequest,
  type NormalizedTurnStartRequest,
} from "./turn-start-request.js";
import { parsePlanToolContent } from "./plan-item-parser.js";
import {
  normalizeThreadGoalUpdate,
  type ThreadGoalUpdate,
} from "./thread-goal-update.js";
import {
  buildTurnCompletionEvidenceText,
  type CompletionEvidenceCheckpointState,
} from "./completion-evidence.js";
import {
  appendItemAndBroadcast,
  persistEventOrReportError,
} from "./runtime-event-persist.js";
import type {
  ApprovalRespondRequest,
  ApprovalRespondResponse,
  AssistantItem,
  AttachmentRecord,
  Item,
  ModelConfig,
  ModelConfigProfile,
  ModelConfigProfilesState,
  ReasoningItem,
  SystemItem,
  ThreadRecord,
  ThreadGoal,
  ToolFailureResult,
  ToolItem,
  TurnRecord,
  TurnStartRequest,
  PlanItem,
  RuntimePreferences,
  RuntimeErrorEvent,
  RuntimePermissionRule,
  TerminalTurnStatus,
  UserItem,
} from "../../shared/agent-contracts.js";
import { normalizeSkillId, type Skill, type SkillTurnResolution } from "../../shared/skills/index.js";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  isModelReasoningEffort,
} from "../../shared/agent-contracts.js";

export {
  CODE_ONLY_TOOL_NAMES,
  COMMAND_TOOL_NAMES,
  createToolAccessPolicy,
  isCodeOnlyToolName,
} from "./tool-catalog.js";
export type {
  ToolAccessDecision,
  ToolAccessPolicy,
  ToolAccessPolicyConfig,
  ToolAccessPolicyInput,
} from "./tool-catalog.js";

interface RuntimeDeps {
  store: JsonlThreadStore;
  attachmentStore: AttachmentStore;
  modelConfigStore: ModelConfigStore;
  runtimePreferencesStore?: RuntimePreferencesStore;
  checkpointStore?: CheckpointStore;
  pool: LlmWorkerPool;
  bus: RuntimeEventBus;
  registry: ToolRegistry;
  skillService?: SkillService;
  toolAccessPolicy?: ToolAccessPolicy;
}

const SYSTEM_PROMPT = [
  "You are the runtime assistant in the Agent Pyramid desktop app.",
  "Stay concise, explain actions, and only call tools when needed.",
  "Use the provided structured tools for workspace inspection; do not write <tool_call>, <tool_result>, or raw tool JSON in assistant text.",
  "For repository exploration, prefer list_files, read_file, search_files, and rg_search before shell commands.",
  "Before a code change touches multiple files through separate edit/write/delete calls, create a visible coordination plan with create_edit_plan; a single apply_patch can still carry one coordinated patch.",
  "Before using shell-specific syntax, confirm the host shell with detect_shell_environment or choose the matching command tool.",
  "On Windows, run_command uses cmd.exe syntax by default; use powershell_command for PowerShell syntax, and only use POSIX shell syntax after confirming Bash or WSL is available.",
  "If a shell command fails because of shell syntax or executable availability, switch to structured workspace tools or detect_shell_environment instead of retrying unrelated shells.",
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

/**
 * Multi-turn runtime. Holds per-turn state, orchestrates worker pool,
 * enforces tool policy, persists items + events, and emits bus events.
 */
export class AgentRuntime {
  private readonly inFlight = new Map<string, TurnRecord>(); // turnId -> record
  private readonly startingThreadIds = new Set<string>();
  private readonly readState = new FileReadStateStore();
  private readonly fileHistory = new FileHistoryStore();
  private readonly toolCatalog: ToolCatalogService;
  private readonly toolExecutor: ToolCallExecutor;

  constructor(private readonly deps: RuntimeDeps) {
    this.toolCatalog = new ToolCatalogService({
      registry: deps.registry,
      ...(deps.toolAccessPolicy ? { toolAccessPolicy: deps.toolAccessPolicy } : {}),
    });
    this.toolExecutor = new ToolCallExecutor({
      store: deps.store,
      ...(deps.checkpointStore ? { checkpointStore: deps.checkpointStore } : {}),
      bus: deps.bus,
      registry: deps.registry,
      toolCatalog: this.toolCatalog,
      readState: this.readState,
      fileHistory: this.fileHistory,
      executeSubagentSkillCall: (turn, thread, call, runtimePreferences, modelConfig, signal) =>
        this.executeSubagentSkillCall(
          turn,
          thread,
          call,
          runtimePreferences,
          modelConfig,
          signal,
        ),
      appendPlanItem: (turn, rawContent) => this.appendPlanItem(turn, rawContent),
      reportRuntimeError: (turn, code, message, error) =>
        this.reportRuntimeError(turn, code, message, error),
      persistApprovalPermissionRule: (rule) => this.persistApprovalPermissionRule(rule),
    });
  }

  /**
   * Emit a runtime_error event while also logging the raw error (with stack)
   * to the main console. Without the console.error the original stack trace is
   * lost — runtime_error only carries message/code, making failures untraceable.
   */
  private reportRuntimeError(
    turn: { threadId: string; id: string } | undefined,
    code: RuntimeErrorEvent["code"],
    message: string,
    error?: unknown,
  ): void {
    console.error(`[runtime] ${code}:`, error ?? message);
    this.deps.bus.emit("runtime_error", {
      kind: "runtime_error",
      threadId: turn?.threadId,
      turnId: turn?.id,
      code,
      message,
    });
  }

  isThreadInFlight(threadId: string): boolean {
    if (this.startingThreadIds.has(threadId)) return true;
    return Array.from(this.inFlight.values()).some(
      (turn) => turn.threadId === threadId,
    );
  }

  async startTurn(request: TurnStartRequest): Promise<TurnRecord> {
    const normalizedRequest = normalizeTurnStartRequest(request);
    if (this.isThreadInFlight(normalizedRequest.threadId)) {
      throw new Error("RUNTIME_TURN_BUSY");
    }
    this.startingThreadIds.add(normalizedRequest.threadId);
    let turnStarted = false;
    try {
      const turn = await this.prepareTurnStart(normalizedRequest);
      turnStarted = true;
      return turn;
    } finally {
      if (!turnStarted) {
        this.startingThreadIds.delete(normalizedRequest.threadId);
      }
    }
  }

  private async prepareTurnStart(
    normalizedRequest: NormalizedTurnStartRequest,
  ): Promise<TurnRecord> {
    const thread = await this.deps.store.getThread(normalizedRequest.threadId);
    if (!thread) throw new Error(`Thread ${normalizedRequest.threadId} not found`);
    if (thread.status === "archived") {
      throw new Error("RUNTIME_THREAD_ARCHIVED");
    }
    const modelProfiles = await this.deps.modelConfigStore.listProfiles();
    const runtimePreferences = await this.resolveRuntimePreferences();
    const selectedProfile = this.resolveModelProfile(
      modelProfiles,
      normalizedRequest,
      thread.mode,
      runtimePreferences,
    );
    const modelConfig = selectedProfile.config;
    const attachmentIds = normalizedRequest.attachmentIds;
    const attachments = await this.resolveAttachmentRecords(attachmentIds);

    const turn: TurnRecord = {
      id: randomUUID(),
      threadId: normalizedRequest.threadId,
      status: "in-flight",
      startedAt: new Date().toISOString(),
      model: modelConfig.model,
      reasoningEffort: normalizedRequest.reasoningEffort ?? modelConfig.model_reasoning_effort,
      modelProfileId: selectedProfile.id,
      mode: normalizedRequest.mode ?? "agent",
      goalMode: normalizedRequest.goalMode ?? Boolean(thread.goal && thread.goal.status === "active"),
    };
    const initialToolDefinitions = this.toolCatalog.listDefinitionsForTurn(
      turn,
      thread,
      runtimePreferences,
    );
    turn.toolCatalog = this.toolCatalog.describeDefinitions(initialToolDefinitions);
    this.inFlight.set(turn.id, turn);
    this.startingThreadIds.delete(turn.threadId);

    // Append the user item first.
    const userItem: UserItem = {
      kind: "user",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      text: normalizedRequest.text,
      ...(normalizedRequest.displayText ? { displayText: normalizedRequest.displayText } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      await this.deps.store.appendItem(turn.threadId, userItem);
      await this.deps.checkpointStore?.beginTurn({
        threadId: turn.threadId,
        turnId: turn.id,
        workspace: thread.workspace,
        prompt: normalizedRequest.displayText ?? normalizedRequest.text,
        createdAt: turn.startedAt,
      });
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
        turn,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.inFlight.delete(turn.id);
      this.startingThreadIds.delete(turn.threadId);
      this.reportRuntimeError(turn, "persistence_error", message, error);
      await this.emitTurnFailed(turn, message);
      throw error;
    }

    // Run the loop in the background; return the turn record immediately.
    void this.runTurn(
      turn,
      thread,
      normalizedRequest.text,
      attachmentIds,
      modelConfig,
      runtimePreferences,
    );
    return turn;
  }

  async interruptTurn(turnId: string): Promise<void> {
    const turn = this.inFlight.get(turnId);
    if (!turn) {
      throw new Error(`Turn ${turnId} is not in flight.`);
    }
    if (turn.status === "interrupted") return;
    turn.status = "interrupted";
    await this.toolExecutor.interruptActiveToolExecutionsForTurn(turn);
    await this.toolExecutor.resolvePendingApprovalsForTurn(turnId, "deny");
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
    try {
      await this.deps.store.appendItem(turn.threadId, item);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item,
      });
    } catch (error) {
      this.reportRuntimeError(turn, "persistence_error", error instanceof Error ? error.message : String(error), error);
    }
  }

  resumeThread(threadId: string): Promise<ThreadRecord | null> {
    return this.deps.store.getThread(threadId);
  }

  respondApproval(approval: ApprovalRespondRequest): ApprovalRespondResponse {
    return this.toolExecutor.respondApproval(approval);
  }

  async updateThreadGoal(
    threadId: string,
    update: ThreadGoalUpdate,
  ): Promise<ThreadRecord> {
    const normalizedUpdate = normalizeThreadGoalUpdate(update);
    const thread = await this.deps.store.getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (thread.status === "archived") {
      throw new Error("RUNTIME_THREAD_ARCHIVED");
    }

    const now = new Date().toISOString();
    let nextGoal: ThreadGoal | undefined;
    if (normalizedUpdate.goal === null) {
      nextGoal = undefined;
    } else {
      const current = thread.goal;
      const status = normalizedUpdate.status ?? current?.status ?? "active";
      const text = normalizedUpdate.goal ?? current?.text;
      if (!text?.trim()) {
        throw new Error("Goal text is required.");
      }
      nextGoal = {
        text: text.trim(),
        status,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        ...(status === "complete"
          ? { completedAt: current?.status === "complete" && current.completedAt ? current.completedAt : now }
          : {}),
        ...(status === "blocked"
          ? { blockedAt: current?.status === "blocked" && current.blockedAt ? current.blockedAt : now }
          : {}),
        ...(normalizedUpdate.summary
          ? { summary: normalizedUpdate.summary }
          : current?.summary ? { summary: current.summary } : {}),
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
    runtimePreferences: RuntimePreferences,
  ): Promise<void> {
    try {
      const history = await this.collectHistory(thread, turn.id);
      const skillResolution = await this.resolveSkillsForTurn(
        turn,
        thread,
        userText,
        runtimePreferences,
      );
      const messages: AgentMessage[] = [
        ...history,
        ...this.buildRuntimeContextMessages(turn, thread, skillResolution),
        { role: "user", content: await this.buildUserContent(userText, attachmentIds) },
      ];

      const maxToolRounds = resolveMaxToolRounds(modelConfig.agent_autonomy);
      let warnedAboutToolBudget = false;

      for (let round = 0; round <= maxToolRounds; round += 1) {
        const request = this.buildLlmRequest(
          turn,
          thread,
          messages,
          modelConfig,
          runtimePreferences,
        );
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
            await this.finalizeInterruptedTurn(turn, streamState);
            return;
          }
          await this.persistTruncatedStreamOutputSafely(turn, streamState);
          const message = error instanceof Error ? error.message : String(error);
          this.reportRuntimeError(turn, runtimeErrorCodeFromWorkerError(error), message, error);
          await this.emitTurnFailed(turn, message);
          await this.markTurnStatus(turn, "failed");
          return;
        }

        if (turn.status === "interrupted") {
          await this.finalizeInterruptedTurn(turn, streamState);
          return;
        }
        const assistantText = await this.persistModelOutput(turn, response, streamState);
        if (turn.status !== "in-flight") {
          await this.finalizeInterruptedTurn(turn);
          return;
        }
        turn.usage = response.usage ?? turn.usage;

        if (response.toolCalls.length === 0) {
          await this.appendCompletionEvidenceIfNeeded(turn);
          await this.markTurnStatus(turn, "completed");
          return;
        }

        if (round >= maxToolRounds) {
          await this.appendBudgetExhaustedToolItems(
            turn,
            response.toolCalls,
            maxToolRounds,
          );
          const message = [
            `Automatic tool budget reached after ${maxToolRounds} round(s) before the model produced a final answer.`,
            TOOL_BUDGET_CONTINUATION_MESSAGE,
          ].join(" ");
          await this.appendSystemItem(turn, message, "warn");
          await this.emitToolBudgetReached(
            turn,
            maxToolRounds,
            response.toolCalls.length,
            message,
          );
          await this.markTurnStatus(turn, "needs_continuation");
          return;
        }

        messages.push({
          role: "assistant",
          content: assistantText,
          toolCalls: response.toolCalls,
        });

        const toolResults = await this.executeToolCallsForRound(
          turn,
          thread,
          response.toolCalls,
          runtimePreferences,
          modelConfig,
        );
        for (const result of toolResults) {
          messages.push({
            role: "tool",
            content: result.content,
            toolCallId: result.toolCallId,
          });
          if (turn.status !== "in-flight") {
            await this.finalizeInterruptedTurn(turn);
            return;
          }
        }

        const nextRound = round + 1;
        if (
          !warnedAboutToolBudget &&
          shouldWarnAboutToolBudget(nextRound, maxToolRounds)
        ) {
          warnedAboutToolBudget = true;
          messages.push({
            role: "system",
            content: [
              `You have used ${nextRound} of ${maxToolRounds} automatic tool round(s) for this turn.`,
              "If you have enough evidence, stop calling tools and provide a final answer.",
              "If more work is essential, choose the next tool call carefully and avoid repeating failed calls.",
            ].join(" "),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (turn.status === "interrupted") {
        this.reportRuntimeError(turn, "persistence_error", message, error);
        await this.finalizeInterruptedTurn(turn);
        return;
      }
      await this.emitTurnFailed(turn, message);
      await this.markTurnStatus(turn, "failed");
    }
  }

  private async executeToolCallsForRound(
    turn: TurnRecord,
    thread: ThreadRecord,
    calls: AgentToolCall[],
    runtimePreferences: RuntimePreferences,
    modelConfig: ModelConfig,
  ): Promise<AgentToolResult[]> {
    if (this.canExecuteToolCallsInParallel(calls)) {
      return Promise.all(
        calls.map((call) =>
          this.toolExecutor.execute(
            turn,
            thread,
            call,
            runtimePreferences,
            modelConfig,
          ),
        ),
      );
    }

    const results: AgentToolResult[] = [];
    for (const call of calls) {
      results.push(
        await this.toolExecutor.execute(
          turn,
          thread,
          call,
          runtimePreferences,
          modelConfig,
        ),
      );
      if (turn.status !== "in-flight") {
        break;
      }
    }
    return results;
  }

  private canExecuteToolCallsInParallel(calls: AgentToolCall[]): boolean {
    return calls.length > 1 && calls.every((call) => this.isParallelSafeReadOnlyToolCall(call));
  }

  private isParallelSafeReadOnlyToolCall(call: AgentToolCall): boolean {
    const tool = this.deps.registry.getTool(call.name);
    if (!tool?.metadata?.isReadOnly) return false;
    // run_skill can dispatch an isolated subagent LLM loop; keep parent and child
    // model calls serialized on the thread-bound worker.
    return call.name !== "run_skill";
  }

  private async appendBudgetExhaustedToolItems(
    turn: TurnRecord,
    calls: AgentToolCall[],
    maxToolRounds: number,
  ): Promise<void> {
    for (const call of calls) {
      const toolItem: ToolItem = {
        kind: "tool",
        id: randomUUID(),
        threadId: turn.threadId,
        turnId: turn.id,
        toolCallId: call.id,
        name: call.name,
        args: call.arguments,
        status: "failed",
        result: {
          code: "tool_budget_exhausted",
          message:
            `Automatic tool budget reached after ${maxToolRounds} round(s); tool was not executed.`,
        } satisfies ToolFailureResult,
        createdAt: new Date().toISOString(),
      };
      await appendItemAndBroadcast(
        this.deps.store,
        this.deps.bus,
        turn.threadId,
        turn.id,
        toolItem,
      );
    }
  }

  private async emitToolBudgetReached(
    turn: TurnRecord,
    maxToolRounds: number,
    attemptedToolCalls: number,
    message: string,
  ): Promise<void> {
    const event = {
      kind: "tool_budget_reached",
      threadId: turn.threadId,
      turnId: turn.id,
      maxToolRounds,
      attemptedToolCalls,
      message,
      reachedAt: new Date().toISOString(),
    } as const;
    await persistEventOrReportError(
      this.deps.store,
      this.deps.bus,
      turn.threadId,
      turn.id,
      event,
    );
  }

  private async emitTurnFailed(turn: TurnRecord, message: string): Promise<void> {
    const event = {
      kind: "turn_failed",
      threadId: turn.threadId,
      turnId: turn.id,
      message,
      failedAt: new Date().toISOString(),
    } as const;
    await persistEventOrReportError(
      this.deps.store,
      this.deps.bus,
      turn.threadId,
      turn.id,
      event,
    );
  }

  private buildLlmRequest(
    turn: TurnRecord,
    thread: ThreadRecord,
    messages: AgentMessage[],
    modelConfig: ModelConfig,
    runtimePreferences: RuntimePreferences,
  ): LlmRequest {
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.toolCatalog.listDefinitionsForTurn(turn, thread, runtimePreferences);
    turn.toolCatalog = this.toolCatalog.describeDefinitions(tools);
    return {
      protocol: modelConfig.protocol,
      provider: modelConfig.model_provide,
      model: turn.model,
      apiKey: modelConfig.OPENAI_API_KEY,
      baseUrl: modelConfig.base_url,
      systemPrompt,
      messages: prepareMessagesForRequest(messages, {
        systemPrompt,
        tools,
        compactTokenLimit: modelConfig.model_auto_compact_token_limit,
        contextWindow: modelConfig.model_context_window,
        maxTokens: modelConfig.max_tokens,
        compaction: runtimePreferences.compaction,
      }),
      tools,
      maxTokens: modelConfig.max_tokens,
      temperature: 1,
      thinking: modelConfig.thinking,
      reasoningEffort: turn.reasoningEffort ?? modelConfig.model_reasoning_effort,
    };
  }

  private async persistTruncatedStreamOutput(
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

  // Interrupts are finalized by the background run loop so streamed partial
  // output/tool cleanup is durable before the terminal turn event unlocks the thread.
  private async finalizeInterruptedTurn(
    turn: TurnRecord,
    streamState?: {
      assistantItem: AssistantItem | null;
      reasoningItem: ReasoningItem | null;
    },
  ): Promise<void> {
    if (!this.inFlight.has(turn.id)) return;
    if (streamState) {
      await this.persistTruncatedStreamOutputSafely(turn, streamState);
    }
    await this.markTurnStatus(turn, "interrupted");
  }

  private async persistTruncatedStreamOutputSafely(
    turn: TurnRecord,
    streamState: {
      assistantItem: AssistantItem | null;
      reasoningItem: ReasoningItem | null;
    },
  ): Promise<void> {
    try {
      await this.persistTruncatedStreamOutput(turn, streamState);
    } catch (error) {
      this.reportRuntimeError(turn, "persistence_error", error instanceof Error ? error.message : String(error), error);
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
      await appendItemAndBroadcast(
        this.deps.store,
        this.deps.bus,
        turn.threadId,
        turn.id,
        streamState.reasoningItem,
      );
    } else if (response.reasoning?.trim()) {
      const finalReasoningItem: ReasoningItem = {
        kind: "reasoning",
        id: randomUUID(),
        threadId: turn.threadId,
        turnId: turn.id,
        text: response.reasoning,
        createdAt: new Date().toISOString(),
      };
      await appendItemAndBroadcast(
        this.deps.store,
        this.deps.bus,
        turn.threadId,
        turn.id,
        finalReasoningItem,
      );
    }

    if (streamState.assistantItem?.text.trim()) {
      const finalAssistantItem: AssistantItem = {
        ...streamState.assistantItem,
        ...(turn.status === "interrupted" ? { truncated: true } : {}),
      };
      await appendItemAndBroadcast(
        this.deps.store,
        this.deps.bus,
        turn.threadId,
        turn.id,
        finalAssistantItem,
      );
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
      await appendItemAndBroadcast(
        this.deps.store,
        this.deps.bus,
        turn.threadId,
        turn.id,
        finalAssistantItem,
      );
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

  private executeSubagentSkillCall(
    turn: TurnRecord,
    thread: ThreadRecord,
    call: AgentToolCall,
    runtimePreferences: RuntimePreferences,
    modelConfig: ModelConfig,
    signal: AbortSignal,
  ): Promise<AgentToolResult> | null {
    if (call.name !== "run_skill" || !this.deps.skillService) return null;
    return this.runSubagentSkillFromToolCall(
      turn,
      thread,
      call,
      runtimePreferences,
      modelConfig,
      signal,
    );
  }

  private async runSubagentSkillFromToolCall(
    turn: TurnRecord,
    thread: ThreadRecord,
    call: AgentToolCall,
    runtimePreferences: RuntimePreferences,
    modelConfig: ModelConfig,
    signal: AbortSignal,
  ): Promise<AgentToolResult> {
    const skillId = parseRunSkillIdArgument(call.arguments.skillId);
    const loaded = await this.deps.skillService?.loadWorkspaceSkills(
      thread.workspace,
      runtimePreferences.skills,
    );
    const skill = loaded?.skills.find((candidate) =>
      candidate.id === normalizeSkillId(skillId) ||
      normalizeSkillId(candidate.name) === normalizeSkillId(skillId)
    );
    if (!skill || skill.runAs !== "subagent") {
      return this.deps.registry.execute(call, {
        threadId: turn.threadId,
        turnId: turn.id,
        workspace: thread.workspace,
        sandboxMode: thread.sandboxMode,
        signal,
        commandDefaults: runtimePreferences.command,
        runtimePreferences,
        readState: this.readState,
        fileHistory: this.fileHistory,
        checkpoint: this.deps.checkpointStore,
      });
    }
    const task = parseRunSkillTaskArgument(call.arguments.arguments);
    const answer = await this.runSubagentSkillLoop(
      turn,
      thread,
      skill,
      task,
      runtimePreferences,
      modelConfig,
      signal,
    );
    return {
      toolCallId: call.id,
      name: call.name,
      content: [
        `Subagent skill: ${skill.name} (${skill.id})`,
        answer,
      ].join("\n\n"),
      displayResult: {
        skillId: skill.id,
        name: skill.name,
        runAs: skill.runAs,
        model: skill.model || modelConfig.model,
        effort: isModelReasoningEffort(skill.effort) ? skill.effort : modelConfig.model_reasoning_effort,
        isolated: true,
        content: answer,
      },
    };
  }

  private async runSubagentSkillLoop(
    turn: TurnRecord,
    thread: ThreadRecord,
    skill: Skill,
    task: string,
    runtimePreferences: RuntimePreferences,
    modelConfig: ModelConfig,
    signal: AbortSignal,
  ): Promise<string> {
    const tools = this.listSubagentToolDefinitions(skill);
    const messages: AgentMessage[] = [{ role: "user", content: task }];
    const maxToolRounds = resolveMaxToolRounds(modelConfig.agent_autonomy);
    for (let round = 0; round <= maxToolRounds; round += 1) {
      if (signal.aborted || turn.status !== "in-flight") {
        throw new Error("Subagent skill was interrupted.");
      }
      const request = this.buildSubagentLlmRequest(
        skill,
        messages,
        tools,
        modelConfig,
        runtimePreferences,
      );
      const response = await this.deps.pool.chat({ id: thread.id }, request, () => undefined);
      if (response.toolCalls.length === 0) {
        const answer = response.text.trim();
        return answer || "Subagent completed without a final answer.";
      }
      if (round >= maxToolRounds) {
        throw new Error(
          `Subagent skill "${skill.id}" reached its automatic tool budget before producing a final answer.`,
        );
      }
      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });
      for (const childCall of response.toolCalls) {
        const childResult = await this.executeSubagentToolCall(
          turn,
          thread,
          skill,
          childCall,
          runtimePreferences,
          signal,
        );
        messages.push({
          role: "tool",
          content: childResult.content,
          toolCallId: childResult.toolCallId,
        });
      }
    }
    throw new Error(`Subagent skill "${skill.id}" did not produce a final answer.`);
  }

  private buildSubagentLlmRequest(
    skill: Skill,
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    modelConfig: ModelConfig,
    runtimePreferences: RuntimePreferences,
  ): LlmRequest {
    const systemPrompt = [
      `You are running as isolated subagent skill "${skill.name}" (${skill.id}).`,
      "Only your final answer will be returned to the parent turn.",
      "Do not assume access to the parent conversation beyond the task below.",
      "Stay within the skill instructions.",
      skill.body,
    ].join("\n\n");
    const reasoningEffort = isModelReasoningEffort(skill.effort)
      ? skill.effort
      : modelConfig.model_reasoning_effort;
    return {
      protocol: modelConfig.protocol,
      provider: modelConfig.model_provide,
      model: skill.model || modelConfig.model,
      apiKey: modelConfig.OPENAI_API_KEY,
      baseUrl: modelConfig.base_url,
      systemPrompt,
      messages: prepareMessagesForRequest(messages, {
        systemPrompt,
        tools,
        compactTokenLimit: modelConfig.model_auto_compact_token_limit,
        contextWindow: modelConfig.model_context_window,
        maxTokens: modelConfig.max_tokens,
        compaction: runtimePreferences.compaction,
      }),
      tools,
      maxTokens: modelConfig.max_tokens,
      temperature: 1,
      thinking: modelConfig.thinking,
      reasoningEffort,
    };
  }

  private listSubagentToolDefinitions(skill: Skill): AgentToolDefinition[] {
    const allowed = new Set(skill.allowedTools);
    if (allowed.size === 0) return [];
    return this.deps.registry
      .listDefinitions()
      .filter((definition) => {
        if (!allowed.has(definition.name) || definition.name === "run_skill") return false;
        const tool = this.deps.registry.getTool(definition.name);
        return Boolean(tool?.metadata?.isReadOnly);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async executeSubagentToolCall(
    turn: TurnRecord,
    thread: ThreadRecord,
    skill: Skill,
    call: AgentToolCall,
    runtimePreferences: RuntimePreferences,
    signal: AbortSignal,
  ): Promise<AgentToolResult> {
    const tool = this.deps.registry.getTool(call.name);
    if (!skill.allowedTools.includes(call.name) || call.name === "run_skill") {
      return {
        toolCallId: call.id,
        name: call.name,
        content: stableStringify({
          denied: true,
          message: `Tool "${call.name}" is not allowed for subagent skill "${skill.id}".`,
        }),
      };
    }
    if (!tool?.metadata?.isReadOnly) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: stableStringify({
          denied: true,
          message:
            `Tool "${call.name}" is not available to subagent skill "${skill.id}" because only read-only tools are supported.`,
        }),
      };
    }
    return this.deps.registry.execute(call, {
      threadId: turn.threadId,
      turnId: `${turn.id}:subagent:${skill.id}`,
      workspace: thread.workspace,
      signal,
      commandDefaults: runtimePreferences.command,
      runtimePreferences,
    });
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
    await appendItemAndBroadcast(
      this.deps.store,
      this.deps.bus,
      turn.threadId,
      turn.id,
      item,
    );
  }

  private async appendCompletionEvidenceIfNeeded(turn: TurnRecord): Promise<void> {
    const items: Item[] = [];
    for await (const item of this.deps.store.replayItems(turn.threadId)) {
      if ("turnId" in item && item.turnId === turn.id) {
        items.push(item);
      }
    }
    const text = buildTurnCompletionEvidenceText({
      items,
      checkpointState: await this.resolveCompletionEvidenceCheckpointState(turn),
    });
    if (!text) return;
    await this.appendSystemItem(turn, text, "info");
  }

  private async resolveCompletionEvidenceCheckpointState(
    turn: TurnRecord,
  ): Promise<CompletionEvidenceCheckpointState> {
    if (!this.deps.checkpointStore) {
      return { kind: "not_configured" };
    }
    try {
      const checkpoints = await this.deps.checkpointStore.list(turn.threadId);
      const checkpoint = checkpoints.find((candidate) => candidate.turnId === turn.id);
      return {
        kind: "available",
        paths: checkpoint?.files.map((file) => file.path) ?? [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportRuntimeError(
        turn,
        "persistence_error",
        `Completion evidence checkpoint lookup failed: ${message}`,
        error,
      );
      return { kind: "lookup_failed", message };
    }
  }

  private async persistApprovalPermissionRule(rule: RuntimePermissionRule): Promise<void> {
    if (!this.deps.runtimePreferencesStore) {
      throw new Error("Runtime preferences store is not available.");
    }
    const current = await this.deps.runtimePreferencesStore.get();
    if (current.permissionRules.some((existing) => arePermissionRulesEquivalent(existing, rule))) {
      return;
    }
    await this.deps.runtimePreferencesStore.update({
      permissionRules: [...current.permissionRules, rule],
    });
  }

  private resolveModelProfile(
    state: ModelConfigProfilesState,
    request: TurnStartRequest,
    threadMode: ThreadRecord["mode"],
    preferences: RuntimePreferences,
  ): ModelConfigProfile {
    const profiles = state.profiles;
    if (request.modelProfileId) {
      const selected = profiles.find((profile) => profile.id === request.modelProfileId);
      if (!selected) {
        throw new Error(`Model config profile ${request.modelProfileId} not found.`);
      }
      return selected;
    }

    const modeDefaultProfileId = threadMode === "write"
      ? preferences.writeDefaultModelProfileId
      : preferences.codeDefaultModelProfileId;
    if (modeDefaultProfileId) {
      const selected = profiles.find((profile) => profile.id === modeDefaultProfileId);
      if (selected) return selected;
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

  private async resolveRuntimePreferences(): Promise<RuntimePreferences> {
    return this.deps.runtimePreferencesStore
      ? this.deps.runtimePreferencesStore.get()
      : DEFAULT_RUNTIME_PREFERENCES;
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
      // Timeline records only carry attachment metadata; the binary payload is
      // rehydrated from the store on demand to keep messages.jsonl small.
      attachments.push(stripAttachmentPayload(attachment));
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

  private async resolveSkillsForTurn(
    turn: TurnRecord,
    thread: ThreadRecord,
    userText: string,
    runtimePreferences: RuntimePreferences,
  ): Promise<SkillTurnResolution | null> {
    if (!this.deps.skillService || !runtimePreferences.skills.enabled) return null;
    try {
      const resolution = await this.deps.skillService.resolveTurn({
        workspace: thread.workspace,
        preferences: runtimePreferences.skills,
        text: userText,
      });
      for (const validationError of resolution.validationErrors) {
        this.reportRuntimeError(turn, "internal", `Skill load warning at ${validationError.root}: ${validationError.message}`);
      }
      return resolution;
    } catch (error) {
      this.reportRuntimeError(turn, "internal", `Skill resolution failed: ${error instanceof Error ? error.message : String(error)}`, error);
      return null;
    }
  }

  private buildRuntimeContextMessages(
    turn: TurnRecord,
    thread: ThreadRecord,
    skillResolution: SkillTurnResolution | null,
  ): AgentMessage[] {
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
    if (skillResolution && skillResolution.instructions.length > 0) {
      parts.push([
        "Matched Agent Skills are active for this turn.",
        "Follow each Active Skill instruction when it is relevant to the user's request.",
        ...skillResolution.instructions,
      ].join("\n\n"));
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

  private async markTurnStatus(
    turn: TurnRecord,
    status: TerminalTurnStatus,
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
      this.reportRuntimeError(turn, "persistence_error", error instanceof Error ? error.message : String(error), error);
    }
    this.deps.bus.emit("turn_completed", event);
    this.inFlight.delete(turn.id);
    this.startingThreadIds.delete(turn.threadId);
    this.toolExecutor.clearReadOnlyToolRepeatStateForTurn(turn.id);
  }
}

function stripAttachmentPayload(attachment: AttachmentRecord & { dataBase64: string }): AttachmentRecord {
  // Timeline records only carry attachment metadata; the binary payload is
  // rehydrated from the store on demand to keep messages.jsonl small.
  const { dataBase64: _payload, ...record } = attachment;
  return record;
}

function runtimeErrorCodeFromWorkerError(error: unknown): RuntimeErrorEvent["code"] {
  if (!isLlmWorkerError(error)) {
    return "internal";
  }
  switch (error.code) {
    case "http":
      return "provider_http";
    case "provider":
      return "provider_error";
    case "schema":
      return "schema_invalid";
    case "worker_crashed":
      return "worker_crashed";
    case "internal":
      return "internal";
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}

function resolveMaxToolRounds(autonomy: ModelConfig["agent_autonomy"]): number {
  const configured = process.env.AGENT_MAX_TOOL_ROUNDS;
  if (configured === undefined || !configured.trim()) {
    return AGENT_AUTONOMY_TOOL_ROUNDS[autonomy] ?? AGENT_AUTONOMY_TOOL_ROUNDS[DEFAULT_AGENT_AUTONOMY];
  }
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < MIN_MAX_TOOL_ROUNDS) {
    return AGENT_AUTONOMY_TOOL_ROUNDS[autonomy] ?? AGENT_AUTONOMY_TOOL_ROUNDS[DEFAULT_AGENT_AUTONOMY];
  }
  return Math.min(MAX_MAX_TOOL_ROUNDS, Math.floor(parsed));
}

function shouldWarnAboutToolBudget(nextRound: number, maxToolRounds: number): boolean {
  if (maxToolRounds <= MIN_MAX_TOOL_ROUNDS) {
    return false;
  }
  return nextRound >= Math.max(1, Math.ceil(maxToolRounds * TOOL_ROUND_WARNING_THRESHOLD));
}

function arePermissionRulesEquivalent(
  left: RuntimePermissionRule,
  right: RuntimePermissionRule,
): boolean {
  return left.tool === right.tool &&
    left.pattern === right.pattern &&
    left.effect === right.effect &&
    (left.match ?? "glob") === (right.match ?? "glob") &&
    permissionRuleScopeKey(left) === permissionRuleScopeKey(right);
}

function permissionRuleScopeKey(rule: RuntimePermissionRule): string {
  if (!rule.scope) return "global";
  return `${rule.scope.kind}:${rule.scope.workspace}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function parseRunSkillIdArgument(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("run_skill requires a non-empty skillId.");
  }
  if (value.includes("\0")) {
    throw new Error("run_skill skillId cannot contain NUL bytes.");
  }
  return value.trim();
}

function parseRunSkillTaskArgument(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("run_skill subagent skills require non-empty arguments.");
  }
  if (value.includes("\0")) {
    throw new Error("run_skill arguments cannot contain NUL bytes.");
  }
  return value.trim();
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
