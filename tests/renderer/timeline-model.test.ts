import { describe, expect, it } from "vitest";
import type { Item, ToolItem } from "../../src/shared/agent-contracts";
import { RUNTIME_TOOL_NAMES } from "../../src/shared/agent-contracts";
import {
  groupTimelineTurns,
  sortTimelineItems,
  summarizeToolItem,
  summarizeToolItemHeader,
  summarizeToolItemPreview,
} from "../../src/renderer/src/ui/components/chat/timeline-model";

const createdAt = "2026-01-01T00:00:00.000Z";

describe("timeline model", () => {
  it("sorts timeline items by createdAt while preserving stable order for ties", () => {
    const first = userItem("user-1", "2026-01-01T00:00:01.000Z");
    const second = userItem("user-2", "2026-01-01T00:00:01.000Z");
    const older = userItem("user-older", "2026-01-01T00:00:00.000Z");

    expect(sortTimelineItems([first, second, older]).map((item) => item.id)).toEqual([
      "user-older",
      "user-1",
      "user-2",
    ]);
  });

  it("groups out-of-order timeline items into chronological turn sections", () => {
    const items: Item[] = [
      assistantItem("assistant-final", "turn-1", "2026-01-01T00:00:03.000Z"),
      userItem("user-1", "2026-01-01T00:00:01.000Z", "turn-1"),
      reasoningItem("reasoning-1", "turn-1", "2026-01-01T00:00:02.000Z"),
    ];

    const [turn] = groupTimelineTurns(items);

    expect(turn.user?.id).toBe("user-1");
    expect(turn.processItems.map((item) => item.id)).toEqual(["reasoning-1"]);
    expect(turn.assistantItems.map((item) => item.id)).toEqual(["assistant-final"]);
  });

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

  it("keeps process items that arrive after the final answer in follow-up order", () => {
    const items: Item[] = [
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Explain",
        createdAt,
      },
      {
        kind: "assistant",
        id: "assistant-final",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Final answer",
        createdAt,
      },
      {
        kind: "reasoning",
        id: "reasoning-after",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Late reasoning chunk",
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

    expect(turn.processItems).toEqual([]);
    expect(turn.assistantItems.map((item) => item.id)).toEqual(["assistant-final"]);
    expect(turn.followupItems.map((item) => item.id)).toEqual([
      "reasoning-after",
      "plan-1",
    ]);
  });

  it("keeps passive post-answer system records after the final answer", () => {
    const items: Item[] = [
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Explain",
        createdAt,
      },
      {
        kind: "assistant",
        id: "assistant-final",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Final answer",
        createdAt,
      },
      {
        kind: "system",
        id: "system-after",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Interrupted after answer.",
        level: "warn",
        createdAt,
      },
      {
        kind: "compaction",
        id: "compaction-after",
        threadId: "thread-1",
        turnId: "turn-1",
        summary: "Older context compacted.",
        replacedItemCount: 4,
        createdAt,
      },
    ];

    const [turn] = groupTimelineTurns(items);

    expect(turn.processItems).toEqual([]);
    expect(turn.assistantItems.map((item) => item.id)).toEqual(["assistant-final"]);
    expect(turn.followupItems.map((item) => item.id)).toEqual([
      "system-after",
      "compaction-after",
    ]);
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
      compactTitle: "chat.tools.searchFilesQuery:AgentRuntime",
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

  it("summarizes command tools with command text", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "run_command",
      args: { command: "npm run test" },
      result: {
        stdout: "passed",
        exitCode: 0,
      },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key, options) =>
      options?.command ? `${key}:${String(options.command)}` : key,
    );

    expect(display.title).toBe("chat.tools.runCommandCommand:npm run test");
    expect(display.compactTitle).toBe("chat.tools.runCommandCommand:npm run test");
    expect(display.statusText).toBe("chat.toolStatus.completed");
  });

  it("uses a short compact title for failed command tools", () => {
    const command = `find src -type d -name "__tests__" ${"nested ".repeat(16)}`;
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "run_command",
      args: { command },
      result: { content: "find: not found" },
      status: "failed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key, options) => {
      if (key === "settings.toolNames.run_command") return "Run command";
      if (options?.tool && options?.command) {
        return `${key}:${String(options.tool)}:${String(options.command)}`;
      }
      if (options?.command) return `${key}:${String(options.command)}`;
      return key;
    });

    const normalizedCommand = command.trim();
    expect(display.title).toBe(`chat.tools.runCommandCommand:${normalizedCommand}`);
    expect(display.compactTitle).toMatch(/^chat\.tools\.failedCommandPreview:Run command:/);
    expect(display.compactTitle.length).toBeLessThan(display.title.length);
    expect(display.detail).toContain("find src -type d -name");
    expect(display.detail).toContain("\\\"__tests__\\\"");
    expect(display.detail).toContain("find: not found");
  });

  it("summarizes apply_patch as a coding tool", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "apply_patch",
      args: { patch: "--- a/file.ts\n+++ b/file.ts" },
      result: {
        files: [{ path: "file.ts" }],
      },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key) => key);

    expect(display.title).toBe("chat.tools.applyPatch");
    expect(display.statusText).toBe("chat.toolStatus.completed");
  });

  it("summarizes rollback_file with file paths", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "rollback_file",
      args: { path: "file.ts" },
      result: { path: "file.ts" },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key, options) =>
      options?.path ? `${key}:${String(options.path)}` : key,
    );

    expect(display.title).toBe("chat.tools.rollbackFilePath:file.ts");
    expect(display.statusText).toBe("chat.toolStatus.completed");
  });

  it("summarizes diagnose_workspace as a command tool", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "diagnose_workspace",
      args: {},
      result: { diagnosticCount: 0 },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key) => key);

    expect(display.title).toBe("chat.tools.diagnoseWorkspace");
    expect(display.statusText).toBe("chat.toolStatus.completed");
  });

  it("summarizes diagnose_file with file paths", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "diagnose_file",
      args: { path: "src/index.ts" },
      result: { diagnosticCount: 1 },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItem(item, (key, options) =>
      options?.path ? `${key}:${String(options.path)}` : key,
    );

    expect(display.title).toBe("chat.tools.diagnoseFilePath:src/index.ts");
    expect(display.statusText).toBe("chat.toolStatus.completed");
  });

  it("uses localized catalog titles for every runtime tool", () => {
    const rawFallbacks = RUNTIME_TOOL_NAMES.filter((toolName) => {
      const title = summarizeToolItemHeader(toolItem(toolName), timelineTitleT).title;
      return title === toolName.replaceAll("_", " ");
    });

    expect(rawFallbacks).toEqual([]);
    expect(
      summarizeToolItemHeader(
        toolItem("shell_command", { command: "npm run test" }),
        timelineTitleT,
      ).title,
    ).toBe("tool:shell_command|command:npm run test");
    expect(
      summarizeToolItemHeader(
        toolItem("delete_file", { path: "src/old.ts" }),
        timelineTitleT,
      ).title,
    ).toBe("tool:delete_file|path:src/old.ts");
    expect(
      summarizeToolItemHeader(
        toolItem("rg_search", { pattern: "AgentRuntime" }),
        timelineTitleT,
      ).title,
    ).toBe("tool:rg_search|query:AgentRuntime");
    expect(summarizeToolItemHeader(toolItem("custom_tool"), timelineTitleT).title)
      .toBe("custom tool");
  });

  it("summarizes tool headers without formatting result detail", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "run_command",
      args: { command: "npm run build" },
      result: { stdout: "x".repeat(100) },
      status: "running",
      createdAt,
    };

    expect(
      summarizeToolItemHeader(item, (key, options) =>
        options?.command ? `${key}:${String(options.command)}` : key,
      ),
    ).toEqual({
      title: "chat.tools.runCommandCommand:npm run build",
      statusText: "chat.toolStatus.running",
      tone: "running",
      compactTitle: "chat.tools.runCommandCommand:npm run build",
    });
  });

  it("summarizes tool detail previews without exposing full long results", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "read_file",
      args: { path: "src/main/index.ts" },
      result: { content: "abcdef" },
      status: "completed",
      createdAt,
    };
    const display = summarizeToolItemPreview(
      item,
      (key, options) => options?.path ? `${key}:${String(options.path)}` : key,
      40,
    );

    expect(display).toEqual({
      title: "chat.tools.readFilePath:src/main/index.ts",
      detail: "{\n  \"path\": \"src/main/index.ts\"\n}\n\nabcde",
      detailTruncated: true,
      hiddenCharCount: 1,
      statusText: "chat.toolStatus.completed",
      tone: "success",
      compactTitle: "chat.tools.readFilePath:src/main/index.ts",
    });
  });
});

