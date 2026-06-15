import { randomUUID } from "node:crypto";
import type { AgentToolCall, AgentToolResult } from "../domain/agent/types.js";
import type { ToolRegistry } from "../domain/agent/ports.js";
import { JsonlThreadStore } from "../persistence/index.js";
import { CheckpointStore } from "../persistence/checkpoint-store.js";
import { RuntimeEventBus } from "../event-bus.js";
import { FileReadStateStore } from "./tools/file-read-state.js";
import { FileHistoryStore } from "./tools/file-history-state.js";
import {
  ACTIVE_TOOL_INTERRUPT_SETTLE_TIMEOUT_MS,
  READ_ONLY_TOOL_REPEAT_SUPPRESSION_THRESHOLD,
} from "./constants.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";
import { ToolCatalogService, isCommandToolName } from "./tool-catalog.js";
import { ToolPolicyService } from "./tool-policy.js";
import { validateToolInputSchema } from "./tools/tool-schema.js";
import type {
  ApprovalItem,
  ApprovalRespondRequest,
  ModelConfig,
  RuntimeErrorEvent,
  RuntimePreferences,
  ThreadRecord,
  ToolFailureCode,
  ToolFailureResult,
  ToolItem,
  ToolProgressStream,
  TurnRecord,
} from "../../shared/agent-contracts.js";
import { isNonNegativeInteger } from "../../shared/agent-contracts.js";

interface ActiveToolExecution {
  item: ToolItem;
  controller?: AbortController;
  finalizedByInterrupt: boolean;
  settled?: Promise<void>;
}

type RuntimeErrorReporter = (
  turn: { threadId: string; id: string } | undefined,
  code: RuntimeErrorEvent["code"],
  message: string,
  error?: unknown,
) => void;

type SubagentSkillExecutor = (
  turn: TurnRecord,
  thread: ThreadRecord,
  call: AgentToolCall,
  runtimePreferences: RuntimePreferences,
  modelConfig: ModelConfig,
  signal: AbortSignal,
) => Promise<AgentToolResult> | null;

export interface ToolCallExecutorDeps {
  store: JsonlThreadStore;
  checkpointStore?: CheckpointStore;
  bus: RuntimeEventBus;
  registry: ToolRegistry;
  toolCatalog: ToolCatalogService;
  readState: FileReadStateStore;
  fileHistory: FileHistoryStore;
  executeSubagentSkillCall: SubagentSkillExecutor;
  appendPlanItem: (turn: TurnRecord, rawContent: string) => Promise<void>;
  reportRuntimeError: RuntimeErrorReporter;
}

/**
 * Owns parent-turn tool execution lifecycle: tool timeline records, catalog and
 * policy checks, approval suspension, live progress, and interruption cleanup.
 * Model/subagent orchestration stays in AgentRuntime and is injected here.
 */
export class ToolCallExecutor {
  private readonly activeToolExecutions = new Map<string, Set<ActiveToolExecution>>();
  private readonly readOnlyToolRepeatCounts = new Map<string, Map<string, number>>();
  private readonly toolPolicy: ToolPolicyService;
  private readonly approvals: ApprovalCoordinator;

  constructor(private readonly deps: ToolCallExecutorDeps) {
    this.toolPolicy = new ToolPolicyService(deps.registry);
    this.approvals = new ApprovalCoordinator({
      store: deps.store,
      bus: deps.bus,
      previewProvider: (call, turn, thread) => this.buildApprovalPreview(call, turn, thread),
    });
  }

  respondApproval(approval: ApprovalRespondRequest): void {
    this.approvals.respond(approval);
  }

  resolvePendingApprovalsForTurn(turnId: string, decision: "allow" | "deny"): Promise<void> {
    return this.approvals.resolvePendingForTurn(turnId, decision);
  }

