import {
  DEFAULT_MODEL_CONFIG,
  LLM_PROTOCOLS,
  type AgentAutonomyLevel,
  type LlmProtocol,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
  type ModelReasoningEffort,
} from "../../../shared/agent-contracts";
import type { SettingsTranslator } from "./settings-runtime-model";

export interface SettingsFormState {
  model_provide: string;
  model: string;
  protocol: LlmProtocol;
  base_url: string;
  OPENAI_API_KEY: string;
  model_context_window: string;
  model_auto_compact_token_limit: string;
  max_tokens: string;
  thinking: boolean;
  model_reasoning_effort: ModelReasoningEffort;
  agent_autonomy: AgentAutonomyLevel;
}

type IntegerValidationResult =
  | { ok: true; value: number | undefined }
  | { ok: false; message: string };

export function toFormState(config: ModelConfig): SettingsFormState {
  return {
    model_provide: config.model_provide,
    model: config.model,
    protocol: config.protocol,
    base_url: config.base_url,
    OPENAI_API_KEY: config.OPENAI_API_KEY,
    model_context_window: String(config.model_context_window),
    model_auto_compact_token_limit: String(config.model_auto_compact_token_limit),
    max_tokens: String(config.max_tokens),
    thinking: config.thinking,
    model_reasoning_effort: config.model_reasoning_effort,
    agent_autonomy: config.agent_autonomy,
  };
}

export function toUpdatePayload(form: SettingsFormState): ModelConfigUpdate {
  const contextWindow = parseOptionalInteger(
    form.model_context_window,
    "model_context_window",
  );
  const compactLimit = parseOptionalInteger(
    form.model_auto_compact_token_limit,
    "model_auto_compact_token_limit",
  );
  const maxTokens = parseOptionalInteger(form.max_tokens, "max_tokens");
  return {
    model_provide: form.model_provide,
    model: form.model,
    protocol: form.protocol,
    base_url: form.base_url,
    OPENAI_API_KEY: form.OPENAI_API_KEY,
    ...(contextWindow !== undefined ? { model_context_window: contextWindow } : {}),
    ...(compactLimit !== undefined
      ? { model_auto_compact_token_limit: compactLimit }
      : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    thinking: form.thinking,
    model_reasoning_effort: form.model_reasoning_effort,
    agent_autonomy: form.agent_autonomy,
  };
}

export function validateModelSettingsForm(
  form: SettingsFormState,
  currentConfig: ModelConfig,
  t: SettingsTranslator,
): string | null {
  const contextWindow = parseOptionalPositiveIntegerForValidation(
    form.model_context_window,
    t("settings.fields.contextWindow"),
    t,
  );
  if (!contextWindow.ok) return contextWindow.message;

  const compactLimit = parseOptionalPositiveIntegerForValidation(
    form.model_auto_compact_token_limit,
    t("settings.fields.compactLimit"),
    t,
  );
  if (!compactLimit.ok) return compactLimit.message;

  const maxTokens = parseOptionalPositiveIntegerForValidation(
    form.max_tokens,
    t("settings.fields.maxTokens"),
    t,
  );
  if (!maxTokens.ok) return maxTokens.message;

  const effectiveContextWindow =
    contextWindow.value ?? currentConfig.model_context_window;
  const effectiveCompactLimit =
    compactLimit.value ?? currentConfig.model_auto_compact_token_limit;
  const effectiveMaxTokens = maxTokens.value ?? currentConfig.max_tokens;

  if (effectiveCompactLimit > effectiveContextWindow) {
    return t("settings.errors.compactLimitTooLarge");
  }
  if (effectiveMaxTokens >= effectiveContextWindow) {
    return t("settings.errors.maxTokensTooLarge");
  }
  return null;
}

export function findActiveProfile(
  state: ModelConfigProfilesState,
): ModelConfigProfile | null {
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    state.profiles[0] ??
    null
  );
}

export function createCustomModelConfig(): ModelConfig {
  return {
    ...DEFAULT_MODEL_CONFIG,
    model_provide: "Custom",
    model: "gpt-4.1",
    base_url: "https://api.openai.com/v1",
    thinking: false,
  };
}

export function isLlmProtocolSetting(value: string): value is LlmProtocol {
  return LLM_PROTOCOLS.includes(value as LlmProtocol);
}

function parseOptionalInteger(raw: string, field: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalPositiveIntegerForValidation(
  raw: string,
  fieldLabel: string,
  t: SettingsTranslator,
): IntegerValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: t("settings.errors.positiveInteger", { field: fieldLabel }),
    };
  }
  return { ok: true, value: parsed };
}
