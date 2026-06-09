import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
} from "../../../src/shared/agent-contracts";
import {
  RuntimePreferencesStore,
  parseRuntimePreferencesUpdate,
} from "../../../src/main/persistence/runtime-preferences-store";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("RuntimePreferencesStore", () => {
  let userDataDir: string;
  let store: RuntimePreferencesStore;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-runtime-preferences-");
    store = new RuntimePreferencesStore(userDataDir);
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("initializes default runtime preferences", async () => {
    const preferences = await store.get();

    expect(preferences).toEqual(DEFAULT_RUNTIME_PREFERENCES);
    expect(preferences.toolAvailability.write.apply_patch).toBe(false);
    expect(preferences.toolAvailability.code.apply_patch).toBe(true);
  });

  it("updates runtime preferences with nested values", async () => {
    const updated = await store.update({
      defaultApprovalPolicy: "never",
      defaultSandboxMode: "read-only",
      codeDefaultModelProfileId: "code-profile",
      writeDefaultModelProfileId: "write-profile",
      toolAvailability: {
        code: { run_command: false },
        write: { diagnose_file: true },
      },
      approvalExperience: {
        showDiffByDefault: false,
      },
      command: {
        timeoutMs: 45_000,
      },
      compaction: {
        enabled: false,
        strategy: "recent-only",
      },
    });

    expect(updated.defaultApprovalPolicy).toBe("never");
    expect(updated.defaultSandboxMode).toBe("read-only");
    expect(updated.codeDefaultModelProfileId).toBe("code-profile");
    expect(updated.writeDefaultModelProfileId).toBe("write-profile");
    expect(updated.toolAvailability.code.run_command).toBe(false);
    expect(updated.toolAvailability.write.diagnose_file).toBe(true);
    expect(updated.approvalExperience.showDiffByDefault).toBe(false);
    expect(updated.approvalExperience.autoScrollOnRequest).toBe(true);
    expect(updated.command.timeoutMs).toBe(45_000);
    expect(updated.command.maxOutputBytes).toBe(
      DEFAULT_RUNTIME_PREFERENCES.command.maxOutputBytes,
    );
    expect(updated.compaction.enabled).toBe(false);
    expect(updated.compaction.strategy).toBe("recent-only");
  });

  it("rejects malformed runtime preference updates", async () => {
    await expect(store.update({})).rejects.toThrow(
      "Runtime preferences update must include at least one field.",
    );
    await expect(
      store.update(malformedRuntimePreferencesUpdate({ defaultApprovalPolicy: "sometimes" })),
    ).rejects.toThrow("defaultApprovalPolicy is invalid.");
    await expect(
      store.update({ command: { timeoutMs: MAX_RUNTIME_COMMAND_TIMEOUT_MS + 1 } }),
    ).rejects.toThrow(
      `command.timeoutMs must be an integer between 100 and ${MAX_RUNTIME_COMMAND_TIMEOUT_MS}.`,
    );
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        toolAvailability: { code: { run_command: "false" } },
      })),
    ).rejects.toThrow("toolAvailability tool value must be a boolean.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        compaction: { strategy: "full-history" },
      })),
    ).rejects.toThrow("compaction.strategy is invalid.");
  });

  it("normalizes malformed persisted runtime preferences", async () => {
    await fs.writeFile(path.join(userDataDir, "runtime-preferences.json"), JSON.stringify({
      defaultApprovalPolicy: "sometimes",
      defaultSandboxMode: "read-only",
      toolAvailability: {
        code: { run_command: false },
        write: { apply_patch: true, diagnose_workspace: "false" },
      },
      codeDefaultModelProfileId: " code-profile ",
      writeDefaultModelProfileId: "",
      approvalExperience: {
        showDiffByDefault: false,
        autoScrollOnRequest: "yes",
      },
      command: {
        timeoutMs: 0,
        maxOutputBytes: 65_536,
      },
      compaction: {
        enabled: false,
        strategy: "unknown",
      },
    }));

    const preferences = await store.get();

    expect(preferences.defaultApprovalPolicy).toBe(
      DEFAULT_RUNTIME_PREFERENCES.defaultApprovalPolicy,
    );
    expect(preferences.defaultSandboxMode).toBe("read-only");
    expect(preferences.toolAvailability.code.run_command).toBe(false);
    expect(preferences.toolAvailability.write.apply_patch).toBe(true);
    expect(preferences.toolAvailability.write.diagnose_workspace).toBe(
      DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.diagnose_workspace,
    );
    expect(preferences.codeDefaultModelProfileId).toBe("code-profile");
    expect(preferences.writeDefaultModelProfileId).toBeNull();
    expect(preferences.approvalExperience.showDiffByDefault).toBe(false);
    expect(preferences.approvalExperience.autoScrollOnRequest).toBe(
      DEFAULT_RUNTIME_PREFERENCES.approvalExperience.autoScrollOnRequest,
    );
    expect(preferences.command.timeoutMs).toBe(DEFAULT_RUNTIME_PREFERENCES.command.timeoutMs);
    expect(preferences.command.maxOutputBytes).toBe(65_536);
    expect(preferences.compaction.enabled).toBe(false);
    expect(preferences.compaction.strategy).toBe(DEFAULT_RUNTIME_PREFERENCES.compaction.strategy);
  });

  it("parses runtime preferences updates independently for IPC reuse", () => {
    expect(parseRuntimePreferencesUpdate({
      command: { maxOutputBytes: 4096 },
    })).toEqual({
      command: { maxOutputBytes: 4096 },
    });

    expect(() => parseRuntimePreferencesUpdate(null)).toThrow(
      "Runtime preferences update must be an object.",
    );
    expect(() => parseRuntimePreferencesUpdate({ approvalExperience: {} })).toThrow(
      "approvalExperience must include at least one field.",
    );
  });
});

function malformedRuntimePreferencesUpdate(
  value: unknown,
): Parameters<RuntimePreferencesStore["update"]>[0] {
  return value as Parameters<RuntimePreferencesStore["update"]>[0];
}
