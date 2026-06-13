import type {
  LlmProtocol,
  ModelReasoningEffort,
  RuntimeCommandPreferences,
  RuntimePreferences,
  ToolProgressStream,
  TokenUsage,
} from "../../../shared/agent-contracts";

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string };

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AgentContentBlock[];
  toolCallId?: string;
  toolCalls?: AgentToolCall[];
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
  displayResult?: unknown;
}

export interface AgentToolContext {
  threadId: string;
  turnId: string;
  workspace?: string;
  signal?: AbortSignal;
  commandDefaults?: RuntimeCommandPreferences;
  runtimePreferences?: RuntimePreferences;
  reportProgress?: (chunk: string, stream: ToolProgressStream) => void;
  readState?: {
    get(filePath: string): {
      content: string;
      mtimeMs: number;
      size: number;
      sha256: string;
      fullSha256?: string;
      truncated: boolean;
      offsetBytes?: number;
      bytesRead?: number;
    } | undefined;
    set(
      filePath: string,
      state: {
        content: string;
        mtimeMs: number;
        size: number;
        sha256: string;
        fullSha256?: string;
        truncated: boolean;
        offsetBytes?: number;
        bytesRead?: number;
      },
    ): void;
    delete(filePath: string): void;
    clear(): void;
  };
  fileHistory?: {
    push(entry: {
      threadId: string;
      turnId: string;
      toolName: string;
      workspace: string;
      filePath: string;
      relativePath: string;
      operation: "create" | "update" | "delete" | "rollback";
      beforeContent: string | null;
      afterContent: string | null;
      beforeSha256: string | null;
      afterSha256: string | null;
    }): {
      id: string;
      threadId: string;
      turnId: string;
      toolName: string;
      workspace: string;
      filePath: string;
      relativePath: string;
      operation: "create" | "update" | "delete" | "rollback";
      beforeContent: string | null;
      afterContent: string | null;
      beforeSha256: string | null;
      afterSha256: string | null;
      createdAt: string;
    };
    latest(filePath: string): {
      id: string;
      threadId: string;
      turnId: string;
      toolName: string;
      workspace: string;
      filePath: string;
      relativePath: string;
      operation: "create" | "update" | "delete" | "rollback";
      beforeContent: string | null;
      afterContent: string | null;
      beforeSha256: string | null;
      afterSha256: string | null;
      createdAt: string;
    } | undefined;
  };
  checkpoint?: {
    recordFileSnapshot(entry: {
      threadId: string;
      turnId: string;
      workspace: string;
      toolName: string;
      relativePath: string;
      operation: "create" | "update" | "delete" | "rollback";
      beforeContent: string | null;
      afterContent: string | null;
      beforeSha256: string | null;
      afterSha256: string | null;
    }): Promise<void>;
  };
}

export type AgentUsage = TokenUsage;

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
  metadata?: {
    isReadOnly?: boolean;
    isDestructive?: boolean;
    category?: "workspace" | "plan" | "goal" | "command" | "skill";
  };
  preview?(input: Record<string, unknown>, context: AgentToolContext): Promise<unknown>;
  execute(input: Record<string, unknown>, context: AgentToolContext): Promise<string | AgentToolResult>;
}
