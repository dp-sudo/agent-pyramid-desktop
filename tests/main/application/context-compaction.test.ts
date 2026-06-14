import { describe, expect, it } from "vitest";
import { prepareMessagesForRequest } from "../../../src/main/application/context-compaction";
import type { AgentMessage, AgentToolDefinition } from "../../../src/main/domain/agent/types";
import type { RuntimePreferences } from "../../../src/shared/agent-contracts";

const emptyTools: AgentToolDefinition[] = [];
const balancedCompaction: RuntimePreferences["compaction"] = {
  enabled: true,
  strategy: "balanced",
};

function prepare(messages: AgentMessage[], overrides: Partial<Parameters<typeof prepareMessagesForRequest>[1]> = {}) {
  return prepareMessagesForRequest(messages, {
    systemPrompt: "System",
    tools: emptyTools,
    compactTokenLimit: 100_000,
    contextWindow: 100_000,
    maxTokens: 1_000,
    compaction: balancedCompaction,
    ...overrides,
  });
}

function expectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

describe("prepareMessagesForRequest", () => {
  it("keeps the current user message and omits image blocks under a tight budget", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: `old-${"x".repeat(10_000)}` },
      { role: "assistant", content: `old-reply-${"x".repeat(10_000)}` },
      {
        role: "user",
        content: [
          { type: "text", text: "CURRENT request" },
          { type: "image", mimeType: "image/png", dataBase64: "a".repeat(4_096) },
        ],
      },
    ];

    const prepared = prepare(messages, {
      compactTokenLimit: 50,
      contextWindow: 100,
      maxTokens: 80,
    });

    expect(prepared.some((message) => message.content === messages[0].content)).toBe(false);
    const current = prepared[prepared.length - 1];
    expect(current.role).toBe("user");
    if (typeof current.content === "string") {
      throw new Error("Expected compacted multimodal content blocks.");
    }
    expect(current.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "CURRENT request" }),
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("omitted image/png attachment"),
        }),
      ]),
    );
  });

  it("compacts completed historical tool call arguments without changing live user input", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Read with complex arguments" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-complex",
            name: "read_file",
            arguments: {
              path: "large.txt",
              nested: {
                data_base64: "a".repeat(2_048),
                query: "x".repeat(9_000),
              },
            },
          },
        ],
      },
      { role: "tool", toolCallId: "call-complex", content: "short result" },
      { role: "user", content: "Continue" },
    ];

    const prepared = prepare(messages);
    const replayedCall = prepared
      .find((message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === "call-complex")
      )
      ?.toolCalls?.find((call) => call.id === "call-complex");
    if (!replayedCall) throw new Error("Expected completed historical tool call to remain.");

    const nested = expectRecord(
      replayedCall.arguments.nested,
      "Expected nested tool arguments to remain an object.",
    );
    expect(nested.data_base64).toBe("[context budget: omitted base64 argument, 2048 bytes]");
    expect(nested.query).toContain("[context budget: omitted long argument tail]");
    expect(prepared[prepared.length - 1]).toMatchObject({ role: "user", content: "Continue" });
  });
});
