import type {
  AgentContentBlock,
  AgentMessage,
  AgentToolCall,
  AgentUsage,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmStreamOptions,
  LlmStopReason,
} from "../../domain/agent/types";
import {
  mapAnthropicUsageFields,
  normalizeAnthropicUsage,
  normalizeToolDefinitions,
  parseAnthropicToolCalls,
  toAnthropicTool,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicMessageResponse,
} from "./minimax-types.js";
import { readSseJson } from "./sse-parser.js";
import {
  ANTHROPIC_MESSAGES_PATH,
  numberOrUndefined,
  parseToolArguments,
  postJson,
  postStream,
  requiredStreamToolName,
  resolveEndpoint,
  resolveRequestApiKey,
} from "./gateway-common.js";

interface AnthropicStreamPayload {
  type?: string;
  index?: number;
  message?: {
    usage?: AnthropicMessageResponse["usage"];
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicMessageResponse["usage"];
}

interface PendingAnthropicToolCall {
  id: string;
  name?: string;
  argumentsText: string;
}

class AnthropicToolCallAccumulator {
  private readonly pendingByIndex = new Map<number, PendingAnthropicToolCall>();

  start(index: number, block: NonNullable<AnthropicStreamPayload["content_block"]>): void {
    if (block.type !== "tool_use") return;
    this.pendingByIndex.set(index, {
      id: block.id ?? `tool_call_${index}`,
      name: block.name,
      argumentsText:
        block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "",
    });
  }

  appendJson(index: number, value: string): void {
    const pending = this.pendingByIndex.get(index);
    if (!pending) return;
    pending.argumentsText += value;
  }

  complete(index: number): AgentToolCall | null {
    const pending = this.pendingByIndex.get(index);
    if (!pending) return null;
    const name = requiredStreamToolName(pending.name, `Anthropic streamed tool call ${pending.id}`);
    this.pendingByIndex.delete(index);
    return {
      id: pending.id,
      name,
      arguments: parseToolArguments(pending.argumentsText || "{}", name),
    };
  }

  completeAll(): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    for (const index of this.pendingByIndex.keys()) {
      const toolCall = this.complete(index);
      if (toolCall) {
        calls.push(toolCall);
      }
    }
    return calls;
  }
}

/**
 * Anthropic-compatible completion adapter. It converts the shared LlmRequest
 * into Messages API shape without leaking provider message rules upward.
 */
export async function completeAnthropicCompatible(request: LlmRequest): Promise<LlmResponse> {
  const anthropicRequest = toAnthropicRequestParts(request);
  const body = buildAnthropicCompatibleBody(request, anthropicRequest, false);
  const apiKey = resolveRequestApiKey(request);

  const response = await postJson<AnthropicMessageResponse>(
    resolveEndpoint(request.baseUrl, ANTHROPIC_MESSAGES_PATH),
    apiKey,
    body,
    "anthropic-compatible",
  );
  const blocks = response.content ?? [];
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter((value): value is string => Boolean(value))
    .join("");
  const reasoning = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .filter((value): value is string => Boolean(value))
    .join("");

  return {
    text,
    reasoning,
    toolCalls: parseAnthropicToolCalls(response),
    usage: normalizeAnthropicUsage(response),
    raw: response,
  };
}

/**
 * Anthropic-compatible SSE adapter. It normalizes Messages API events into the
 * same runtime stream chunks used by OpenAI-compatible providers.
 */
export async function* streamAnthropicCompatible(
  request: LlmRequest,
  options: LlmStreamOptions,
): AsyncIterable<LlmStreamChunk> {
  const anthropicRequest = toAnthropicRequestParts(request);
  const body = buildAnthropicCompatibleBody(request, anthropicRequest, true);
  const apiKey = resolveRequestApiKey(request);

  const response = await postStream(
    resolveEndpoint(request.baseUrl, ANTHROPIC_MESSAGES_PATH),
    apiKey,
    body,
    "anthropic-compatible",
    options.signal,
  );

  let stopReason: LlmStopReason = "stop";
  let usage: AgentUsage | undefined;
  const toolAccumulator = new AnthropicToolCallAccumulator();

  for await (const payload of readSseJson(response.body, options.signal)) {
    const result = consumeAnthropicStreamPayload(payload, toolAccumulator);
    if (result.usage) {
      usage = mergeAnthropicStreamUsage(usage, result.usage);
      yield { kind: "usage", usage };
    }
    if (result.stopReason) {
      stopReason = result.stopReason;
    }
    for (const chunk of result.chunks) {
      yield chunk;
    }
  }

  for (const toolCall of toolAccumulator.completeAll()) {
    yield { kind: "tool_call_completed", toolCall };
  }
  yield { kind: "completed", stopReason };
}

