import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MODEL_CONFIG,
  isAgentAutonomyLevel,
  isIsoTimestampString,
  isLlmProtocol,
  isModelReasoningEffort,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfileCreateRequest,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
  type RuntimePreferences,
} from "../../shared/agent-contracts.js";
import {
  cloneRuntimePreferences,
  normalizeRuntimePreferences,
} from "./runtime-preferences-schema.js";
import {
  MissingSecretCodec,
  type SecretStringCodec,
} from "./secret-codec.js";

const CONFIG_FILENAME = "config";
const LEGACY_RUNTIME_PREFERENCES_FILENAME = "runtime-preferences.json";
const TMP_SUFFIX = ".tmp";
const configQueues = new Map<string, Promise<unknown>>();
export const ENCRYPTED_SECRET_PREFIX = "encrypted:v1:";

export interface AppConfigState extends ModelConfigProfilesState {
  runtimePreferences: RuntimePreferences;
}

export interface AppConfigFileOptions {
  secretCodec?: SecretStringCodec;
}

type AppConfigMutation<T> = {
  state: AppConfigState;
  result: T;
};

const MODEL_CONFIG_UPDATE_FIELDS: readonly (keyof ModelConfigUpdate)[] = [
  "model_provide",
  "model",
  "protocol",
  "base_url",
  "OPENAI_API_KEY",
  "model_context_window",
  "model_auto_compact_token_limit",
  "max_tokens",
  "thinking",
  "model_reasoning_effort",
  "agent_autonomy",
];

export class AppConfigFile {
  private readonly configPath: string;
  private readonly legacyRuntimePreferencesPath: string;
  private readonly secretCodec: SecretStringCodec;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly userDataDir: string,
    options: AppConfigFileOptions = {},
  ) {
    this.configPath = path.join(userDataDir, CONFIG_FILENAME);
    this.legacyRuntimePreferencesPath = path.join(
      userDataDir,
      LEGACY_RUNTIME_PREFERENCES_FILENAME,
    );
    this.secretCodec = options.secretCodec ?? new MissingSecretCodec();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.serialized(async () => {
        await fs.mkdir(this.userDataDir, { recursive: true });
        const state = await this.readStateFromDisk();
        await this.atomicWriteJson(state);
        this.initialized = true;
      });
    }
    try {
      await this.initPromise;
    } finally {
      if (!this.initialized) {
        this.initPromise = null;
      }
    }
  }

  async read(): Promise<AppConfigState> {
    await this.init();
    return this.readStateFromDisk();
  }

  async update<T>(
    work: (state: AppConfigState) => Promise<AppConfigMutation<T>> | AppConfigMutation<T>,
  ): Promise<T> {
    await this.init();
    return this.serialized(async () => {
      const current = await this.readStateFromDisk();
      const mutation = await work(current);
      await this.atomicWriteJson(mutation.state);
      return mutation.result;
    });
  }

  private async readStateFromDisk(): Promise<AppConfigState> {
    const parsed = existsSync(this.configPath)
      ? deserializeAppConfigSecrets(
          JSON.parse(await fs.readFile(this.configPath, "utf8")) as unknown,
          this.secretCodec,
        )
      : undefined;
    const runtimePreferences = hasRuntimePreferencesSection(parsed)
      ? undefined
      : await this.readLegacyRuntimePreferences();
    return normalizeAppConfigState(parsed, runtimePreferences ?? undefined);
  }

  private async readLegacyRuntimePreferences(): Promise<RuntimePreferences | null> {
    if (!existsSync(this.legacyRuntimePreferencesPath)) {
      return null;
    }
    const raw = await fs.readFile(this.legacyRuntimePreferencesPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRuntimePreferences(parsed);
  }

  private async atomicWriteJson(value: AppConfigState): Promise<void> {
    const serialized = JSON.stringify(
      serializeAppConfigSecrets(value, this.secretCodec),
      null,
      2,
    );
    const tmp = this.configPath + TMP_SUFFIX;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.configPath);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const current = configQueues.get(this.configPath) ?? Promise.resolve();
    const next = current.then(work, work);
    configQueues.set(this.configPath, next.catch(() => undefined));
    return next;
  }
}

function deserializeAppConfigSecrets(
  value: unknown,
  secretCodec: SecretStringCodec,
): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.profiles)) {
    return {
      ...value,
      profiles: value.profiles.map((profile) =>
        deserializeStoredProfileSecrets(profile, secretCodec)
      ),
    };
  }
  return deserializeStoredConfigSecrets(value, secretCodec);
}

