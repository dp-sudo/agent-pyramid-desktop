import { ipcMain } from "electron";
import {
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_UPDATE_CHANNEL,
} from "../../shared/ipc.js";
import type {
  IpcResult,
  ModelConfig,
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ModelConfigResult = IpcResult<ModelConfig>;
