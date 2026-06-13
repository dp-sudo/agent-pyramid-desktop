import { describe, expect, it } from "vitest";
import {
  canSubmitModelSettingsSection,
  clearDeletedDefaultProfileReferences,
  formatSkillTriggerSummary,
  formatMcpStartupStats,
  getDefaultCategoryForSection,
  getFirstVisibleSettingsCategoryForSection,
  isProfileDeletePending,
  isSettingsCategoryInSection,
  mergeRuntimePreferencesUpdates,
  messageOfUnknownError,
  parseRuntimeSkillsExtraRootsDraft,
  parseMcpServerStringRecordDraft,
  prunePendingProfileDeleteId,
  resolveRuntimePreferencesAfterProfileActivationRefreshFailure,
  shouldAllowSettingsCategorySelection,
  shouldBlockSettingsNavigation,
  shouldDisableModelProfileControls,
  shouldDisableRuntimePreferenceControls,
  toDefaultInspectorMode,
  toDefaultInspectorModeValue,
  toUpdatePayload,
  validateCodeBlockCollapseLineThreshold,
  validateModelSettingsForm,
  validateRuntimeCommandDraft,
  validateRuntimeSkillsNumericDraft,
  type SettingsFormState,
} from "../../src/renderer/src/ui/SettingsView";
import {
  filterSettingsSidebarItems,
  getSettingsCategorySearchKeywords,
  isSettingsCategoryAdvanced,
} from "../../src/renderer/src/ui/components/settings/settings-search";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_PREFERENCES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
  RUNTIME_TOOL_NAMES,
  type McpServerConfig,
  type RuntimeSkillCatalogEntry,
} from "../../src/shared/agent-contracts";

