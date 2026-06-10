import type {
  RuntimePreferences,
  RuntimePreferencesUpdate,
} from "../../shared/agent-contracts.js";
import {
  AppConfigFile,
  type AppConfigFileOptions,
  type AppConfigState,
} from "./config-file.js";
import {
  mergeRuntimePreferences,
  parseRuntimePreferencesUpdate,
} from "./runtime-preferences-schema.js";

export { parseRuntimePreferencesUpdate } from "./runtime-preferences-schema.js";

export class RuntimePreferencesStore {
  private readonly configFile: AppConfigFile;

  constructor(userDataDir: string, options: AppConfigFileOptions = {}) {
    this.configFile = new AppConfigFile(userDataDir, options);
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
      assertDefaultProfileReferencesExist(parsed, state);
      const preferences = mergeRuntimePreferences(state.runtimePreferences, parsed);
      const nextState: AppConfigState = {
        ...state,
        runtimePreferences: preferences,
      };
      return { state: nextState, result: preferences };
    });
  }
}

function assertDefaultProfileReferencesExist(
  update: RuntimePreferencesUpdate,
  state: AppConfigState,
): void {
  const profileIds = new Set(state.profiles.map((profile) => profile.id));
  if (
    update.codeDefaultModelProfileId !== undefined &&
    update.codeDefaultModelProfileId !== null &&
    !profileIds.has(update.codeDefaultModelProfileId)
  ) {
    throw new Error("codeDefaultModelProfileId must reference an existing model profile.");
  }
  if (
    update.writeDefaultModelProfileId !== undefined &&
    update.writeDefaultModelProfileId !== null &&
    !profileIds.has(update.writeDefaultModelProfileId)
  ) {
    throw new Error("writeDefaultModelProfileId must reference an existing model profile.");
  }
}
