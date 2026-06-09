import { ipcMain } from "electron";
import {
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  MODEL_CONFIG_PROFILES_CREATE_CHANNEL,
  MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_LIST_CHANNEL,
  MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
  MODEL_CONFIG_UPDATE_CHANNEL,
} from "../../shared/ipc.js";
import type {
  ModelConfigProfileActivateRequest,
  ModelConfigProfileCreateRequest,
  ModelConfigProfileDeleteRequest,
  ModelConfigProfileUpdateRequest,
  ModelConfigUpdate,
} from "../../shared/agent-contracts.js";
import {
  err,
  isAgentAutonomyLevel,
  isModelReasoningEffort,
  ok,
} from "../../shared/agent-contracts.js";
import type { ModelConfigStore } from "../persistence/model-config-store.js";

export function registerModelConfigHandlers(store: ModelConfigStore): void {
  ipcMain.handle(MODEL_CONFIG_GET_CHANNEL, async () => {
    try {
      return ok(await store.get());
    } catch (error) {
      return err("MODEL_CONFIG_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(MODEL_CONFIG_UPDATE_CHANNEL, async (_event, update: unknown) => {
    try {
      return ok(await store.update(parseModelConfigUpdateRequest(update)));
    } catch (error) {
      return err("MODEL_CONFIG_UPDATE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(MODEL_CONFIG_PROFILES_LIST_CHANNEL, async () => {
    try {
      return ok(await store.listProfiles());
    } catch (error) {
      return err("MODEL_CONFIG_PROFILES_LIST_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_CREATE_CHANNEL,
    async (_event, request: ModelConfigProfileCreateRequest) => {
      try {
        return ok(await store.createProfile(parseModelConfigProfileCreateRequest(request)));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_CREATE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
    async (_event, request: unknown) => {
      try {
        return ok(await store.updateProfile(parseModelConfigProfileUpdateRequest(request)));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_UPDATE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
    async (_event, request: unknown) => {
      try {
        return ok(await store.deleteProfile(parseModelConfigProfileIdRequest(request).id));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_DELETE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
    async (_event, request: unknown) => {
      try {
        return ok(await store.setActiveProfile(parseModelConfigProfileIdRequest(request).id));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_ACTIVATE_FAILED", messageOf(error));
      }
    },
  );
}

// IPC profile creation crosses from renderer to main; reject truthy non-booleans
// before they can change the active profile selection.
export function parseModelConfigProfileCreateRequest(
  request: unknown,
): ModelConfigProfileCreateRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Model config profile create request must be an object.");
  }
  const value = request as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Model config profile name is required.");
  }
  if (!value.config || typeof value.config !== "object" || Array.isArray(value.config)) {
    throw new Error("Model config profile config must be an object.");
  }
  if (value.activate !== undefined && typeof value.activate !== "boolean") {
    throw new Error("Model config profile activate must be a boolean.");
  }
  return {
    name: value.name,
    config: parseModelConfigUpdateRequest(value.config),
    ...(value.activate !== undefined ? { activate: value.activate } : {}),
  };
}

export function parseModelConfigProfileUpdateRequest(
  request: unknown,
): ModelConfigProfileUpdateRequest {
  const value = parseModelConfigProfileIdRequest(request);
  const source = request as Record<string, unknown>;
  if (source.name !== undefined && (typeof source.name !== "string" || !source.name.trim())) {
    throw new Error("Model config profile name is required.");
  }
  if (
    source.config !== undefined &&
    (!source.config || typeof source.config !== "object" || Array.isArray(source.config))
  ) {
    throw new Error("Model config profile config must be an object.");
  }
  return {
    id: value.id,
    ...(source.name !== undefined ? { name: source.name } : {}),
    ...(source.config !== undefined ? { config: parseModelConfigUpdateRequest(source.config) } : {}),
  };
}

export function parseModelConfigProfileIdRequest(
  request: unknown,
): ModelConfigProfileDeleteRequest & ModelConfigProfileActivateRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Model config profile request must be an object.");
  }
  const id = (request as Record<string, unknown>).id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Model config profile id is required.");
  }
  return { id: id.trim() };
}

// Model config normalization is allowed to fill omitted fields from the active
// profile, but malformed provided fields must fail here so bad IPC payloads do
// not silently reset booleans or API keys through store defaults.
export function parseModelConfigUpdateRequest(request: unknown): ModelConfigUpdate {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Model config update request must be an object.");
  }
  const value = request as Record<string, unknown>;
  const parsed: Partial<ModelConfigUpdate> = {};
  if (value.model_provide !== undefined) {
    parsed.model_provide = requiredTrimmedString(value.model_provide, "model_provide");
  }
  if (value.model !== undefined) {
    parsed.model = requiredTrimmedString(value.model, "model");
  }
  if (value.base_url !== undefined) {
    parsed.base_url = requiredTrimmedString(value.base_url, "base_url");
  }
  if (value.OPENAI_API_KEY !== undefined) {
    if (typeof value.OPENAI_API_KEY !== "string") {
      throw new Error("OPENAI_API_KEY must be a string.");
    }
    parsed.OPENAI_API_KEY = value.OPENAI_API_KEY;
  }
  if (value.model_context_window !== undefined) {
    parsed.model_context_window = requiredPositiveInteger(
      value.model_context_window,
      "model_context_window",
    );
  }
  if (value.model_auto_compact_token_limit !== undefined) {
    parsed.model_auto_compact_token_limit = requiredPositiveInteger(
      value.model_auto_compact_token_limit,
      "model_auto_compact_token_limit",
    );
  }
  if (value.max_tokens !== undefined) {
    parsed.max_tokens = requiredPositiveInteger(value.max_tokens, "max_tokens");
  }
  if (value.thinking !== undefined) {
    if (typeof value.thinking !== "boolean") {
      throw new Error("thinking must be a boolean.");
    }
    parsed.thinking = value.thinking;
  }
  if (value.model_reasoning_effort !== undefined) {
    if (!isModelReasoningEffort(value.model_reasoning_effort)) {
      throw new Error("model_reasoning_effort must be one of low, medium, high, xhigh.");
    }
    parsed.model_reasoning_effort = value.model_reasoning_effort;
  }
  if (value.agent_autonomy !== undefined) {
    if (!isAgentAutonomyLevel(value.agent_autonomy)) {
      throw new Error("agent_autonomy must be one of conservative, balanced, deep.");
    }
    parsed.agent_autonomy = value.agent_autonomy;
  }
  return parsed as ModelConfigUpdate;
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Number(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
