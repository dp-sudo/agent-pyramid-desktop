import type {
  AgentContentBlock,
  AgentMessage,
} from "../domain/agent/types.js";
import { stableJsonStringify } from "../stable-json.js";
import type {
  AttachmentRecord,
  Item,
  ThreadRecord,
} from "../../shared/agent-contracts.js";

export interface RuntimeHistoryDeps {
  store: {
    replayItems(threadId: string): AsyncIterable<Item>;
  };
  attachmentStore: {
    get(id: string): Promise<(AttachmentRecord & { dataBase64: string }) | null>;
  };
}

export async function collectAgentHistory(
  deps: RuntimeHistoryDeps,
  thread: ThreadRecord,
  options: { excludeTurnId?: string } = {},
): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  const items = await replayLatestThreadItems(deps.store, thread.id, options.excludeTurnId);
  for (const item of items) {
    const messageParts = await itemToAgentMessages(deps, item);
    messages.push(...messageParts);
  }
  return messages;
}

export async function buildUserContent(
  attachmentStore: RuntimeHistoryDeps["attachmentStore"],
  text: string,
  attachmentIds: readonly string[],
): Promise<string | AgentContentBlock[]> {
  if (attachmentIds.length === 0) return text;
  const blocks: AgentContentBlock[] = [{ type: "text", text }];
  for (const id of attachmentIds) {
    const attachment = await attachmentStore.get(id);
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

async function replayLatestThreadItems(
  store: RuntimeHistoryDeps["store"],
  threadId: string,
  excludeTurnId?: string,
): Promise<Item[]> {
  const items: Item[] = [];
  const itemIndexById = new Map<string, number>();
  for await (const item of store.replayItems(threadId)) {
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
  return items;
}

async function itemToAgentMessages(
  deps: RuntimeHistoryDeps,
  item: Item,
): Promise<AgentMessage[]> {
  switch (item.kind) {
    case "user":
      return [{
        role: "user",
        content: await buildUserContent(
          deps.attachmentStore,
          item.text,
          item.attachmentIds ?? [],
        ),
      }];
    case "assistant":
      return [{ role: "assistant", content: item.text }];
    case "tool":
      if (item.status !== "completed" && item.status !== "failed") {
        return [];
      }
      return [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: item.toolCallId,
              name: item.name,
              arguments: item.args,
            },
          ],
        },
        {
          role: "tool",
          content: toolResultContent(item.result),
          toolCallId: item.toolCallId,
        },
      ];
    default:
      return [];
  }
}

function toolResultContent(result: unknown): string {
  if (typeof result === "object" && result && "content" in result) {
    return String((result as { content: unknown }).content);
  }
  return stableJsonStringify(result ?? null);
}
