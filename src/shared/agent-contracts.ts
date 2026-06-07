export type LlmProtocol = "openai-compatible" | "anthropic-compatible";

export type AgentRunStatus = "completed" | "failed";

export interface AgentRunRequest {
  goal: string;
  protocol: LlmProtocol;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

export interface AgentStageEvent {
  stage: "observe" | "reason" | "act";
  title: string;
  detail: string;
  timestamp: string;
}

export interface AgentRunResponse {
  status: AgentRunStatus;
  output: string;
  reasoning?: string;
  trace: AgentStageEvent[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}
