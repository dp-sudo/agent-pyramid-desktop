import type {
  AgentContentBlock,
  AgentMessage,
  AgentToolCall,
  AgentUsage,
  LlmGateway,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmStreamOptions,
  LlmStopReason
} from "../../domain/agent/types";
import {
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  normalizeToolDefinitions,
  mapOpenAiUsageFields,
  parseAnthropicToolCalls,
  parseOpenAiToolCalls,
  stableJsonStringify,
  toAnthropicTool,
  toOpenAiTool,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicMessageResponse,
  type OpenAiChatMessage,
  type OpenAiChatResponse,
  type OpenAiContentBlock,
  type OpenAiToolCallMessage
} from "./minimax-types";

const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const ANTHROPIC_MESSAGES_PATH = "/anthropic/v1/messages";
const DEEPSEEK_CHAT_COMPLETIONS_PATH = "/chat/completions";
type ProviderDialect = "minimax" | "deepseek" | "custom";

export class MiniMaxGateway implements LlmGateway {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.protocol === "openai-compatible") {
      return this.completeOpenAiCompatible(request);
    }

    return this.completeAnthropicCompatible(request);
  }

  async *stream(
    request: LlmRequest,
    options: LlmStreamOptions = {}
  ): AsyncIterable<LlmStreamChunk> {
    if (request.protocol === "openai-compatible") {
      yield* this.streamOpenAiCompatible(request, options);
      return;
    }

    yield* this.streamAnthropicCompatible(request, options);
  }

  private async completeOpenAiCompatible(request: LlmRequest): Promise<LlmResponse> {
    const messages = toOpenAiMessages(request);
    const dialect = resolveProviderDialect(request.provider);
    const body = buildOpenAiCompatibleBody(request, messages, false, dialect);

    const response = await postJson<OpenAiChatResponse>(
      resolveOpenAiEndpoint(request.baseUrl, dialect),
      request.apiKey,
      body,
      "openai-compatible"
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
      raw: response
    };
  }

  private async completeAnthropicCompatible(request: LlmRequest): Promise<LlmResponse> {
    const anthropicRequest = toAnthropicRequestParts(request);
    const body = {
      model: request.model,
      system: anthropicRequest.system,
      messages: anthropicRequest.messages,
      tools: normalizeToolDefinitions(request.tools).map(toAnthropicTool),
      tool_choice: {
        type: "auto"
      },
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      thinking: {
        type: request.thinking ? "adaptive" : "disabled"
      }
    };

    const response = await postJson<AnthropicMessageResponse>(
      resolveEndpoint(request.baseUrl, ANTHROPIC_MESSAGES_PATH),
      request.apiKey,
      body,
      "anthropic-compatible"
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
      raw: response
    };
  }

  private async *streamOpenAiCompatible(
    request: LlmRequest,
    options: LlmStreamOptions
  ): AsyncIterable<LlmStreamChunk> {
    const messages = toOpenAiMessages(request);
    const dialect = resolveProviderDialect(request.provider);
    const body = buildOpenAiCompatibleBody(request, messages, true, dialect);

    const response = await postStream(
      resolveOpenAiEndpoint(request.baseUrl, dialect),
      request.apiKey,
      body,
      "openai-compatible",
      options.signal
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
        reasoning
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
      if (isTerminalFinishReason(finishReason)) {
        break;
      }
    }

    const stopReason = mapOpenAiStopReason(finishReason);
    yield { kind: "completed", stopReason };
  }

  private async *streamAnthropicCompatible(
    request: LlmRequest,
    options: LlmStreamOptions
  ): AsyncIterable<LlmStreamChunk> {
    const anthropicRequest = toAnthropicRequestParts(request);
    const body = {
      model: request.model,
      system: anthropicRequest.system,
      messages: anthropicRequest.messages,
      tools: normalizeToolDefinitions(request.tools).map(toAnthropicTool),
      tool_choice: {
        type: "auto"
      },
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
      thinking: {
        type: request.thinking ? "adaptive" : "disabled"
      }
    };

    const response = await postStream(
      resolveEndpoint(request.baseUrl, ANTHROPIC_MESSAGES_PATH),
      request.apiKey,
      body,
      "anthropic-compatible",
      options.signal
    );

    let stopReason: LlmStopReason = "stop";
    const toolAccumulator = new AnthropicToolCallAccumulator();

    for await (const payload of readSseJson(response.body, options.signal)) {
      const result = consumeAnthropicStreamPayload(payload, toolAccumulator);
      if (result.usage) {
        yield { kind: "usage", usage: result.usage };
      }
      if (result.stopReason) {
        stopReason = result.stopReason;
      }
      for (const chunk of result.chunks) {
        yield chunk;
      }
      if (result.stopReason) {
        break;
      }
    }

    yield { kind: "completed", stopReason };
  }
}

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

