import type {
  ApprovalPreview,
  AssistantItem,
  FileDiffLine,
  FileDiffPreview,
  Item,
  ToolItem,
  UserItem,
} from "../../../../../shared/agent-contracts";
import { isRuntimeToolName } from "../../../../../shared/agent-contracts";

type TimelineProcessItem = Exclude<Item, UserItem>;

export interface TimelineTurn {
  id: string;
  user: UserItem | null;
  processItems: TimelineProcessItem[];
  assistantItems: AssistantItem[];
  followupItems: TimelineProcessItem[];
}

interface MutableTimelineTurn {
  id: string;
  user: UserItem | null;
  blocks: TimelineProcessItem[];
}

export function groupTimelineTurns(
  items: readonly Item[],
  options: { sorted?: boolean } = {},
): TimelineTurn[] {
  const turns: MutableTimelineTurn[] = [];
  const byTurnId = new Map<string, MutableTimelineTurn>();
  const orderedItems = options.sorted ? items : sortTimelineItems(items);

  for (const item of orderedItems) {
    const turnId = getTimelineItemTurnId(item);
    let turn = byTurnId.get(turnId);
    if (!turn) {
      turn = { id: turnId, user: null, blocks: [] };
      byTurnId.set(turnId, turn);
      turns.push(turn);
    }

    if (item.kind === "user") {
      turn.user = item;
    } else {
      turn.blocks.push(item);
    }
  }

  return turns.map((turn) => deriveTurnSections(turn));
}

export function sortTimelineItems(items: readonly Item[]): Item[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const timeDelta = getTimelineItemTime(left.item) - getTimelineItemTime(right.item);
      return timeDelta !== 0 ? timeDelta : left.index - right.index;
    })
    .map(({ item }) => item);
}

export function getTimelineItemTurnId(item: Item): string {
  return "turnId" in item && typeof item.turnId === "string"
    ? item.turnId
    : `item:${item.id}`;
}