function deserializeStoredProfileSecrets(
  value: unknown,
  secretCodec: SecretStringCodec,
): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    config: deserializeStoredConfigSecrets(value.config, secretCodec),
  };
}

function deserializeStoredConfigSecrets(
  value: unknown,
  secretCodec: SecretStringCodec,
): unknown {
  if (!isRecord(value)) return value;
  const apiKey = value.OPENAI_API_KEY;
  if (typeof apiKey !== "string") return value;
  return {
    ...value,
    OPENAI_API_KEY: deserializeSecretString(apiKey, secretCodec),
  };
}

function deserializeSecretString(
  value: string,
  secretCodec: SecretStringCodec,
): string {
  if (!value.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    return value;
  }
  return secretCodec.decrypt(value.slice(ENCRYPTED_SECRET_PREFIX.length));
}

function serializeAppConfigSecrets(
  value: AppConfigState,
  secretCodec: SecretStringCodec,
): AppConfigState {
  return {
    ...value,
    profiles: value.profiles.map((profile) => ({
      ...profile,
      config: serializeModelConfigSecrets(profile.config, secretCodec),
    })),
  };
}

function serializeModelConfigSecrets(
  value: ModelConfig,
  secretCodec: SecretStringCodec,
): ModelConfig {
  return {
    ...value,
    // The renderer/runtime contract stays plain-text in memory. Only the
    // Electron userData/config representation is sealed, and legacy plain-text
    // values are migrated the next time the normalized config is written.
    OPENAI_API_KEY: value.OPENAI_API_KEY
      ? ENCRYPTED_SECRET_PREFIX + secretCodec.encrypt(value.OPENAI_API_KEY)
      : "",
  };
}

export function normalizeAppConfigState(
  value: unknown,
  runtimePreferencesOverride?: RuntimePreferences,
): AppConfigState {
  const modelState = normalizeModelProfilesState(value);
  const runtimePreferences = runtimePreferencesOverride
    ? cloneRuntimePreferences(runtimePreferencesOverride)
    : normalizeRuntimePreferences(
        isRecord(value) ? value.runtimePreferences : undefined,
      );
  return {
    ...modelState,
    runtimePreferences: normalizeRuntimeProfileReferences(runtimePreferences, modelState),
  };
}

export function toModelConfigProfilesState(
  state: AppConfigState,
): ModelConfigProfilesState {
  return {
    activeProfileId: state.activeProfileId,
    profiles: state.profiles,
  };
}

// Store methods can be called directly by runtime/tests, so they mirror the IPC
// no-op guard and require at least one recognized config/profile field before
// mutating `updatedAt`.
export function assertProfileCreateRequest(
  request: unknown,
): asserts request is ModelConfigProfileCreateRequest {
  if (!isRecord(request)) {
    throw new Error("Model config profile create request must be an object.");
  }
  if (typeof request.name !== "string" || !request.name.trim()) {
    throw new Error("Model config profile name is required.");
  }
  if (!isRecord(request.config)) {
    throw new Error("Model config profile config must be an object.");
  }
  if (request.activate !== undefined) {
    normalizeProfileActivate(request.activate);
  }
}