interface AnthropicStreamPayload {
  type?: string;
  index?: number;
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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
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
      argumentsText: ""
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
        argumentsDelta: call.function.arguments
      });
    }
    this.pending.set(id, pending);
    return chunks;
  }

  completeAll(): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    for (const pending of this.pending.values()) {
      if (!pending.name) continue;
      calls.push({
        id: pending.id,
        name: pending.name,
        arguments: parseToolArguments(pending.argumentsText || "{}", pending.name)
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
        block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ""
    });
  }

  appendJson(index: number, value: string): void {
    const pending = this.pendingByIndex.get(index);
    if (!pending) return;
    pending.argumentsText += value;
  }

  complete(index: number): AgentToolCall | null {
    const pending = this.pendingByIndex.get(index);
    if (!pending || !pending.name) return null;
    this.pendingByIndex.delete(index);
    return {
      id: pending.id,
      name: pending.name,
      arguments: parseToolArguments(pending.argumentsText || "{}", pending.name)
    };
  }
}

function consumeOpenAiStreamPayload(
  raw: unknown,
  toolAccumulator: OpenAiToolCallAccumulator,
  previousText: string,
  previousReasoning: string
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
    usage: payload.usage ? mapOpenAiUsageFields(payload.usage) : undefined
  };
}

function consumeAnthropicStreamPayload(
  raw: unknown,
  toolAccumulator: AnthropicToolCallAccumulator
): {
  chunks: LlmStreamChunk[];
  stopReason?: LlmStopReason;
  usage?: AgentUsage;
} {
  const payload = raw as AnthropicStreamPayload;
  const chunks: LlmStreamChunk[] = [];
  const index = numberOrUndefined(payload.index);

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
      usage: payload.usage ? mapAnthropicUsage(payload.usage) : undefined
    };
  }

  return {
    chunks,
    usage: payload.usage ? mapAnthropicUsage(payload.usage) : undefined
  };
}

function resolveEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("base_url is required.");
  }

  if (path === OPENAI_CHAT_COMPLETIONS_PATH && trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }

  if (path === OPENAI_CHAT_COMPLETIONS_PATH && trimmed.endsWith("/anthropic")) {
    return `${trimmed.slice(0, -"/anthropic".length)}${OPENAI_CHAT_COMPLETIONS_PATH}`;
  }

  if (path === ANTHROPIC_MESSAGES_PATH && trimmed.endsWith("/v1")) {
    return `${trimmed.slice(0, -3)}${ANTHROPIC_MESSAGES_PATH}`;
  }

  if (
    path === ANTHROPIC_MESSAGES_PATH &&
    trimmed.endsWith("/anthropic")
  ) {
    return `${trimmed}/v1/messages`;
  }

  return `${trimmed}${path}`;
}

function resolveOpenAiEndpoint(baseUrl: string, dialect: ProviderDialect): string {
  return dialect === "deepseek"
    ? resolveEndpoint(baseUrl, DEEPSEEK_CHAT_COMPLETIONS_PATH)
    : resolveEndpoint(baseUrl, OPENAI_CHAT_COMPLETIONS_PATH);
}

function buildOpenAiCompatibleBody(
  request: LlmRequest,
  messages: OpenAiChatMessage[],
  stream: boolean,
  dialect: ProviderDialect
): Record<string, unknown> {
  const tools = normalizeToolDefinitions(request.tools).map(toOpenAiTool);
  const common = {
    model: request.model,
    messages,
    temperature: request.temperature,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {})
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
              include_usage: true
            }
          }
        : {}),
      thinking: {
        type: request.thinking ? "adaptive" : "disabled"
      }
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
              include_usage: true
            }
          }
        : {}),
      thinking: {
        type: request.thinking ? "enabled" : "disabled"
      },
      reasoning_effort: mapDeepSeekReasoningEffort(request.reasoningEffort)
    };
  }

  return {
    ...common,
    max_tokens: request.maxTokens,
    ...(stream
      ? {
          stream: true
        }
      : {})
  };
}

