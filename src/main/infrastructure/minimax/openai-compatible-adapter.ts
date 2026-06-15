import type {
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
  mapOpenAiUsageFields,
  normalizeOpenAiUsage,
  normalizeToolDefinitions,
  parseOpenAiToolCalls,
  stableJsonStringify,
  toOpenAiTool,
  type OpenAiChatMessage,
  type OpenAiChatResponse,
  type OpenAiContentBlock,
  type OpenAiToolCallMessage,
} from "./minimax-types.js";
import { readSseJson } from "./sse-parser.js";
import {
  numberOrUndefined,
  parseToolArguments,
  postJson,
  postStream,
  requiredStreamToolName,
  resolveOpenAiEndpoint,
  resolveProviderDialect,
  resolveRequestApiKey,
  type ProviderDialect,
} from "./gateway-common.js";

interface OpenAiStreamPayload {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: Array<{ text?: string | null }>;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: OpenAiChatResponse["usage"];
}

interface PendingOpenAiToolCall {
  index?: number;
  id: string;
  name?: string;
  argumentsText: string;
}

class OpenAiToolCallAccumulator {
  private readonly pending = new Map<string, PendingOpenAiToolCall>();

  append(call: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): LlmStreamChunk[] {
    const id = this.resolveId(call);
    const pending = this.pending.get(id) ?? {
      id,
      index: numberOrUndefined(call.index),
      argumentsText: "",
    };
    const nextIndex = numberOrUndefined(call.index);
    if (nextIndex !== undefined) pending.index = nextIndex;
    if (call.function?.name) pending.name = call.function.name;
    const chunks: LlmStreamChunk[] = [];
    if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
      pending.argumentsText += call.function.arguments;
      chunks.push({
        kind: "tool_call_delta",
        toolCallId: id,
        name: pending.name,
        argumentsDelta: call.function.arguments,
      });
    }
    this.pending.set(id, pending);
    return chunks;
  }

  completeAll(): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    for (const pending of this.pending.values()) {
      const name = requiredStreamToolName(pending.name, `OpenAI streamed tool call ${pending.id}`);
      calls.push({
        id: pending.id,
        name,
        arguments: parseToolArguments(pending.argumentsText || "{}", name),
      });
    }
    this.pending.clear();
    return calls;
  }

  private resolveId(call: { index?: number; id?: string }): string {
    const nextIndex = numberOrUndefined(call.index);
    const existingByIndex = findOpenAiToolCallByIndex(this.pending, nextIndex);
    if (call.id) {
      if (existingByIndex && existingByIndex !== call.id) {
        const existing = this.pending.get(existingByIndex);
        if (existing) {
          this.pending.delete(existingByIndex);
          existing.id = call.id;
          this.pending.set(call.id, existing);
        }
      }
      return call.id;
    }
    return existingByIndex ?? `tool_call_${this.pending.size}`;
  }
}

/**
 * OpenAI-compatible completion adapter. It owns provider dialect request-body
 * differences while preserving the shared LlmGateway response shape.
 */
export async function completeOpenAiCompatible(request: LlmRequest): Promise<LlmResponse> {
  const messages = toOpenAiMessages(request);
  const dialect = resolveProviderDialect(request.provider);
  const body = buildOpenAiCompatibleBody(request, messages, false, dialect);
  const apiKey = resolveRequestApiKey(request);

  const response = await postJson<OpenAiChatResponse>(
    resolveOpenAiEndpoint(request.baseUrl, dialect),
    apiKey,
    body,
    "openai-compatible",
  );
  const message = response.choices?.[0]?.message;
  const reasoning =
    message?.reasoning_content ??
    message?.reasoning_details
      ?.map((detail) => detail.text)
      .filter((text): text is string => Boolean(text))
      .join("");

  return {
    text: message?.content ?? "",
    reasoning,
    toolCalls: parseOpenAiToolCalls(response),
    usage: normalizeOpenAiUsage(response),
    raw: response,
  };
}

/**
 * OpenAI-compatible SSE adapter. It converts provider deltas into the stable
 * runtime chunk protocol consumed by AgentRuntime.
 */
export async function* streamOpenAiCompatible(
  request: LlmRequest,
  options: LlmStreamOptions,
): AsyncIterable<LlmStreamChunk> {
  const messages = toOpenAiMessages(request);
  const dialect = resolveProviderDialect(request.provider);
  const body = buildOpenAiCompatibleBody(request, messages, true, dialect);
  const apiKey = resolveRequestApiKey(request);

  const response = await postStream(
    resolveOpenAiEndpoint(request.baseUrl, dialect),
    apiKey,
    body,
    "openai-compatible",
    options.signal,
  );

  let text = "";
  let reasoning = "";
  let usage: AgentUsage | undefined;
  let finishReason: string | undefined;
  const toolAccumulator = new OpenAiToolCallAccumulator();

  for await (const payload of readSseJson(response.body, options.signal)) {
    const result = consumeOpenAiStreamPayload(
      payload,
      toolAccumulator,
      text,
      reasoning,
    );
    text = result.text;
    reasoning = result.reasoning;
    if (result.usage) {
      usage = result.usage;
      yield { kind: "usage", usage };
    }
    if (result.finishReason) {
      finishReason = result.finishReason;
    }
    for (const chunk of result.chunks) {
      yield chunk;
    }
  }

  for (const toolCall of toolAccumulator.completeAll()) {
    yield { kind: "tool_call_completed", toolCall };
  }
  const stopReason = mapOpenAiStopReason(finishReason);
  yield { kind: "completed", stopReason };
}

