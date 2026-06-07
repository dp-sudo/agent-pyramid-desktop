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
  IpcResult,
  ModelConfig,
  ModelConfigProfile,
  ModelConfigProfileActivateRequest,
  ModelConfigProfileCreateRequest,
  ModelConfigProfileDeleteRequest,
  ModelConfigProfilesState,
  ModelConfigProfileUpdateRequest,
  ModelConfigUpdate,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { ModelConfigStore } from "../persistence/model-config-store.js";

export function registerModelConfigHandlers(store: ModelConfigStore): void {
  ipcMain.handle(MODEL_CONFIG_GET_CHANNEL, async () => {
    try {
      return ok(await store.get());
    } catch (error) {
      return err("MODEL_CONFIG_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(MODEL_CONFIG_UPDATE_CHANNEL, async (_event, update: ModelConfigUpdate) => {
    try {
      return ok(await store.update(update));
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
        return ok(await store.createProfile(request));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_CREATE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
    async (_event, request: ModelConfigProfileUpdateRequest) => {
      try {
        return ok(await store.updateProfile(request));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_UPDATE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
    async (_event, request: ModelConfigProfileDeleteRequest) => {
      try {
        return ok(await store.deleteProfile(request.id));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_DELETE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
    async (_event, request: ModelConfigProfileActivateRequest) => {
      try {
        return ok(await store.setActiveProfile(request.id));
      } catch (error) {
        return err("MODEL_CONFIG_PROFILES_ACTIVATE_FAILED", messageOf(error));
      }
    },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ModelConfigResult = IpcResult<ModelConfig>;
export type ModelConfigProfilesResult = IpcResult<ModelConfigProfilesState>;
export type ModelConfigProfileResult = IpcResult<ModelConfigProfile>;
