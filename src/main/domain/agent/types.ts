import type {
  LlmProtocol,
  ModelReasoningEffort,
} from "../../../shared/agent-contracts";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string };

export interface AgentMessage {
  role: AgentRole;
  content: string | AgentContentBlock[];
  toolCallId?: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolResult {
  toolCallId: string;
  name: string;
  content: string;
}

export interface AgentToolContext {
  threadId: string;
  turnId: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmRequest {
  protocol: LlmProtocol;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  maxTokens: number;
  temperature: number;
  thinking: boolean;
  reasoningEffort: ModelReasoningEffort;
}

export interface LlmResponse {
  text: string;
  reasoning?: string;
  toolCalls: AgentToolCall[];
  usage?: AgentUsage;
  raw: unknown;
}

export type LlmStopReason = "stop" | "tool_calls" | "length" | "error";

export type LlmStreamChunk =
  | { kind: "text_delta"; text: string }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "tool_call_delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { kind: "tool_call_completed"; toolCall: AgentToolCall }
  | { kind: "usage"; usage: AgentUsage }
  | { kind: "completed"; stopReason: LlmStopReason }
  | { kind: "error"; message: string; code?: string };

export interface LlmStreamOptions {
  signal?: AbortSignal;
}

export interface LlmGateway {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest, options?: LlmStreamOptions): AsyncIterable<LlmStreamChunk>;
}

export interface AgentTool {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, context: AgentToolContext): Promise<string>;
}
