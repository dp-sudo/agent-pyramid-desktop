import { describe, expect, it, vi } from "vitest";
import { MiniMaxGateway } from "../../../src/main/infrastructure/minimax/minimax-gateway";
import type { LlmRequest, LlmStreamChunk } from "../../../src/main/domain/agent/types";

const baseRequest: LlmRequest = {
  protocol: "openai-compatible",
  provider: "Custom",
  model: "custom-model",
  apiKey: "test-key",
  baseUrl: "https://provider.example.test/v1",
  systemPrompt: "You are concise.",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  maxTokens: 256,
  temperature: 0.2,
  thinking: true,
  reasoningEffort: "high",
};

describe("MiniMaxGateway", () => {
  it("sends a minimal custom OpenAI-compatible request when no tools are present", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Done",
                reasoning_content: "Thought",
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await new MiniMaxGateway().complete(baseRequest);
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(url).toBe("https://provider.example.test/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    });
    expect(body).toMatchObject({
      model: "custom-model",
      max_tokens: 256,
      temperature: 0.2,
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("stream_options");
    expect(response).toMatchObject({
      text: "Done",
      reasoning: "Thought",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  it("sends a minimal Anthropic-compatible request when no tools are present", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "Done" },
            { type: "thinking", thinking: "Thought" },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await new MiniMaxGateway().complete({
      ...baseRequest,
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example.test/anthropic",
    });
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(url).toBe("https://provider.example.test/anthropic/v1/messages");
    expect(body).toMatchObject({
      model: "custom-model",
      max_tokens: 256,
      temperature: 0.2,
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("stream");
    expect(response).toMatchObject({
      text: "Done",
      reasoning: "Thought",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  it("uses DeepSeek endpoint and maps xhigh reasoning effort to max", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new MiniMaxGateway().complete({
      ...baseRequest,
      provider: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      reasoningEffort: "xhigh",
      tools: [
        {
          name: "update_goal",
          description: "Update goal",
          inputSchema: { type: "object" },
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(body).toMatchObject({
      max_tokens: 256,
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      tool_choice: "auto",
    });
  });

  it("serializes historical OpenAI tool call arguments with stable key order", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new MiniMaxGateway().complete({
      ...baseRequest,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "read_file",
              arguments: { z: 1, a: { y: 2, b: 3 } },
            },
          ],
        },
        { role: "tool", toolCallId: "call-1", content: "result" },
      ],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ tool_calls?: Array<{ function?: { arguments?: string } }> }>;
    };
    expect(body.messages[1].tool_calls?.[0]?.function?.arguments).toBe(
      "{\"a\":{\"b\":3,\"y\":2},\"z\":1}",
    );
  });

  it("streams OpenAI-compatible deltas, usage, and completed tool calls", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"Hel","reasoning_content":"Think "}}]}',
              "",
              'data: {"choices":[{"delta":{"content":"Hello","tool_calls":[{"index":0,"id":"call-1","function":{"name":"create_plan","arguments":"{\\"steps\\":"}}]}}]}',
              "",
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[]}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9,"prompt_cache_hit_tokens":3,"prompt_cache_miss_tokens":1}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "text_delta", text: "Hel" },
      { kind: "reasoning_delta", text: "Think " },
      { kind: "text_delta", text: "lo" },
      {
        kind: "tool_call_delta",
        toolCallId: "call-1",
        name: "create_plan",
        argumentsDelta: "{\"steps\":",
      },
      {
        kind: "usage",
        usage: {
          inputTokens: 4,
          outputTokens: 5,
          totalTokens: 9,
          cacheHitTokens: 3,
          cacheMissTokens: 1,
          cacheHitRate: 0.75,
        },
      },
      {
        kind: "tool_call_delta",
        toolCallId: "call-1",
        name: "create_plan",
        argumentsDelta: "[]}",
      },
      {
        kind: "tool_call_completed",
        toolCall: { id: "call-1", name: "create_plan", arguments: { steps: [] } },
      },
      { kind: "completed", stopReason: "tool_calls" },
    ]);
  });

  it("flushes pending OpenAI-compatible tool calls when providers finish with stop", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"create_plan","arguments":"{\\"steps\\":[]}"}}]}}]}',
              "",
              'data: {"choices":[{"finish_reason":"stop"}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        kind: "tool_call_delta",
        toolCallId: "call-1",
        name: "create_plan",
        argumentsDelta: "{\"steps\":[]}",
      },
      {
        kind: "tool_call_completed",
        toolCall: { id: "call-1", name: "create_plan", arguments: { steps: [] } },
      },
      { kind: "completed", stopReason: "stop" },
    ]);
  });

  it("keeps reading OpenAI-compatible streams after finish_reason to capture usage-only frames", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":null}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "text_delta", text: "Done" },
      { kind: "usage", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
      { kind: "completed", stopReason: "stop" },
    ]);
  });

  it("flushes pending OpenAI-compatible tool calls when streams end with DONE only", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"update_goal","arguments":"{\\"status\\":\\"complete\\"}"}}]}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        kind: "tool_call_delta",
        toolCallId: "call-1",
        name: "update_goal",
        argumentsDelta: "{\"status\":\"complete\"}",
      },
      {
        kind: "tool_call_completed",
        toolCall: { id: "call-1", name: "update_goal", arguments: { status: "complete" } },
      },
      { kind: "completed", stopReason: "stop" },
    ]);
  });

  it("rejects streamed OpenAI-compatible tool calls without tool names", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"arguments":"{}"}}]}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    await expect(async () => {
      for await (const _chunk of new MiniMaxGateway().stream(baseRequest)) {
        void _chunk;
      }
    }).rejects.toThrow("OpenAI streamed tool call call-1 is missing a tool name.");
  });

  it("converts Anthropic-compatible tool messages and streams tool calls", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
              "",
              'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"update_goal"}}',
              "",
              'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"status\\":\\"complete\\"}"}}',
              "",
              'data: {"type":"content_block_stop","index":1}',
              "",
              'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":2,"output_tokens":3}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream({
      ...baseRequest,
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example.test/anthropic",
      messages: [
        { role: "user", content: "Run" },
        { role: "tool", toolCallId: "tool-0", content: "result" },
      ],
    })) {
      chunks.push(chunk);
    }

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    } & Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-0",
          content: "result",
        },
      ],
    });
    expect(chunks).toEqual([
      { kind: "text_delta", text: "Hi" },
      {
        kind: "tool_call_completed",
        toolCall: {
          id: "tool-1",
          name: "update_goal",
          arguments: { status: "complete" },
        },
      },
      { kind: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
      { kind: "completed", stopReason: "tool_calls" },
    ]);
  });

  it("flushes pending Anthropic-compatible tool calls when content_block_stop is missing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"update_goal"}}',
              "",
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"status\\":\\"blocked\\"}"}}',
              "",
              'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream({
      ...baseRequest,
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example.test/anthropic",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        kind: "tool_call_completed",
        toolCall: {
          id: "tool-1",
          name: "update_goal",
          arguments: { status: "blocked" },
        },
      },
      { kind: "completed", stopReason: "tool_calls" },
    ]);
  });

  it("rejects streamed Anthropic-compatible tool calls without tool names", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1"}}',
              "",
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
              "",
              'data: {"type":"content_block_stop","index":0}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    await expect(async () => {
      for await (const _chunk of new MiniMaxGateway().stream({
        ...baseRequest,
        protocol: "anthropic-compatible",
        baseUrl: "https://provider.example.test/anthropic",
      })) {
        void _chunk;
      }
    }).rejects.toThrow("Anthropic streamed tool call tool-1 is missing a tool name.");
  });

  it("keeps reading Anthropic-compatible streams after stop_reason to capture usage-only frames", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}',
              "",
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
              "",
              'data: {"type":"message_delta","usage":{"input_tokens":7,"output_tokens":4}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream({
      ...baseRequest,
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example.test/anthropic",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "text_delta", text: "Done" },
      { kind: "usage", usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } },
      { kind: "completed", stopReason: "stop" },
    ]);
  });

  it("merges Anthropic-compatible stream usage from message_start and message_delta frames", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":6}}}',
              "",
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}',
              "",
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of new MiniMaxGateway().stream({
      ...baseRequest,
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example.test/anthropic",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          cacheHitTokens: 4,
          cacheMissTokens: 6,
          cacheHitRate: 0.4,
        },
      },
      { kind: "text_delta", text: "Done" },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheHitTokens: 4,
          cacheMissTokens: 6,
          cacheHitRate: 0.4,
        },
      },
      { kind: "completed", stopReason: "stop" },
    ]);
  });

  it("reports invalid JSON provider responses and HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 })),
    );
    await expect(new MiniMaxGateway().complete(baseRequest)).rejects.toThrow(
      "LLM openai-compatible response was not valid JSON",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("bad request", { status: 400 })),
    );
    await expect(new MiniMaxGateway().complete(baseRequest)).rejects.toThrow(
      "LLM openai-compatible request failed with HTTP 400: bad request",
    );
  });
});
