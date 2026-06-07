import type {
  AgentMessage,
  LlmGateway,
  LlmRequest,
  LlmResponse
} from "../../domain/agent/types";
import {
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  parseAnthropicToolCalls,
  parseOpenAiToolCalls,
  toAnthropicTool,
  toOpenAiTool,
  type AnthropicMessage,
  type AnthropicMessageResponse,
  type OpenAiChatMessage,
  type OpenAiChatResponse
} from "./minimax-types";

const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const ANTHROPIC_MESSAGES_PATH = "/anthropic/v1/messages";

export class MiniMaxGateway implements LlmGateway {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.protocol === "openai-compatible") {
      return this.completeOpenAiCompatible(request);
    }

    return this.completeAnthropicCompatible(request);
  }

  private async completeOpenAiCompatible(request: LlmRequest): Promise<LlmResponse> {
    const messages = toOpenAiMessages(request);
    const body = {
      model: request.model,
      messages,
      tools: request.tools.map(toOpenAiTool),
      tool_choice: "auto",
      temperature: request.temperature,
      max_completion_tokens: request.maxTokens,
      reasoning_split: true,
      thinking: {
        type: request.thinking ? "adaptive" : "disabled"
      }
    };

    const response = await postJson<OpenAiChatResponse>(
      resolveEndpoint(request.baseUrl, OPENAI_CHAT_COMPLETIONS_PATH),
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
    const body = {
      model: request.model,
      system: request.systemPrompt,
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map(toAnthropicTool),
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
      content: message.content,
      tool_call_id: message.toolCallId
    });
  }

  return messages;
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
            content: message.content
          }
        ]
      };
    }

    if (message.role === "system") {
      throw new Error("Anthropic system messages must be passed through the system field.");
    }

    return {
      role: message.role,
      content: message.content
    };
  });
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
      `MiniMax ${protocol} request failed with HTTP ${response.status}: ${responseText.slice(0, 800)}`
    );
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`MiniMax ${protocol} response was not valid JSON: ${reason}`);
  }
}
