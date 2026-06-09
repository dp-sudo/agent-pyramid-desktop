import { ipcMain } from "electron";
import {
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
} from "../../shared/ipc.js";
import { err, ok } from "../../shared/agent-contracts.js";
import {
  parseRuntimePreferencesUpdate,
  type RuntimePreferencesStore,
} from "../persistence/runtime-preferences-store.js";

export function registerRuntimePreferencesHandlers(
  store: RuntimePreferencesStore,
): void {
  ipcMain.handle(RUNTIME_PREFERENCES_GET_CHANNEL, async () => {
    try {
      return ok(await store.get());
    } catch (error) {
      return err("RUNTIME_PREFERENCES_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(RUNTIME_PREFERENCES_UPDATE_CHANNEL, async (_event, update: unknown) => {
    try {
      return ok(await store.update(parseRuntimePreferencesUpdate(update)));
    } catch (error) {
      return err("RUNTIME_PREFERENCES_UPDATE_FAILED", messageOf(error));
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
