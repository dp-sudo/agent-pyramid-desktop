import type {
  Item,
  ToolItem,
} from "../../shared/agent-contracts.js";
import { getRuntimeToolCompletionEvidence } from "../../shared/runtime-tool-contracts.js";

export type CompletionEvidenceCheckpointState =
  | { kind: "available"; paths: readonly string[] }
  | { kind: "not_configured" }
  | { kind: "lookup_failed"; message: string };

export interface CompletionEvidenceInput {
  items: readonly Item[];
  checkpointState: CompletionEvidenceCheckpointState;
}

interface FileChangeEvidence {
  path: string;
  operation: string;
  toolName: string;
  added?: number;
  removed?: number;
}

interface CommandEvidence {
  toolName: string;
  status: ToolItem["status"];
  resultStatus?: string;
  command?: string;
  exitCode?: number | null;
  timedOut: boolean;
  success: boolean;
}

interface FileChangeSummary {
  path: string;
  operations: string[];
  added?: number;
  removed?: number;
}

const MAX_LISTED_ENTRIES = 8;
const MAX_COMMAND_TEXT_LENGTH = 96;
const MAX_ERROR_TEXT_LENGTH = 120;

/**
 * Builds a user-visible audit from durable ToolItem results only. The text does
 * not assert "tests passed" unless a command result actually completed with a
 * zero exit code; missing evidence is surfaced as remaining risk.
 */
export function buildTurnCompletionEvidenceText(
  input: CompletionEvidenceInput,
): string | null {
  const toolItems = latestToolItems(input.items);
  const relevantTools = toolItems.filter(isDevelopmentEvidenceTool);
  if (relevantTools.length === 0) return null;

  const fileChanges = collectFileChanges(relevantTools);
  const commandRuns = collectCommandRuns(relevantTools);
  const failedTools = relevantTools.filter((item) => item.status === "failed");
  const checkpointCoverage = computeCheckpointCoverage(fileChanges, input.checkpointState);

  return [
    "Completion evidence:",
    `files changed: ${formatFileChanges(fileChanges)}`,
    `commands: ${formatCommandRuns(commandRuns)}`,
    `checkpoints: ${formatCheckpointCoverage(checkpointCoverage, input.checkpointState)}`,
    `remaining risk: ${formatRemainingRisk({
      fileChanges,
      commandRuns,
      failedTools,
      checkpointCoverage,
      checkpointState: input.checkpointState,
    })}`,
  ].join(" ");
}

function latestToolItems(items: readonly Item[]): ToolItem[] {
  const byId = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.kind === "tool") {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

function isDevelopmentEvidenceTool(item: ToolItem): boolean {
  return getRuntimeToolCompletionEvidence(item.name) !== null;
}

function collectFileChanges(items: readonly ToolItem[]): FileChangeEvidence[] {
  return items.flatMap((item) => {
    if (getRuntimeToolCompletionEvidence(item.name) !== "file_change" || item.status !== "completed") {
      return [];
    }
    return fileChangesFromResult(item);
  });
}

function fileChangesFromResult(item: ToolItem): FileChangeEvidence[] {
  const result = asRecord(item.result);
  if (!result) return [];
  const files = result.files;
  if (Array.isArray(files)) {
    return files.flatMap((file) => {
      const record = asRecord(file);
      const change = record ? readFileChange(record, item.name) : null;
      return change ? [change] : [];
    });
  }
  const change = readFileChange(result, item.name);
  return change ? [change] : [];
}

function readFileChange(
  record: Record<string, unknown>,
  toolName: string,
): FileChangeEvidence | null {
  const path = readString(record, "path");
  const operation = readString(record, "operation");
  if (!path || !operation) return null;

  const diff = asRecord(record.diff);
  const added = diff ? readNumber(diff, "added") : readNumber(record, "added");
  const removed = diff ? readNumber(diff, "removed") : readNumber(record, "removed");
  return {
    path,
    operation,
    toolName,
    ...(added !== undefined ? { added } : {}),
    ...(removed !== undefined ? { removed } : {}),
  };
}

function collectCommandRuns(items: readonly ToolItem[]): CommandEvidence[] {
  return items.flatMap((item) => {
    if (getRuntimeToolCompletionEvidence(item.name) !== "command") return [];
    const result = asRecord(item.result);
    const command = result ? readString(result, "command") : readString(item.args, "command");
    const exitCode = result ? readNullableNumber(result, "exitCode") : undefined;
    const resultStatus = result ? readString(result, "status") : undefined;
    const timedOut = result ? readBoolean(result, "timedOut") ?? false : false;
    const success = commandRunSucceeded(item.name, item.status, resultStatus, exitCode, timedOut);
    return [{
      toolName: item.name,
      status: item.status,
      ...(resultStatus ? { resultStatus } : {}),
      ...(command ? { command } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      timedOut,
      success,
    }];
  });
}

function computeCheckpointCoverage(
  fileChanges: readonly FileChangeEvidence[],
  checkpointState: CompletionEvidenceCheckpointState,
): { changedPaths: string[]; coveredPaths: string[] } {
  const changedPaths = uniqueSorted(fileChanges.map((change) => change.path));
  if (checkpointState.kind !== "available") {
    return { changedPaths, coveredPaths: [] };
  }
  const checkpointPaths = new Set(checkpointState.paths);
  return {
    changedPaths,
    coveredPaths: changedPaths.filter((changedPath) => checkpointPaths.has(changedPath)),
  };
}

function formatFileChanges(fileChanges: readonly FileChangeEvidence[]): string {
  if (fileChanges.length === 0) return "none recorded;";
  const summaries = summarizeFileChanges(fileChanges);
  const entries = summaries.map((summary) => {
    const counts = summary.added !== undefined && summary.removed !== undefined
      ? ` (+${summary.added}/-${summary.removed})`
      : "";
    return `${summary.path} ${summary.operations.join("+")}${counts}`;
  });
  return `${summaries.length} file(s): ${formatBoundedList(entries)};`;
}

function summarizeFileChanges(fileChanges: readonly FileChangeEvidence[]): FileChangeSummary[] {
  const byPath = new Map<string, {
    operations: Set<string>;
    added: number;
    removed: number;
    hasCounts: boolean;
  }>();
  for (const change of fileChanges) {
    const current = byPath.get(change.path) ?? {
      operations: new Set<string>(),
      added: 0,
      removed: 0,
      hasCounts: false,
    };
    current.operations.add(change.operation);
    if (change.added !== undefined && change.removed !== undefined) {
      current.added += change.added;
      current.removed += change.removed;
      current.hasCounts = true;
    }
    byPath.set(change.path, current);
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, summary]) => ({
      path,
      operations: [...summary.operations].sort((left, right) => left.localeCompare(right)),
      ...(summary.hasCounts ? { added: summary.added, removed: summary.removed } : {}),
    }));
}