function consumeAnthropicStreamPayload(
  raw: unknown,
  toolAccumulator: AnthropicToolCallAccumulator,
): {
  chunks: LlmStreamChunk[];
  stopReason?: LlmStopReason;
  usage?: AgentUsage;
} {
  const payload = raw as AnthropicStreamPayload;
  const chunks: LlmStreamChunk[] = [];
  const index = numberOrUndefined(payload.index);
  const usage = mapAnthropicStreamUsage(payload);

  if (payload.type === "content_block_start" && index !== undefined && payload.content_block) {
    toolAccumulator.start(index, payload.content_block);
  }

  if (payload.type === "content_block_delta" && payload.delta) {
    if (payload.delta.type === "text_delta" && payload.delta.text) {
      chunks.push({ kind: "text_delta", text: payload.delta.text });
    } else if (payload.delta.type === "thinking_delta" && payload.delta.thinking) {
      chunks.push({ kind: "reasoning_delta", text: payload.delta.thinking });
    } else if (
      payload.delta.type === "input_json_delta" &&
      index !== undefined &&
      typeof payload.delta.partial_json === "string"
    ) {
      toolAccumulator.appendJson(index, payload.delta.partial_json);
    }
  }

  if (payload.type === "content_block_stop" && index !== undefined) {
    const toolCall = toolAccumulator.complete(index);
    if (toolCall) {
      chunks.push({ kind: "tool_call_completed", toolCall });
    }
  }

  if (payload.type === "message_delta") {
    return {
      chunks,
      stopReason: mapAnthropicStopReason(payload.delta?.stop_reason),
      usage,
    };
  }

  return {
    chunks,
    usage,
  };
}

function buildAnthropicCompatibleBody(
  request: LlmRequest,
  anthropicRequest: {
    system?: string;
    messages: AnthropicMessage[];
  },
  stream: boolean,
): Record<string, unknown> {
  const tools = normalizeToolDefinitions(request.tools).map(toAnthropicTool);
  return {
    model: request.model,
    system: anthropicRequest.system,
    messages: anthropicRequest.messages,
    ...(tools.length > 0
      ? {
          tools,
          tool_choice: {
            type: "auto",
          },
        }
      : {}),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    ...(stream ? { stream: true } : {}),
    thinking: {
      type: request.thinking ? "adaptive" : "disabled",
    },
  };
}

function toAnthropicRequestParts(request: LlmRequest): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts = [
    request.systemPrompt,
    ...request.messages
      .filter((message) => message.role === "system")
      .map((message) => contentAsText(message.content)),
  ].filter((part): part is string => Boolean(part?.trim()));
  const messages = request.messages.filter((message) => message.role !== "system");
  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: toAnthropicMessages(messages),
  };
}

function toAnthropicMessages(messages: AgentMessage[]): AnthropicMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new Error("Anthropic tool_result messages require toolCallId.");
      }

      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: contentAsText(message.content),
          },
        ],
      };
    }

    if (message.role === "system") {
      throw new Error("Anthropic system messages must be passed through the system field.");
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const text = contentAsText(message.content);
      return {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool_use" as const,
            id: call.id,
            name: call.name,
            input: canonicalizeJsonRecord(call.arguments),
          })),
        ],
      };
    }

    return {
      role: message.role,
      content: toAnthropicContent(message.content),
    };
  });
}

function canonicalizeJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const canonical = canonicalizeJson(value);
  return canonical && typeof canonical === "object" && !Array.isArray(canonical)
    ? (canonical as Record<string, unknown>)
    : {};
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

function toAnthropicContent(
  content: AgentMessage["content"],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.dataBase64,
      },
    };
  });
}

function contentAsText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is Extract<AgentContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function mapAnthropicStreamUsage(payload: AnthropicStreamPayload): AgentUsage | undefined {
  const usage = payload.usage ?? payload.message?.usage;
  return usage ? mapAnthropicUsageFields(usage) : undefined;
}

function mergeAnthropicStreamUsage(
  previous: AgentUsage | undefined,
  next: AgentUsage,
): AgentUsage {
  const merged: AgentUsage = {
    ...(previous ?? {}),
    ...next,
  };
  if (merged.inputTokens !== undefined && merged.outputTokens !== undefined) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
  }
  if (merged.cacheHitTokens !== undefined || merged.cacheMissTokens !== undefined) {
    const cacheHitTokens = merged.cacheHitTokens ?? 0;
    const cacheMissTokens = merged.cacheMissTokens ?? 0;
    const cacheTotal = cacheHitTokens + cacheMissTokens;
    merged.cacheHitRate = cacheTotal > 0 ? cacheHitTokens / cacheTotal : null;
  }
  return merged;
}

function mapAnthropicStopReason(reason: string | undefined | null): LlmStopReason {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "error":
      return "error";
    default:
      return "stop";
  }
}