function getTimelineItemTime(item: Item): number {
  const timestamp = Date.parse(item.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function deriveTurnSections(turn: MutableTimelineTurn): TimelineTurn {
  const answerStart = findFinalAssistantStart(turn.blocks);
  const processItems: TimelineProcessItem[] = [];
  const assistantItems: AssistantItem[] = [];
  const followupItems: TimelineProcessItem[] = [];

  for (const [index, item] of turn.blocks.entries()) {
    if (item.kind === "assistant") {
      if (index >= answerStart && item.text.trim()) {
        assistantItems.push(item);
      } else if (item.text.trim()) {
        processItems.push(item);
      }
      continue;
    }

    if (index >= answerStart) {
      followupItems.push(item);
      continue;
    }

    if (isFollowupItem(item)) {
      followupItems.push(item);
      continue;
    }

    processItems.push(item);
  }

  return {
    id: turn.id,
    user: turn.user,
    processItems,
    assistantItems,
    followupItems,
  };
}

function findFinalAssistantStart(items: TimelineProcessItem[]): number {
  let start = items.length;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (isPassiveFollowupItem(item) && start === items.length) continue;
    if (item.kind !== "assistant" || !item.text.trim()) break;
    start = index;
  }

  return start;
}

function isFollowupItem(item: TimelineProcessItem): boolean {
  return item.kind === "plan";
}

function isPassiveFollowupItem(item: TimelineProcessItem): boolean {
  return item.kind === "reasoning" ||
    item.kind === "plan" ||
    item.kind === "compaction" ||
    item.kind === "system";
}

export interface ToolDisplay {
  title: string;
  detail: string;
  statusText: string;
  tone: "neutral" | "running" | "success" | "danger";
  compactTitle: string;
}

export interface ToolPreviewDisplay extends ToolDisplay {
  detailTruncated: boolean;
  hiddenCharCount: number;
}

export interface ToolChangeSummary {
  fileCount: number;
  added: number;
  removed: number;
  path?: string;
}

export function extractToolDiffPreview(result: unknown): ApprovalPreview | null {
  if (isApprovalPreviewValue(result)) return result;
  const record = asRecord(result);
  if (!record) return null;
  const diff = record.diff;
  return isApprovalPreviewValue(diff) ? diff : null;
}

export function summarizeToolChangeResult(item: ToolItem): ToolChangeSummary | null {
  if (!MODIFY_TOOL_NAMES.has(item.name)) return null;
  const preview = extractToolDiffPreview(item.result);
  if (!preview) return null;

  if (preview.kind === "file_diff") {
    return {
      fileCount: 1,
      path: preview.path,
      added: preview.added,
      removed: preview.removed,
    };
  }

  return {
    fileCount: preview.files.length,
    added: preview.added,
    removed: preview.removed,
  };
}

// Code-route compact rows derive a short action label + tone from the tool
// category and status, instead of the full card title+status used by Write /
// Inspector. Names are sourced from RUNTIME_TOOL_NAMES so the mapping stays in
// sync with the registered tool set; unknown tools (e.g. mcp__*) fall back to
// the generic executed/failed label.
export interface ToolAction {
  label: string;
  tone: "neutral" | "running" | "success" | "danger";
}

const EXPLORATORY_TOOL_NAMES = new Set<string>(["list_files", "search_files", "rg_search"]);
const READ_TOOL_NAMES = new Set<string>([
  "read_file",
  "list_symbols",
  "search_symbols",
  "create_edit_plan",
  "list_command_sessions",
  "diagnose_file",
  "diagnose_workspace",
]);
const MODIFY_TOOL_NAMES = new Set<string>([
  "edit_file",
  "multi_edit",
  "write_file",
  "delete_file",
  "apply_patch",
  "rollback_file",
]);
// Command-style tools run shell/git/package/test/build/session work; the rest of
// RUNTIME_TOOL_NAMES that is neither read-only nor a modify tool lands here so
// run_command, git_*, package_*, run_*, *_command_session etc. read as "executed".
const EXECUTE_TOOL_NAMES = new Set<string>([
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
  "create_plan",
  "update_goal",
]);

export function summarizeToolAction(
  item: ToolItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): ToolAction {
  // Status dominates the label so a failed/explore or running/modify still
  // surfaces the live outcome rather than the static category.
  if (item.status === "failed") {
    return { label: t("chat.toolAction.failed"), tone: "danger" };
  }
  if (item.status === "running") {
    return { label: t("chat.toolAction.running"), tone: "running" };
  }
  if (item.status === "pending") {
    return { label: t("chat.toolAction.pending"), tone: "neutral" };
  }

  if (EXPLORATORY_TOOL_NAMES.has(item.name)) {
    return { label: t("chat.toolAction.explored"), tone: "success" };
  }
  if (READ_TOOL_NAMES.has(item.name)) {
    return { label: t("chat.toolAction.read"), tone: "success" };
  }
  if (MODIFY_TOOL_NAMES.has(item.name)) {
    return { label: t("chat.toolAction.modified"), tone: "success" };
  }
  if (EXECUTE_TOOL_NAMES.has(item.name)) {
    return { label: t("chat.toolAction.executed"), tone: "success" };
  }
  // MCP tools (mcp__*) and any unknown tool: default to executed on completion.
  return { label: t("chat.toolAction.executed"), tone: "success" };
}

const JSON_PREVIEW_COLLECTION_LIMIT = 24;
const JSON_PREVIEW_MAX_DEPTH = 4;

export function summarizeToolItem(
  item: ToolItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): ToolDisplay {
  const header = summarizeToolItemHeader(item, t);
  return {
    ...header,
    detail: formatToolDetail(item),
  };
}

export function summarizeToolItemPreview(
  item: ToolItem,
  t: (key: string, options?: Record<string, unknown>) => string,
  maxDetailChars: number,
): ToolPreviewDisplay {
  // Inspector panels need bounded summaries; ChatBlock still owns the full
  // detail path so explicit timeline expansion can show complete tool output.
  const header = summarizeToolItemHeader(item, t);
  const detail = formatToolDetailPreview(item, maxDetailChars);
  return {
    ...header,
    detail: detail.text,
    detailTruncated: detail.truncated,
    hiddenCharCount: detail.hiddenCharCount,
  };
}

export function summarizeToolItemHeader(
  item: ToolItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): Omit<ToolDisplay, "detail"> {
  const path = readStringArg(item.args, "path") ??
    readStringArg(item.args, "workspace") ??
    readStringArg(item.args, "cwd");
  const query = readStringArg(item.args, "query") ?? readStringArg(item.args, "pattern");
  const command = readStringArg(item.args, "command");
  const title = titleForTool(item.name, { path, query, command }, t);
  return {
    title,
    statusText: statusText(item.status, t),
    tone: statusTone(item.status),
    compactTitle: compactTitleForTool(item, { path, query, command }, t),
  };
}

function titleForTool(
  name: string,
  args: {
    path?: string;
    query?: string;
    command?: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const { path, query, command } = args;
  switch (name) {
    case "list_files":
      return path
        ? t("chat.tools.listFilesPath", { path })
        : t("chat.tools.listFiles");
    case "read_file":
      return path
        ? t("chat.tools.readFilePath", { path })
        : t("chat.tools.readFile");
    case "search_files":
      return query
        ? t("chat.tools.searchFilesQuery", { query })
        : t("chat.tools.searchFiles");
    case "edit_file":
      return path
        ? t("chat.tools.editFilePath", { path })
        : t("chat.tools.editFile");
    case "multi_edit":
      return path
        ? t("chat.tools.multiEditPath", { path })
        : t("chat.tools.multiEdit");
    case "write_file":
      return path
        ? t("chat.tools.writeFilePath", { path })
        : t("chat.tools.writeFile");
    case "apply_patch":
      return t("chat.tools.applyPatch");
    case "rollback_file":
      return path
        ? t("chat.tools.rollbackFilePath", { path })
        : t("chat.tools.rollbackFile");
    case "run_command":
      return command
        ? t("chat.tools.runCommandCommand", { command })
        : t("chat.tools.runCommand");
    case "diagnose_workspace":
      return t("chat.tools.diagnoseWorkspace");
    case "diagnose_file":
      return path
        ? t("chat.tools.diagnoseFilePath", { path })
        : t("chat.tools.diagnoseFile");
    case "list_symbols":
      return path
        ? t("chat.tools.listSymbolsPath", { path })
        : t("chat.tools.listSymbols");
    case "search_symbols":
      return query
        ? t("chat.tools.searchSymbolsQuery", { query })
        : path
          ? t("chat.tools.searchSymbolsPath", { path })
          : t("chat.tools.searchSymbols");
    case "create_edit_plan":
      return t("chat.tools.createEditPlan");
    case "create_plan":
      return t("chat.tools.createPlan");
    case "update_goal":
      return t("chat.tools.updateGoal");
    default:
      if (isRuntimeToolName(name)) {
        return genericRuntimeToolTitle(name, { path, query, command }, t);
      }
      return name.replaceAll("_", " ");
  }
}

function genericRuntimeToolTitle(
  name: string,
  args: {
    path?: string;
    query?: string;
    command?: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const tool = t(`settings.toolNames.${name}`);
  if (args.command) {
    return t("chat.tools.genericCommand", { tool, command: args.command });
  }
  if (args.path) {
    return t("chat.tools.genericPath", { tool, path: args.path });
  }
  if (args.query) {
    return t("chat.tools.genericQuery", { tool, query: args.query });
  }
  return tool;
}

const COMPACT_COMMAND_PREVIEW_MAX_CHARS = 72;

function compactTitleForTool(
  item: ToolItem,
  args: {
    path?: string;
    query?: string;
    command?: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const { name, status } = item;
  const changeSummary = status === "completed" ? summarizeToolChangeResult(item) : null;
  if (changeSummary) {
    return compactTitleForChangeSummary(changeSummary, t);
  }
  if (status !== "failed") {
    return titleForTool(name, args, t);
  }
  if (args.command) {
    return t("chat.tools.failedCommandPreview", {
      tool: getToolDisplayName(name, t),
      command: previewSingleLine(args.command, COMPACT_COMMAND_PREVIEW_MAX_CHARS),
    });
  }
  return titleForTool(name, args, t);
}

function compactTitleForChangeSummary(
  summary: ToolChangeSummary,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (summary.fileCount === 1 && summary.path) {
    return t("chat.tools.changedFileSummary", {
      path: summary.path,
      added: summary.added,
      removed: summary.removed,
    });
  }
  return t("chat.tools.changedFilesSummary", {
    count: summary.fileCount,
    added: summary.added,
    removed: summary.removed,
  });
}

export function getToolDisplayName(
  name: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (isRuntimeToolName(name)) {
    return t(`settings.toolNames.${name}`);
  }
  return name.replaceAll("_", " ");
}

export function previewSingleLine(text: string, maxChars: number): string {
  const normalizedText = text.trim().replace(/\s+/g, " ");
  const normalizedMaxChars = Math.max(1, Math.floor(Number.isFinite(maxChars) ? maxChars : 1));
  if (normalizedText.length <= normalizedMaxChars) return normalizedText;
  return `${normalizedText.slice(0, Math.max(1, normalizedMaxChars - 1))}...`;
}

function formatToolDetail(item: ToolItem): string {
  const parts = [
    JSON.stringify(item.args, null, 2),
    extractToolResultText(item.result),
  ].filter((part) => part.trim().length > 0);
  return parts.join("\n\n");
}

function formatToolDetailPreview(
  item: ToolItem,
  maxChars: number,
): { text: string; truncated: boolean; hiddenCharCount: number } {
  const normalizedMaxChars = normalizePreviewLimit(maxChars);
  let text = "";
  let truncated = false;
  let hiddenCharCount = 0;

  const appendPart = (part: { text: string; truncated: boolean; hiddenCharCount: number }): void => {
    if (!part.text.trim()) {
      truncated = truncated || part.truncated;
      hiddenCharCount += part.hiddenCharCount;
      return;
    }

    const separator = text ? "\n\n" : "";
    const remaining = normalizedMaxChars - text.length - separator.length;
    if (remaining <= 0) {
      truncated = true;
      hiddenCharCount += part.text.length + part.hiddenCharCount;
      return;
    }

    const visibleText = part.text.length > remaining ? part.text.slice(0, remaining) : part.text;
    text += `${separator}${visibleText}`;
    truncated = truncated || part.truncated || visibleText.length < part.text.length;
    hiddenCharCount += part.hiddenCharCount + Math.max(0, part.text.length - visibleText.length);
  };

  appendPart(stringifyJsonPreview(item.args, normalizedMaxChars));
  appendPart(extractToolResultPreview(item.result, normalizedMaxChars - text.length));

  return {
    text,
    truncated,
    hiddenCharCount: normalizeHiddenCharCount(truncated, hiddenCharCount),
  };
}

function extractToolResultText(result: unknown): string {
  if (result === undefined) return "";
  const liveProgress = readLiveProgressDisplayResult(result);
  if (liveProgress) {
    return [
      extractToolResultText(stripLiveProgressDisplayResult(result)),
      formatToolProgressDisplayResult(liveProgress),
    ].filter((part) => part.trim().length > 0).join("\n\n");
  }
  if (typeof result === "string") return result;
  if (isToolProgressDisplayResult(result)) {
    return formatToolProgressDisplayResult(result);
  }
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content;
    return typeof content === "string" ? content : JSON.stringify(content, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

function extractToolResultPreview(
  result: unknown,
  maxChars: number,
): { text: string; truncated: boolean; hiddenCharCount: number } {
  const normalizedMaxChars = normalizePreviewLimit(maxChars);
  if (result === undefined) return { text: "", truncated: false, hiddenCharCount: 0 };
  const liveProgress = readLiveProgressDisplayResult(result);
  if (liveProgress) {
    return previewPlainText(
      [
        extractToolResultText(stripLiveProgressDisplayResult(result)),
        formatToolProgressDisplayResult(liveProgress),
      ].filter((part) => part.trim().length > 0).join("\n\n"),
      normalizedMaxChars,
    );
  }
  if (typeof result === "string") return previewPlainText(result, normalizedMaxChars);
  if (isToolProgressDisplayResult(result)) {
    return previewPlainText(formatToolProgressDisplayResult(result), normalizedMaxChars);
  }
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content;
    return typeof content === "string"
      ? previewPlainText(content, normalizedMaxChars)
      : stringifyJsonPreview(content, normalizedMaxChars);
  }
  return stringifyJsonPreview(result, normalizedMaxChars);
}

interface ToolProgressDisplayResult {
  kind: "tool_progress";
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

function isToolProgressDisplayResult(result: unknown): result is ToolProgressDisplayResult {
  return Boolean(result) &&
    typeof result === "object" &&
    (result as { kind?: unknown }).kind === "tool_progress";
}

function readLiveProgressDisplayResult(result: unknown): ToolProgressDisplayResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const liveProgress = (result as Record<string, unknown>).liveProgress;
  return isToolProgressDisplayResult(liveProgress) ? liveProgress : null;
}

function stripLiveProgressDisplayResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const entries = Object.entries(result).filter(([key]) => key !== "liveProgress");
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function formatToolProgressDisplayResult(result: ToolProgressDisplayResult): string {
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(`${result.stdoutTruncated ? "[stdout: latest output]" : "[stdout]"}\n${result.stdout}`);
  }
  if (result.stderr) {
    parts.push(`${result.stderrTruncated ? "[stderr: latest output]" : "[stderr]"}\n${result.stderr}`);
  }
  return parts.join("\n\n");
}

function previewPlainText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; hiddenCharCount: number } {
  const normalizedMaxChars = normalizePreviewLimit(maxChars);
  if (text.length <= normalizedMaxChars) {
    return { text, truncated: false, hiddenCharCount: 0 };
  }
  return {
    text: text.slice(0, normalizedMaxChars),
    truncated: true,
    hiddenCharCount: text.length - normalizedMaxChars,
  };
}

function stringifyJsonPreview(
  value: unknown,
  maxChars: number,
): { text: string; truncated: boolean; hiddenCharCount: number } {
  const normalizedMaxChars = normalizePreviewLimit(maxChars);
  const state = { truncated: false, hiddenCharCount: 0 };
  const previewValue = normalizeJsonPreviewValue(value, normalizedMaxChars, state, 0);
  const text = JSON.stringify(previewValue, null, 2) ?? "";
  if (text.length <= normalizedMaxChars) {
    return {
      text,
      truncated: state.truncated,
      hiddenCharCount: normalizeHiddenCharCount(state.truncated, state.hiddenCharCount),
    };
  }
  return {
    text: text.slice(0, normalizedMaxChars),
    truncated: true,
    hiddenCharCount: normalizeHiddenCharCount(
      true,
      state.hiddenCharCount + text.length - normalizedMaxChars,
    ),
  };
}

function normalizeJsonPreviewValue(
  value: unknown,
  maxStringChars: number,
  state: { truncated: boolean; hiddenCharCount: number },
  depth: number,
): unknown {
  if (typeof value === "string") {
    if (value.length <= maxStringChars) return value;
    state.truncated = true;
    state.hiddenCharCount += value.length - maxStringChars;
    return value.slice(0, maxStringChars);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= JSON_PREVIEW_MAX_DEPTH) {
    state.truncated = true;
    return "[Max preview depth reached]";
  }
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, JSON_PREVIEW_COLLECTION_LIMIT)
      .map((entry) => normalizeJsonPreviewValue(entry, maxStringChars, state, depth + 1));
    if (value.length > visible.length) {
      state.truncated = true;
      visible.push(`[${value.length - visible.length} more items hidden]`);
    }
    return visible;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const visibleEntries = entries.slice(0, JSON_PREVIEW_COLLECTION_LIMIT);
  const preview: Record<string, unknown> = {};
  for (const [key, entryValue] of visibleEntries) {
    preview[key] = normalizeJsonPreviewValue(entryValue, maxStringChars, state, depth + 1);
  }
  if (entries.length > visibleEntries.length) {
    state.truncated = true;
    preview.__preview__ = `${entries.length - visibleEntries.length} more fields hidden`;
  }
  return preview;
}

function normalizePreviewLimit(limit: number): number {
  return Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
}

function normalizeHiddenCharCount(truncated: boolean, hiddenCharCount: number): number {
  return truncated ? Math.max(1, hiddenCharCount) : 0;
}

function isApprovalPreviewValue(value: unknown): value is ApprovalPreview {
  const record = asRecord(value);
  if (!record) return false;
  if (record.kind === "file_diff") return isFileDiffPreviewValue(record);
  if (record.kind !== "multi_file_diff") return false;
  return Array.isArray(record.files) &&
    record.files.every(isFileDiffPreviewValue) &&
    isNonNegativeIntegerValue(record.added) &&
    isNonNegativeIntegerValue(record.removed);
}

function isFileDiffPreviewValue(value: unknown): value is FileDiffPreview {
  const record = asRecord(value);
  if (!record) return false;
  return record.kind === "file_diff" &&
    typeof record.path === "string" &&
    isFileDiffOperationValue(record.operation) &&
    isNonNegativeIntegerValue(record.added) &&
    isNonNegativeIntegerValue(record.removed) &&
    Array.isArray(record.lines) &&
    record.lines.every(isFileDiffLineValue);
}

function isFileDiffLineValue(value: unknown): value is FileDiffLine {
  const record = asRecord(value);
  if (!record) return false;
  return isFileDiffLineTypeValue(record.type) && typeof record.text === "string";
}

function isFileDiffOperationValue(value: unknown): value is FileDiffPreview["operation"] {
  return value === "create" || value === "update" || value === "delete";
}

function isFileDiffLineTypeValue(value: unknown): value is FileDiffLine["type"] {
  return value === "context" || value === "added" || value === "removed";
}

function isNonNegativeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusText(
  status: ToolItem["status"],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (status) {
    case "pending":
      return t("chat.toolStatus.pending");
    case "running":
      return t("chat.toolStatus.running");
    case "completed":
      return t("chat.toolStatus.completed");
    case "failed":
      return t("chat.toolStatus.failed");
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function statusTone(status: ToolItem["status"]): ToolDisplay["tone"] {
  switch (status) {
    case "pending":
      return "neutral";
    case "running":
      return "running";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
