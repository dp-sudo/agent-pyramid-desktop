import { describe, expect, it } from "vitest";
import {
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  parseAnthropicToolCalls,
  parseOpenAiToolCalls,
  toAnthropicTool,
  toOpenAiTool,
} from "../../../src/main/infrastructure/minimax/minimax-types";
import type {
  AnthropicMessageResponse,
  OpenAiChatResponse,
} from "../../../src/main/infrastructure/minimax/minimax-types";
import type { AgentToolDefinition } from "../../../src/main/domain/agent/types";

describe("minimax protocol type helpers", () => {
  const tool: AgentToolDefinition = {
    name: "update_goal",
    description: "Update goal",
    inputSchema: { type: "object", properties: {} },
  };

  it("maps internal tool definitions to provider schemas", () => {
    expect(toOpenAiTool(tool)).toEqual({
      type: "function",
      function: {
        name: "update_goal",
        description: "Update goal",
        parameters: tool.inputSchema,
      },
    });
    expect(toAnthropicTool(tool)).toEqual({
      name: "update_goal",
      description: "Update goal",
      input_schema: tool.inputSchema,
    });
  });

  it("normalizes provider usage fields", () => {
    expect(
      normalizeOpenAiUsage({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(
      normalizeAnthropicUsage({
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  });

  it("parses tool calls and rejects invalid OpenAI tool arguments", () => {
    const openAi: OpenAiChatResponse = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-1",
                function: {
                  name: "update_goal",
                  arguments: "{\"status\":\"complete\"}",
                },
              },
            ],
          },
        },
      ],
    };
    expect(parseOpenAiToolCalls(openAi)).toEqual([
      {
        id: "call-1",
        name: "update_goal",
        arguments: { status: "complete" },
      },
    ]);

    expect(() =>
      parseOpenAiToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "bad",
                    arguments: "[]",
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toThrow('Failed to parse arguments for tool "bad"');
  });

  it("parses Anthropic tool_use content blocks", () => {
    const response: AnthropicMessageResponse = {
      content: [
        { type: "text", text: "hello" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "create_plan",
          input: { steps: [{ title: "Read", status: "pending" }] },
        },
      ],
    };

    expect(parseAnthropicToolCalls(response)).toEqual([
      {
        id: "tool-1",
        name: "create_plan",
        arguments: { steps: [{ title: "Read", status: "pending" }] },
      },
    ]);
  });
});
