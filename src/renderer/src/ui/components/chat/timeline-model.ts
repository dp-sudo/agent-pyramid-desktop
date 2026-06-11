import type {
  AssistantItem,
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
}

export interface ToolPreviewDisplay extends ToolDisplay {
  detailTruncated: boolean;
  hiddenCharCount: number;
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
  if (typeof result === "string") return result;
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
  if (typeof result === "string") return previewPlainText(result, normalizedMaxChars);
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content;
    return typeof content === "string"
      ? previewPlainText(content, normalizedMaxChars)
      : stringifyJsonPreview(content, normalizedMaxChars);
  }
  return stringifyJsonPreview(result, normalizedMaxChars);
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
