import { describe, expect, it } from "vitest";
import {
  filterSettingsSidebarItems,
  getDefaultCategoryForSection,
  isProfileDeletePending,
  isSettingsCategoryInSection,
  shouldBlockSettingsNavigation,
  toDefaultInspectorMode,
  toDefaultInspectorModeValue,
  toUpdatePayload,
  validateModelSettingsForm,
  validateRuntimeCommandDraft,
  type SettingsFormState,
} from "../../src/renderer/src/ui/SettingsView";
import {
  DEFAULT_MODEL_CONFIG,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
} from "../../src/shared/agent-contracts";

describe("SettingsView helpers", () => {
  it("tracks inline delete confirmation for a single profile", () => {
    expect(isProfileDeletePending("profile-1", "profile-1")).toBe(true);
    expect(isProfileDeletePending("profile-1", "profile-2")).toBe(false);
    expect(isProfileDeletePending(null, "profile-1")).toBe(false);
  });

  it("blocks profile-changing settings actions while dirty or failed with unsaved changes", () => {
    expect(shouldBlockSettingsNavigation("dirty")).toBe(true);
    expect(shouldBlockSettingsNavigation("idle")).toBe(false);
    expect(shouldBlockSettingsNavigation("saved")).toBe(false);
    expect(shouldBlockSettingsNavigation("error")).toBe(false);
    expect(shouldBlockSettingsNavigation("error", true)).toBe(true);
    expect(shouldBlockSettingsNavigation("error", false)).toBe(false);
    expect(shouldBlockSettingsNavigation("loading")).toBe(false);
    expect(shouldBlockSettingsNavigation("saving")).toBe(false);
  });

  it("keeps settings categories scoped to six first-level sections", () => {
    expect(getDefaultCategoryForSection("basic")).toBe("appearance");
    expect(getDefaultCategoryForSection("model")).toBe("profiles");
    expect(getDefaultCategoryForSection("agent")).toBe("compaction");
    expect(getDefaultCategoryForSection("tools")).toBe("permissions");
    expect(getDefaultCategoryForSection("workbench")).toBe("startup");
    expect(getDefaultCategoryForSection("visibility")).toBe("approvalPresentation");
    expect(isSettingsCategoryInSection("basic", "appearance")).toBe(true);
    expect(isSettingsCategoryInSection("basic", "startup")).toBe(false);
    expect(isSettingsCategoryInSection("basic", "profiles")).toBe(false);
    expect(isSettingsCategoryInSection("model", "profiles")).toBe(true);
    expect(isSettingsCategoryInSection("model", "connection")).toBe(true);
    expect(isSettingsCategoryInSection("model", "context")).toBe(true);
    expect(isSettingsCategoryInSection("model", "reasoning")).toBe(true);
    expect(isSettingsCategoryInSection("model", "appearance")).toBe(false);
    expect(isSettingsCategoryInSection("agent", "compaction")).toBe(true);
    expect(isSettingsCategoryInSection("tools", "toolAccess")).toBe(true);
    expect(isSettingsCategoryInSection("tools", "commandLimits")).toBe(true);
    expect(isSettingsCategoryInSection("workbench", "modelDefaults")).toBe(true);
    expect(isSettingsCategoryInSection("visibility", "approvalPresentation")).toBe(true);
  });

  it("serializes the closed Inspector default as a select value", () => {
    expect(toDefaultInspectorModeValue(null)).toBe("closed");
    expect(toDefaultInspectorModeValue("changes")).toBe("changes");
    expect(toDefaultInspectorMode("closed")).toBeNull();
    expect(toDefaultInspectorMode("todo")).toBe("todo");
    expect(toDefaultInspectorMode("unknown")).toBeNull();
  });

  it("filters settings sidebar items by label, description, or id", () => {
    const items = [
      {
        id: "appearance" as const,
        label: "Appearance",
        description: "Language and theme",
        marker: "01",
      },
      {
        id: "context" as const,
        label: "Context",
        description: "Token windows",
        marker: "02",
      },
    ];

    expect(filterSettingsSidebarItems(items, "theme").map((item) => item.id))
      .toEqual(["appearance"]);
    expect(filterSettingsSidebarItems(items, "context").map((item) => item.id))
      .toEqual(["context"]);
    expect(filterSettingsSidebarItems(items, "missing")).toEqual([]);
    expect(filterSettingsSidebarItems(items, " ")).toEqual(items);
  });

  it("validates model token limits before submitting to IPC", () => {
    expect(validateModelSettingsForm(modelForm(), DEFAULT_MODEL_CONFIG, testT)).toBeNull();
    expect(validateModelSettingsForm(
      modelForm({ model_context_window: "abc" }),
      DEFAULT_MODEL_CONFIG,
      testT,
    )).toBe("Context window must be a positive whole number.");
    expect(validateModelSettingsForm(
      modelForm({
        model_context_window: "100",
        model_auto_compact_token_limit: "101",
      }),
      DEFAULT_MODEL_CONFIG,
      testT,
    )).toBe("Auto compact limit must fit in context.");
    expect(validateModelSettingsForm(
      modelForm({
        model_context_window: "100",
        model_auto_compact_token_limit: "90",
        max_tokens: "100",
      }),
      DEFAULT_MODEL_CONFIG,
      testT,
    )).toBe("Max output tokens must stay below context.");
  });

  it("includes the selected protocol in model profile update payloads", () => {
    expect(toUpdatePayload(modelForm({ protocol: "anthropic-compatible" })))
      .toMatchObject({ protocol: "anthropic-compatible" });
  });

  it("validates command-limit drafts before runtime preference updates", () => {
    expect(validateRuntimeCommandDraft("timeoutMs", "", testT))
      .toEqual({ ok: true, value: null });
    expect(validateRuntimeCommandDraft("timeoutMs", "45000", testT))
      .toEqual({ ok: true, value: 45000 });
    expect(validateRuntimeCommandDraft("timeoutMs", "1.5", testT))
      .toEqual({
        ok: false,
        message: "Command timeout must be a positive whole number.",
      });
    expect(validateRuntimeCommandDraft("timeoutMs", "10", testT))
      .toEqual({
        ok: false,
        message: `Command timeout must be between ${MIN_RUNTIME_COMMAND_TIMEOUT_MS} and ${MAX_RUNTIME_COMMAND_TIMEOUT_MS}.`,
      });
  });
});

