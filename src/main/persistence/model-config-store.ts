import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MODEL_CONFIG,
  isModelReasoningEffort,
  type ModelConfig,
  type ModelConfigUpdate,
} from "../../shared/agent-contracts.js";

const CONFIG_FILENAME = "config";
const TMP_SUFFIX = ".tmp";

export class ModelConfigStore {
  private readonly configPath: string;
  private initialized = false;

  constructor(private readonly userDataDir: string) {
    this.configPath = path.join(userDataDir, CONFIG_FILENAME);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.userDataDir, { recursive: true });
    if (!existsSync(this.configPath)) {
      await this.atomicWriteJson(DEFAULT_MODEL_CONFIG);
    }
    this.initialized = true;
  }

  async get(): Promise<ModelConfig> {
    await this.init();
    const raw = await fs.readFile(this.configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStoredConfig(parsed);
  }

  async update(update: ModelConfigUpdate): Promise<ModelConfig> {
    await this.init();
    const current = await this.get();
    const contextWindow =
      update.model_context_window ?? DEFAULT_MODEL_CONFIG.model_context_window;
    const next = normalizeModelConfig({
      ...current,
      ...update,
      model_context_window: contextWindow,
      model_auto_compact_token_limit:
        update.model_auto_compact_token_limit ?? Math.floor(contextWindow * 0.9),
      max_tokens: update.max_tokens ?? DEFAULT_MODEL_CONFIG.max_tokens,
      thinking: update.thinking ?? DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort:
        update.model_reasoning_effort ?? DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });
    await this.atomicWriteJson(next);
    return next;
  }

  private async atomicWriteJson(value: ModelConfig): Promise<void> {
    const tmp = this.configPath + TMP_SUFFIX;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.configPath);
  }
}

function normalizeStoredConfig(value: unknown): ModelConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_MODEL_CONFIG;
  }
  const raw = value as Partial<ModelConfig>;
  const contextWindow =
    raw.model_context_window ?? DEFAULT_MODEL_CONFIG.model_context_window;
  return normalizeModelConfig({
    ...DEFAULT_MODEL_CONFIG,
    ...raw,
    model_context_window: contextWindow,
    model_auto_compact_token_limit:
      raw.model_auto_compact_token_limit ?? Math.floor(contextWindow * 0.9),
  });
}

function normalizeModelConfig(value: Partial<ModelConfig>): ModelConfig {
  const modelProvide = assertNonEmptyString(value.model_provide, "model_provide");
  const model = assertNonEmptyString(value.model, "model");
  const baseUrl = assertNonEmptyString(value.base_url, "base_url");
  const apiKey = typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY : "";
  const contextWindow = assertPositiveInteger(
    value.model_context_window,
    "model_context_window",
  );
  const compactLimit =
    value.model_auto_compact_token_limit === undefined
      ? Math.floor(contextWindow * 0.9)
      : assertPositiveInteger(
          value.model_auto_compact_token_limit,
          "model_auto_compact_token_limit",
        );
  const maxTokens = assertPositiveInteger(value.max_tokens, "max_tokens");
  if (compactLimit > contextWindow) {
    throw new Error("model_auto_compact_token_limit must be <= model_context_window.");
  }
  if (!isModelReasoningEffort(value.model_reasoning_effort)) {
    throw new Error("model_reasoning_effort must be one of low, medium, high, xhigh.");
  }

  return {
    model_provide: modelProvide,
    model,
    base_url: baseUrl,
    OPENAI_API_KEY: apiKey,
    model_context_window: contextWindow,
    model_auto_compact_token_limit: compactLimit,
    max_tokens: maxTokens,
    thinking:
      typeof value.thinking === "boolean"
        ? value.thinking
        : DEFAULT_MODEL_CONFIG.thinking,
    model_reasoning_effort: value.model_reasoning_effort,
  };
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Number(value);
}
