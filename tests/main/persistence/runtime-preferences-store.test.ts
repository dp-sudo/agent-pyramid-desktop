import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENCRYPTED_SECRET_PREFIX } from "../../../src/main/persistence/config-file";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_PREFERENCES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  type ModelConfigProfilesState,
  type RuntimePreferences,
} from "../../../src/shared/agent-contracts";
import {
  RuntimePreferencesStore,
  parseRuntimePreferencesUpdate,
} from "../../../src/main/persistence/runtime-preferences-store";
import { ModelConfigStore } from "../../../src/main/persistence/model-config-store";
import type { SecretStringCodec } from "../../../src/main/persistence/secret-codec";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("RuntimePreferencesStore", () => {
  let userDataDir: string;
  let store: RuntimePreferencesStore;
  let secretCodec: SecretStringCodec;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-runtime-preferences-");
    secretCodec = createTestSecretCodec();
    store = new RuntimePreferencesStore(userDataDir, { secretCodec });
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("initializes default runtime preferences", async () => {
    const preferences = await store.get();
    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as { runtimePreferences?: RuntimePreferences };

    expect(preferences).toEqual(DEFAULT_RUNTIME_PREFERENCES);
    expect(raw.runtimePreferences).toEqual(DEFAULT_RUNTIME_PREFERENCES);
    expect(preferences.toolAvailability.write.apply_patch).toBe(false);
    expect(preferences.toolAvailability.code.apply_patch).toBe(true);
    expect(preferences.skills).toEqual(DEFAULT_RUNTIME_PREFERENCES.skills);
    expect(existsSync(path.join(userDataDir, "runtime-preferences.json"))).toBe(false);
  });

  it("updates runtime preferences with nested values", async () => {
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify({
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "MiniMax",
          config: DEFAULT_MODEL_CONFIG,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "code-profile",
          name: "Code",
          config: DEFAULT_MODEL_CONFIG,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "write-profile",
          name: "Write",
          config: DEFAULT_MODEL_CONFIG,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
    }));

    const updated = await store.update({
      defaultApprovalPolicy: "never",
      defaultSandboxMode: "read-only",
      codeDefaultModelProfileId: " code-profile ",
      writeDefaultModelProfileId: " write-profile ",
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
      skills: {
        enabled: false,
        activeLimit: 5,
        instructionBudgetBytes: 32_000,
        extraRoots: [" custom-skills ", "", "custom-skills", "shared-skills"],
      },
      permissionRules: [
        {
          id: "allow-tests",
          tool: "command",
          pattern: "npm test*",
          effect: "allow",
        },
        {
          id: "ask-src",
          tool: "write",
          pattern: "src/*",
          effect: "ask",
        },
      ],
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
    expect(updated.skills).toEqual({
      enabled: false,
      activeLimit: 5,
      instructionBudgetBytes: 32_000,
      extraRoots: ["custom-skills", "shared-skills"],
    });
    expect(updated.permissionRules).toEqual([
      {
        id: "allow-tests",
        tool: "command",
        pattern: "npm test*",
        effect: "allow",
      },
      {
        id: "ask-src",
        tool: "write",
        pattern: "src/*",
        effect: "ask",
      },
    ]);
  });

  it("rejects runtime default profile ids that do not exist", async () => {
    await expect(
      store.update({ codeDefaultModelProfileId: "missing-profile" }),
    ).rejects.toThrow("codeDefaultModelProfileId must reference an existing model profile.");
    await expect(
      store.update({ writeDefaultModelProfileId: "missing-profile" }),
    ).rejects.toThrow("writeDefaultModelProfileId must reference an existing model profile.");
    await expect(
      store.update({ codeDefaultModelProfileId: " " }),
    ).rejects.toThrow("codeDefaultModelProfileId cannot be blank.");
  });

  it("preserves model profiles when runtime preferences are updated", async () => {
    const profileState: ModelConfigProfilesState & { runtimePreferences: RuntimePreferences } = {
      activeProfileId: "legacy-profile",
      profiles: [
        {
          id: "legacy-profile",
          name: "Legacy",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model_provide: "Legacy",
            model: "legacy-model",
            base_url: "https://legacy.example.test/v1",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    await store.update({ command: { timeoutMs: 45_000 } });
    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as ModelConfigProfilesState & { runtimePreferences?: RuntimePreferences };

    expect(raw.activeProfileId).toBe(profileState.activeProfileId);
    expect(raw.profiles).toEqual(profileState.profiles);
    expect(raw.runtimePreferences?.command.timeoutMs).toBe(45_000);
  });

  it("preserves encrypted model API keys when runtime preferences rewrite config", async () => {
    const modelConfigStore = new ModelConfigStore(userDataDir, { secretCodec });
    await modelConfigStore.update({ OPENAI_API_KEY: "test-runtime-shared-key" });

    await store.update({ command: { timeoutMs: 45_000 } });
    const raw = await fs.readFile(path.join(userDataDir, "config"), "utf8");
    const parsed = JSON.parse(raw) as ModelConfigProfilesState & {
      runtimePreferences?: RuntimePreferences;
    };

    expect(raw).not.toContain("test-runtime-shared-key");
    expect(parsed.profiles[0]?.config.OPENAI_API_KEY).toContain(ENCRYPTED_SECRET_PREFIX);
    expect(parsed.runtimePreferences?.command.timeoutMs).toBe(45_000);
  });

  it("uses config runtime preferences instead of stale legacy preferences", async () => {
    const configPreferences: RuntimePreferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      defaultApprovalPolicy: "never",
      command: {
        ...DEFAULT_RUNTIME_PREFERENCES.command,
        timeoutMs: 45_000,
      },
    };
    const legacyPreferences: RuntimePreferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      defaultApprovalPolicy: "auto",
      command: {
        ...DEFAULT_RUNTIME_PREFERENCES.command,
        timeoutMs: 60_000,
      },
    };
    const profileState: ModelConfigProfilesState & { runtimePreferences: RuntimePreferences } = {
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "MiniMax",
          config: DEFAULT_MODEL_CONFIG,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      runtimePreferences: configPreferences,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));
    await fs.writeFile(
      path.join(userDataDir, "runtime-preferences.json"),
      JSON.stringify(legacyPreferences),
    );

    const preferences = await store.get();

    expect(preferences).toEqual(configPreferences);
  });

  it("serializes shared config writes from model config and runtime preference stores", async () => {
    const modelConfigStore = new ModelConfigStore(userDataDir, { secretCodec });

    const [modelConfig, preferences] = await Promise.all([
      modelConfigStore.update({ model: "MiniMax-M3-latest" }),
      store.update({ command: { timeoutMs: 45_000 } }),
    ]);
    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as ModelConfigProfilesState & { runtimePreferences?: RuntimePreferences };

    expect(modelConfig.model).toBe("MiniMax-M3-latest");
    expect(preferences.command.timeoutMs).toBe(45_000);
    expect(raw.profiles[0]?.config.model).toBe("MiniMax-M3-latest");
    expect(raw.runtimePreferences?.command.timeoutMs).toBe(45_000);
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
        skills: { activeLimit: -1 },
      })),
    ).rejects.toThrow("skills.activeLimit must be an integer");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        skills: { extraRoots: ["ok", "bad\0root"] },
      })),
    ).rejects.toThrow("skills.extraRoots[1] cannot contain NUL bytes.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        toolAvailability: { code: {} },
      })),
    ).rejects.toThrow("toolAvailability mode must include at least one tool.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        compaction: { strategy: "full-history" },
      })),
    ).rejects.toThrow("compaction.strategy is invalid.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        permissionRules: [
          { id: "bad", tool: "command", pattern: "npm *", effect: "sometimes" },
        ],
      })),
    ).rejects.toThrow("permissionRules[0].effect is invalid.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        permissionRules: [
          { id: "duplicate", tool: "command", pattern: "npm *", effect: "allow" },
          { id: "duplicate", tool: "write", pattern: "src/*", effect: "ask" },
        ],
      })),
    ).rejects.toThrow("permissionRules[1].id is duplicated.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        permissionRules: [
          { id: "duplicate", tool: "command", pattern: "npm *", effect: "allow" },
          { id: " duplicate ", tool: "write", pattern: "src/*", effect: "ask" },
        ],
      })),
    ).rejects.toThrow("permissionRules[1].id is duplicated.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        permissionRules: [
          { id: "bad\0id", tool: "command", pattern: "npm *", effect: "allow" },
        ],
      })),
    ).rejects.toThrow("permissionRules[0].id cannot contain NUL bytes.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        permissionRules: [
          { id: "nul", tool: "command", pattern: "npm\0*", effect: "allow" },
        ],
      })),
    ).rejects.toThrow("permissionRules[0].pattern cannot contain NUL bytes.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({ mcpServers: "not-an-array" })),
    ).rejects.toThrow("mcpServers must be an array.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        mcpServers: [
          {
            id: "bad-mcp",
            name: "bad MCP",
            transport: "stdio",
            args: [],
            env: {},
            headers: {},
            enabled: true,
            readOnlyTools: [],
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      })),
    ).rejects.toThrow("mcpServers[0].command must be a non-empty string.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        mcpServers: [
          {
            id: "bad-mcp",
            name: "bad MCP",
            transport: "streamable-http",
            args: [],
            env: {},
            url: "https://mcp.example.test/mcp",
            headers: {
              Authorization: "Bearer one",
              " Authorization ": "Bearer two",
            },
            enabled: true,
            readOnlyTools: [],
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      })),
    ).rejects.toThrow("mcpServers[0].headers.Authorization key is duplicated.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        mcpServers: [
          {
            id: "bad-mcp",
            name: "bad MCP",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            headers: {},
            enabled: true,
            readOnlyTools: ["tools/list", "   "],
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      })),
    ).rejects.toThrow("mcpServers[0].readOnlyTools[1] must be a non-empty string.");
    await expect(
      store.update(malformedRuntimePreferencesUpdate({
        mcpServers: [
          {
            id: "docs-mcp",
            name: "docs mcp",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            headers: {},
            enabled: true,
            readOnlyTools: [],
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
          {
            id: "docs-mcp-segment-collision",
            name: "docs_mcp",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            headers: {},
            enabled: true,
            readOnlyTools: [],
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      })),
    ).rejects.toThrow("mcpServers[1].name conflicts with another MCP server namespace segment.");
  });

  it("normalizes malformed persisted runtime preferences", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const validMcpServer = {
      id: "valid-mcp",
      name: "valid MCP",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: {},
      headers: {},
      enabled: true,
      readOnlyTools: ["list"],
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
    } satisfies RuntimePreferences["mcpServers"][number];
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
      skills: {
        enabled: false,
        activeLimit: 99,
        instructionBudgetBytes: 512,
        extraRoots: [" valid-root ", "", "valid-root", "bad\0root", "shared-root"],
      },
      permissionRules: [
        { id: "allow-tests", tool: "command", pattern: "npm test*", effect: "allow" },
      ],
      mcpServers: [
        validMcpServer,
        {
          id: "broken-mcp",
          name: "broken MCP",
          transport: "stdio",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z",
        },
        {
          id: "valid-mcp",
          name: "duplicate MCP",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z",
        },
        {
          id: "duplicate-header",
          name: "duplicate header",
          transport: "streamable-http",
          args: [],
          env: {},
          url: "https://mcp.example.test/mcp",
          headers: {
            Authorization: "Bearer one",
            " Authorization ": "Bearer two",
          },
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z",
        },
        {
          id: "segment-duplicate-mcp",
          name: "valid_MCP",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z",
        },
      ],
    }));

    try {
      const preferences = await store.get();
      const raw = JSON.parse(
        await fs.readFile(path.join(userDataDir, "config"), "utf8"),
      ) as { runtimePreferences?: RuntimePreferences };

      expect(preferences.defaultApprovalPolicy).toBe(
        DEFAULT_RUNTIME_PREFERENCES.defaultApprovalPolicy,
      );
      expect(preferences.defaultSandboxMode).toBe("read-only");
      expect(preferences.toolAvailability.code.run_command).toBe(false);
      expect(preferences.toolAvailability.write.apply_patch).toBe(true);
      expect(preferences.toolAvailability.write.diagnose_workspace).toBe(
        DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.diagnose_workspace,
      );
      expect(preferences.codeDefaultModelProfileId).toBeNull();
      expect(preferences.writeDefaultModelProfileId).toBeNull();
      expect(preferences.approvalExperience.showDiffByDefault).toBe(false);
      expect(preferences.approvalExperience.autoScrollOnRequest).toBe(
        DEFAULT_RUNTIME_PREFERENCES.approvalExperience.autoScrollOnRequest,
      );
      expect(preferences.command.timeoutMs).toBe(DEFAULT_RUNTIME_PREFERENCES.command.timeoutMs);
      expect(preferences.command.maxOutputBytes).toBe(65_536);
      expect(preferences.compaction.enabled).toBe(false);
      expect(preferences.compaction.strategy).toBe(DEFAULT_RUNTIME_PREFERENCES.compaction.strategy);
      expect(preferences.skills).toEqual({
        ...DEFAULT_RUNTIME_PREFERENCES.skills,
        enabled: false,
        extraRoots: ["valid-root", "shared-root"],
      });
      expect(preferences.permissionRules).toEqual([
        { id: "allow-tests", tool: "command", pattern: "npm test*", effect: "allow" },
      ]);
      expect(preferences.mcpServers).toEqual([validMcpServer]);
      expect(warn).toHaveBeenCalledWith(
        "[runtime-preferences] skipped malformed mcpServers[1] entry:",
        "mcpServers[1].command must be a non-empty string.",
      );
      expect(warn).toHaveBeenCalledWith(
        "[runtime-preferences] skipped malformed mcpServers[2] entry:",
        "mcpServers[2].id is duplicated.",
      );
      expect(warn).toHaveBeenCalledWith(
        "[runtime-preferences] skipped malformed mcpServers[3] entry:",
        "mcpServers[3].headers.Authorization key is duplicated.",
      );
      expect(warn).toHaveBeenCalledWith(
        "[runtime-preferences] skipped malformed mcpServers[4] entry:",
        "mcpServers[4].name conflicts with another MCP server namespace segment.",
      );
      expect(raw.runtimePreferences).toEqual(preferences);
    } finally {
      warn.mockRestore();
    }
  });

  it("parses runtime preferences updates independently for IPC reuse", () => {
    expect(parseRuntimePreferencesUpdate({
      command: { maxOutputBytes: 4096 },
      skills: { activeLimit: 2, extraRoots: [" custom-skills ", "", "custom-skills"] },
      permissionRules: [
        { id: "deny-rm", tool: "command", pattern: "rm *", effect: "deny" },
      ],
    })).toEqual({
      command: { maxOutputBytes: 4096 },
      skills: { activeLimit: 2, extraRoots: ["custom-skills"] },
      permissionRules: [
        { id: "deny-rm", tool: "command", pattern: "rm *", effect: "deny" },
      ],
    });

    expect(() => parseRuntimePreferencesUpdate(null)).toThrow(
      "Runtime preferences update must be an object.",
    );
    expect(() => parseRuntimePreferencesUpdate({ approvalExperience: {} })).toThrow(
      "approvalExperience must include at least one field.",
    );
    expect(() => parseRuntimePreferencesUpdate({
      permissionRules: [
        { id: "bad", tool: "network", pattern: "*", effect: "deny" },
      ],
    })).toThrow("permissionRules[0].tool is invalid.");
  });
});

function malformedRuntimePreferencesUpdate(
  value: unknown,
): Parameters<RuntimePreferencesStore["update"]>[0] {
  return value as Parameters<RuntimePreferencesStore["update"]>[0];
}

function createTestSecretCodec(): SecretStringCodec {
  return {
    encrypt: encodeTestSecret,
    decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
  };
}

function encodeTestSecret(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
