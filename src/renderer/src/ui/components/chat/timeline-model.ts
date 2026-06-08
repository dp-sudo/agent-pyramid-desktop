import type {
  AssistantItem,
  Item,
  ToolItem,
  UserItem,
} from "../../../../../shared/agent-contracts";

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

export function groupTimelineTurns(items: Item[]): TimelineTurn[] {
  const turns: MutableTimelineTurn[] = [];
  const byTurnId = new Map<string, MutableTimelineTurn>();

  for (const item of items) {
    const turnId = "turnId" in item && typeof item.turnId === "string"
      ? item.turnId
      : `item:${item.id}`;
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
    if (item.kind === "reasoning" && start === items.length) continue;
    if (isFollowupItem(item) && start === items.length) continue;
    if (item.kind !== "assistant" || !item.text.trim()) break;
    start = index;
  }

  return start;
}

function isFollowupItem(item: TimelineProcessItem): boolean {
  return item.kind === "plan";
}

export interface ToolDisplay {
  title: string;
  detail: string;
  statusText: string;
  tone: "neutral" | "running" | "success" | "danger";
}

export function summarizeToolItem(
  item: ToolItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): ToolDisplay {
  const path = readStringArg(item.args, "path") ?? readStringArg(item.args, "workspace");
  const query = readStringArg(item.args, "query");
  const command = readStringArg(item.args, "command");
  const title = titleForTool(item.name, { path, query, command }, t);
  const detail = formatToolDetail(item);
  return {
    title,
    detail,
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
      return name.replaceAll("_", " ");
  }
}

function formatToolDetail(item: ToolItem): string {
  const parts = [
    JSON.stringify(item.args, null, 2),
    extractToolResultText(item.result),
  ].filter((part) => part.trim().length > 0);
  return parts.join("\n\n");
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
