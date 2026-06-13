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
  ACTIVE_TOOL_INTERRUPT_SETTLE_TIMEOUT_MS,
  AGENT_AUTONOMY_TOOL_ROUNDS,
  CONTEXT_BUDGET_SAFETY_RATIO,
  DEFAULT_AGENT_AUTONOMY,
  MAX_MAX_TOOL_ROUNDS,
  MAX_PROGRESSIVE_COMPACTION_PASSES,
  MIN_MAX_TOOL_ROUNDS,
  MIN_PROGRESSIVE_COMPACTION_BYTES,
  MIN_TEXT_COMPACTION_BYTES,
  TIGHT_ASSISTANT_MESSAGE_MAX_BYTES,
  TIGHT_SYSTEM_MESSAGE_MAX_BYTES,
  TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
  TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES,
  TIGHT_TOOL_RESULT_MAX_BYTES,
  TIGHT_TOOL_RESULT_MAX_LINES,
  TIGHT_USER_MESSAGE_MAX_BYTES,
  TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
  TOOL_ARGUMENT_STRING_MAX_BYTES,
  TOOL_BUDGET_CONTINUATION_MESSAGE,
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_MAX_LINES,
  TOOL_ROUND_WARNING_THRESHOLD,
} from "./constants.js";
import type {
  ApprovalItem,
  ApprovalRespondRequest,
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
  ToolItem,
  TurnRecord,
  TurnStartRequest,
  TurnMode,
  PlanItem,
  PlanStep,
  RuntimePreferences,
  RuntimeErrorEvent,
  TerminalTurnStatus,
  ToolProgressStream,
  UserItem,
} from "../../shared/agent-contracts.js";
import { normalizeSkillId, type Skill, type SkillTurnResolution } from "../../shared/skills/index.js";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  THREAD_MODES,
  isRuntimeToolName,
  isNonNegativeInteger,
  isModelReasoningEffort,
  isThreadGoalStatus,
} from "../../shared/agent-contracts.js";
import { evaluatePermission } from "./permission-policy.js";

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

interface PendingApproval {
  approvalId: string;
  threadId: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview?: ApprovalItem["preview"];
  resolve: (decision: "allow" | "deny") => void | Promise<void>;
}

interface ActiveToolExecution {
  item: ToolItem;
  controller?: AbortController;
  finalizedByInterrupt: boolean;
  settled?: Promise<void>;
}

type NormalizedTurnStartRequest = Omit<TurnStartRequest, "attachmentIds"> & {
  attachmentIds: string[];
};

export type ToolAccessDecision = "allow" | "deny" | "inherit";

export interface ToolAccessPolicyInput {
  name: string;
  turn: TurnRecord;
  thread: ThreadRecord;
  definition?: AgentToolDefinition;
}

export type ToolAccessPolicy = (input: ToolAccessPolicyInput) => ToolAccessDecision;

export interface ToolAccessPolicyConfig {
  allowByMode?: Partial<Record<ThreadRecord["mode"], readonly string[]>>;
  denyByMode?: Partial<Record<ThreadRecord["mode"], readonly string[]>>;
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

export const COMMAND_TOOL_NAMES = [
  "run_command",
  "shell_command",
  "git_bash_command",
  "powershell_command",
  "wsl_command",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_commit",
  "package_scripts",
  "package_install",
  "package_test",
  "package_build",
  "run_lint",
  "run_format",
  "run_tests",
  "run_build",
  "start_command_session",
  "read_command_session",
  "write_command_session",
  "stop_command_session",
  "detect_shell_environment",
  "diagnose_workspace",
  "diagnose_file",
] as const;
const COMMAND_TOOL_NAME_SET = new Set<string>(COMMAND_TOOL_NAMES);
export const CODE_ONLY_TOOL_NAMES = [
  "edit_file",
  "write_file",
  "delete_file",
  "apply_patch",
  "rollback_file",
  ...COMMAND_TOOL_NAMES,
] as const;
const CODE_ONLY_TOOL_NAME_SET = new Set<string>(CODE_ONLY_TOOL_NAMES);
const DEFAULT_TOOL_ACCESS_POLICY = createToolAccessPolicy({
  denyByMode: {
    write: CODE_ONLY_TOOL_NAMES,
  },
});

const MCP_TOOL_NAME_PREFIX = "mcp__";

export function isCodeOnlyToolName(name: string): boolean {
  return CODE_ONLY_TOOL_NAME_SET.has(name);
}

export function createToolAccessPolicy(config: ToolAccessPolicyConfig): ToolAccessPolicy {
  const allowByMode = toToolAccessSets(config.allowByMode);
  const denyByMode = toToolAccessSets(config.denyByMode);
  assertNoToolAccessConflicts(allowByMode, denyByMode);
  return ({ name, thread }) => {
    if (allowByMode[thread.mode]?.has(name)) return "allow";
    if (denyByMode[thread.mode]?.has(name)) return "deny";
    return "inherit";
  };
}

function toToolAccessSets(
  config: Partial<Record<ThreadRecord["mode"], readonly string[]>> | undefined,
): Partial<Record<ThreadRecord["mode"], ReadonlySet<string>>> {
  return {
    ...(config?.code ? { code: new Set(config.code) } : {}),
    ...(config?.write ? { write: new Set(config.write) } : {}),
  };
}

function assertNoToolAccessConflicts(
  allowByMode: Partial<Record<ThreadRecord["mode"], ReadonlySet<string>>>,
  denyByMode: Partial<Record<ThreadRecord["mode"], ReadonlySet<string>>>,
): void {
  for (const mode of THREAD_MODES) {
    const allow = allowByMode[mode];
    const deny = denyByMode[mode];
    if (!allow || !deny) {
      continue;
    }
    for (const name of allow) {
      if (deny.has(name)) {
        throw new Error(`Tool access policy conflict for ${mode}:${name}.`);
      }
    }
  }
}

/**
 * Multi-turn runtime. Holds per-turn state, orchestrates worker pool,
 * enforces tool policy, persists items + events, and emits bus events.
 */
export class AgentRuntime {
  private readonly inFlight = new Map<string, TurnRecord>(); // turnId -> record
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly activeToolExecutions = new Map<string, Set<ActiveToolExecution>>();
  private readonly readState = new FileReadStateStore();
  private readonly fileHistory = new FileHistoryStore();

