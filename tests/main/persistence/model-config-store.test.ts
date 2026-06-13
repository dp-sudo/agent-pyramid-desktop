import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENCRYPTED_SECRET_PREFIX } from "../../../src/main/persistence/config-file";
import { ModelConfigStore } from "../../../src/main/persistence/model-config-store";
import type { SecretStringCodec } from "../../../src/main/persistence/secret-codec";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_PREFERENCES,
  isIsoTimestampString,
  type ModelConfig,
  type ModelConfigProfilesState,
  type RuntimePreferences,
} from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("ModelConfigStore", () => {
  let userDataDir: string;
  let store: ModelConfigStore;
  let secretCodec: SecretStringCodec;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-model-config-");
    secretCodec = createTestSecretCodec();
    store = new ModelConfigStore(userDataDir, { secretCodec });
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("initializes a default profile and updates the active config", async () => {
    const initial = await store.listProfiles();
    expect(initial.activeProfileId).toBe("default");
    expect(initial.profiles).toHaveLength(1);

    const updated = await store.update({
      model_provide: "Agnes",
      model: "agnes-2.0-flash",
      base_url: "https://apihub.example.test/v1",
      OPENAI_API_KEY: "",
      model_context_window: 1000,
      model_auto_compact_token_limit: 900,
      max_tokens: 200,
      thinking: false,
      model_reasoning_effort: "high",
    });

    expect(updated).toMatchObject({
      model_provide: "Agnes",
      model: "agnes-2.0-flash",
      protocol: "openai-compatible",
      model_auto_compact_token_limit: 900,
      thinking: false,
      model_reasoning_effort: "high",
    });
  });

  it("initializes agent runtime preferences inside the shared config file", async () => {
    await store.init();

    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as { runtimePreferences?: RuntimePreferences };

    expect(raw.runtimePreferences).toEqual(DEFAULT_RUNTIME_PREFERENCES);
  });

  it("creates, activates, updates, and deletes profiles", async () => {
    const created = await store.createProfile({
      name: " DeepSeek ",
      activate: true,
      config: {
        model_provide: "DeepSeek",
        model: "deepseek-v4-flash",
        base_url: "https://api.deepseek.com",
        OPENAI_API_KEY: "",
      },
    });
    const createdProfile = created.profiles.find((profile) => profile.name === "DeepSeek");
    expect(createdProfile).toBeDefined();
    expect(created.activeProfileId).toBe(createdProfile?.id);

    if (!createdProfile) {
      throw new Error("Expected created profile to exist.");
    }

    const renamed = await store.updateProfile({
      id: createdProfile.id,
      name: "DeepSeek Flash",
      config: {
        model_provide: "DeepSeek",
        model: "deepseek-v4-flash",
        base_url: "https://api.deepseek.com",
        OPENAI_API_KEY: "",
        max_tokens: 4096,
      },
    });
    expect(renamed.name).toBe("DeepSeek Flash");
    expect(renamed.config.max_tokens).toBe(4096);

    const protocolUpdated = await store.updateProfile({
      id: createdProfile.id,
      config: {
        protocol: "anthropic-compatible",
      },
    });
    expect(protocolUpdated.config.protocol).toBe("anthropic-compatible");

    const afterDelete = await store.deleteProfile(createdProfile.id);
    expect(afterDelete.activeProfileId).toBe("default");
    expect(afterDelete.profiles.map((profile) => profile.id)).toEqual(["default"]);
  });

  it("rejects non-boolean profile activation at the store boundary", async () => {
    const invalidRequest = {
      name: "DeepSeek",
      activate: "false",
      config: {
        model_provide: "DeepSeek",
        model: "deepseek-v4-flash",
        base_url: "https://api.deepseek.com",
        OPENAI_API_KEY: "",
      },
    } as unknown as Parameters<ModelConfigStore["createProfile"]>[0];

    await expect(store.createProfile(invalidRequest)).rejects.toThrow(
      "activate must be a boolean.",
    );
    const profiles = await store.listProfiles();
    expect(profiles.activeProfileId).toBe("default");
    expect(profiles.profiles).toHaveLength(1);
  });

  it("rejects malformed profile create payloads at the store boundary", async () => {
    const before = await store.listProfiles();

    await expect(
      store.createProfile(null as unknown as Parameters<ModelConfigStore["createProfile"]>[0]),
    ).rejects.toThrow("Model config profile create request must be an object.");
    await expect(
      store.createProfile({
        name: "DeepSeek",
      } as unknown as Parameters<ModelConfigStore["createProfile"]>[0]),
    ).rejects.toThrow("Model config profile config must be an object.");

    await expect(store.listProfiles()).resolves.toEqual(before);
  });

  it("rejects empty active config updates at the store boundary", async () => {
    const before = await store.listProfiles();

    await expect(store.update({})).rejects.toThrow(
      "Model config update must include at least one field.",
    );
    await expect(
      store.update(
        { unknown: "value" } as unknown as Parameters<ModelConfigStore["update"]>[0],
      ),
    ).rejects.toThrow("Model config update must include at least one field.");

    await expect(store.listProfiles()).resolves.toEqual(before);
  });

  it("rejects empty profile updates at the store boundary", async () => {
    const before = await store.listProfiles();

    await expect(store.updateProfile({ id: "default" })).rejects.toThrow(
      "Model config profile update must include name or config.",
    );
    await expect(store.updateProfile({ id: "default", config: {} })).rejects.toThrow(
      "Model config update must include at least one field.",
    );
    await expect(
      store.updateProfile({
        id: "default",
        config: { unknown: "value" } as unknown as Parameters<ModelConfigStore["update"]>[0],
      }),
    ).rejects.toThrow("Model config update must include at least one field.");

    await expect(store.listProfiles()).resolves.toEqual(before);
  });

  it("preserves agent runtime preferences when model profiles are updated", async () => {
    const runtimePreferences: RuntimePreferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      command: {
        ...DEFAULT_RUNTIME_PREFERENCES.command,
        timeoutMs: 45_000,
      },
      toolAvailability: {
        ...DEFAULT_RUNTIME_PREFERENCES.toolAvailability,
        code: {
          ...DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code,
          run_command: false,
        },
      },
    };
    const profileState = {
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
      runtimePreferences,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    await store.update({ model: "MiniMax-M3-latest" });
    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as { runtimePreferences?: RuntimePreferences };

    expect(raw.runtimePreferences).toEqual(runtimePreferences);
  });

  it("clears runtime default profile references when a profile is deleted", async () => {
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
        {
          id: "write-profile",
          name: "Write",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model: "write-model",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "code-profile",
          name: "Code",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model: "code-model",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      runtimePreferences: {
        ...DEFAULT_RUNTIME_PREFERENCES,
        codeDefaultModelProfileId: "code-profile",
        writeDefaultModelProfileId: "write-profile",
      },
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    await store.deleteProfile("write-profile");
    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as { runtimePreferences?: RuntimePreferences };

    expect(raw.runtimePreferences?.codeDefaultModelProfileId).toBe("code-profile");
    expect(raw.runtimePreferences?.writeDefaultModelProfileId).toBeNull();
  });

  it("normalizes stale runtime default profile references from shared config", async () => {
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
        {
          id: "code-profile",
          name: "Code",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model: "code-model",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      runtimePreferences: {
        ...DEFAULT_RUNTIME_PREFERENCES,
        codeDefaultModelProfileId: "code-profile",
        writeDefaultModelProfileId: "missing-profile",
      },
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    await store.init();
    const raw = JSON.parse(
      await fs.readFile(path.join(userDataDir, "config"), "utf8"),
    ) as { runtimePreferences?: RuntimePreferences };

    expect(raw.runtimePreferences?.codeDefaultModelProfileId).toBe("code-profile");
    expect(raw.runtimePreferences?.writeDefaultModelProfileId).toBeNull();
  });

  it("normalizes a legacy single-config file into profile state", async () => {
    const legacyConfig: ModelConfig = {
      ...DEFAULT_MODEL_CONFIG,
      model_provide: "Legacy",
      model: "legacy-model",
      base_url: "https://legacy.example.test/v1",
      model_context_window: 100,
      model_auto_compact_token_limit: 90,
      max_tokens: 50,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(legacyConfig));

    const profiles = await store.listProfiles();
    const expectedProfiles: ModelConfigProfilesState = {
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "Legacy",
          config: legacyConfig,
          createdAt: expect.any(String) as string,
          updatedAt: expect.any(String) as string,
        },
      ],
    };
    expect(profiles).toMatchObject(expectedProfiles);
  });

  it("normalizes legacy configs without protocol to OpenAI-compatible", async () => {
    const legacyConfig = {
      model_provide: "Legacy",
      model: "legacy-model",
      base_url: "https://legacy.example.test/v1",
      OPENAI_API_KEY: "",
      model_context_window: 100,
      model_auto_compact_token_limit: 90,
      max_tokens: 50,
      thinking: true,
      model_reasoning_effort: "medium",
      agent_autonomy: "balanced",
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(legacyConfig));

    const profiles = await store.listProfiles();
    expect(profiles.profiles[0]?.config.protocol).toBe("openai-compatible");
  });

  it("migrates legacy plain-text API keys into encrypted config storage", async () => {
    const legacySecret = "test-model-api-key";
    const legacyConfig: ModelConfig = {
      ...DEFAULT_MODEL_CONFIG,
      model_provide: "Legacy",
      model: "legacy-model",
      base_url: "https://legacy.example.test/v1",
      OPENAI_API_KEY: legacySecret,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(legacyConfig));

    const profiles = await store.listProfiles();
    const raw = await fs.readFile(path.join(userDataDir, "config"), "utf8");
    const persisted = JSON.parse(raw) as ModelConfigProfilesState;

    expect(profiles.profiles[0]?.config.OPENAI_API_KEY).toBe(legacySecret);
    expect(raw).not.toContain(legacySecret);
    expect(persisted.profiles[0]?.config.OPENAI_API_KEY)
      .toBe(`${ENCRYPTED_SECRET_PREFIX}${encodeTestSecret(legacySecret)}`);
  });

  it("keeps API keys encrypted on profile updates while returning decrypted config", async () => {
    const updated = await store.update({ OPENAI_API_KEY: "test-updated-api-key" });
    const raw = await fs.readFile(path.join(userDataDir, "config"), "utf8");

    expect(updated.OPENAI_API_KEY).toBe("test-updated-api-key");
    expect(raw).not.toContain("test-updated-api-key");
    expect(raw).toContain(ENCRYPTED_SECRET_PREFIX);
  });

  it("fails traceably instead of writing a non-empty API key without encryption", async () => {
    const unencryptedStore = new ModelConfigStore(userDataDir);

    await expect(
      unencryptedStore.update({ OPENAI_API_KEY: "test-unencrypted-api-key" }),
    ).rejects.toThrow("Secret encryption codec is not configured.");
  });

  it("rejects invalid protocol updates at the store boundary", async () => {
    await expect(
      store.update({
        protocol: "custom",
      } as unknown as Parameters<ModelConfigStore["update"]>[0]),
    ).rejects.toThrow("protocol must be one of openai-compatible, anthropic-compatible.");
  });

  it("rejects malformed primitive config fields at the store boundary", async () => {
    await expect(
      store.update({
        thinking: "false",
      } as unknown as Parameters<ModelConfigStore["update"]>[0]),
    ).rejects.toThrow("thinking must be a boolean.");
    await expect(
      store.update({
        OPENAI_API_KEY: false,
      } as unknown as Parameters<ModelConfigStore["update"]>[0]),
    ).rejects.toThrow("OPENAI_API_KEY must be a string.");
    await expect(
      store.createProfile({
        name: "Bad profile",
        config: { thinking: "true" },
      } as unknown as Parameters<ModelConfigStore["createProfile"]>[0]),
    ).rejects.toThrow("thinking must be a boolean.");
    await expect(
      store.updateProfile({
        id: "default",
        config: { OPENAI_API_KEY: false },
      } as unknown as Parameters<ModelConfigStore["updateProfile"]>[0]),
    ).rejects.toThrow("OPENAI_API_KEY must be a string.");
  });

  it("clamps legacy single-config max tokens below the context window", async () => {
    const legacyConfig: ModelConfig = {
      ...DEFAULT_MODEL_CONFIG,
      model_provide: "Legacy",
      model: "legacy-model",
      base_url: "https://legacy.example.test/v1",
      model_context_window: 100,
      model_auto_compact_token_limit: 90,
      max_tokens: 100,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(legacyConfig));

    const profiles = await store.listProfiles();
    expect(profiles.profiles[0]?.config.model_context_window).toBe(100);
    expect(profiles.profiles[0]?.config.max_tokens).toBe(99);
  });

  it("clamps legacy single-config compact limits to the context window", async () => {
    const legacyConfig: ModelConfig = {
      ...DEFAULT_MODEL_CONFIG,
      model_provide: "Legacy",
      model: "legacy-model",
      base_url: "https://legacy.example.test/v1",
      model_context_window: 100,
      model_auto_compact_token_limit: 120,
      max_tokens: 50,
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(legacyConfig));

    const profiles = await store.listProfiles();
    expect(profiles.profiles[0]?.config.model_context_window).toBe(100);
    expect(profiles.profiles[0]?.config.model_auto_compact_token_limit).toBe(100);
  });

  it("clamps stored profile max tokens below the context window", async () => {
    const profileState: ModelConfigProfilesState = {
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
            model_context_window: 100,
            model_auto_compact_token_limit: 90,
            max_tokens: 120,
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    const profiles = await store.listProfiles();
    expect(profiles.activeProfileId).toBe("legacy-profile");
    expect(profiles.profiles[0]?.config.model_context_window).toBe(100);
    expect(profiles.profiles[0]?.config.max_tokens).toBe(99);
  });

  it("clamps stored profile compact limits to the context window", async () => {
    const profileState: ModelConfigProfilesState = {
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
            model_context_window: 100,
            model_auto_compact_token_limit: 120,
            max_tokens: 50,
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    const profiles = await store.listProfiles();
    expect(profiles.activeProfileId).toBe("legacy-profile");
    expect(profiles.profiles[0]?.config.model_context_window).toBe(100);
    expect(profiles.profiles[0]?.config.model_auto_compact_token_limit).toBe(100);
  });

  it("normalizes invalid stored profile timestamps to ISO timestamps", async () => {
    const profileState: ModelConfigProfilesState = {
      activeProfileId: "legacy-profile",
      profiles: [
        {
          id: "legacy-profile",
          name: "Legacy",
          config: DEFAULT_MODEL_CONFIG,
          createdAt: "not-a-date",
          updatedAt: "2026-01-01",
        },
      ],
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    const profiles = await store.listProfiles();
    const profile = profiles.profiles[0];

    expect(profile?.createdAt).not.toBe("not-a-date");
    expect(profile?.updatedAt).not.toBe("2026-01-01");
    expect(isIsoTimestampString(profile?.createdAt)).toBe(true);
    expect(isIsoTimestampString(profile?.updatedAt)).toBe(true);
  });

  it("deduplicates persisted profile ids before profile mutations run", async () => {
    const profileState: ModelConfigProfilesState = {
      activeProfileId: "duplicate-profile",
      profiles: [
        {
          id: "duplicate-profile",
          name: "First",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model: "first-model",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "duplicate-profile",
          name: "Second",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model: "second-model",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "remaining-profile",
          name: "Remaining",
          config: {
            ...DEFAULT_MODEL_CONFIG,
            model: "remaining-model",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(path.join(userDataDir, "config"), JSON.stringify(profileState));

    const profiles = await store.listProfiles();
    expect(profiles.activeProfileId).toBe("duplicate-profile");
    expect(profiles.profiles.map((profile) => profile.id)).toEqual([
      "duplicate-profile",
      "remaining-profile",
    ]);
    expect(profiles.profiles[0]?.config.model).toBe("first-model");

    const afterDelete = await store.deleteProfile("duplicate-profile");
    expect(afterDelete.activeProfileId).toBe("remaining-profile");
    expect(afterDelete.profiles.map((profile) => profile.id)).toEqual([
      "remaining-profile",
    ]);
  });

  it("rejects invalid token limits and keeps failures observable", async () => {
    await expect(
      store.update({
        model_provide: "MiniMax",
        model: "MiniMax-M3",
        base_url: "https://api.minimaxi.com/v1",
        OPENAI_API_KEY: "",
        model_context_window: 100,
        model_auto_compact_token_limit: 101,
        max_tokens: 50,
        model_reasoning_effort: "medium",
      }),
    ).rejects.toThrow("model_auto_compact_token_limit must be <= model_context_window.");

    await expect(
      store.update({
        model_provide: "MiniMax",
        model: "MiniMax-M3",
        base_url: "https://api.minimaxi.com/v1",
        OPENAI_API_KEY: "",
        model_context_window: 100,
        model_auto_compact_token_limit: 90,
        max_tokens: 100,
        model_reasoning_effort: "medium",
      }),
    ).rejects.toThrow("max_tokens must be < model_context_window.");

    await expect(store.deleteProfile("default")).rejects.toThrow(
      "At least one model config profile is required.",
    );
  });
});

function createTestSecretCodec(): SecretStringCodec {
  return {
    encrypt: encodeTestSecret,
    decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
  };
}

function encodeTestSecret(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
