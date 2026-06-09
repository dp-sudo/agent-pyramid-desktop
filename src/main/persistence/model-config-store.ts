import { randomUUID } from "node:crypto";
import {
  DEFAULT_MODEL_CONFIG,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfileCreateRequest,
  type ModelConfigProfileUpdateRequest,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
} from "../../shared/agent-contracts.js";
import {
  AppConfigFile,
  assertModelConfigUpdateHasFields,
  assertNonEmptyString,
  assertProfileUpdateHasFields,
  getActiveProfile,
  normalizeModelConfig,
  normalizeProfileActivate,
  toModelConfigProfilesState,
  type AppConfigState,
} from "./config-file.js";

export class ModelConfigStore {
  private readonly configFile: AppConfigFile;

  constructor(userDataDir: string) {
    this.configFile = new AppConfigFile(userDataDir);
  }

  async init(): Promise<void> {
    await this.configFile.init();
  }

  async get(): Promise<ModelConfig> {
    const state = await this.configFile.read();
    return getActiveProfile(state).config;
  }

  async update(update: ModelConfigUpdate): Promise<ModelConfig> {
    assertModelConfigUpdateHasFields(
      update,
      "Model config update must include at least one field.",
    );
    return this.configFile.update((state) => {
      const active = getActiveProfile(state);
      const contextWindow =
        update.model_context_window ?? active.config.model_context_window;
      const next = normalizeModelConfig({
        ...active.config,
        ...update,
        protocol: update.protocol ?? active.config.protocol,
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
      const nextState: AppConfigState = {
        ...state,
        profiles: state.profiles.map((profile) =>
          profile.id === active.id ? { ...profile, config: next, updatedAt } : profile,
        ),
      };
      return { state: nextState, result: next };
    });
  }

  async listProfiles(): Promise<ModelConfigProfilesState> {
    return toModelConfigProfilesState(await this.configFile.read());
  }

  async createProfile(
    request: ModelConfigProfileCreateRequest,
  ): Promise<ModelConfigProfilesState> {
    return this.configFile.update((state) => {
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
      const next: AppConfigState = {
        ...state,
        activeProfileId: activate ? profile.id : state.activeProfileId,
        profiles: [...state.profiles, profile],
      };
      return { state: next, result: toModelConfigProfilesState(next) };
    });
  }

  async updateProfile(
    request: ModelConfigProfileUpdateRequest,
  ): Promise<ModelConfigProfile> {
    assertProfileUpdateHasFields(request);
    return this.configFile.update((state) => {
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
      const nextState: AppConfigState = {
        ...state,
        profiles: state.profiles.map((profile) =>
          profile.id === request.id ? nextProfile : profile,
        ),
      };
      return { state: nextState, result: nextProfile };
    });
  }

  async deleteProfile(id: string): Promise<ModelConfigProfilesState> {
    return this.configFile.update((state) => {
      const existing = state.profiles.find((profile) => profile.id === id);
      if (!existing) {
        throw new Error(`Model config profile ${id} not found.`);
      }
      if (state.profiles.length <= 1) {
        throw new Error("At least one model config profile is required.");
      }

      const profiles = state.profiles.filter((profile) => profile.id !== id);
      const nextActive = state.activeProfileId === id ? profiles[0] : getActiveProfile(state);
      const nextState: AppConfigState = {
        ...state,
        activeProfileId: nextActive.id,
        profiles,
      };
      return { state: nextState, result: toModelConfigProfilesState(nextState) };
    });
  }

  async setActiveProfile(id: string): Promise<ModelConfigProfilesState> {
    return this.configFile.update((state) => {
      if (!state.profiles.some((profile) => profile.id === id)) {
        throw new Error(`Model config profile ${id} not found.`);
      }
      const nextState: AppConfigState = { ...state, activeProfileId: id };
      return { state: nextState, result: toModelConfigProfilesState(nextState) };
    });
  }
}