function consumeOpenAiStreamPayload(
  raw: unknown,
  toolAccumulator: OpenAiToolCallAccumulator,
  previousText: string,
  previousReasoning: string,
): {
  chunks: LlmStreamChunk[];
  text: string;
  reasoning: string;
  finishReason?: string;
  usage?: AgentUsage;
} {
  const payload = raw as OpenAiStreamPayload;
  const chunks: LlmStreamChunk[] = [];
  let text = previousText;
  let reasoning = previousReasoning;
  let finishReason: string | undefined;
  const choice = payload.choices?.[0];
  const delta = choice?.delta;

  if (delta) {
    const textDelta = normalizeMaybeCumulativeDelta(delta.content ?? undefined, text);
    if (textDelta) {
      text += textDelta;
      chunks.push({ kind: "text_delta", text: textDelta });
    }

    const reasoningText =
      delta.reasoning_content ??
      delta.reasoning ??
      delta.reasoning_details
        ?.map((detail) => detail.text)
        .filter((value): value is string => typeof value === "string")
        .join("");
    const reasoningDelta = normalizeMaybeCumulativeDelta(reasoningText ?? undefined, reasoning);
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      chunks.push({ kind: "reasoning_delta", text: reasoningDelta });
    }

    for (const call of delta.tool_calls ?? []) {
      chunks.push(...toolAccumulator.append(call));
    }
  }

  if (typeof choice?.finish_reason === "string") {
    finishReason = choice.finish_reason;
    if (finishReason === "tool_calls") {
      for (const toolCall of toolAccumulator.completeAll()) {
        chunks.push({ kind: "tool_call_completed", toolCall });
      }
    }
  }

  return {
    chunks,
    text,
    reasoning,
    finishReason,
    usage: payload.usage ? mapOpenAiUsageFields(payload.usage) : undefined,
  };
}

function buildOpenAiCompatibleBody(
  request: LlmRequest,
  messages: OpenAiChatMessage[],
  stream: boolean,
  dialect: ProviderDialect,
): Record<string, unknown> {
  const tools = normalizeToolDefinitions(request.tools).map(toOpenAiTool);
  const common = {
    model: request.model,
    messages,
    temperature: request.temperature,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };

  if (dialect === "minimax") {
    return {
      ...common,
      max_completion_tokens: request.maxTokens,
      reasoning_split: true,
      ...(stream
        ? {
            stream: true,
            stream_options: {
              include_usage: true,
            },
          }
        : {}),
      thinking: {
        type: request.thinking ? "adaptive" : "disabled",
      },
    };
  }

  if (dialect === "deepseek") {
    return {
      ...common,
      max_tokens: request.maxTokens,
      ...(stream
        ? {
            stream: true,
            stream_options: {
              include_usage: true,
            },
          }
        : {}),
      thinking: {
        type: request.thinking ? "enabled" : "disabled",
      },
      reasoning_effort: mapDeepSeekReasoningEffort(request.reasoningEffort),
    };
  }

  return {
    ...common,
    max_tokens: request.maxTokens,
    ...(stream
      ? {
          stream: true,
        }
      : {}),
  };
}

function mapDeepSeekReasoningEffort(effort: LlmRequest["reasoningEffort"]): "high" | "max" {
  return effort === "xhigh" ? "max" : "high";
}

function toOpenAiMessages(request: LlmRequest): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];

  if (request.systemPrompt) {
    messages.push({
      role: "system",
      content: request.systemPrompt,
    });
  }

  for (const message of request.messages) {
    messages.push({
      role: message.role,
      content: toOpenAiContent(message.content),
      tool_call_id: message.toolCallId,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? { tool_calls: message.toolCalls.map(toOpenAiToolCallMessage) }
        : {}),
    });
  }

  return messages;
}

function toOpenAiToolCallMessage(call: AgentToolCall): OpenAiToolCallMessage {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: stableJsonStringify(call.arguments),
    },
  };
}

function toOpenAiContent(content: AgentMessage["content"]): string | OpenAiContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    return {
      type: "image_url",
      image_url: {
        url: `data:${block.mimeType};base64,${block.dataBase64}`,
      },
    };
  });
}

function normalizeMaybeCumulativeDelta(value: string | undefined, previous: string): string {
  if (!value) return "";
  if (previous && value.startsWith(previous)) {
    return value.slice(previous.length);
  }
  return value;
}

function mapOpenAiStopReason(reason: string | undefined | null): LlmStopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function findOpenAiToolCallByIndex(
  pending: Map<string, PendingOpenAiToolCall>,
  index: number | undefined,
): string | undefined {
  if (index === undefined) return undefined;
  for (const [id, value] of pending) {
    if (value.index === index) return id;
  }
  return undefined;
}