  async execute(
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

    const isToolAvailable = this.deps.toolCatalog.isToolAvailableForTurn(
      call.name,
      turn,
      thread,
      runtimePreferences,
    );
    if (!isToolAvailable) {
      const message = `Tool "${call.name}" is not available in this turn.`;
      toolItem.status = "failed";
      toolItem.result = toolFailureResult("tool_unavailable", message);
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      this.deps.reportRuntimeError(turn, "tool_not_found", message);
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    const tool = this.deps.registry.getTool(call.name);
    if (!tool) {
      const message = `Tool "${call.name}" is not registered.`;
      toolItem.status = "failed";
      toolItem.result = toolFailureResult("tool_not_registered", message);
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      this.deps.reportRuntimeError(turn, "tool_not_found", message);
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    try {
      validateToolInputSchema(tool.definition.name, tool.definition.inputSchema, call.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toolItem.status = "failed";
      toolItem.result = toolFailureResult("tool_schema_invalid", message);
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      this.deps.reportRuntimeError(turn, "tool_failed", `${call.name}: ${message}`, error);
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    // Read-only retries are safe to suppress because they cannot mutate the
    // workspace; the visible failed ToolItem keeps the model/user audit trail.
    const repeatInspection = this.inspectReadOnlyToolRepeat(turn.id, call);
    if (repeatInspection.suppressed) {
      const message = [
        `Tool "${call.name}" was called with identical arguments ${repeatInspection.count} time(s) in this turn.`,
        "The duplicate read-only call was not executed; reuse the earlier result or change the arguments.",
      ].join(" ");
      toolItem.status = "failed";
      toolItem.result = toolFailureResult("tool_repeat_suppressed", message, {
        suppressed: true,
        reason: "repeat_read_only_tool_call",
        count: repeatInspection.count,
        threshold: repeatInspection.threshold,
      });
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }

    const policyDecision = this.toolPolicy.resolve({
      call,
      turn,
      thread,
      runtimePreferences,
      isToolAvailable,
    });
    if (policyDecision === "deny") {
      const message = `Tool "${call.name}" is denied by thread policy.`;
      toolItem.status = "failed";
      toolItem.result = toolFailureResult("tool_policy_denied", message, {
        denied: true,
      });
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
        const approval = await this.approvals.requestApproval(turn, call, thread);
        if (approval === "deny") {
          if (activeExecution.finalizedByInterrupt) {
            this.unregisterActiveToolExecution(turn.id, activeExecution);
            return interruptedToolResult(call, toolItem);
          }
          const message = `Tool "${call.name}" was denied by user approval.`;
          toolItem.status = "failed";
          toolItem.result = toolFailureResult("tool_approval_denied", message, {
            denied: true,
          });
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
        return interruptedToolResult(call, toolItem);
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
        readState: this.deps.readState,
        fileHistory: this.deps.fileHistory,
        checkpoint: this.deps.checkpointStore,
      };
      const executionPromise =
        this.deps.executeSubagentSkillCall(
          turn,
          thread,
          call,
          runtimePreferences,
          modelConfig,
          controller.signal,
        ) ??
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
        return interruptedToolResult(call, toolItem);
      }
      toolItem.status = "completed";
      toolItem.result = content.displayResult ?? content;
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      if (call.name === "create_plan") {
        await this.deps.appendPlanItem(turn, content.content);
      }
      return content;
    } catch (error) {
      if (activeExecution.finalizedByInterrupt) {
        this.unregisterActiveToolExecution(turn.id, activeExecution);
        return interruptedToolResult(call, toolItem);
      }
      const message = error instanceof Error ? error.message : String(error);
      toolItem.status = "failed";
      toolItem.result = toolFailureResult("tool_execution_failed", message);
      await this.deps.store.appendItem(turn.threadId, toolItem);
      this.emitToolItemUpdated(turn, toolItem);
      this.unregisterActiveToolExecution(turn.id, activeExecution);
      if (turn.status !== "interrupted") {
        this.deps.reportRuntimeError(turn, "tool_failed", `${call.name}: ${message}`, error);
      }
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolItem.result),
      };
    }
  }

  clearReadOnlyToolRepeatStateForTurn(turnId: string): void {
    this.readOnlyToolRepeatCounts.delete(turnId);
  }

  async interruptActiveToolExecutionsForTurn(turn: TurnRecord): Promise<void> {
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
      execution.item.result = toolFailureResult(
        "tool_interrupted",
        interruptedToolMessage(execution.item.name),
      );
      try {
        await this.deps.store.appendItem(turn.threadId, execution.item);
      } catch (error) {
        this.deps.reportRuntimeError(
          turn,
          "persistence_error",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      this.emitToolItemUpdated(turn, execution.item);
    }
    if (!await waitForInterruptedToolExecutions(settling)) {
      this.deps.reportRuntimeError(turn, "internal", "Timed out waiting for interrupted tools to settle.");
    }
  }

  private inspectReadOnlyToolRepeat(
    turnId: string,
    call: AgentToolCall,
  ): { suppressed: boolean; count: number; threshold: number } {
    const tool = this.deps.registry.getTool(call.name);
    if (!tool?.metadata?.isReadOnly) {
      return {
        suppressed: false,
        count: 0,
        threshold: READ_ONLY_TOOL_REPEAT_SUPPRESSION_THRESHOLD,
      };
    }
    const key = `${call.name}:${stableJsonStringify(call.arguments)}`;
    const repeatCounts = this.readOnlyToolRepeatCounts.get(turnId) ?? new Map<string, number>();
    const count = (repeatCounts.get(key) ?? 0) + 1;
    repeatCounts.set(key, count);
    this.readOnlyToolRepeatCounts.set(turnId, repeatCounts);
    return {
      suppressed: count >= READ_ONLY_TOOL_REPEAT_SUPPRESSION_THRESHOLD,
      count,
      threshold: READ_ONLY_TOOL_REPEAT_SUPPRESSION_THRESHOLD,
    };
  }

  private async buildApprovalPreview(
    call: AgentToolCall,
    turn: TurnRecord,
    thread: ThreadRecord,
  ): Promise<ApprovalItem["preview"] | undefined> {
    const tool = this.deps.registry.getTool(call.name);
    if (!tool?.preview) return undefined;
    validateToolInputSchema(tool.definition.name, tool.definition.inputSchema, call.arguments);
    const preview = await tool.preview(call.arguments, {
      threadId: turn.threadId,
      turnId: turn.id,
      workspace: thread.workspace,
      readState: this.deps.readState,
      fileHistory: this.deps.fileHistory,
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

  private emitToolItemUpdated(turn: TurnRecord, item: ToolItem): void {
    this.deps.bus.emit("item_updated", {
      kind: "item_updated",
      threadId: turn.threadId,
      turnId: turn.id,
      item,
    });
  }
}

function interruptedToolResult(call: AgentToolCall, item: ToolItem): AgentToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(
      item.result ?? toolFailureResult("tool_interrupted", interruptedToolMessage(call.name)),
    ),
  };
}

function toolFailureResult(
  code: ToolFailureCode,
  message: string,
  extra: Partial<Omit<ToolFailureResult, "code" | "message">> = {},
): ToolFailureResult {
  return {
    code,
    message,
    ...extra,
  };
}

function interruptedToolMessage(toolName: string): string {
  if (isCommandToolName(toolName)) {
    return "Command was interrupted.";
  }
  return "Tool was interrupted.";
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

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]),
  );
}
