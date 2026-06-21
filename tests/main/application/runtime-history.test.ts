import { describe, expect, it } from "vitest";
import {
  buildUserContent,
  collectAgentHistory,
  type RuntimeHistoryDeps,
} from "../../../src/main/application/runtime-history";
import type {
  Item,
  ThreadRecord,
} from "../../../src/shared/agent-contracts";

describe("runtime history", () => {
  it("replays latest items into model messages while excluding the active turn", async () => {
    const deps = createDeps([
      userItem("user-1", "turn-1", "hello"),
      assistantItem("assistant-1", "turn-1", "hi"),
      toolItem("tool-1", "turn-1", "running", { partial: true }),
      toolItem("tool-2", "turn-1", "completed", { content: "tool text" }),
      toolItem("tool-2", "turn-1", "failed", { code: "tool_failed" }),
      userItem("user-active", "turn-active", "skip me"),
    ]);

    const messages = await collectAgentHistory(deps, thread(), {
      excludeTurnId: "turn-active",
    });

    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-tool-2",
            name: "read_file",
            arguments: { path: "src/main/index.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: "{\"code\":\"tool_failed\"}",
        toolCallId: "call-tool-2",
      },
    ]);
  });

  it("rehydrates attachment payloads only when user content needs them", async () => {
    const content = await buildUserContent(
      {
        async get(id) {
          return {
            id,
            name: "image.png",
            mimeType: "image/png",
            size: 4,
            createdAt: "2026-01-01T00:00:00.000Z",
            dataBase64: "iVBORw==",
          };
        },
      },
      "see image",
      ["attachment-1"],
    );

    expect(content).toEqual([
      { type: "text", text: "see image" },
      { type: "image", mimeType: "image/png", dataBase64: "iVBORw==" },
    ]);
  });
});

function createDeps(items: Item[]): RuntimeHistoryDeps {
  return {
    store: {
      async *replayItems() {
        for (const item of items) {
          yield item;
        }
      },
    },
    attachmentStore: {
      async get() {
        return null;
      },
    },
  };
}

function thread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: "Thread",
    workspace: "/workspace",
    mode: "code",
    status: "active",
    relation: "primary",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    ...overrides,
  };
}

function userItem(id: string, turnId: string, text: string): Item {
  return {
    kind: "user",
    id,
    threadId: "thread-1",
    turnId,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function assistantItem(id: string, turnId: string, text: string): Item {
  return {
    kind: "assistant",
    id,
    threadId: "thread-1",
    turnId,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function toolItem(
  id: string,
  turnId: string,
  status: "running" | "completed" | "failed",
  result: unknown,
): Item {
  return {
    kind: "tool",
    id,
    threadId: "thread-1",
    turnId,
    toolCallId: `call-${id}`,
    name: "read_file",
    args: { path: "src/main/index.ts" },
    status,
    result,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
