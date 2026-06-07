import type { LlmProtocol } from "../../../shared/agent-contracts";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  role: AgentRole;
  content: string;
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

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmRequest {
  protocol: LlmProtocol;
  model: string;
  apiKey: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  maxTokens: number;
  temperature: number;
}

export interface LlmResponse {
  text: string;
  reasoning?: string;
  toolCalls: AgentToolCall[];
  usage?: AgentUsage;
  raw: unknown;
}

export interface LlmGateway {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface AgentTool {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>): Promise<string>;
}