function userItem(
  id: string,
  createdAtValue: string,
  turnId = id,
): Extract<Item, { kind: "user" }> {
  return {
    kind: "user",
    id,
    threadId: "thread-1",
    turnId,
    text: id,
    createdAt: createdAtValue,
  };
}

function assistantItem(
  id: string,
  turnId: string,
  createdAtValue: string,
): Extract<Item, { kind: "assistant" }> {
  return {
    kind: "assistant",
    id,
    threadId: "thread-1",
    turnId,
    text: id,
    createdAt: createdAtValue,
  };
}

function reasoningItem(
  id: string,
  turnId: string,
  createdAtValue: string,
): Extract<Item, { kind: "reasoning" }> {
  return {
    kind: "reasoning",
    id,
    threadId: "thread-1",
    turnId,
    text: id,
    createdAt: createdAtValue,
  };
}

function toolItem(name: string, args: Record<string, unknown> = {}): ToolItem {
  return {
    kind: "tool",
    id: `tool-${name}`,
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: `call-${name}`,
    name,
    args,
    status: "completed",
    createdAt,
  };
}

function timelineTitleT(key: string, options?: Record<string, unknown>): string {
  if (key.startsWith("settings.toolNames.")) {
    return `tool:${key.slice("settings.toolNames.".length)}`;
  }
  if (key === "chat.tools.genericCommand") {
    return `${String(options?.tool)}|command:${String(options?.command)}`;
  }
  if (key === "chat.tools.genericPath") {
    return `${String(options?.tool)}|path:${String(options?.path)}`;
  }
  if (key === "chat.tools.genericQuery") {
    return `${String(options?.tool)}|query:${String(options?.query)}`;
  }
  return key;
}
