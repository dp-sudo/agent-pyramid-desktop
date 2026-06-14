export const LLM_PROTOCOLS = ["openai-compatible", "anthropic-compatible"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];
export const DEFAULT_LLM_PROTOCOL: LlmProtocol = "openai-compatible";

export const MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export const AGENT_AUTONOMY_LEVELS = ["conservative", "balanced", "deep"] as const;
export type AgentAutonomyLevel = (typeof AGENT_AUTONOMY_LEVELS)[number];

export interface ModelConfig {
  model_provide: string;
  model: string;
  protocol: LlmProtocol;
  base_url: string;
  OPENAI_API_KEY: string;
  model_context_window: number;
  model_auto_compact_token_limit: number;
  max_tokens: number;
  thinking: boolean;
  model_reasoning_effort: ModelReasoningEffort;
  agent_autonomy: AgentAutonomyLevel;
}

export interface ModelConfigUpdate {
  model_provide?: string;
  model?: string;
  protocol?: LlmProtocol;
  base_url?: string;
  OPENAI_API_KEY?: string;
  model_context_window?: number;
  model_auto_compact_token_limit?: number;
  max_tokens?: number;
  thinking?: boolean;
  model_reasoning_effort?: ModelReasoningEffort;
  agent_autonomy?: AgentAutonomyLevel;
}

export interface ModelConfigProfile {
  id: string;
  name: string;
  config: ModelConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigProfilesState {
  activeProfileId: string;
  profiles: ModelConfigProfile[];
}

export interface ModelConfigProfileCreateRequest {
  name: string;
  config: ModelConfigUpdate;
  activate?: boolean;
}

export interface ModelConfigProfileUpdateRequest {
  id: string;
  name?: string;
  config?: ModelConfigUpdate;
}

export interface ModelConfigProfileDeleteRequest {
  id: string;
}

export interface ModelConfigProfileActivateRequest {
  id: string;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model_provide: "MiniMax",
  model: "MiniMax-M3",
  protocol: DEFAULT_LLM_PROTOCOL,
  base_url: "https://api.minimaxi.com/v1",
  OPENAI_API_KEY: "",
  model_context_window: 256000,
  model_auto_compact_token_limit: 230400,
  max_tokens: 65536,
  thinking: true,
  model_reasoning_effort: "medium",
  agent_autonomy: "balanced",
};

export const DEFAULT_DEEPSEEK_MODEL_CONFIG: ModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  model_provide: "DeepSeek",
  model: "deepseek-v4-flash",
  base_url: "https://api.deepseek.com",
};

export function isLlmProtocol(value: unknown): value is LlmProtocol {
  return typeof value === "string" && LLM_PROTOCOLS.includes(value as LlmProtocol);
}

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    typeof value === "string" &&
    MODEL_REASONING_EFFORTS.includes(value as ModelReasoningEffort)
  );
}

export function isAgentAutonomyLevel(value: unknown): value is AgentAutonomyLevel {
  return (
    typeof value === "string" &&
    AGENT_AUTONOMY_LEVELS.includes(value as AgentAutonomyLevel)
  );
}
