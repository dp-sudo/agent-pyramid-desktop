import { describe, expect, it } from "vitest";
import {
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  normalizeToolDefinitions,
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
    inputSchema: {
      properties: {
        status: { enum: ["active", "complete"], type: "string" },
        goal: { type: "string" },
      },
      type: "object",
    },
  };

  it("maps internal tool definitions to provider schemas", () => {
    expect(toOpenAiTool(tool)).toEqual({
      type: "function",
      function: {
        name: "update_goal",
        description: "Update goal",
            parameters: {
              properties: {
                goal: { type: "string" },
                status: { enum: ["active", "complete"], type: "string" },
              },
              type: "object",
            },
          },
        });
    expect(toAnthropicTool(tool)).toEqual({
      name: "update_goal",
      description: "Update goal",
      input_schema: {
        properties: {
          goal: { type: "string" },
          status: { enum: ["active", "complete"], type: "string" },
        },
        type: "object",
      },
    });
  });

  it("sorts tool definitions and recursively canonicalizes schemas", () => {
    const tools: AgentToolDefinition[] = [
      {
        name: "z_tool",
        description: "Z",
        inputSchema: { type: "object", properties: { z: { type: "string" } } },
      },
      {
        name: "a_tool",
        description: "A",
        inputSchema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
      },
    ];

    expect(normalizeToolDefinitions(tools)).toEqual([
      {
        name: "a_tool",
        description: "A",
        inputSchema: {
          properties: {
            a: { type: "string" },
            b: { type: "number" },
          },
          type: "object",
        },
      },
      {
        name: "z_tool",
        description: "Z",
        inputSchema: { properties: { z: { type: "string" } }, type: "object" },
      },
    ]);
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
      normalizeOpenAiUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 95,
          prompt_cache_miss_tokens: 5,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheHitTokens: 95,
      cacheMissTokens: 5,
      cacheHitRate: 0.95,
    });
    expect(
      normalizeOpenAiUsage({
        usage: {
          prompt_tokens: 80,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    ).toEqual({
      inputTokens: 80,
      outputTokens: 10,
      totalTokens: 90,
      cacheHitTokens: 30,
      cacheMissTokens: 50,
      cacheHitRate: 0.375,
    });
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

    expect(() =>
      parseOpenAiToolCalls({
        choices: [
          {
            message: {
              tool_calls: [{ function: { arguments: "{}" } }],
            },
          },
        ],
      }),
    ).toThrow("OpenAI tool call 0 is missing a tool name.");
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

    expect(() =>
      parseAnthropicToolCalls({
        content: [{ type: "tool_use", id: "tool-2", input: {} }],
      }),
    ).toThrow("Anthropic tool_use 0 is missing a tool name.");
  });
});
