import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MODEL_CONFIG,
  isAgentAutonomyLevel,
  isModelReasoningEffort,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfileCreateRequest,
  type ModelConfigProfileUpdateRequest,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
} from "../../shared/agent-contracts.js";

const CONFIG_FILENAME = "config";
const TMP_SUFFIX = ".tmp";
const MODEL_CONFIG_UPDATE_FIELDS: readonly (keyof ModelConfigUpdate)[] = [
  "model_provide",
  "model",
  "base_url",
  "OPENAI_API_KEY",
  "model_context_window",
  "model_auto_compact_token_limit",
  "max_tokens",
  "thinking",
  "model_reasoning_effort",
  "agent_autonomy",
];

export class ModelConfigStore {
  private readonly configPath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly userDataDir: string) {
    this.configPath = path.join(userDataDir, CONFIG_FILENAME);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.userDataDir, { recursive: true });
        if (!existsSync(this.configPath)) {
          await this.atomicWriteJson(createDefaultProfilesState());
        } else {
          const state = await this.readState();
          await this.atomicWriteJson(state);
        }
        this.initialized = true;
      })();
    }
    try {
      await this.initPromise;
    } finally {
      if (!this.initialized) {
        this.initPromise = null;
      }
    }
  }

  async get(): Promise<ModelConfig> {
    await this.init();
    const state = await this.readState();
    return getActiveProfile(state).config;
  }

  async update(update: ModelConfigUpdate): Promise<ModelConfig> {
    assertModelConfigUpdateHasFields(
      update,
      "Model config update must include at least one field.",
    );
    await this.init();
    return this.serialized(async () => {
      const state = await this.readState();
      const active = getActiveProfile(state);
      const contextWindow =
        update.model_context_window ?? active.config.model_context_window;
      const next = normalizeModelConfig({
        ...active.config,
        ...update,
        model_context_window: contextWindow,
        model_auto_compact_token_limit:
          update.model_auto_compact_token_limit ??
          active.config.model_auto_compact_token_limit,
        max_tokens: update.max_tokens ?? active.config.max_tokens,
        thinking: update.thinking ?? active.config.thinking,
        model_reasoning_effort:
          update.model_reasoning_effort ?? active.config.model_reasoning_effort,
        agent_autonomy: update.agent_autonomy ?? active.config.agent_autonomy,
      });
      const updatedAt = new Date().toISOString();
      const nextState: ModelConfigProfilesState = {
        ...state,
        profiles: state.profiles.map((profile) =>
          profile.id === active.id ? { ...profile, config: next, updatedAt } : profile,
        ),
      };
      await this.atomicWriteJson(nextState);
      return next;
    });
  }

  async listProfiles(): Promise<ModelConfigProfilesState> {
    await this.init();
    return this.readState();
  }

  async createProfile(
    request: ModelConfigProfileCreateRequest,
  ): Promise<ModelConfigProfilesState> {
    await this.init();
    return this.serialized(async () => {
      const state = await this.readState();
      const name = assertNonEmptyString(request.name, "name");
      const activate = normalizeProfileActivate(request.activate);
      const now = new Date().toISOString();
      const profile: ModelConfigProfile = {
        id: randomUUID(),
        name,
        config: normalizeModelConfig({
          ...DEFAULT_MODEL_CONFIG,
          ...request.config,
        }),
        createdAt: now,
        updatedAt: now,
      };
      const next: ModelConfigProfilesState = {
        activeProfileId: activate ? profile.id : state.activeProfileId,
        profiles: [...state.profiles, profile],
      };
      await this.atomicWriteJson(next);
      return next;
    });
  }

  async updateProfile(
    request: ModelConfigProfileUpdateRequest,
  ): Promise<ModelConfigProfile> {
    assertProfileUpdateHasFields(request);
    await this.init();
    return this.serialized(async () => {
      const state = await this.readState();
      const existing = state.profiles.find((profile) => profile.id === request.id);
      if (!existing) {
        throw new Error(`Model config profile ${request.id} not found.`);
      }

      const updatedAt = new Date().toISOString();
      const nextProfile: ModelConfigProfile = {
        ...existing,
        ...(request.name !== undefined
          ? { name: assertNonEmptyString(request.name, "name") }
          : {}),
        ...(request.config
          ? {
              config: normalizeModelConfig({
                ...existing.config,
                ...request.config,
              }),
            }
          : {}),
        updatedAt,
      };
      const nextState: ModelConfigProfilesState = {
        ...state,
        profiles: state.profiles.map((profile) =>
          profile.id === request.id ? nextProfile : profile,
        ),
      };
      await this.atomicWriteJson(nextState);
      return nextProfile;
    });
  }

  async deleteProfile(id: string): Promise<ModelConfigProfilesState> {
    await this.init();
    return this.serialized(async () => {
      const state = await this.readState();
      const existing = state.profiles.find((profile) => profile.id === id);
      if (!existing) {
        throw new Error(`Model config profile ${id} not found.`);
      }
      if (state.profiles.length <= 1) {
        throw new Error("At least one model config profile is required.");
      }

      const profiles = state.profiles.filter((profile) => profile.id !== id);
      const nextActive = state.activeProfileId === id ? profiles[0] : getActiveProfile(state);
      const nextState: ModelConfigProfilesState = {
        activeProfileId: nextActive.id,
        profiles,
      };
      await this.atomicWriteJson(nextState);
      return nextState;
    });
  }

  async setActiveProfile(id: string): Promise<ModelConfigProfilesState> {
    await this.init();
    return this.serialized(async () => {
      const state = await this.readState();
      if (!state.profiles.some((profile) => profile.id === id)) {
        throw new Error(`Model config profile ${id} not found.`);
      }
      const nextState: ModelConfigProfilesState = { ...state, activeProfileId: id };
      await this.atomicWriteJson(nextState);
      return nextState;
    });
  }

  private async readState(): Promise<ModelConfigProfilesState> {
    const raw = await fs.readFile(this.configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStoredState(parsed);
  }

  private async atomicWriteJson(value: ModelConfigProfilesState): Promise<void> {
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

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// Store methods can be called directly by runtime/tests, so they mirror the IPC
// no-op guard and require at least one recognized config/profile field before
// mutating `updatedAt`.
function assertProfileUpdateHasFields(request: ModelConfigProfileUpdateRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Model config profile update request must be an object.");
  }
  if (typeof request.id !== "string" || !request.id.trim()) {
    throw new Error("Model config profile id is required.");
  }
  if (request.config !== undefined) {
    assertModelConfigUpdateHasFields(
      request.config,
      "Model config update must include at least one field.",
    );
  }
  if (request.name === undefined && request.config === undefined) {
    throw new Error("Model config profile update must include name or config.");
  }
}

function assertModelConfigUpdateHasFields(
  update: ModelConfigUpdate,
  message: string,
): void {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error(message);
  }
  const candidate = update as Record<keyof ModelConfigUpdate, unknown>;
  if (!MODEL_CONFIG_UPDATE_FIELDS.some((field) => candidate[field] !== undefined)) {
    throw new Error(message);
  }
}

