import { describe, expect, it, vi } from "vitest";
import { RuntimePreferencesSaveQueue } from "../../src/renderer/src/ui/settings-runtime-preferences-save-queue";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  err,
  ok,
  type RuntimePreferences,
  type RuntimePreferencesUpdate,
} from "../../src/shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../src/shared/ipc-errors";

describe("RuntimePreferencesSaveQueue", () => {
  it("merges updates queued while a save is in progress", async () => {
    let resolveFirst!: (preferences: RuntimePreferences) => void;
    const update = vi.fn((request: RuntimePreferencesUpdate) => {
      if (request.defaultApprovalPolicy === "never") {
        return new Promise<ReturnType<typeof ok<RuntimePreferences>>>((resolve) => {
          resolveFirst = (preferences) => resolve(ok(preferences));
        });
      }
      const preferences: RuntimePreferences = {
        ...DEFAULT_RUNTIME_PREFERENCES,
        defaultApprovalPolicy: "never",
        defaultSandboxMode: "read-only",
        approvalExperience: {
          ...DEFAULT_RUNTIME_PREFERENCES.approvalExperience,
          showFailureToasts: false,
        },
      };
      return Promise.resolve(ok(preferences));
    });
    const events: string[] = [];
    const queue = new RuntimePreferencesSaveQueue({
      getUpdater: () => update,
      onSaving: () => events.push("saving"),
      onSaved: () => events.push("saved"),
      onError: (message) => events.push(`error:${message}`),
      messageOfUnknownError: String,
      preloadMissingMessage: () => "preload missing",
    });

    void queue.save({ defaultApprovalPolicy: "never" });
    await Promise.resolve();
    void queue.save({ defaultSandboxMode: "read-only" });
    void queue.save({ approvalExperience: { showFailureToasts: false } });

    expect(update).toHaveBeenCalledTimes(1);
    resolveFirst(DEFAULT_RUNTIME_PREFERENCES);
    await Promise.resolve();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(2, {
      defaultSandboxMode: "read-only",
      approvalExperience: { showFailureToasts: false },
    });
    expect(events).toEqual(["saving", "saved", "saving", "saved"]);
  });

  it("reports missing preload and failed IPC results through error state", async () => {
    const events: string[] = [];
    const queue = new RuntimePreferencesSaveQueue({
      getUpdater: () => null,
      onSaving: () => events.push("saving"),
      onSaved: () => events.push("saved"),
      onError: (message) => events.push(`error:${message}`),
      messageOfUnknownError: String,
      preloadMissingMessage: () => "preload missing",
    });

    await queue.save({ defaultApprovalPolicy: "on-request" });
    queue.updateHandlers({
      getUpdater: () => vi.fn(async () =>
        err(IPC_ERROR_CODES.RUNTIME_PREFERENCES_UPDATE_FAILED, "update failed")
      ),
      onSaving: () => events.push("saving"),
      onSaved: () => events.push("saved"),
      onError: (message) => events.push(`error:${message}`),
      messageOfUnknownError: String,
      preloadMissingMessage: () => "preload missing",
    });
    await queue.save({ defaultApprovalPolicy: "never" });

    expect(events).toEqual(["error:preload missing", "saving", "error:update failed"]);
  });

  it("reports thrown updater errors through messageOfUnknownError", async () => {
    const events: string[] = [];
    const queue = new RuntimePreferencesSaveQueue({
      getUpdater: () => vi.fn(async () => {
        throw new Error("bridge rejected");
      }),
      onSaving: () => events.push("saving"),
      onSaved: () => events.push("saved"),
      onError: (message) => events.push(`error:${message}`),
      messageOfUnknownError: (error) =>
        error instanceof Error ? error.message : String(error),
      preloadMissingMessage: () => "preload missing",
    });

    await queue.save({ defaultApprovalPolicy: "never" });

    expect(events).toEqual(["saving", "error:bridge rejected"]);
  });
});
