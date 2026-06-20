import type { AgentToolCall, AgentToolDefinition, AgentUsage } from "../../domain/agent/types";
import { canonicalizeJsonRecord } from "../../stable-json.js";
import { isNonNegativeInteger } from "../../../shared/agent-contracts.js";
import { parseToolArguments } from "./gateway-common.js";

export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentBlock[];
  tool_call_id?: string;
  tool_calls?: OpenAiToolCallMessage[];
}

export type OpenAiContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiToolCallMessage {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiChatResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning_details?: Array<{ text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessageResponse {
  id?: string;
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function toOpenAiTool(tool: AgentToolDefinition): OpenAiTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: canonicalizeJsonRecord(tool.inputSchema)
    }
  };
}

export function toAnthropicTool(tool: AgentToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: canonicalizeJsonRecord(tool.inputSchema)
  };
}

export function normalizeToolDefinitions(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
  return [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeJsonRecord(tool.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeOpenAiUsage(response: OpenAiChatResponse): AgentUsage | undefined {
  if (!response.usage) {
    return undefined;
  }

  return mapOpenAiUsageFields(response.usage);
}

export function normalizeAnthropicUsage(response: AnthropicMessageResponse): AgentUsage | undefined {
  if (!response.usage) {
    return undefined;
  }

  return mapAnthropicUsageFields(response.usage);
}

export function parseOpenAiToolCalls(response: OpenAiChatResponse): AgentToolCall[] {
  const calls = response.choices?.[0]?.message?.tool_calls ?? [];

  return calls.map((call, index) => {
    const name = requiredToolName(call.function?.name, `OpenAI tool call ${index}`);
    const rawArguments = call.function?.arguments ?? "{}";
    const parsedArguments = parseToolArguments(rawArguments, name);

    return {
      id: call.id ?? `tool_call_${index}`,
      name,
      arguments: parsedArguments
    };
  });
}

export function parseAnthropicToolCalls(response: AnthropicMessageResponse): AgentToolCall[] {
  const blocks = response.content ?? [];

  return blocks
    .filter((block) => block.type === "tool_use")
    .map((block, index) => {
      const name = requiredToolName(block.name, `Anthropic tool_use ${index}`);
      return {
        id: block.id ?? `tool_call_${index}`,
        name,
        arguments: block.input ?? {}
      };
    });
}

function requiredToolName(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing a tool name.`);
  }
  return value;
}

type OpenAiUsageFields = NonNullable<OpenAiChatResponse["usage"]>;

export function mapOpenAiUsageFields(usage: OpenAiUsageFields): AgentUsage | undefined {
  const inputTokens = tokenCountOrUndefined(usage.prompt_tokens);
  const outputTokens = tokenCountOrUndefined(usage.completion_tokens);
  const fallbackTotal =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  const totalTokens = tokenCountOrUndefined(usage.total_tokens) ?? fallbackTotal;
  const cacheHitTokens = resolveCacheHitTokens(usage);
  const cacheMissTokens = resolveCacheMissTokens(usage, cacheHitTokens, inputTokens);
  const cacheTotal = (cacheHitTokens ?? 0) + (cacheMissTokens ?? 0);
  const mapped: AgentUsage = {};

  if (inputTokens !== undefined) mapped.inputTokens = inputTokens;
  if (outputTokens !== undefined) mapped.outputTokens = outputTokens;
  if (totalTokens !== undefined) mapped.totalTokens = totalTokens;
  if (cacheHitTokens !== undefined) mapped.cacheHitTokens = cacheHitTokens;
  if (cacheMissTokens !== undefined) mapped.cacheMissTokens = cacheMissTokens;
  if (cacheHitTokens !== undefined) {
    mapped.cacheHitRate = cacheTotal > 0 ? cacheHitTokens / cacheTotal : null;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

type AnthropicUsageFields = NonNullable<AnthropicMessageResponse["usage"]>;

export function mapAnthropicUsageFields(usage: AnthropicUsageFields): AgentUsage | undefined {
  const inputTokens = tokenCountOrUndefined(usage.input_tokens);
  const outputTokens = tokenCountOrUndefined(usage.output_tokens);
  const hasCacheUsage =
    tokenCountOrUndefined(usage.cache_read_input_tokens) !== undefined ||
    tokenCountOrUndefined(usage.cache_creation_input_tokens) !== undefined;
  const cacheHitTokens = hasCacheUsage
    ? tokenCountOrUndefined(usage.cache_read_input_tokens) ?? 0
    : undefined;
  const cacheMissTokens = hasCacheUsage
    ? tokenCountOrUndefined(usage.cache_creation_input_tokens) ?? 0
    : undefined;
  const cacheTotal = (cacheHitTokens ?? 0) + (cacheMissTokens ?? 0);
  const mapped: AgentUsage = {};

  if (inputTokens !== undefined) mapped.inputTokens = inputTokens;
  if (outputTokens !== undefined) mapped.outputTokens = outputTokens;
  if (inputTokens !== undefined && outputTokens !== undefined) {
    mapped.totalTokens = inputTokens + outputTokens;
  }
  if (cacheHitTokens !== undefined) mapped.cacheHitTokens = cacheHitTokens;
  if (cacheMissTokens !== undefined) mapped.cacheMissTokens = cacheMissTokens;
  if (hasCacheUsage) {
    mapped.cacheHitRate = cacheTotal > 0 ? (cacheHitTokens ?? 0) / cacheTotal : null;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function resolveCacheHitTokens(usage: OpenAiUsageFields): number | undefined {
  const nativeHit = tokenCountOrUndefined(usage.prompt_cache_hit_tokens);
  const nativeMiss = tokenCountOrUndefined(usage.prompt_cache_miss_tokens);
  if (nativeHit !== undefined || nativeMiss !== undefined) {
    return nativeHit ?? 0;
  }

  return (
    tokenCountOrUndefined(usage.prompt_tokens_details?.cached_tokens) ??
    tokenCountOrUndefined(usage.cache_read_input_tokens)
  );
}

function resolveCacheMissTokens(
  usage: OpenAiUsageFields,
  cacheHitTokens: number | undefined,
  inputTokens: number | undefined,
): number | undefined {
  const nativeHit = tokenCountOrUndefined(usage.prompt_cache_hit_tokens);
  const nativeMiss = tokenCountOrUndefined(usage.prompt_cache_miss_tokens);
  if (nativeHit !== undefined || nativeMiss !== undefined) {
    return nativeMiss ?? 0;
  }

  if (cacheHitTokens === undefined || inputTokens === undefined) {
    return undefined;
  }
  return Math.max(0, inputTokens - cacheHitTokens);
}

function tokenCountOrUndefined(value: unknown): number | undefined {
  return isNonNegativeInteger(value) ? value : undefined;
}