function formatCommandRuns(commandRuns: readonly CommandEvidence[]): string {
  if (commandRuns.length === 0) return "none recorded;";
  const entries = commandRuns.map((run) => {
    const command = run.command ? `: ${truncateOneLine(run.command, MAX_COMMAND_TEXT_LENGTH)}` : "";
    return `${run.toolName} ${formatCommandStatus(run)}${command}`;
  });
  return `${commandRuns.length} command(s): ${formatBoundedList(entries)};`;
}

function formatCommandStatus(run: CommandEvidence): string {
  if (run.timedOut) return "timed out";
  if (run.resultStatus === "running" || run.resultStatus === "stopping") {
    return "still running";
  }
  if (run.resultStatus === "failed") return "failed";
  if (run.toolName === "write_command_session") return "input written";
  if (run.exitCode !== undefined) {
    return run.exitCode === 0
      ? "passed (exit 0)"
      : `failed (exit ${run.exitCode === null ? "null" : run.exitCode})`;
  }
  if (run.status === "completed") return "completed";
  if (run.status === "running") return "still running";
  if (run.status === "pending") return "pending";
  return "failed";
}

function commandRunSucceeded(
  toolName: string,
  toolStatus: ToolItem["status"],
  resultStatus: string | undefined,
  exitCode: number | null | undefined,
  timedOut: boolean,
): boolean {
  if (toolStatus !== "completed" || timedOut) return false;
  if (toolName === "write_command_session") return false;
  if (resultStatus === "running" || resultStatus === "stopping" || resultStatus === "failed") {
    return false;
  }
  if (exitCode === undefined) return true;
  return exitCode === 0;
}

function formatCheckpointCoverage(
  coverage: { changedPaths: readonly string[]; coveredPaths: readonly string[] },
  checkpointState: CompletionEvidenceCheckpointState,
): string {
  if (coverage.changedPaths.length === 0) return "no file snapshots needed;";
  if (checkpointState.kind === "not_configured") return "not configured;";
  if (checkpointState.kind === "lookup_failed") {
    return `lookup failed (${truncateOneLine(checkpointState.message, MAX_ERROR_TEXT_LENGTH)});`;
  }
  if (coverage.coveredPaths.length === coverage.changedPaths.length) {
    return `${coverage.coveredPaths.length}/${coverage.changedPaths.length} changed file snapshot(s) available;`;
  }
  return `${coverage.coveredPaths.length}/${coverage.changedPaths.length} changed file snapshot(s) available;`;
}

function formatRemainingRisk(input: {
  fileChanges: readonly FileChangeEvidence[];
  commandRuns: readonly CommandEvidence[];
  failedTools: readonly ToolItem[];
  checkpointCoverage: { changedPaths: readonly string[]; coveredPaths: readonly string[] };
  checkpointState: CompletionEvidenceCheckpointState;
}): string {
  if (input.failedTools.length > 0) {
    const names = uniqueSorted(input.failedTools.map((item) => item.name));
    return `some tools failed (${formatBoundedList(names)}); inspect failed tool cards.`;
  }
  if (input.commandRuns.some((run) => !run.success)) {
    return "one or more commands failed, timed out, or did not report a zero exit code.";
  }
  if (input.fileChanges.length > 0 && input.commandRuns.length === 0) {
    return "changed files were not verified by a command in this turn.";
  }
  if (
    input.fileChanges.length > 0 &&
    input.checkpointState.kind !== "available"
  ) {
    return "changed files do not have confirmed checkpoint lookup evidence.";
  }
  if (
    input.fileChanges.length > 0 &&
    input.checkpointCoverage.coveredPaths.length < input.checkpointCoverage.changedPaths.length
  ) {
    return "some changed files do not have checkpoint snapshots.";
  }
  if (input.fileChanges.length > 0) {
    return "not assessed beyond successful commands and available checkpoints.";
  }
  if (input.commandRuns.length > 0) {
    return "no file changes were made in this turn.";
  }
  return "none recorded.";
}

function formatBoundedList(entries: readonly string[]): string {
  const visible = entries.slice(0, MAX_LISTED_ENTRIES);
  const suffix = entries.length > visible.length
    ? `, and ${entries.length - visible.length} more`
    : "";
  return `${visible.join(", ")}${suffix}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