function resolveProviderDialect(provider: string): ProviderDialect {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "minimax") return "minimax";
  if (normalized === "deepseek") return "deepseek";
  return "custom";
}

function mapDeepSeekReasoningEffort(effort: LlmRequest["reasoningEffort"]): "high" | "max" {
  return effort === "xhigh" ? "max" : "high";
}

function toOpenAiMessages(request: LlmRequest): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];

  if (request.systemPrompt) {
    messages.push({
      role: "system",
      content: request.systemPrompt
    });
  }

  for (const message of request.messages) {
    messages.push({
      role: message.role,
      content: toOpenAiContent(message.content),
      tool_call_id: message.toolCallId,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? { tool_calls: message.toolCalls.map(toOpenAiToolCallMessage) }
        : {})
    });
  }

  return messages;
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
            content: contentAsText(message.content)
          }
        ]
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
                input: canonicalizeJsonRecord(call.arguments)
              }))
            ]
          };
    }

    return {
      role: message.role,
      content: toAnthropicContent(message.content)
    };
  });
}

function toOpenAiToolCallMessage(call: AgentToolCall): OpenAiToolCallMessage {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: stableJsonStringify(call.arguments)
    }
  };
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

function toOpenAiContent(content: AgentMessage["content"]): string | OpenAiContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    return {
      type: "image_url",
      image_url: {
        url: `data:${block.mimeType};base64,${block.dataBase64}`
      }
    };
  });
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
        data: block.dataBase64
      }
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

async function postJson<T>(
  url: string,
  apiKey: string,
  body: unknown,
  protocol: LlmRequest["protocol"]
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `LLM ${protocol} request failed with HTTP ${response.status}: ${responseText.slice(0, 800)}`
    );
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM ${protocol} response was not valid JSON: ${reason}`);
  }
}

async function postStream(
  url: string,
  apiKey: string,
  body: unknown,
  protocol: LlmRequest["protocol"],
  signal?: AbortSignal
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `LLM ${protocol} stream failed with HTTP ${response.status}: ${responseText.slice(0, 800)}`
    );
  }

  if (!response.body) {
    throw new Error(`LLM ${protocol} stream response had no body.`);
  }

  return response;
}

async function* readSseJson(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): AsyncIterable<unknown> {
  if (!body) {
    throw new Error("SSE response body is missing.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frame: { block: string; rest: string } | null;
      while ((frame = takeSseFrame(buffer)) !== null) {
        buffer = frame.rest;
        const payload = parseSseFrame(frame.block);
        if (payload === null) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing && !signal?.aborted) {
      const payload = parseSseFrame(trailing);
      if (payload !== null && payload !== "[DONE]") {
        yield payload;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed.
    }
  }
}

function takeSseFrame(buffer: string): { block: string; rest: string } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return {
      block: buffer.slice(0, crlf),
      rest: buffer.slice(crlf + 4)
    };
  }
  return {
    block: buffer.slice(0, lf),
    rest: buffer.slice(lf + 2)
  };
}

function parseSseFrame(frame: string): unknown | "[DONE]" | null {
  const data = frame
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";

  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM stream frame was not valid JSON: ${reason}`);
  }
}

function normalizeMaybeCumulativeDelta(value: string | undefined, previous: string): string {
  if (!value) return "";
  if (previous && value.startsWith(previous)) {
    return value.slice(previous.length);
  }
  return value;
}

function mapAnthropicUsage(usage: NonNullable<AnthropicStreamPayload["usage"]>): AgentUsage {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof inputTokens === "number" && typeof outputTokens === "number"
        ? inputTokens + outputTokens
        : undefined
  };
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

function isTerminalFinishReason(reason: string | undefined): boolean {
  return reason === "stop" || reason === "tool_calls" || reason === "length" || reason === "error";
}

function findOpenAiToolCallByIndex(
  pending: Map<string, PendingOpenAiToolCall>,
  index: number | undefined
): string | undefined {
  if (index === undefined) return undefined;
  for (const [id, value] of pending) {
    if (value.index === index) return id;
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse arguments for tool "${toolName}": ${reason}`);
  }
}
