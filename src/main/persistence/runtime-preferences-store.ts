import type {
  RuntimePreferences,
  RuntimePreferencesUpdate,
} from "../../shared/agent-contracts.js";
import { AppConfigFile, type AppConfigState } from "./config-file.js";
import {
  mergeRuntimePreferences,
  parseRuntimePreferencesUpdate,
} from "./runtime-preferences-schema.js";

export { parseRuntimePreferencesUpdate } from "./runtime-preferences-schema.js";

export class RuntimePreferencesStore {
  private readonly configFile: AppConfigFile;

  constructor(userDataDir: string) {
    this.configFile = new AppConfigFile(userDataDir);
  }

  async init(): Promise<void> {
    await this.configFile.init();
  }

  async get(): Promise<RuntimePreferences> {
    const state = await this.configFile.read();
    return state.runtimePreferences;
  }

  async update(update: RuntimePreferencesUpdate): Promise<RuntimePreferences> {
    const parsed = parseRuntimePreferencesUpdate(update);
    return this.configFile.update((state) => {
      const preferences = mergeRuntimePreferences(state.runtimePreferences, parsed);
      const nextState: AppConfigState = {
        ...state,
        runtimePreferences: preferences,
      };
      return { state: nextState, result: preferences };
    });
  }
}
