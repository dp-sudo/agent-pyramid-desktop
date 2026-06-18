import { ipcMain } from "electron";
import {
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import {
  MCP_SECRET_VALUE_MASK,
  err,
  isMcpSecretRecordKey,
  ok,
  toRendererRuntimePreferences,
} from "../../shared/agent-contracts.js";
import {
  parseRuntimePreferencesUpdate,
  type RuntimePreferencesStore,
} from "../persistence/runtime-preferences-store.js";
import type {
  McpServerConfig,
  RuntimePreferences,
  RuntimePreferencesUpdate,
} from "../../shared/agent-contracts.js";
import { messageOfIpcError as messageOf } from "./ipc-result-handler.js";

export interface RuntimePreferencesHandlerOptions {
  afterUpdate?(preferences: RuntimePreferences): void | Promise<void>;
}

export function registerRuntimePreferencesHandlers(
  store: RuntimePreferencesStore,
  options: RuntimePreferencesHandlerOptions = {},
): void {
  ipcMain.handle(RUNTIME_PREFERENCES_GET_CHANNEL, async () => {
    try {
      return ok(toRendererRuntimePreferences(await store.get()));
    } catch (error) {
      return err(IPC_ERROR_CODES.RUNTIME_PREFERENCES_GET_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(RUNTIME_PREFERENCES_UPDATE_CHANNEL, async (_event, update: unknown) => {
    try {
      const parsed = parseRuntimePreferencesUpdate(update);
      const merged = await mergeMaskedMcpSecrets(store, parsed);
      const preferences = await store.update(merged);
      await options.afterUpdate?.(preferences);
      return ok(toRendererRuntimePreferences(preferences));
    } catch (error) {
      return err(IPC_ERROR_CODES.RUNTIME_PREFERENCES_UPDATE_FAILED, messageOf(error));
    }
  });
}

async function mergeMaskedMcpSecrets(
  store: RuntimePreferencesStore,
  update: RuntimePreferencesUpdate,
): Promise<RuntimePreferencesUpdate> {
  if (!update.mcpServers) return update;
  const current = await store.get();
  return {
    ...update,
    mcpServers: mergeMcpServersWithCurrentSecrets(
      current.mcpServers,
      update.mcpServers,
    ),
  };
}

function mergeMcpServersWithCurrentSecrets(
  currentServers: readonly McpServerConfig[],
  nextServers: readonly McpServerConfig[],
): McpServerConfig[] {
  const currentById = new Map(currentServers.map((server) => [server.id, server]));
  return nextServers.map((server) => {
    const current = currentById.get(server.id);
    return {
      ...server,
      env: mergeSecretRecordMasks(current?.env ?? {}, server.env),
      headers: mergeSecretRecordMasks(current?.headers ?? {}, server.headers),
    };
  });
}

function mergeSecretRecordMasks(
  current: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [
      key,
      value === MCP_SECRET_VALUE_MASK && isMcpSecretRecordKey(key) && current[key] !== undefined
        ? current[key]
        : value,
    ]),
  );
}
