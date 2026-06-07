import type { AgentToolCall, AgentToolDefinition, AgentUsage } from "../../domain/agent/types";

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
  };
}

export function toOpenAiTool(tool: AgentToolDefinition): OpenAiTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: canonicalizeSchema(tool.inputSchema)
    }
  };
}

export function toAnthropicTool(tool: AgentToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: canonicalizeSchema(tool.inputSchema)
  };
}

export function normalizeToolDefinitions(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
  return [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeSchema(tool.inputSchema),
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

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof inputTokens === "number" && typeof outputTokens === "number"
        ? inputTokens + outputTokens
        : undefined
  };
}

export function parseOpenAiToolCalls(response: OpenAiChatResponse): AgentToolCall[] {
  const calls = response.choices?.[0]?.message?.tool_calls ?? [];

  return calls.map((call, index) => {
    const rawArguments = call.function?.arguments ?? "{}";
    const parsedArguments = parseToolArguments(rawArguments, call.function?.name ?? `tool_${index}`);

    return {
      id: call.id ?? `tool_call_${index}`,
      name: call.function?.name ?? "",
      arguments: parsedArguments
    };
  });
}

export function parseAnthropicToolCalls(response: AnthropicMessageResponse): AgentToolCall[] {
  const blocks = response.content ?? [];

  return blocks
    .filter((block) => block.type === "tool_use")
    .map((block, index) => ({
      id: block.id ?? `tool_call_${index}`,
      name: block.name ?? "",
      arguments: block.input ?? {}
    }));
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

type OpenAiUsageFields = NonNullable<OpenAiChatResponse["usage"]>;

export function mapOpenAiUsageFields(usage: OpenAiUsageFields): AgentUsage {
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const fallbackTotal =
    typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined;
  const cacheHitTokens = resolveCacheHitTokens(usage);
  const cacheMissTokens = resolveCacheMissTokens(usage, cacheHitTokens);
  const cacheTotal = (cacheHitTokens ?? 0) + (cacheMissTokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? fallbackTotal,
    ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
    ...(cacheHitTokens !== undefined
      ? { cacheHitRate: cacheTotal > 0 ? cacheHitTokens / cacheTotal : null }
      : {}),
  };
}

function resolveCacheHitTokens(usage: OpenAiUsageFields): number | undefined {
  const nativeHit = nonNegativeIntegerOrUndefined(usage.prompt_cache_hit_tokens);
  const nativeMiss = nonNegativeIntegerOrUndefined(usage.prompt_cache_miss_tokens);
  if (nativeHit !== undefined || nativeMiss !== undefined) {
    return nativeHit ?? 0;
  }

  return (
    nonNegativeIntegerOrUndefined(usage.prompt_tokens_details?.cached_tokens) ??
    nonNegativeIntegerOrUndefined(usage.cache_read_input_tokens)
  );
}

function resolveCacheMissTokens(
  usage: OpenAiUsageFields,
  cacheHitTokens: number | undefined,
): number | undefined {
  const nativeHit = nonNegativeIntegerOrUndefined(usage.prompt_cache_hit_tokens);
  const nativeMiss = nonNegativeIntegerOrUndefined(usage.prompt_cache_miss_tokens);
  if (nativeHit !== undefined || nativeMiss !== undefined) {
    return nativeMiss ?? 0;
  }

  if (cacheHitTokens === undefined || typeof usage.prompt_tokens !== "number") {
    return undefined;
  }
  return Math.max(0, Math.floor(usage.prompt_tokens) - cacheHitTokens);
}

function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function canonicalizeSchema(value: unknown): Record<string, unknown> {
  const canonical = canonicalize(value);
  return canonical && typeof canonical === "object" && !Array.isArray(canonical)
    ? (canonical as Record<string, unknown>)
    : {};
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
