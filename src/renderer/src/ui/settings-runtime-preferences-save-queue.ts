import type {
  IpcResult,
  RuntimePreferences,
  RuntimePreferencesUpdate,
} from "../../../shared/agent-contracts";
import { mergeRuntimePreferencesUpdates } from "./settings-runtime-preferences-model";

export type RuntimePreferencesUpdateApi = (
  update: RuntimePreferencesUpdate,
) => Promise<IpcResult<RuntimePreferences>>;

export interface RuntimePreferencesSaveQueueHandlers {
  getUpdater(): RuntimePreferencesUpdateApi | null;
  onSaving(): void;
  onSaved(preferences: RuntimePreferences): void;
  onError(message: string): void;
  messageOfUnknownError(error: unknown): string;
  preloadMissingMessage(): string;
}

export class RuntimePreferencesSaveQueue {
  private handlers: RuntimePreferencesSaveQueueHandlers;
  private inProgress = false;
  private pendingUpdate: RuntimePreferencesUpdate | null = null;

  constructor(handlers: RuntimePreferencesSaveQueueHandlers) {
    this.handlers = handlers;
  }

  updateHandlers(handlers: RuntimePreferencesSaveQueueHandlers): void {
    this.handlers = handlers;
  }

  async save(update: RuntimePreferencesUpdate): Promise<void> {
    const updater = this.handlers.getUpdater();
    if (!updater) {
      this.handlers.onError(this.handlers.preloadMissingMessage());
      return;
    }
    if (this.inProgress) {
      this.pendingUpdate = mergeRuntimePreferencesUpdates(this.pendingUpdate, update);
      return;
    }

    this.inProgress = true;
    this.handlers.onSaving();
    try {
      const result = await updater(update);
      if (!result.ok) {
        this.handlers.onError(result.message);
        return;
      }
      this.handlers.onSaved(result.value);
    } catch (updateError) {
      this.handlers.onError(this.handlers.messageOfUnknownError(updateError));
    } finally {
      this.inProgress = false;
      const pendingUpdate = this.pendingUpdate;
      this.pendingUpdate = null;
      if (pendingUpdate) {
        void this.save(pendingUpdate);
      }
    }
  }
}