  constructor(private readonly deps: RuntimeDeps) {}

  isThreadInFlight(threadId: string): boolean {
    return Array.from(this.inFlight.values()).some(
      (turn) => turn.threadId === threadId,
    );
  }

  async startTurn(request: TurnStartRequest): Promise<TurnRecord> {
    const normalizedRequest = normalizeTurnStartRequest(request);
    const thread = await this.deps.store.getThread(normalizedRequest.threadId);
    if (!thread) throw new Error(`Thread ${normalizedRequest.threadId} not found`);
    if (thread.status === "archived") {
      throw new Error("RUNTIME_THREAD_ARCHIVED");
    }

    if (this.isThreadInFlight(normalizedRequest.threadId)) {
      throw new Error("RUNTIME_TURN_BUSY");
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
    this.inFlight.set(turn.id, turn);

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
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "persistence_error",
        message,
      });
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
    await this.interruptActiveToolExecutionsForTurn(turn);
    await this.resolvePendingApprovalsForTurn(turnId, "deny");
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
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "persistence_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  resumeThread(threadId: string): Promise<ThreadRecord | null> {
    return this.deps.store.getThread(threadId);
  }

  respondApproval(approval: ApprovalRespondRequest): void {
    if (approval.decision !== "allow" && approval.decision !== "deny") {
      throw new Error("Approval decision must be allow or deny.");
    }
    const pending = this.pendingApprovals.get(approval.approvalId);
    if (!pending) {
      throw new Error(`Approval ${approval.approvalId} is not pending.`);
    }
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
          this.deps.bus.emit("runtime_error", {
            kind: "runtime_error",
            threadId: turn.threadId,
            turnId: turn.id,
            code: runtimeErrorCodeFromWorkerError(error),
            message,
          });
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

        for (const call of response.toolCalls) {
          const result = await this.executeToolCall(
            turn,
            thread,
            call,
            runtimePreferences,
            modelConfig,
          );
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
        this.deps.bus.emit("runtime_error", {
          kind: "runtime_error",
          threadId: turn.threadId,
          turnId: turn.id,
          code: "persistence_error",
          message,
        });
        await this.finalizeInterruptedTurn(turn);
        return;
      }
      await this.emitTurnFailed(turn, message);
      await this.markTurnStatus(turn, "failed");
    }
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
          message:
            `Automatic tool budget reached after ${maxToolRounds} round(s); tool was not executed.`,
        },
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.deps.bus.emit("item_appended", {
        kind: "item_appended",
        threadId: turn.threadId,
        turnId: turn.id,
        item: toolItem,
      });
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
    this.deps.bus.emit("tool_budget_reached", event);
  }

  private async emitTurnFailed(turn: TurnRecord, message: string): Promise<void> {
    const event = {
      kind: "turn_failed",
      threadId: turn.threadId,
      turnId: turn.id,
      message,
      failedAt: new Date().toISOString(),
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
    this.deps.bus.emit("turn_failed", event);
  }

  private buildLlmRequest(
    turn: TurnRecord,
    thread: ThreadRecord,
    messages: AgentMessage[],
    modelConfig: ModelConfig,
    runtimePreferences: RuntimePreferences,
  ): LlmRequest {
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.listToolDefinitionsForTurn(turn, thread, runtimePreferences);
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
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "persistence_error",
        message: error instanceof Error ? error.message : String(error),
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
    runtimePreferences: RuntimePreferences,
    modelConfig: ModelConfig,
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
    const activeExecution = this.registerActiveToolExecution(turn.id, toolItem);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item: toolItem,
    });

    if (!this.isToolAvailableForTurn(call.name, turn, thread, runtimePreferences)) {
      toolItem.status = "failed";
      toolItem.result = { message: `Tool "${call.name}" is not available in this turn.` };
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "tool_not_found",
        message: `Tool "${call.name}" is not available in this turn.`,
      });
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    const policyDecision = this.resolveToolPolicy(
      call,
      turn,
      thread,
      runtimePreferences,
    );
    if (policyDecision === "deny") {
      toolItem.status = "failed";
      toolItem.result = {
        denied: true,
        message: `Tool "${call.name}" is denied by thread policy.`,
      };
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    try {
      if (policyDecision === "ask") {
        const approval = await this.requestApproval(turn, call, thread);
        if (approval === "deny") {
          if (activeExecution.finalizedByInterrupt) {
            this.unregisterActiveToolExecution(turn.id, activeExecution);
            return {
              toolCallId: call.id,
              name: call.name,
              content: JSON.stringify(toolItem.result ?? { message: interruptedToolMessage(call.name) }),
            };
          }
          toolItem.status = "failed";
          toolItem.result = { denied: true };
          await this.deps.store.appendItem(turn.threadId, toolItem);
          this.emitToolItemUpdated(turn, toolItem);
          this.unregisterActiveToolExecution(turn.id, activeExecution);
          return {
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(toolItem.result),
          };
        }
      }
      if (activeExecution.finalizedByInterrupt || turn.status !== "in-flight") {
        this.unregisterActiveToolExecution(turn.id, activeExecution);
        return {
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(toolItem.result ?? { message: interruptedToolMessage(call.name) }),
        };
      }

      const controller = new AbortController();
      activeExecution.controller = controller;
      let progressSeq = 0;
      const reportProgress = (chunk: string, stream: ToolProgressStream): void => {
        if (!chunk) return;
        try {
          this.deps.bus.emit("tool_progress", {
            kind: "tool_progress",
            threadId: turn.threadId,
            turnId: turn.id,
            toolCallId: call.id,
            chunk,
            stream,
            seq: ++progressSeq,
          });
        } catch (error) {
          console.warn(
            `[agent-runtime] failed to emit tool progress for ${call.name}:`,
            error,
          );
        }
      };
      const toolContext = {
        threadId: turn.threadId,
        turnId: turn.id,
        workspace: thread.workspace,
        signal: controller.signal,
        commandDefaults: runtimePreferences.command,
        runtimePreferences,
        reportProgress,
        readState: this.readState,
        fileHistory: this.fileHistory,
        checkpoint: this.deps.checkpointStore,
      };
      const executionPromise =
        this.executeSubagentSkillCall(turn, thread, call, runtimePreferences, modelConfig, controller.signal) ??
        this.deps.registry.execute(call, toolContext);
      activeExecution.settled = executionPromise.then(
        () => undefined,
        () => undefined,
      );
      let content: AgentToolResult;
      try {
        content = await executionPromise;
      } finally {
        activeExecution.controller = undefined;
      }
      if (activeExecution.finalizedByInterrupt) {
        this.unregisterActiveToolExecution(turn.id, activeExecution);
        return {
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(toolItem.result ?? { message: interruptedToolMessage(call.name) }),
        };
      }
      toolItem.status = "completed";
      toolItem.result = content.displayResult ?? content;
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      if (call.name === "create_plan") {
        await this.appendPlanItem(turn, content.content);
      }
      return content;
    } catch (error) {
      if (activeExecution.finalizedByInterrupt) {
        this.unregisterActiveToolExecution(turn.id, activeExecution);
        return {
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(toolItem.result ?? { message: interruptedToolMessage(call.name) }),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      toolItem.status = "failed";
      toolItem.result = {
        message,
      };
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      if (turn.status !== "interrupted") {
        this.deps.bus.emit("runtime_error", {
          kind: "runtime_error",
          threadId: turn.threadId,
          turnId: turn.id,
          code: "tool_failed",
          message: `${call.name}: ${message}`,
        });
      }
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
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

  private listToolDefinitionsForTurn(
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
  ): AgentToolDefinition[] {
    return this.deps.registry
      .listDefinitions()
      .filter((definition) =>
        this.isToolEnabledForTurn(
          definition.name,
          turn,
          thread,
          runtimePreferences,
          definition,
        ),
      );
  }

  private isToolAvailableForTurn(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
  ): boolean {
    return this.listToolDefinitionsForTurn(turn, thread, runtimePreferences).some(
      (definition) => definition.name === name,
    );
  }

  private isToolEnabledForTurn(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
    definition?: AgentToolDefinition,
  ): boolean {
    if (name === "create_plan") {
      return turn.mode === "plan" &&
        this.isToolAllowedByAccessPolicy(
          name,
          turn,
          thread,
          runtimePreferences,
          definition,
        );
    }
    if (name === "update_goal") {
      return Boolean(turn.goalMode || thread.goal?.status === "active") &&
        this.isToolAllowedByAccessPolicy(
          name,
          turn,
          thread,
          runtimePreferences,
          definition,
        );
    }
    return this.isToolAllowedByAccessPolicy(
      name,
      turn,
      thread,
      runtimePreferences,
      definition,
    );
  }

  private isToolAllowedByAccessPolicy(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
    definition?: AgentToolDefinition,
  ): boolean {
    // Tool access is a catalog-level policy, separate from approval/sandbox
    // execution policy below. A caller can override individual mode/tool pairs
    // while the default keeps Code-only tools out of Write threads.
    const input = { name, turn, thread, ...(definition ? { definition } : {}) };
    const configuredDecision = this.deps.toolAccessPolicy?.(input);
    if (configuredDecision === "allow") return true;
    if (configuredDecision === "deny") return false;
    if (isRuntimeToolName(name)) {
      return runtimePreferences.toolAvailability[thread.mode][name];
    }
    if (name.startsWith(MCP_TOOL_NAME_PREFIX)) {
      return thread.mode === "code";
    }
    return DEFAULT_TOOL_ACCESS_POLICY(input) !== "deny";
  }

  private resolveToolPolicy(
    call: AgentToolCall,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
  ): "allow" | "ask" | "deny" {
    const name = call.name;
    const tool = this.deps.registry.getTool(name);
    if (!tool) {
      return "deny";
    }
    if (tool.metadata?.isReadOnly) {
      return "allow";
    }
    if (
      (name === "create_plan" || name === "update_goal") &&
      this.isToolAvailableForTurn(name, turn, thread, runtimePreferences)
    ) {
      return "allow";
    }
    if (thread.sandboxMode === "read-only") {
      return "deny";
    }
    if (thread.approvalPolicy === "never") {
      return "deny";
    }
    // Configurable per-call rules may only refine non-read-only command,
    // write, or MCP calls after hard sandbox and approval denials have already
    // been applied.
    const permissionDecision = evaluatePermission({
      toolName: name,
      args: call.arguments,
      rules: runtimePreferences.permissionRules,
    });
    if (permissionDecision !== "none") {
      return permissionDecision;
    }
    if (thread.approvalPolicy === "auto" && tool.metadata?.isDestructive === false) {
      return "allow";
    }
    return "ask";
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
    thread: ThreadRecord,
  ): Promise<"allow" | "deny"> {
    const approvalId = randomUUID();
    const preview = await this.buildApprovalPreview(call, turn, thread);
    const pendingItem: ApprovalItem = {
      kind: "approval",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      approvalId,
      toolName: call.name,
      args: call.arguments,
      ...(preview ? { preview } : {}),
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
        ...(preview ? { preview } : {}),
        resolve: (decision) => {
          const item: ApprovalItem = {
            ...pendingItem,
            kind: "approval",
            decision,
            resolvedAt: new Date().toISOString(),
          };
          void (async () => {
            try {
              await this.deps.store.appendItem(turn.threadId, item);
            } catch (error) {
              this.deps.bus.emit("runtime_error", {
                kind: "runtime_error",
                threadId: turn.threadId,
                turnId: turn.id,
                code: "persistence_error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
            this.deps.bus.emit("item_updated", {
              kind: "item_updated",
              threadId: turn.threadId,
              turnId: turn.id,
              item,
            });
            resolve(decision);
          })();
        },
      });
      this.deps.bus.emit("approval_requested", {
        kind: "approval_requested",
        threadId: turn.threadId,
        turnId: turn.id,
        approvalId,
        toolName: call.name,
        args: call.arguments,
        ...(preview ? { preview } : {}),
      });
    });
  }

  private async buildApprovalPreview(
    call: AgentToolCall,
    turn: TurnRecord,
    thread: ThreadRecord,
  ): Promise<ApprovalItem["preview"] | undefined> {
    const tool = this.deps.registry.getTool(call.name);
    if (!tool?.preview) return undefined;
    const preview = await tool.preview(call.arguments, {
      threadId: turn.threadId,
      turnId: turn.id,
      workspace: thread.workspace,
      readState: this.readState,
      fileHistory: this.fileHistory,
    });
    return isApprovalPreview(preview) ? preview : undefined;
  }

  private registerActiveToolExecution(
    turnId: string,
    item: ToolItem,
  ): ActiveToolExecution {
    const execution: ActiveToolExecution = {
      item,
      finalizedByInterrupt: false,
    };
    const executions =
      this.activeToolExecutions.get(turnId) ?? new Set<ActiveToolExecution>();
    executions.add(execution);
    this.activeToolExecutions.set(turnId, executions);
    return execution;
  }

  private unregisterActiveToolExecution(
    turnId: string,
    execution: ActiveToolExecution,
  ): void {
    const executions = this.activeToolExecutions.get(turnId);
    if (!executions) return;
    executions.delete(execution);
    if (executions.size === 0) {
      this.activeToolExecutions.delete(turnId);
    }
  }

  private async interruptActiveToolExecutionsForTurn(turn: TurnRecord): Promise<void> {
    const executions = this.activeToolExecutions.get(turn.id);
    if (!executions) return;
    const settling: Promise<void>[] = [];
    for (const execution of [...executions]) {
      execution.controller?.abort();
      if (execution.settled) {
        settling.push(execution.settled);
      }
      if (execution.item.status !== "running") continue;
      execution.finalizedByInterrupt = true;
      execution.item.status = "failed";
      execution.item.result = { message: interruptedToolMessage(execution.item.name) };
      try {
        await this.deps.store.appendItem(turn.threadId, execution.item);
      } catch (error) {
        this.deps.bus.emit("runtime_error", {
          kind: "runtime_error",
          threadId: turn.threadId,
          turnId: turn.id,
          code: "persistence_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      this.emitToolItemUpdated(turn, execution.item);
    }
    if (!await waitForInterruptedToolExecutions(settling)) {
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "internal",
        message: "Timed out waiting for interrupted tools to settle.",
      });
    }
  }

  private async resolvePendingApprovalsForTurn(
    turnId: string,
    decision: "allow" | "deny",
  ): Promise<void> {
    const pendingForTurn: PendingApproval[] = [];
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.turnId !== turnId) continue;
      pendingForTurn.push(pending);
      this.pendingApprovals.delete(approvalId);
    }
    await Promise.all(pendingForTurn.map((pending) => pending.resolve(decision)));
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
        this.deps.bus.emit("runtime_error", {
          kind: "runtime_error",
          threadId: turn.threadId,
          turnId: turn.id,
          code: "internal",
          message: `Skill load warning at ${validationError.root}: ${validationError.message}`,
        });
      }
      return resolution;
    } catch (error) {
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: turn.threadId,
        turnId: turn.id,
        code: "internal",
        message: `Skill resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      });
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

function normalizeThreadGoalUpdate(update: {
  goal?: string | null;
  status?: ThreadGoal["status"];
  summary?: string;
}): {
  goal?: string | null;
  status?: ThreadGoal["status"];
  summary?: string;
} {
  const normalized: {
    goal?: string | null;
    status?: ThreadGoal["status"];
    summary?: string;
  } = {};
  if (update.goal !== undefined) {
    if (update.goal === null) {
      if (update.status !== undefined || update.summary !== undefined) {
        throw new Error("Goal clear cannot be combined with status or summary.");
      }
      normalized.goal = null;
    } else {
      if (typeof update.goal !== "string" || !update.goal.trim()) {
        throw new Error("Goal text is required.");
      }
      normalized.goal = update.goal.trim();
    }
  }
  if (update.status !== undefined) {
    if (!isThreadGoalStatus(update.status)) {
      throw new Error("Goal status must be active, complete, or blocked.");
    }
    normalized.status = update.status;
  }
  if (update.summary !== undefined) {
    if (typeof update.summary !== "string" || !update.summary.trim()) {
      throw new Error("Goal summary must be a non-empty string.");
    }
    normalized.summary = update.summary.trim();
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("Goal update must include at least one of goal, status, or summary.");
  }
  return normalized;
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

function interruptedToolMessage(toolName: string): string {
  if (COMMAND_TOOL_NAME_SET.has(toolName)) {
    return "Command was interrupted.";
  }
  return "Tool was interrupted.";
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

async function waitForInterruptedToolExecutions(
  executions: Promise<void>[],
): Promise<boolean> {
  if (executions.length === 0) return true;
  let timedOut = false;
  await Promise.race([
    Promise.all(executions),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, ACTIVE_TOOL_INTERRUPT_SETTLE_TIMEOUT_MS);
    }),
  ]);
  return !timedOut;
}

function normalizeTurnStartRequest(request: unknown): NormalizedTurnStartRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Turn start request must be an object.");
  }
  const value = request as Record<string, unknown>;
  const threadId = requiredString(value.threadId, "Turn threadId is required.");
  const text = requiredString(value.text, "Turn text is required.");
  const displayText = optionalString(value.displayText, "Turn displayText must be a string.");
  const model = optionalString(value.model, "Turn model must be a string.");
  const modelProfileId = optionalString(
    value.modelProfileId,
    "Turn modelProfileId must be a string.",
  );
  const reasoningEffort = resolveTurnReasoningEffort(value.reasoningEffort);
  const mode = resolveTurnMode(value.mode);
  const goalMode = resolveTurnGoalMode(value.goalMode);
  return {
    threadId,
    text,
    ...(displayText !== undefined ? { displayText } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelProfileId !== undefined ? { modelProfileId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    attachmentIds: resolveTurnAttachmentIds(value.attachmentIds),
    ...(mode !== undefined ? { mode } : {}),
    ...(goalMode !== undefined ? { goalMode } : {}),
  };
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function resolveTurnReasoningEffort(
  value: unknown,
): TurnRecord["reasoningEffort"] | undefined {
  if (value === undefined) return undefined;
  if (isModelReasoningEffort(value)) return value;
  throw new Error("Turn reasoningEffort is invalid.");
}

function resolveTurnMode(value: unknown): TurnMode | undefined {
  if (value === undefined) return undefined;
  if (value === "agent" || value === "plan") return value;
  throw new Error("Turn mode must be agent or plan.");
}

function resolveTurnGoalMode(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error("Turn goalMode must be a boolean.");
}

function resolveTurnAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Turn attachmentIds must be a string array.");
  }
  return value;
}

function isApprovalPreview(value: unknown): value is ApprovalItem["preview"] {
  if (!value || typeof value !== "object") return false;
  const preview = value as Record<string, unknown>;
  if (preview.kind === "multi_file_diff") {
    return (
      Array.isArray(preview.files) &&
      preview.files.every(isFileDiffPreview) &&
      isNonNegativeInteger(preview.added) &&
      isNonNegativeInteger(preview.removed)
    );
  }
  return isFileDiffPreview(preview);
}

function isFileDiffPreview(preview: Record<string, unknown>): boolean {
  return (
    preview.kind === "file_diff" &&
    typeof preview.path === "string" &&
    (preview.operation === "create" || preview.operation === "update" || preview.operation === "delete") &&
    isNonNegativeInteger(preview.added) &&
    isNonNegativeInteger(preview.removed) &&
    Array.isArray(preview.lines) &&
    preview.lines.every(isFileDiffLine)
  );
}

function isFileDiffLine(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  return (
    (line.type === "context" || line.type === "added" || line.type === "removed") &&
    typeof line.text === "string"
  );
}

function prepareMessagesForRequest(
  messages: AgentMessage[],
  options: {
    systemPrompt: string;
    tools: AgentToolDefinition[];
    compactTokenLimit: number;
    contextWindow: number;
    maxTokens: number;
    compaction: RuntimePreferences["compaction"];
  },
): AgentMessage[] {
  const budget = resolveContextBudget(options);
  if (!options.compaction.enabled) {
    return enforceHardContextLimit(messages, budget);
  }

  if (options.compaction.strategy === "recent-only") {
    return prepareRecentOnlyMessages(messages, budget);
  }

  if (options.compaction.strategy === "aggressive") {
    return prepareAggressiveMessages(messages, budget);
  }

  let prepared = applyRequestHistoryHygiene(
    messages,
    options.compaction.strategy === "preserve-tools"
      ? PRESERVE_TOOLS_REQUEST_HYGIENE_PROFILE
      : DEFAULT_REQUEST_HYGIENE_PROFILE,
  );
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = trimOldestDynamicMessages(prepared, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = applyRequestHistoryHygiene(prepared, TIGHT_REQUEST_HYGIENE_PROFILE);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = trimOldestDynamicMessages(prepared, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  return compactMandatoryMessagesToFit(prepared, budget);
}

function prepareRecentOnlyMessages(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  if (isWithinRequestBudget(messages, budget)) {
    return messages;
  }

  let prepared = trimOldestDynamicMessages(messages, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = applyRequestHistoryHygiene(prepared, TIGHT_REQUEST_HYGIENE_PROFILE);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  return compactMandatoryMessagesToFit(prepared, budget);
}

function prepareAggressiveMessages(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  let prepared = applyRequestHistoryHygiene(messages, TIGHT_REQUEST_HYGIENE_PROFILE);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = trimOldestDynamicMessages(prepared, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  return compactMandatoryMessagesToFit(prepared, budget);
}

function enforceHardContextLimit(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  if (isWithinRequestBudget(messages, budget)) {
    return messages;
  }

  const trimmed = trimOldestDynamicMessages(messages, budget);
  if (isWithinRequestBudget(trimmed, budget)) {
    return trimmed;
  }

  return compactMandatoryMessagesToFit(trimmed, budget);
}

interface ContextBudgetOptions {
  systemPrompt: string;
  tools: AgentToolDefinition[];
  compactTokenLimit: number;
  contextWindow: number;
  maxTokens: number;
}

interface ResolvedContextBudget {
  systemPrompt: string;
  tools: AgentToolDefinition[];
  tokenLimit: number;
}

interface RequestHygieneProfile {
  toolResultMaxLines: number;
  toolResultMaxBytes: number;
  toolArgumentStringMaxBytes: number;
  toolArgumentArrayMaxItems: number;
}

const DEFAULT_REQUEST_HYGIENE_PROFILE: RequestHygieneProfile = {
  toolResultMaxLines: TOOL_RESULT_MAX_LINES,
  toolResultMaxBytes: TOOL_RESULT_MAX_BYTES,
  toolArgumentStringMaxBytes: TOOL_ARGUMENT_STRING_MAX_BYTES,
  toolArgumentArrayMaxItems: TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
};

const TIGHT_REQUEST_HYGIENE_PROFILE: RequestHygieneProfile = {
  toolResultMaxLines: TIGHT_TOOL_RESULT_MAX_LINES,
  toolResultMaxBytes: TIGHT_TOOL_RESULT_MAX_BYTES,
  toolArgumentStringMaxBytes: TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES,
  toolArgumentArrayMaxItems: TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
};

const PRESERVE_TOOLS_REQUEST_HYGIENE_PROFILE: RequestHygieneProfile = {
  toolResultMaxLines: TOOL_RESULT_MAX_LINES,
  toolResultMaxBytes: TOOL_RESULT_MAX_BYTES,
  toolArgumentStringMaxBytes: TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES,
  toolArgumentArrayMaxItems: TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
};

function resolveContextBudget(options: ContextBudgetOptions): ResolvedContextBudget {
  const configuredLimit = Math.max(1, options.compactTokenLimit);
  const contextWindow = Math.max(1, options.contextWindow);
  const maxOutputTokens = Math.max(0, options.maxTokens);
  const availableInputTokens = Math.max(1, contextWindow - maxOutputTokens);
  return {
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    tokenLimit: Math.max(
      1,
      Math.floor(Math.min(configuredLimit, availableInputTokens) * CONTEXT_BUDGET_SAFETY_RATIO),
    ),
  };
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

function isWithinRequestBudget(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): boolean {
  return estimateRequestTokens(budget.systemPrompt, messages, budget.tools) <= budget.tokenLimit;
}

function applyRequestHistoryHygiene(
  messages: AgentMessage[],
  profile: RequestHygieneProfile,
): AgentMessage[] {
  let changed = false;
  const completedToolCallIds = new Set(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => message.toolCallId as string),
  );
  const next = messages.map((message) => {
    if (message.role === "tool") {
      const content = compactToolResultContent(message.content, profile);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      let toolCallsChanged = false;
      const toolCalls = message.toolCalls.map((call) => {
        if (!completedToolCallIds.has(call.id)) return call;
        const compactedArguments = compactToolArguments(call.arguments, profile);
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
  budget: ResolvedContextBudget,
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
    if (!isWithinRequestBudget(candidate, budget)) {
      break;
    }
    keep.unshift(...segments[index]);
  }
  return keep.length > 0 ? keep : messages.slice(-1);
}

function compactMandatoryMessagesToFit(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  let prepared = compactMessages(messages, DEFAULT_MANDATORY_COMPACTION_PROFILE);
  for (let pass = 0; pass < MAX_PROGRESSIVE_COMPACTION_PASSES; pass += 1) {
    if (isWithinRequestBudget(prepared, budget)) {
      return prepared;
    }
    prepared = compactMessages(prepared, createProgressiveCompactionProfile(pass));
  }
  return prepared;
}

interface MandatoryCompactionProfile extends RequestHygieneProfile {
  systemMessageMaxBytes: number;
  assistantMessageMaxBytes: number;
  userMessageMaxBytes: number;
}

const DEFAULT_MANDATORY_COMPACTION_PROFILE: MandatoryCompactionProfile = {
  ...TIGHT_REQUEST_HYGIENE_PROFILE,
  systemMessageMaxBytes: TIGHT_SYSTEM_MESSAGE_MAX_BYTES,
  assistantMessageMaxBytes: TIGHT_ASSISTANT_MESSAGE_MAX_BYTES,
  userMessageMaxBytes: TIGHT_USER_MESSAGE_MAX_BYTES,
};

function createProgressiveCompactionProfile(pass: number): MandatoryCompactionProfile {
  const divisor = 2 ** (pass + 1);
  return {
    toolResultMaxLines: Math.max(1, Math.floor(TIGHT_TOOL_RESULT_MAX_LINES / divisor)),
    toolResultMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_TOOL_RESULT_MAX_BYTES / divisor),
    ),
    toolArgumentStringMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES / divisor),
    ),
    toolArgumentArrayMaxItems: Math.max(1, Math.floor(TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS / divisor)),
    systemMessageMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_SYSTEM_MESSAGE_MAX_BYTES / divisor),
    ),
    assistantMessageMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_ASSISTANT_MESSAGE_MAX_BYTES / divisor),
    ),
    userMessageMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_USER_MESSAGE_MAX_BYTES / divisor),
    ),
  };
}

function compactMessages(
  messages: AgentMessage[],
  profile: MandatoryCompactionProfile,
): AgentMessage[] {
  return messages.map((message) => {
    let nextMessage = message;
    if (message.role === "tool") {
      nextMessage = {
        ...message,
        content: compactContentToBytes(message.content, profile.toolResultMaxBytes),
      };
    } else {
      const maxBytes =
        message.role === "system"
          ? profile.systemMessageMaxBytes
          : message.role === "assistant"
            ? profile.assistantMessageMaxBytes
            : profile.userMessageMaxBytes;
      nextMessage = {
        ...message,
        content: compactContentToBytes(message.content, maxBytes),
      };
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      return nextMessage;
    }

    let toolCallsChanged = false;
    const toolCalls = message.toolCalls.map((call) => {
      const compactedArguments = compactToolArguments(call.arguments, profile);
      if (compactedArguments === call.arguments) return call;
      toolCallsChanged = true;
      return { ...call, arguments: compactedArguments };
    });
    return toolCallsChanged ? { ...nextMessage, toolCalls } : nextMessage;
  });
}

function compactContentToBytes(
  content: AgentMessage["content"],
  maxBytes: number,
): AgentMessage["content"] {
  if (typeof content === "string") {
    return compactTextToBytes(content, maxBytes);
  }

  let changed = false;
  const blocks = content.map((block) => {
    if (block.type === "text") {
      const text = compactTextToBytes(block.text, maxBytes);
      if (text !== block.text) changed = true;
      return { ...block, text };
    }
    changed = true;
    return {
      type: "text" as const,
      text: `[context budget: omitted ${block.mimeType} attachment from oversized request message]`,
    };
  });
  return changed ? blocks : content;
}

function compactTextToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  if (maxBytes < MIN_TEXT_COMPACTION_BYTES) {
    return "[context budget: omitted oversized text]";
  }
  const marker = "\n[context budget: omitted oversized text middle]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const available = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(available * 0.6);
  const tailBytes = available - headBytes;
  return `${sliceUtf8(text, headBytes)}${marker}${sliceUtf8FromEnd(text, tailBytes)}`;
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

function compactToolResultContent(
  content: AgentMessage["content"],
  profile: RequestHygieneProfile,
): AgentMessage["content"] {
  if (typeof content === "string") {
    return compactToolResultText(content, profile);
  }
  let changed = false;
  const blocks = content.map((block) => {
    if (block.type === "text") {
      const text = compactToolResultText(block.text, profile);
      if (text !== block.text) changed = true;
      return { ...block, text };
    }
    changed = true;
    return {
      type: "text" as const,
      text: `[context budget: omitted ${block.mimeType} attachment from historical tool result]`,
    };
  });
  return changed ? blocks : content;
}

function compactToolResultText(text: string, profile: RequestHygieneProfile): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  if (originalBytes <= profile.toolResultMaxBytes && lines.length <= profile.toolResultMaxLines) {
    return text;
  }

  const headCount = Math.min(80, Math.max(1, Math.floor(profile.toolResultMaxLines * 0.25)));
  const tailCount = Math.min(120, Math.max(1, Math.floor(profile.toolResultMaxLines * 0.35)));
  const signalLines = lines
    .slice(headCount, Math.max(headCount, lines.length - tailCount))
    .filter((line) => /\b(error|failed?|fatal|exception|warning|denied|timeout|not found|invalid)\b/i.test(line))
    .slice(0, Math.max(0, profile.toolResultMaxLines - headCount - tailCount));
  const selected = [
    ...lines.slice(0, headCount),
    ...signalLines,
    ...lines.slice(Math.max(headCount, lines.length - tailCount)),
  ];
  const fitted = fitLinesToBytes(selected, profile.toolResultMaxBytes);
  const omittedLines = Math.max(0, lines.length - fitted.length);
  const marker = `[context budget: omitted ${omittedLines} historical tool result line(s); narrow the next read/search for details]`;
  return [...fitted, marker].join("\n");
}

function compactToolArguments(
  args: Record<string, unknown>,
  profile: RequestHygieneProfile,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const compacted = compactArgumentValue(key, value, profile);
    out[key] = compacted.value;
    changed ||= compacted.changed;
  }
  return changed ? out : args;
}

function compactArgumentValue(
  key: string,
  value: unknown,
  profile: RequestHygieneProfile,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (isBase64Like(key, value)) {
      return {
        value: `[context budget: omitted base64 argument, ${Buffer.byteLength(value, "utf8")} bytes]`,
        changed: true,
      };
    }
    if (Buffer.byteLength(value, "utf8") > profile.toolArgumentStringMaxBytes) {
      return {
        value: compactArgumentString(value, profile.toolArgumentStringMaxBytes),
        changed: true,
      };
    }
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const selected =
      value.length > profile.toolArgumentArrayMaxItems
        ? [
            ...value.slice(0, Math.floor(profile.toolArgumentArrayMaxItems * 0.75)),
            { context_budget_omitted_items: value.length - profile.toolArgumentArrayMaxItems },
            ...value.slice(
              -(profile.toolArgumentArrayMaxItems - Math.floor(profile.toolArgumentArrayMaxItems * 0.75)),
            ),
          ]
        : value;
    changed ||= selected !== value;
    const compacted = selected.map((item) => {
      const child = compactArgumentValue(key, item, profile);
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
    const child = compactArgumentValue(childKey, childValue, profile);
    out[childKey] = child.value;
    changed ||= child.changed;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

function compactArgumentString(value: string, maxBytes: number): string {
  if (maxBytes < MIN_TEXT_COMPACTION_BYTES) {
    return `[context budget: omitted long argument, ${Buffer.byteLength(value, "utf8")} bytes]`;
  }
  const marker = "\n[context budget: omitted long argument tail]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.max(0, maxBytes - markerBytes);
  return `${sliceUtf8(value, headBytes)}${marker}`;
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

function sliceUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

function sliceUtf8FromEnd(value: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  const chars = Array.from(value);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out = `${char}${out}`;
    bytes += charBytes;
  }
  return out;
}

function estimateRequestTokens(
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): number {
  return estimateTokens(
    stableStringify({
      systemPrompt,
      messages,
      tools,
    }),
  );
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
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

function isBase64Like(key: string, value: string): boolean {
  return (
    /(?:^|_)(?:data_)?base64$/i.test(key) ||
    /^data:[^;,]+;base64,/i.test(value)
  );
}
