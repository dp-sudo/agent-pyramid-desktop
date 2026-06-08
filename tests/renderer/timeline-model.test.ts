import { describe, expect, it } from "vitest";
import type { Item, ToolItem } from "../../src/shared/agent-contracts";
import { groupTimelineTurns, summarizeToolItem } from "../../src/renderer/src/ui/components/chat/timeline-model";

const createdAt = "2026-01-01T00:00:00.000Z";

describe("timeline model", () => {
  it("groups process items before the final assistant answer within a turn", () => {
    const items: Item[] = [
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Inspect the project",
        createdAt,
      },
      {
        kind: "reasoning",
        id: "reasoning-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Need to read files.",
        createdAt,
      },
      {
        kind: "tool",
        id: "tool-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        name: "read_file",
        args: { path: "src/main/index.ts" },
        result: "content",
        status: "completed",
        createdAt,
      },
      {
        kind: "assistant",
        id: "assistant-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Final answer",
        createdAt,
      },
      {
        kind: "plan",
        id: "plan-1",
        threadId: "thread-1",
        turnId: "turn-1",
        steps: [{ id: "step-1", title: "Patch", status: "pending" }],
        createdAt,
      },
    ];

    const [turn] = groupTimelineTurns(items);

    expect(turn).toMatchObject({
      id: "turn-1",
      user: expect.objectContaining({ id: "user-1" }),
      processItems: [
        expect.objectContaining({ id: "reasoning-1" }),
        expect.objectContaining({ id: "tool-1" }),
      ],
      assistantItems: [expect.objectContaining({ id: "assistant-1" })],
      followupItems: [expect.objectContaining({ id: "plan-1" })],
    });
  });

  it("keeps earlier assistant text in the process when a later final answer exists", () => {
    const items: Item[] = [
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Run",
        createdAt,
      },
      {
        kind: "assistant",
        id: "assistant-process",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "I will inspect files first.",
        createdAt,
      },
      {
        kind: "tool",
        id: "tool-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        name: "list_files",
        args: {},
        status: "completed",
        result: "[]",
        createdAt,
      },
      {
        kind: "assistant",
        id: "assistant-final",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Here is the result.",
        createdAt,
      },
    ];

    const [turn] = groupTimelineTurns(items);

    expect(turn.processItems.map((item) => item.id)).toEqual(["assistant-process", "tool-1"]);
    expect(turn.assistantItems.map((item) => item.id)).toEqual(["assistant-final"]);
  });

  it("summarizes known tools with localized status and detail", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "search_files",
      args: { query: "AgentRuntime" },
      result: { content: "src/main/application/agent-runtime.ts:1" },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key, options) =>
      options?.query ? `${key}:${String(options.query)}` : key,
    );

    expect(display).toEqual({
      title: "chat.tools.searchFilesQuery:AgentRuntime",
      detail: "{\n  \"query\": \"AgentRuntime\"\n}\n\nsrc/main/application/agent-runtime.ts:1",
      statusText: "chat.toolStatus.completed",
      tone: "success",
    });
  });

  it("summarizes coding tools with file paths", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "edit_file",
      args: { path: "src/main/index.ts" },
      result: {
        content: "{\"path\":\"src/main/index.ts\"}",
      },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key, options) =>
      options?.path ? `${key}:${String(options.path)}` : key,
    );

    expect(display.title).toBe("chat.tools.editFilePath:src/main/index.ts");
    expect(display.statusText).toBe("chat.toolStatus.completed");
  });
});