function modelForm(overrides: Partial<SettingsFormState> = {}): SettingsFormState {
  return {
    model_provide: "MiniMax",
    model: "MiniMax-M3",
    protocol: "openai-compatible",
    base_url: "https://api.minimaxi.com/v1",
    OPENAI_API_KEY: "",
    model_context_window: "1000",
    model_auto_compact_token_limit: "900",
    max_tokens: "200",
    thinking: true,
    model_reasoning_effort: "medium",
    agent_autonomy: "balanced",
    ...overrides,
  };
}

function testT(key: string, options?: Record<string, unknown>): string {
  if (key === "settings.fields.contextWindow") return "Context window";
  if (key === "settings.fields.compactLimit") return "Auto compact limit";
  if (key === "settings.fields.maxTokens") return "Max output tokens";
  if (key === "settings.fields.commandTimeout") return "Command timeout";
  if (key === "settings.fields.commandMaxOutput") return "Command output limit";
  if (key === "settings.errors.positiveInteger") {
    return `${String(options?.field)} must be a positive whole number.`;
  }
  if (key === "settings.errors.integerRange") {
    return `${String(options?.field)} must be between ${String(options?.min)} and ${String(options?.max)}.`;
  }
  if (key === "settings.errors.compactLimitTooLarge") {
    return "Auto compact limit must fit in context.";
  }
  if (key === "settings.errors.maxTokensTooLarge") {
    return "Max output tokens must stay below context.";
  }
  return key;
}