describe("SettingsView helpers", () => {
  it("tracks inline delete confirmation for a single profile", () => {
    expect(isProfileDeletePending("profile-1", "profile-1")).toBe(true);
    expect(isProfileDeletePending("profile-1", "profile-2")).toBe(false);
    expect(isProfileDeletePending(null, "profile-1")).toBe(false);
  });

  it("clears stale profile delete confirmation when the profile disappears", () => {
    expect(
      prunePendingProfileDeleteId("profile-1", [
        { id: "profile-1" },
        { id: "profile-2" },
      ]),
    ).toBe("profile-1");
    expect(prunePendingProfileDeleteId("profile-3", [{ id: "profile-1" }])).toBeNull();
    expect(prunePendingProfileDeleteId(null, [{ id: "profile-1" }])).toBeNull();
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

  it("blocks Settings category changes while model profile edits are unsaved", () => {
    expect(
      shouldAllowSettingsCategorySelection("connection", "context", "dirty"),
    ).toBe(false);
    expect(
      shouldAllowSettingsCategorySelection("connection", "context", "error", true),
    ).toBe(false);
    expect(
      shouldAllowSettingsCategorySelection("connection", "connection", "dirty"),
    ).toBe(true);
    expect(
      shouldAllowSettingsCategorySelection("connection", "context", "error", false),
    ).toBe(true);
    expect(
      shouldAllowSettingsCategorySelection("connection", "context", "saved"),
    ).toBe(true);
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
    expect(isSettingsCategoryInSection("agent", "skills")).toBe(true);
    expect(isSettingsCategoryInSection("tools", "skills")).toBe(false);
    expect(isSettingsCategoryInSection("tools", "toolAccess")).toBe(true);
    expect(isSettingsCategoryInSection("tools", "commandLimits")).toBe(true);
    expect(isSettingsCategoryInSection("workbench", "modelDefaults")).toBe(true);
    expect(isSettingsCategoryInSection("workbench", "attachments")).toBe(true);
    expect(isSettingsCategoryInSection("basic", "attachments")).toBe(false);
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
        searchKeywords: ["Interface language", "Follow system theme"],
      },
      {
        id: "context" as const,
        label: "Context",
        description: "Token windows",
        marker: "02",
        advanced: true,
        searchKeywords: ["Maximum context tokens", "Auto compact limit"],
      },
    ];

    expect(filterSettingsSidebarItems(items, "theme").map((item) => item.id))
      .toEqual(["appearance"]);
    expect(filterSettingsSidebarItems(items, "context").map((item) => item.id))
      .toEqual(["context"]);
    expect(filterSettingsSidebarItems(items, "compact").map((item) => item.id))
      .toEqual(["context"]);
    expect(filterSettingsSidebarItems(items, "missing")).toEqual([]);
    expect(filterSettingsSidebarItems(items, " ")).toEqual(items);
    expect(
      filterSettingsSidebarItems(items, "compact", { showAdvanced: false }),
    ).toEqual([]);
    expect(
      filterSettingsSidebarItems(items, " ", { showAdvanced: false })
        .map((item) => item.id),
    ).toEqual(["appearance"]);
  });

  it("derives tool access search keywords from the shared runtime tool catalog", () => {
    const toolKeywords = getSettingsCategorySearchKeywords("toolAccess", (key) => key)
      .filter((key) => key.startsWith("settings.toolNames."))
      .sort();

    expect(toolKeywords).toEqual(
      RUNTIME_TOOL_NAMES.map((toolName) => `settings.toolNames.${toolName}`).sort(),
    );
  });

  it("identifies advanced Settings categories and keeps safe fallbacks visible", () => {
    expect(isSettingsCategoryAdvanced("context")).toBe(true);
    expect(isSettingsCategoryAdvanced("skills")).toBe(true);
    expect(isSettingsCategoryAdvanced("toolAccess")).toBe(true);
    expect(isSettingsCategoryAdvanced("profiles")).toBe(false);
    expect(getFirstVisibleSettingsCategoryForSection("model", false)).toBe("profiles");
    expect(getFirstVisibleSettingsCategoryForSection("tools", false)).toBe("permissions");
    expect(getFirstVisibleSettingsCategoryForSection("tools", true)).toBe("permissions");
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

  it("submits only model configuration categories through the Settings form", () => {
    expect(canSubmitModelSettingsSection("model", "connection")).toBe(true);
    expect(canSubmitModelSettingsSection("model", "context")).toBe(true);
    expect(canSubmitModelSettingsSection("model", "reasoning")).toBe(true);
    expect(canSubmitModelSettingsSection("model", "profiles")).toBe(false);
    expect(canSubmitModelSettingsSection("tools", "commandLimits")).toBe(false);
    expect(canSubmitModelSettingsSection("workbench", "modelDefaults")).toBe(false);
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

  it("validates skill runtime drafts before runtime preference updates", () => {
    expect(validateRuntimeSkillsNumericDraft("activeLimit", "", testT))
      .toEqual({ ok: true, value: null });
    expect(validateRuntimeSkillsNumericDraft("activeLimit", "0", testT))
      .toEqual({ ok: true, value: 0 });
    expect(validateRuntimeSkillsNumericDraft("activeLimit", "2.5", testT))
      .toEqual({
        ok: false,
        message: "Active skill limit must be a non-negative whole number.",
      });
    expect(validateRuntimeSkillsNumericDraft(
      "activeLimit",
      String(MAX_RUNTIME_SKILLS_ACTIVE_LIMIT + 1),
      testT,
    )).toEqual({
      ok: false,
      message: `Active skill limit must be between ${MIN_RUNTIME_SKILLS_ACTIVE_LIMIT} and ${MAX_RUNTIME_SKILLS_ACTIVE_LIMIT}.`,
    });
    expect(parseRuntimeSkillsExtraRootsDraft(
      " .agent/skills \n\nshared-skills\n.agent/skills",
      testT,
    )).toEqual({ ok: true, value: [".agent/skills", "shared-skills"] });
    expect(parseRuntimeSkillsExtraRootsDraft("ok\nbad\0root", testT))
      .toEqual({
        ok: false,
        message: "Skill root line 2 cannot contain NUL bytes.",
      });
  });

  it("formats skill catalog trigger summaries", () => {
    const skill: RuntimeSkillCatalogEntry = {
      id: "project/review",
      name: "Review",
      description: "Review current changes.",
      version: "1.0.0",
      runAs: "inline",
      scope: "project",
      priority: 100,
      rootDir: "/workspace/.agent/skills/review",
      skillPath: "/workspace/.agent/skills/review/SKILL.md",
      allowedTools: ["read_file"],
      trigger: {
        manual: true,
        commands: ["/review"],
        keywords: ["review"],
        promptPatterns: ["audit"],
        fileTypes: [".ts"],
      },
      referenceCount: 0,
      referenceNames: [],
    };

    expect(formatSkillTriggerSummary(skill, testT)).toBe(
      "Manual · Commands: /review · Keywords: review · Prompt patterns: audit · File types: .ts",
    );
    expect(formatSkillTriggerSummary({
      ...skill,
      trigger: {
        manual: false,
        commands: [],
        keywords: [],
        promptPatterns: [],
        fileTypes: [],
      },
    }, testT)).toBe("No automatic triggers");
  });

  it("validates code block fold threshold drafts before saving local preferences", () => {
    expect(validateCodeBlockCollapseLineThreshold("24", testT))
      .toEqual({ ok: true, value: 24 });
    expect(validateCodeBlockCollapseLineThreshold("", testT))
      .toEqual({
        ok: false,
        message: "Code block fold line count must be a positive whole number.",
      });
    expect(validateCodeBlockCollapseLineThreshold("201", testT))
      .toEqual({
        ok: false,
        message: "Code block fold line count must be between 1 and 200.",
      });
  });

  it("disables runtime preference controls when IPC is unavailable or saving", () => {
    expect(shouldDisableRuntimePreferenceControls(false, "idle")).toBe(true);
    expect(shouldDisableRuntimePreferenceControls(true, "loading")).toBe(true);
    expect(shouldDisableRuntimePreferenceControls(true, "saving")).toBe(true);
    expect(shouldDisableRuntimePreferenceControls(true, "idle")).toBe(false);
    expect(shouldDisableRuntimePreferenceControls(true, "saved")).toBe(false);
    expect(shouldDisableRuntimePreferenceControls(true, "error")).toBe(false);
  });

  it("merges queued runtime preference updates without dropping nested controls", () => {
    const mcpServer: McpServerConfig = {
      id: "server-1",
      name: "local-mcp",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      headers: {},
      enabled: false,
      readOnlyTools: [],
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };
    const first = mergeRuntimePreferencesUpdates(null, {
      toolAvailability: {
        code: { run_command: false },
      },
      approvalExperience: { showDiffByDefault: false },
      command: { timeoutMs: 45_000 },
      compaction: { enabled: false },
      skills: { activeLimit: 2, extraRoots: ["project-skills"] },
      permissionRules: [
        { id: "ask-tests", tool: "command", pattern: "npm test*", effect: "ask" },
      ],
      mcpServers: [mcpServer],
    });

    expect(mergeRuntimePreferencesUpdates(first, {
      defaultApprovalPolicy: "never",
      toolAvailability: {
        code: { apply_patch: false },
        write: { read_file: false },
      },
      approvalExperience: { autoScrollOnRequest: false },
      command: { maxOutputBytes: 65_536 },
      compaction: { strategy: "aggressive" },
      skills: {
        instructionBudgetBytes: 48_000,
        extraRoots: ["project-skills", "shared-skills"],
      },
      permissionRules: [
        { id: "deny-src", tool: "write", pattern: "src/*", effect: "deny" },
      ],
      mcpServers: [{ ...mcpServer, enabled: true }],
    })).toEqual({
      defaultApprovalPolicy: "never",
      toolAvailability: {
        code: { run_command: false, apply_patch: false },
        write: { read_file: false },
      },
      approvalExperience: {
        showDiffByDefault: false,
        autoScrollOnRequest: false,
      },
      command: {
        timeoutMs: 45_000,
        maxOutputBytes: 65_536,
      },
      compaction: {
        enabled: false,
        strategy: "aggressive",
      },
      skills: {
        activeLimit: 2,
        instructionBudgetBytes: 48_000,
        extraRoots: ["project-skills", "shared-skills"],
      },
      permissionRules: [
        { id: "deny-src", tool: "write", pattern: "src/*", effect: "deny" },
      ],
      mcpServers: [{ ...mcpServer, enabled: true }],
    });
  });

  it("parses MCP JSON drafts for env and headers", () => {
    expect(parseMcpServerStringRecordDraft(
      "{\"Authorization\":\"Bearer test\"}",
      testT,
      "headers",
    )).toEqual({ ok: true, value: { Authorization: "Bearer test" } });
    expect(parseMcpServerStringRecordDraft("", testT, "env"))
      .toEqual({ ok: true, value: {} });
    expect(parseMcpServerStringRecordDraft("[]", testT, "headers"))
      .toEqual({ ok: false, message: "Headers JSON must be an object." });
    expect(parseMcpServerStringRecordDraft("{bad", testT, "env"))
      .toEqual({ ok: false, message: "Environment must be valid JSON." });
  });

  it("formats MCP startup stats only when runtime observations exist", () => {
    const baseStatus = {
      id: "server-1",
      name: "local-mcp",
      transport: "stdio" as const,
      enabled: true,
      status: "connected" as const,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    };

    expect(formatMcpStartupStats(baseStatus, testT)).toBeNull();
    expect(formatMcpStartupStats({
      ...baseStatus,
      lastStartupDurationMs: 42,
      startupSuccessCount: 2,
      startupFailureCount: 1,
    }, testT)).toBe("Last startup 42 ms, 2 ok, 1 failed");
  });

  it("lets later queued runtime preference updates override the same field", () => {
    expect(mergeRuntimePreferencesUpdates({
      defaultSandboxMode: "read-only",
      toolAvailability: {
        code: { run_command: false },
      },
    }, {
      defaultSandboxMode: "danger-full-access",
      toolAvailability: {
        code: { run_command: true },
      },
    })).toEqual({
      defaultSandboxMode: "danger-full-access",
      toolAvailability: {
        code: { run_command: true },
        write: {},
      },
    });
  });

  it("disables model profile controls while profile state can be overwritten", () => {
    expect(shouldDisableModelProfileControls(false, "idle", "")).toBe(true);
    expect(shouldDisableModelProfileControls(true, "loading", "")).toBe(true);
    expect(shouldDisableModelProfileControls(true, "saving", "")).toBe(true);
    expect(shouldDisableModelProfileControls(true, "idle", "profile-1")).toBe(true);
    expect(shouldDisableModelProfileControls(true, "dirty", "")).toBe(false);
    expect(shouldDisableModelProfileControls(true, "error", "")).toBe(false);
  });

  it("keeps rejected runtime preference IPC errors traceable", () => {
    expect(messageOfUnknownError(new Error("IPC channel failed"))).toBe("IPC channel failed");
    expect(messageOfUnknownError("renderer bridge unavailable")).toBe(
      "renderer bridge unavailable",
    );
  });

  it("clears local default profile references after deleting a model profile", () => {
    const preferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      codeDefaultModelProfileId: "code-profile",
      writeDefaultModelProfileId: "write-profile",
    };

    expect(clearDeletedDefaultProfileReferences(preferences, "write-profile"))
      .toEqual({
        ...preferences,
        writeDefaultModelProfileId: null,
      });
    expect(clearDeletedDefaultProfileReferences(preferences, "code-profile"))
      .toEqual({
        ...preferences,
        codeDefaultModelProfileId: null,
      });
    expect(clearDeletedDefaultProfileReferences(preferences, "other-profile"))
      .toBe(preferences);
  });

  it("keeps default profile references when activation refresh cannot reload runtime preferences", () => {
    const preferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      codeDefaultModelProfileId: "code-profile",
      writeDefaultModelProfileId: "write-profile",
    };

    expect(resolveRuntimePreferencesAfterProfileActivationRefreshFailure(preferences))
      .toBe(preferences);
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
  if (key === "settings.fields.skillsActiveLimit") return "Active skill limit";
  if (key === "settings.fields.skillsInstructionBudgetBytes") {
    return "Instruction budget bytes";
  }
  if (key === "settings.fields.codeBlockCollapseLineThreshold") {
    return "Code block fold line count";
  }
  if (key === "settings.errors.positiveInteger") {
    return `${String(options?.field)} must be a positive whole number.`;
  }
  if (key === "settings.errors.nonNegativeInteger") {
    return `${String(options?.field)} must be a non-negative whole number.`;
  }
  if (key === "settings.errors.integerRange") {
    return `${String(options?.field)} must be between ${String(options?.min)} and ${String(options?.max)}.`;
  }
  if (key === "settings.errors.skillsExtraRootNul") {
    return `Skill root line ${String(options?.index)} cannot contain NUL bytes.`;
  }
  if (key === "settings.skills.manualTrigger") return "Manual";
  if (key === "settings.skills.commands") return `Commands: ${String(options?.values)}`;
  if (key === "settings.skills.keywords") return `Keywords: ${String(options?.values)}`;
  if (key === "settings.skills.promptPatterns") {
    return `Prompt patterns: ${String(options?.values)}`;
  }
  if (key === "settings.skills.fileTypes") return `File types: ${String(options?.values)}`;
  if (key === "settings.skills.noTriggers") return "No automatic triggers";
  if (key === "settings.errors.compactLimitTooLarge") {
    return "Auto compact limit must fit in context.";
  }
  if (key === "settings.errors.maxTokensTooLarge") {
    return "Max output tokens must stay below context.";
  }
  if (key === "settings.errors.mcpHeadersObject") {
    return "Headers JSON must be an object.";
  }
  if (key === "settings.errors.mcpEnvJson") {
    return "Environment must be valid JSON.";
  }
  if (key === "settings.mcpServers.startupStats") {
    return `Last startup ${String(options?.duration)} ms, ${String(options?.successes)} ok, ${String(options?.failures)} failed`;
  }
  return key;
}