export function assertProfileUpdateHasFields(
  request: { id?: unknown; name?: unknown; config?: ModelConfigUpdate },
): void {
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

export function assertModelConfigUpdateHasFields(
  update: ModelConfigUpdate,
  message: string,
): void {
  parseModelConfigUpdateFields(update, { emptyMessage: message });
}

export function parseModelConfigUpdateFields(
  update: unknown,
  options: { allowEmpty?: boolean; emptyMessage?: string } = {},
): ModelConfigUpdate {
  const emptyMessage = options.emptyMessage ?? "Model config update must include at least one field.";
  if (!isRecord(update)) {
    throw new Error(emptyMessage);
  }
  const parsed: ModelConfigUpdate = {};
  if (update.model_provide !== undefined) {
    parsed.model_provide = assertNonEmptyString(update.model_provide, "model_provide");
  }
  if (update.model !== undefined) {
    parsed.model = assertNonEmptyString(update.model, "model");
  }
  if (update.protocol !== undefined) {
    if (!isLlmProtocol(update.protocol)) {
      throw new Error("protocol must be one of openai-compatible, anthropic-compatible.");
    }
    parsed.protocol = update.protocol;
  }
  if (update.base_url !== undefined) {
    parsed.base_url = assertNonEmptyString(update.base_url, "base_url");
  }
  if (update.OPENAI_API_KEY !== undefined) {
    if (typeof update.OPENAI_API_KEY !== "string") {
      throw new Error("OPENAI_API_KEY must be a string.");
    }
    parsed.OPENAI_API_KEY = update.OPENAI_API_KEY;
  }
  if (update.model_context_window !== undefined) {
    parsed.model_context_window = assertPositiveInteger(
      update.model_context_window,
      "model_context_window",
    );
  }
  if (update.model_auto_compact_token_limit !== undefined) {
    parsed.model_auto_compact_token_limit = assertPositiveInteger(
      update.model_auto_compact_token_limit,
      "model_auto_compact_token_limit",
    );
  }
  if (update.max_tokens !== undefined) {
    parsed.max_tokens = assertPositiveInteger(update.max_tokens, "max_tokens");
  }
  if (update.thinking !== undefined) {
    if (typeof update.thinking !== "boolean") {
      throw new Error("thinking must be a boolean.");
    }
    parsed.thinking = update.thinking;
  }
  if (update.model_reasoning_effort !== undefined) {
    if (!isModelReasoningEffort(update.model_reasoning_effort)) {
      throw new Error("model_reasoning_effort must be one of low, medium, high, xhigh.");
    }
    parsed.model_reasoning_effort = update.model_reasoning_effort;
  }
  if (update.agent_autonomy !== undefined) {
    if (!isAgentAutonomyLevel(update.agent_autonomy)) {
      throw new Error("agent_autonomy must be one of conservative, balanced, deep.");
    }
    parsed.agent_autonomy = update.agent_autonomy;
  }
  if (!options.allowEmpty && Object.keys(parsed).length === 0) {
    throw new Error(emptyMessage);
  }
  return parsed;
}

export function normalizeModelConfig(value: Partial<ModelConfig>): ModelConfig {
  const modelProvide = assertNonEmptyString(value.model_provide, "model_provide");
  const model = assertNonEmptyString(value.model, "model");
  if (!isLlmProtocol(value.protocol)) {
    throw new Error("protocol must be one of openai-compatible, anthropic-compatible.");
  }
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
    protocol: value.protocol,
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

export function getActiveProfile(state: ModelConfigProfilesState): ModelConfigProfile {
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  if (!active) {
    throw new Error(`Active model config profile ${state.activeProfileId} not found.`);
  }
  return active;
}

export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

export function normalizeProfileActivate(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new Error("activate must be a boolean.");
}

function normalizeModelProfilesState(value: unknown): ModelConfigProfilesState {
  if (!value || typeof value !== "object") {
    return createDefaultProfilesState();
  }
  const raw = value as Partial<ModelConfigProfilesState> & Partial<ModelConfig>;
  if (Array.isArray(raw.profiles)) {
    const profiles = normalizeStoredProfiles(raw.profiles);
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

function normalizeRuntimeProfileReferences(
  runtimePreferences: RuntimePreferences,
  modelState: ModelConfigProfilesState,
): RuntimePreferences {
  const profileIds = new Set(modelState.profiles.map((profile) => profile.id));
  return {
    ...runtimePreferences,
    codeDefaultModelProfileId:
      runtimePreferences.codeDefaultModelProfileId !== null &&
      !profileIds.has(runtimePreferences.codeDefaultModelProfileId)
        ? null
        : runtimePreferences.codeDefaultModelProfileId,
    writeDefaultModelProfileId:
      runtimePreferences.writeDefaultModelProfileId !== null &&
      !profileIds.has(runtimePreferences.writeDefaultModelProfileId)
        ? null
        : runtimePreferences.writeDefaultModelProfileId,
  };
}

function normalizeStoredProfiles(values: unknown[]): ModelConfigProfile[] {
  const seenIds = new Set<string>();
  const profiles: ModelConfigProfile[] = [];
  for (const value of values) {
    const profile = normalizeStoredProfile(value);
    // Profile id is the mutation key for update/delete/activate; damaged
    // config files with duplicates are collapsed at the read boundary so store
    // operations stay unambiguous.
    if (!profile || seenIds.has(profile.id)) continue;
    seenIds.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
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
    createdAt: normalizeStoredTimestamp(raw.createdAt, now),
    updatedAt: normalizeStoredTimestamp(raw.updatedAt, now),
  };
}

function normalizeStoredTimestamp(value: unknown, fallback: string): string {
  return isIsoTimestampString(value) ? value : fallback;
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

function assertPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Number(value);
}

function hasRuntimePreferencesSection(value: unknown): boolean {
  return isRecord(value) && value.runtimePreferences !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