function createDefaultProfilesState(): ModelConfigProfilesState {
  const now = new Date().toISOString();
  return {
    activeProfileId: "default",
    profiles: [
      {
        id: "default",
        name: DEFAULT_MODEL_CONFIG.model_provide,
        config: DEFAULT_MODEL_CONFIG,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function normalizeStoredState(value: unknown): ModelConfigProfilesState {
  if (!value || typeof value !== "object") {
    return createDefaultProfilesState();
  }
  const raw = value as Partial<ModelConfigProfilesState> & Partial<ModelConfig>;
  if (Array.isArray(raw.profiles)) {
    const profiles = raw.profiles
      .map((profile) => normalizeStoredProfile(profile))
      .filter((profile): profile is ModelConfigProfile => profile !== null);
    if (profiles.length === 0) {
      return createDefaultProfilesState();
    }
    const activeProfileId =
      typeof raw.activeProfileId === "string" &&
      profiles.some((profile) => profile.id === raw.activeProfileId)
        ? raw.activeProfileId
        : profiles[0].id;
    return {
      activeProfileId,
      profiles,
    };
  }

  const config = normalizeStoredConfig(raw);
  const now = new Date().toISOString();
  return {
    activeProfileId: "default",
    profiles: [
      {
        id: "default",
        name: config.model_provide,
        config,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function normalizeStoredProfile(value: unknown): ModelConfigProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<ModelConfigProfile>;
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    return null;
  }
  const config = normalizeStoredConfig(raw.config);
  const now = new Date().toISOString();
  return {
    id: raw.id.trim(),
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : config.model_provide,
    config,
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt.trim()
        ? raw.createdAt
        : now,
    updatedAt:
      typeof raw.updatedAt === "string" && raw.updatedAt.trim()
        ? raw.updatedAt
        : now,
  };
}

function normalizeStoredConfig(value: unknown): ModelConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_MODEL_CONFIG;
  }
  const raw = value as Partial<ModelConfig>;
  const contextWindow = normalizeStoredContextWindow(raw.model_context_window);
  const compactLimit = normalizeStoredCompactLimit(
    raw.model_auto_compact_token_limit,
    contextWindow,
  );
  const maxTokens = normalizeStoredMaxTokens(raw.max_tokens, contextWindow);
  return normalizeModelConfig({
    ...DEFAULT_MODEL_CONFIG,
    ...raw,
    model_context_window: contextWindow,
    model_auto_compact_token_limit: compactLimit,
    max_tokens: maxTokens,
  });
}

function normalizeStoredContextWindow(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 2) {
    return DEFAULT_MODEL_CONFIG.model_context_window;
  }
  return Number(value);
}

function normalizeStoredMaxTokens(value: unknown, contextWindow: number): number {
  const maxAllowed = contextWindow - 1;
  const fallback = Math.min(DEFAULT_MODEL_CONFIG.max_tokens, maxAllowed);
  if (!Number.isInteger(value) || Number(value) < 1) {
    return fallback;
  }
  return Math.min(Number(value), maxAllowed);
}

function normalizeStoredCompactLimit(value: unknown, contextWindow: number): number {
  const fallback = Math.min(Math.floor(contextWindow * 0.9), contextWindow);
  if (!Number.isInteger(value) || Number(value) < 1) {
    return fallback;
  }
  return Math.min(Number(value), contextWindow);
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
  if (maxTokens >= contextWindow) {
    throw new Error("max_tokens must be < model_context_window.");
  }
  if (!isModelReasoningEffort(value.model_reasoning_effort)) {
    throw new Error("model_reasoning_effort must be one of low, medium, high, xhigh.");
  }
  if (!isAgentAutonomyLevel(value.agent_autonomy)) {
    throw new Error("agent_autonomy must be one of conservative, balanced, deep.");
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
    agent_autonomy: value.agent_autonomy,
  };
}

function getActiveProfile(state: ModelConfigProfilesState): ModelConfigProfile {
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  if (!active) {
    throw new Error(`Active model config profile ${state.activeProfileId} not found.`);
  }
  return active;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function normalizeProfileActivate(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new Error("activate must be a boolean.");
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Number(value);
}
