import type { AgentToolCall, AgentToolDefinition, AgentUsage } from "../../domain/agent/types";

export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentBlock[];
  tool_call_id?: string;
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
      parameters: tool.inputSchema
    }
  };
}

export function toAnthropicTool(tool: AgentToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  };
}

export function normalizeOpenAiUsage(response: OpenAiChatResponse): AgentUsage | undefined {
  if (!response.usage) {
    return undefined;
  }

  return {
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens
  };
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
