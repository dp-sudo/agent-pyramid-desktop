import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type LocaleCode,
} from "../../../shared/locale";
import {
  AGENT_AUTONOMY_LEVELS,
  DEFAULT_DEEPSEEK_MODEL_CONFIG,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
  DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  type IpcResult,
  LLM_PROTOCOLS,
  MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MCP_SERVER_TRANSPORTS,
  MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
  MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MODEL_REASONING_EFFORTS,
  RUNTIME_COMPACTION_STRATEGIES,
  RUNTIME_PERMISSION_RULE_EFFECTS,
  RUNTIME_PERMISSION_RULE_TOOLS,
  RUNTIME_TOOL_NAMES,
  THREAD_APPROVAL_POLICIES,
  THREAD_SANDBOX_MODES,
  type McpServerConfig,
  type McpServerConfigUpdate,
  type McpServerStatusRecord,
  type McpServerTransport,
  type AgentAutonomyLevel,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfilesState,
  type ModelReasoningEffort,
  type RuntimeCompactionStrategy,
  type RuntimePermissionRule,
  type RuntimePermissionRuleEffect,
  type RuntimePermissionRuleTool,
  type RuntimePreferences,
  type RuntimePreferencesUpdate,
  type RuntimeEvent,
  type RuntimeToolName,
  type RuntimeSkillCatalogEntry,
  type SkillListResponse,
  type SseSubscribeGlobalResponse,
  type SseUnsubscribeGlobalResponse,
  type ThreadApprovalPolicy,
  type ThreadSandboxMode,
} from "../../../shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../../shared/ipc-errors";
import { useWorkbench } from "./store/WorkbenchContext";
import {
  SecretInput,
  SettingRow,
  SettingsCard,
  StatusBadge,
  Toggle,
} from "./components/settings/SettingsControls";
import {
  DEFAULT_INSPECTOR_MODES,
  STARTUP_VIEWS,
  isDefaultStartupViewSetting,
  toDefaultInspectorMode,
  toDefaultInspectorModeValue,
  validateCodeBlockCollapseLineThreshold,
} from "./settings-basic-preferences-model";
import {
  SettingsSidebar,
  type SettingsCategory,
  type SettingsSidebarItem,
} from "./components/settings/SettingsSidebar";
import {
  filterSettingsSidebarItems,
  isSettingsCategoryAdvanced,
} from "./components/settings/settings-search";
import {
  canSubmitModelSettingsSection,
  getDefaultCategoryForSection,
  getFirstVisibleSettingsCategoryForSection,
  getSettingsNavItems,
  getSettingsSectionItems,
  type SettingsSection,
  type SettingsSectionItem,
} from "./settings-navigation-model";
import {
  createCustomModelConfig,
  findActiveProfile,
  isLlmProtocolSetting,
  toFormState,
  toUpdatePayload,
  validateModelSettingsForm,
  type SettingsFormState,
} from "./settings-model-config-model";
import {
  createDefaultMcpServer,
  createUniqueMcpServerName,
  formatMcpStartupStats,
  mcpServerConnectionLabel,
  updateMcpServerConfigs,
} from "./settings-mcp-model";
import {
  parseMcpServerEnvDraft,
  parseMcpServerStringRecordDraft,
  parseRuntimeSkillsExtraRootsDraft,
  splitCommaList,
  splitWhitespaceList,
  validateRuntimeCommandDraft,
  validateRuntimeSkillsNumericDraft,
  type RuntimeCommandDraftField,
  type RuntimeSkillsDraftField,
  type SettingsTranslator,
} from "./settings-runtime-model";
import {
  arraysEqual,
  clearDeletedDefaultProfileReferences,
  createDefaultPermissionRule,
  formatRuntimeSkillsExtraRoots,
  mergeRuntimePreferencesUpdates,
  resolveRuntimePreferencesAfterProfileActivationRefreshFailure,
  shouldDisableRuntimePreferenceControls,
  toPermissionRulePatternDrafts,
  toRuntimeCommandDraft,
  toRuntimeSkillsDraft,
  type RuntimeCommandDraft,
  type RuntimeSaveState,
  type RuntimeSkillsDraft,
} from "./settings-runtime-preferences-model";
import {
  emptyStringToNullableProfileId,
  hasUnsavedProfileChanges,
  isProfileDeletePending,
  prunePendingProfileDeleteId,
  shouldAllowSettingsCategorySelection,
  shouldBlockSettingsNavigation,
  shouldDisableModelProfileControls,
  type SaveState,
} from "./settings-view-state-model";
import { i18n, persistLocale, setFollowSystemTheme, setTheme } from "../i18n";
import {
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
  type ThemePreference,
} from "./preferences";

type SettingsSseApi = {
  subscribeGlobal(): Promise<IpcResult<SseSubscribeGlobalResponse>>;
  unsubscribeGlobal(): Promise<IpcResult<SseUnsubscribeGlobalResponse>>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
};
type RuntimePermissionRuleEditableField = "tool" | "pattern" | "effect";
const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark"];

export function SettingsView(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const preferences = state.basicPreferences;
  const [section, setSection] = useState<SettingsSection>("basic");
  const [category, setCategory] = useState<SettingsCategory>("appearance");
  const [locale, setLocale] = useState<LocaleCode>(() => {
    const currentLocale = i18n.language;
    return isSettingsLocale(currentLocale) ? currentLocale : DEFAULT_LOCALE;
  });
  const [form, setForm] = useState<SettingsFormState>(() =>
    toFormState(DEFAULT_MODEL_CONFIG),
  );
  const [profileName, setProfileName] = useState(DEFAULT_MODEL_CONFIG.model_provide);
  const [profilesState, setProfilesState] = useState<ModelConfigProfilesState | null>(
    null,
  );
  const [runtimePreferences, setRuntimePreferences] = useState<RuntimePreferences>(
    state.runtimePreferences,
  );
  const [mcpServerStatuses, setMcpServerStatuses] = useState<
    Record<string, McpServerStatusRecord>
  >({});
  const [commandDraft, setCommandDraft] = useState<RuntimeCommandDraft>(() =>
    toRuntimeCommandDraft(state.runtimePreferences.command),
  );
  const [skillsDraft, setSkillsDraft] = useState<RuntimeSkillsDraft>(() =>
    toRuntimeSkillsDraft(state.runtimePreferences.skills),
  );
  const [skillCatalog, setSkillCatalog] = useState<SkillListResponse | null>(null);
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false);
  const [skillCatalogError, setSkillCatalogError] = useState("");
  const [permissionRulePatternDrafts, setPermissionRulePatternDrafts] = useState<
    Record<string, string>
  >({});
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [runtimeSaveState, setRuntimeSaveState] = useState<RuntimeSaveState>("loading");
  const [error, setError] = useState<string>("");
  const [runtimeError, setRuntimeError] = useState<string>("");
  const [profileBusy, setProfileBusy] = useState<string>("");
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [settingsSearch, setSettingsSearch] = useState("");
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [basicPreferenceError, setBasicPreferenceError] = useState("");
  const [codeBlockThresholdDraft, setCodeBlockThresholdDraft] = useState(() =>
    String(state.basicPreferences.codeBlockCollapseLineThreshold),
  );
  const runtimeSaveInProgressRef = useRef(false);
  const pendingRuntimePreferencesUpdateRef = useRef<RuntimePreferencesUpdate | null>(null);

  const activeProfile = profilesState ? findActiveProfile(profilesState) : null;
  const hasAgentApi = Boolean(window.agentApi);
  const profileHasUnsavedChanges = hasUnsavedProfileChanges(
    activeProfile,
    profileName,
    form,
  );
  const settingsSectionItems = useMemo<SettingsSectionItem[]>(
    () => getSettingsSectionItems(t),
    [t],
  );
  const settingsNavItems = useMemo<SettingsSidebarItem[]>(
    () => getSettingsNavItems(section, t),
    [section, t],
  );
  const visibleSettingsNavItems = useMemo(
    () => filterSettingsSidebarItems(
      settingsNavItems,
      settingsSearch,
      { showAdvanced: showAdvancedSettings },
    ),
    [settingsNavItems, settingsSearch, showAdvancedSettings],
  );
  const sidebarFooterTitle = t(`settings.sidebarFooter.${section}Title`);
  const sidebarFooterDescription = t(`settings.sidebarFooter.${section}Description`);
  const settingsSubtitle = t(`settings.subtitles.${section}`);
  const runtimeControlsDisabled = shouldDisableRuntimePreferenceControls(
    hasAgentApi,
    runtimeSaveState,
  );
  const modelProfileControlsDisabled = shouldDisableModelProfileControls(
    hasAgentApi,
    saveState,
    profileBusy,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!window.agentApi) {
        setSaveState("error");
        setError(i18n.t("settings.preloadMissing"));
        return;
      }
      let profilesResult: Awaited<ReturnType<typeof window.agentApi.modelConfig.listProfiles>>;
      let runtimePreferencesResult: Awaited<
        ReturnType<typeof window.agentApi.runtimePreferences.get>
      >;
      try {
        [profilesResult, runtimePreferencesResult] = await Promise.all([
          window.agentApi.modelConfig.listProfiles(),
          window.agentApi.runtimePreferences.get(),
        ]);
      } catch (loadError) {
        if (cancelled) return;
        const message = messageOfUnknownError(loadError);
        setSaveState("error");
        setError(message);
        setRuntimeSaveState("error");
        setRuntimeError(message);
        return;
      }
      if (cancelled) return;
      if (profilesResult.ok) {
        applyProfilesState(profilesResult.value);
        setSaveState("idle");
      } else {
        setSaveState("error");
        setError(profilesResult.message);
      }
      if (runtimePreferencesResult.ok) {
        applyRuntimePreferences(runtimePreferencesResult.value);
        setRuntimeSaveState("idle");
      } else {
        setRuntimeSaveState("error");
        setRuntimeError(runtimePreferencesResult.message);
      }
      await refreshMcpServerStatuses(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

  useEffect(() => {
    if (!window.agentApi) return undefined;
    return subscribeSettingsGlobalRuntimeEvents(
      window.agentApi.sse,
      (event) => {
        if (
          event.kind === "mcp_server_connection" ||
          event.kind === "mcp_tool_list_changed" ||
          event.kind === "mcp_surface_changed"
        ) {
          void refreshMcpServerStatuses(false);
        }
      },
      (message) => {
        setRuntimeSaveState("error");
        setRuntimeError(message);
      },
    );
  }, []);

  useEffect(() => {
    if (!shouldBlockSettingsNavigation(saveState, profileHasUnsavedChanges)) {
      return undefined;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [profileHasUnsavedChanges, saveState]);

  useEffect(() => {
    setPendingDeleteProfileId((current) =>
      prunePendingProfileDeleteId(current, profilesState?.profiles ?? []),
    );
  }, [profilesState?.profiles]);

  useEffect(() => {
    setCodeBlockThresholdDraft(String(preferences.codeBlockCollapseLineThreshold));
  }, [preferences.codeBlockCollapseLineThreshold]);

  useEffect(() => {
    if (section !== "agent" || category !== "skills") return;
    void refreshSkillCatalog(false);
  }, [
    category,
    runtimePreferences.skills.activeLimit,
    runtimePreferences.skills.enabled,
    runtimePreferences.skills.extraRoots,
    runtimePreferences.skills.instructionBudgetBytes,
    section,
    state.workspaceRoot,
  ]);

  function applyProfilesState(state: ModelConfigProfilesState): void {
    const active = findActiveProfile(state);
    setProfilesState(state);
    if (active) {
      setProfileName(active.name);
      setForm(toFormState(active.config));
      actions.setModelConfig(active.config);
      actions.setModelProfiles(state);
    }
  }

  function applyRuntimePreferences(preferences: RuntimePreferences): void {
    setRuntimePreferences(preferences);
    setCommandDraft(toRuntimeCommandDraft(preferences.command));
    setSkillsDraft(toRuntimeSkillsDraft(preferences.skills));
    setPermissionRulePatternDrafts(toPermissionRulePatternDrafts(preferences.permissionRules));
    actions.setRuntimePreferences(preferences);
  }

  function updateText(
    field: keyof Omit<
      SettingsFormState,
      "thinking" | "model_reasoning_effort" | "agent_autonomy"
    >,
  ): (event: ChangeEvent<HTMLInputElement>) => void {
    return (event) => {
      markDirty();
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };
  }

  function updateSecret(value: string): void {
    markDirty();
    setForm((current) => ({ ...current, OPENAI_API_KEY: value }));
  }

  function updateProfileName(value: string): void {
    markDirty();
    setProfileName(value);
  }

  function updateProtocol(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value;
    if (!isLlmProtocolSetting(value)) return;
    markDirty();
    setForm((current) => ({ ...current, protocol: value }));
  }

  function updateThinking(checked: boolean): void {
    markDirty();
    setForm((current) => ({ ...current, thinking: checked }));
  }

  function updateEffort(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as ModelReasoningEffort;
    markDirty();
    setForm((current) => ({ ...current, model_reasoning_effort: value }));
  }

  function updateAutonomy(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as AgentAutonomyLevel;
    markDirty();
    setForm((current) => ({ ...current, agent_autonomy: value }));
  }

  function updateLocale(event: ChangeEvent<HTMLSelectElement>): void {
    const nextLocale = event.target.value;
    if (!isSettingsLocale(nextLocale)) return;
    setLocale(nextLocale);
    persistLocale(nextLocale);
    void i18n.changeLanguage(nextLocale);
  }

  function updateThemePreference(theme: ThemePreference): void {
    actions.updateBasicPreference("theme", theme);
    actions.updateBasicPreference("followSystemTheme", false);
    setTheme(theme);
  }

  function updateFollowSystemTheme(enabled: boolean): void {
    actions.updateBasicPreference("followSystemTheme", enabled);
    setFollowSystemTheme(enabled);
  }

  function updateStartupView(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value;
    if (!isDefaultStartupViewSetting(value)) return;
    actions.updateBasicPreference("defaultStartupView", value);
  }

  function updateDefaultInspectorMode(event: ChangeEvent<HTMLSelectElement>): void {
    const value = toDefaultInspectorMode(event.target.value);
    actions.updateBasicPreference("defaultInspectorMode", value);
  }

  function commitCodeBlockThresholdDraft(raw = codeBlockThresholdDraft): void {
    const validation = validateCodeBlockCollapseLineThreshold(raw, t);
    if (!validation.ok) {
      setBasicPreferenceError(validation.message);
      return;
    }
    setBasicPreferenceError("");
    setCodeBlockThresholdDraft(String(validation.value));
    if (validation.value !== preferences.codeBlockCollapseLineThreshold) {
      actions.updateBasicPreference("codeBlockCollapseLineThreshold", validation.value);
    }
  }

  function resetCodeBlockThresholdDraft(): void {
    setCodeBlockThresholdDraft(String(preferences.codeBlockCollapseLineThreshold));
    setBasicPreferenceError("");
  }

  function handleCodeBlockThresholdKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCodeBlockThresholdDraft(event.currentTarget.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetCodeBlockThresholdDraft();
    }
  }

  async function updateRuntimePreferences(update: RuntimePreferencesUpdate): Promise<void> {
    if (!window.agentApi) {
      setRuntimeSaveState("error");
      setRuntimeError(i18n.t("settings.preloadMissing"));
      return;
    }
    if (runtimeSaveInProgressRef.current) {
      pendingRuntimePreferencesUpdateRef.current = mergeRuntimePreferencesUpdates(
        pendingRuntimePreferencesUpdateRef.current,
        update,
      );
      return;
    }
    runtimeSaveInProgressRef.current = true;
    setRuntimeSaveState("saving");
    setRuntimeError("");
    try {
      const result = await window.agentApi.runtimePreferences.update(update);
      if (!result.ok) {
        setRuntimeSaveState("error");
        setRuntimeError(result.message);
        return;
      }
      applyRuntimePreferences(result.value);
      setRuntimeSaveState("saved");
    } catch (updateError) {
      setRuntimeSaveState("error");
      setRuntimeError(messageOfUnknownError(updateError));
    } finally {
      runtimeSaveInProgressRef.current = false;
      const pendingUpdate = pendingRuntimePreferencesUpdateRef.current;
      pendingRuntimePreferencesUpdateRef.current = null;
      if (pendingUpdate) {
        void updateRuntimePreferences(pendingUpdate);
      }
    }
  }

  function updateRuntimeToolAvailability(
    mode: "code" | "write",
    toolName: RuntimeToolName,
    enabled: boolean,
  ): void {
    void updateRuntimePreferences({
      toolAvailability: { [mode]: { [toolName]: enabled } },
    });
  }

  function updateDefaultApprovalPolicy(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as ThreadApprovalPolicy;
    void updateRuntimePreferences({ defaultApprovalPolicy: value });
  }

  function updateDefaultSandboxMode(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as ThreadSandboxMode;
    void updateRuntimePreferences({ defaultSandboxMode: value });
  }

  function addRuntimePermissionRule(): void {
    void updateRuntimePreferences({
      permissionRules: [
        ...runtimePreferences.permissionRules,
        createDefaultPermissionRule(),
      ],
    });
  }

  function updateRuntimePermissionRule(
    id: string,
    field: RuntimePermissionRuleEditableField,
    value: string,
  ): void {
    const nextRules = runtimePreferences.permissionRules.map((rule) => {
      if (rule.id !== id) {
        return rule;
      }
      if (field === "tool") {
        return { ...rule, tool: value as RuntimePermissionRuleTool };
      }
      if (field === "effect") {
        return { ...rule, effect: value as RuntimePermissionRuleEffect };
      }
      return { ...rule, pattern: value };
    });
    void updateRuntimePreferences({ permissionRules: nextRules });
  }

  function updateRuntimePermissionRulePatternDraft(id: string, value: string): void {
    setPermissionRulePatternDrafts((current) => ({ ...current, [id]: value }));
  }

  function commitRuntimePermissionRulePattern(id: string, value: string): void {
    const existingRule = runtimePreferences.permissionRules.find((rule) => rule.id === id);
    if (!existingRule) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      setPermissionRulePatternDrafts((current) => ({ ...current, [id]: existingRule.pattern }));
      setRuntimeSaveState("error");
      setRuntimeError(t("settings.errors.permissionRulePatternRequired"));
      return;
    }
    updateRuntimePermissionRule(id, "pattern", trimmed);
  }

  function handlePermissionRulePatternKeyDown(
    id: string,
    event: KeyboardEvent<HTMLInputElement>,
  ): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRuntimePermissionRulePattern(id, event.currentTarget.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const currentPattern = runtimePreferences.permissionRules.find((rule) => rule.id === id)
        ?.pattern;
      if (currentPattern !== undefined) {
        setPermissionRulePatternDrafts((current) => ({ ...current, [id]: currentPattern }));
      }
      setRuntimeError("");
    }
  }

  function deleteRuntimePermissionRule(id: string): void {
    void updateRuntimePreferences({
      permissionRules: runtimePreferences.permissionRules.filter((rule) => rule.id !== id),
    });
  }

  async function refreshMcpServerStatuses(showErrors = true): Promise<void> {
    if (!window.agentApi) return;
    const result = await window.agentApi.mcp.listServers();
    if (!result.ok) {
      if (showErrors) {
        setRuntimeSaveState("error");
        setRuntimeError(result.message);
      }
      return;
    }
    setMcpServerStatuses(Object.fromEntries(
      result.value.servers.map((server) => [server.id, server]),
    ));
  }

  function addMcpServer(): void {
    void updateRuntimePreferences({
      mcpServers: [
        ...runtimePreferences.mcpServers,
        createDefaultMcpServer(createUniqueMcpServerName(
          t("settings.mcpServers.defaultName"),
          runtimePreferences.mcpServers,
        )),
      ],
    });
  }

  function updateMcpServer(id: string, update: McpServerConfigUpdate): void {
    void updateRuntimePreferences({
      mcpServers: updateMcpServerConfigs(runtimePreferences.mcpServers, id, update),
    });
  }

  function updateMcpServerTransport(id: string, transport: McpServerTransport): void {
    const server = runtimePreferences.mcpServers.find((candidate) => candidate.id === id);
    if (!server) return;
    updateMcpServer(id, {
      transport,
      ...(transport === "stdio"
        ? { url: undefined, headers: {}, command: server.command || "node" }
        : { command: undefined, args: [], env: {}, cwd: undefined, url: server.url || "http://localhost:3000/mcp" }),
    });
  }

  function updateMcpServerEnv(id: string, raw: string): void {
    const parsed = parseMcpServerEnvDraft(raw, t);
    if (!parsed.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(parsed.message);
      return;
    }
    updateMcpServer(id, { env: parsed.value });
  }

  function updateMcpServerHeaders(id: string, raw: string): void {
    const parsed = parseMcpServerStringRecordDraft(raw, t, "headers");
    if (!parsed.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(parsed.message);
      return;
    }
    updateMcpServer(id, { headers: parsed.value });
  }

  function deleteMcpServer(id: string): void {
    void updateRuntimePreferences({
      mcpServers: runtimePreferences.mcpServers.filter((server) => server.id !== id),
    });
  }

  async function handleMcpConnect(serverId: string): Promise<void> {
    if (!window.agentApi) return;
    setRuntimeError("");
    const result = await window.agentApi.mcp.connect({ serverId });
    if (!result.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(result.message);
      return;
    }
    setMcpServerStatuses((current) => ({ ...current, [result.value.id]: result.value }));
    setRuntimeSaveState("saved");
  }

  async function handleMcpDisconnect(serverId: string): Promise<void> {
    if (!window.agentApi) return;
    setRuntimeError("");
    const result = await window.agentApi.mcp.disconnect({ serverId });
    if (!result.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(result.message);
      return;
    }
    setMcpServerStatuses((current) => ({ ...current, [result.value.id]: result.value }));
    setRuntimeSaveState("saved");
  }

  async function handleMcpRefreshTools(serverId: string): Promise<void> {
    if (!window.agentApi) return;
    setRuntimeError("");
    const result = await window.agentApi.mcp.refreshTools({ serverId });
    if (!result.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(result.message);
      return;
    }
    setMcpServerStatuses((current) => ({ ...current, [result.value.id]: result.value }));
    const surface = await window.agentApi.mcp.refreshSurface({ serverId });
    if (surface.ok) {
      setMcpServerStatuses((current) => ({ ...current, [surface.value.id]: surface.value }));
    }
    setRuntimeSaveState("saved");
  }

  async function refreshSkillCatalog(showErrors = true): Promise<void> {
    if (!state.workspaceRoot) {
      setSkillCatalog(null);
      setSkillCatalogError("");
      return;
    }
    if (!window.agentApi) {
      setSkillCatalog(null);
      setSkillCatalogError(i18n.t("settings.preloadMissing"));
      return;
    }
    setSkillCatalogLoading(true);
    if (showErrors) setSkillCatalogError("");
    try {
      const result = await window.agentApi.skills.list({ workspace: state.workspaceRoot });
      if (!result.ok) {
        setSkillCatalog(null);
        if (showErrors) setSkillCatalogError(result.message);
        return;
      }
      setSkillCatalog(result.value);
      setSkillCatalogError("");
    } catch (loadError) {
      setSkillCatalog(null);
      if (showErrors) setSkillCatalogError(messageOfUnknownError(loadError));
    } finally {
      setSkillCatalogLoading(false);
    }
  }

  function updateCompactionStrategy(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as RuntimeCompactionStrategy;
    void updateRuntimePreferences({ compaction: { strategy: value } });
  }

  function updateSkillsDraft(field: RuntimeSkillsDraftField, value: string): void {
    setSkillsDraft((current) => ({ ...current, [field]: value }));
  }

  function resetSkillsDraftField(field: RuntimeSkillsDraftField): void {
    setSkillsDraft((current) => ({
      ...current,
      [field]: String(runtimePreferences.skills[field]),
    }));
  }

  async function commitSkillsDraft(
    field: RuntimeSkillsDraftField,
    raw = skillsDraft[field],
  ): Promise<void> {
    const validation = validateRuntimeSkillsNumericDraft(field, raw, t);
    if (!validation.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(validation.message);
      return;
    }
    if (validation.value === null) {
      resetSkillsDraftField(field);
      setRuntimeError("");
      return;
    }
    if (validation.value === runtimePreferences.skills[field]) {
      resetSkillsDraftField(field);
      setRuntimeError("");
      return;
    }
    const update: RuntimePreferencesUpdate =
      field === "activeLimit"
        ? { skills: { activeLimit: validation.value } }
        : { skills: { instructionBudgetBytes: validation.value } };
    await updateRuntimePreferences(update);
  }

  function handleSkillsDraftKeyDown(
    field: RuntimeSkillsDraftField,
    event: KeyboardEvent<HTMLInputElement>,
  ): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitSkillsDraft(field, event.currentTarget.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetSkillsDraftField(field);
      setRuntimeError("");
    }
  }

  function updateSkillsExtraRoots(value: string): void {
    setSkillsDraft((current) => ({ ...current, extraRoots: value }));
  }

  async function commitSkillsExtraRoots(raw = skillsDraft.extraRoots): Promise<void> {
    const validation = parseRuntimeSkillsExtraRootsDraft(raw, t);
    if (!validation.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(validation.message);
      return;
    }
    const currentRoots = runtimePreferences.skills.extraRoots;
    if (arraysEqual(validation.value, currentRoots)) {
      setSkillsDraft((current) => ({
        ...current,
        extraRoots: formatRuntimeSkillsExtraRoots(currentRoots),
      }));
      setRuntimeError("");
      return;
    }
    await updateRuntimePreferences({ skills: { extraRoots: validation.value } });
  }

  function handleSkillsExtraRootsKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void commitSkillsExtraRoots(event.currentTarget.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSkillsDraft((current) => ({
        ...current,
        extraRoots: formatRuntimeSkillsExtraRoots(runtimePreferences.skills.extraRoots),
      }));
      setRuntimeError("");
    }
  }

  function updateCodeDefaultModelProfile(event: ChangeEvent<HTMLSelectElement>): void {
    void updateRuntimePreferences({
      codeDefaultModelProfileId: emptyStringToNullableProfileId(event.target.value),
    });
  }

  function updateWriteDefaultModelProfile(event: ChangeEvent<HTMLSelectElement>): void {
    void updateRuntimePreferences({
      writeDefaultModelProfileId: emptyStringToNullableProfileId(event.target.value),
    });
  }

  function updateCommandDraft(field: RuntimeCommandDraftField, value: string): void {
    setCommandDraft((current) => ({ ...current, [field]: value }));
  }

  function resetCommandDraftField(field: RuntimeCommandDraftField): void {
    setCommandDraft((current) => ({
      ...current,
      [field]: String(runtimePreferences.command[field]),
    }));
  }

  async function commitCommandDraft(
    field: RuntimeCommandDraftField,
    raw = commandDraft[field],
  ): Promise<void> {
    const validation = validateRuntimeCommandDraft(field, raw, t);
    if (!validation.ok) {
      setRuntimeSaveState("error");
      setRuntimeError(validation.message);
      return;
    }
    if (validation.value === null) {
      resetCommandDraftField(field);
      setRuntimeError("");
      return;
    }
    if (validation.value === runtimePreferences.command[field]) {
      resetCommandDraftField(field);
      setRuntimeError("");
      return;
    }
    const update: RuntimePreferencesUpdate =
      field === "timeoutMs"
        ? { command: { timeoutMs: validation.value } }
        : { command: { maxOutputBytes: validation.value } };
    await updateRuntimePreferences(update);
  }

  function handleCommandDraftKeyDown(
    field: RuntimeCommandDraftField,
    event: KeyboardEvent<HTMLInputElement>,
  ): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitCommandDraft(field, event.currentTarget.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetCommandDraftField(field);
      setRuntimeError("");
    }
  }

  function markDirty(): void {
    setSaveState((current) =>
      current === "loading" || current === "saving" ? current : "dirty",
    );
  }

  function ensureNoUnsavedProfileChanges(): boolean {
    if (!shouldBlockSettingsNavigation(saveState, profileHasUnsavedChanges)) {
      return true;
    }
    setError(t("settings.unsavedChanges"));
    return false;
  }

  function handleSelectSection(nextSection: SettingsSection): void {
    if (nextSection === section) return;
    if (!ensureNoUnsavedProfileChanges()) return;
    setSection(nextSection);
    setCategory(getDefaultCategoryForSection(nextSection));
    setPendingDeleteProfileId(null);
  }

  function handleSelectCategory(nextCategory: SettingsCategory): void {
    if (!shouldAllowSettingsCategorySelection(
      category,
      nextCategory,
      saveState,
      profileHasUnsavedChanges,
    )) {
      setError(t("settings.unsavedChanges"));
      return;
    }
    setCategory(nextCategory);
  }

  function handleToggleAdvancedSettings(nextShowAdvanced: boolean): void {
    if (!nextShowAdvanced && isSettingsCategoryAdvanced(category)) {
      const fallbackCategory = getFirstVisibleSettingsCategoryForSection(
        section,
        false,
      );
      if (fallbackCategory && fallbackCategory !== category) {
        if (!ensureNoUnsavedProfileChanges()) return;
        setCategory(fallbackCategory);
      }
    }
    setShowAdvancedSettings(nextShowAdvanced);
  }

  async function handleActivateProfile(profile: ModelConfigProfile): Promise<void> {
    if (!ensureNoUnsavedProfileChanges()) return;
    setPendingDeleteProfileId(null);
    setProfileBusy(profile.id);
    setSaveState("saving");
    setError("");
    try {
      const result = await window.agentApi.modelConfig.activateProfile({ id: profile.id });
      if (!result.ok) {
        setSaveState("error");
        setError(result.message);
        return;
      }
      applyProfilesState(result.value);
      const runtimeResult = await window.agentApi.runtimePreferences.get();
      if (runtimeResult.ok) {
        applyRuntimePreferences(runtimeResult.value);
        setRuntimeSaveState("idle");
        setRuntimeError("");
      } else {
        applyRuntimePreferences(
          resolveRuntimePreferencesAfterProfileActivationRefreshFailure(runtimePreferences),
        );
        setRuntimeSaveState("error");
        setRuntimeError(runtimeResult.message);
      }
      setSaveState("saved");
    } finally {
      setProfileBusy("");
    }
  }

  async function handleCreateProfile(
    name: string,
    config: ModelConfig,
  ): Promise<void> {
    if (!ensureNoUnsavedProfileChanges()) return;
    setPendingDeleteProfileId(null);
    setProfileBusy("create");
    setSaveState("saving");
    setError("");
    try {
      const result = await window.agentApi.modelConfig.createProfile({
        name,
        config,
        activate: true,
      });
      if (!result.ok) {
        setSaveState("error");
        setError(result.message);
        return;
      }
      applyProfilesState(result.value);
      setCategory("profiles");
      setSaveState("saved");
    } finally {
      setProfileBusy("");
    }
  }

  async function handleDuplicateProfile(profile: ModelConfigProfile): Promise<void> {
    await handleCreateProfile(
      t("settings.profiles.copyName", { name: profile.name }),
      profile.config,
    );
  }

  async function handleDeleteProfile(profile: ModelConfigProfile): Promise<void> {
    if (!profilesState || profilesState.profiles.length <= 1) return;
    if (!ensureNoUnsavedProfileChanges()) return;
    setPendingDeleteProfileId(null);
    setProfileBusy(profile.id);
    setSaveState("saving");
    setError("");
    try {
      const result = await window.agentApi.modelConfig.deleteProfile({ id: profile.id });
      if (!result.ok) {
        setSaveState("error");
        setError(result.message);
        return;
      }
      applyProfilesState(result.value);
      const runtimeResult = await window.agentApi.runtimePreferences.get();
      if (runtimeResult.ok) {
        applyRuntimePreferences(runtimeResult.value);
        setRuntimeSaveState("idle");
        setRuntimeError("");
      } else {
        applyRuntimePreferences(
          clearDeletedDefaultProfileReferences(runtimePreferences, profile.id),
        );
        setRuntimeSaveState("error");
        setRuntimeError(runtimeResult.message);
      }
      setSaveState("saved");
    } finally {
      setProfileBusy("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmitModelSettingsSection(section, category)) return;
    if (!activeProfile) {
      setSaveState("error");
      setError(t("settings.profiles.noActive"));
      return;
    }
    const validationError = validateModelSettingsForm(form, activeProfile.config, t);
    if (validationError) {
      setSaveState("error");
      setError(validationError);
      return;
    }
    setSaveState("saving");
    setError("");
    try {
      const update = toUpdatePayload(form);
      const result = await window.agentApi.modelConfig.updateProfile({
        id: activeProfile.id,
        name: profileName,
        config: update,
      });
      if (!result.ok) {
        setSaveState("error");
        setError(result.message);
        return;
      }
      const updatedProfile = result.value;
      const nextState = profilesState
        ? {
            ...profilesState,
            profiles: profilesState.profiles.map((profile) =>
              profile.id === updatedProfile.id ? updatedProfile : profile,
            ),
          }
        : null;
      if (nextState) {
        setProfilesState(nextState);
        actions.setModelProfiles(nextState);
      }
      setForm(toFormState(updatedProfile.config));
      setProfileName(updatedProfile.name);
      actions.setModelConfig(updatedProfile.config);
      setSaveState("saved");
    } catch (submitError) {
      setSaveState("error");
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  }

  const statusLabel =
    saveState === "loading"
      ? t("settings.status.loading")
      : saveState === "saving"
        ? t("settings.status.saving")
        : saveState === "saved"
          ? t("settings.status.saved")
          : saveState === "error"
            ? t("settings.status.error")
            : saveState === "dirty"
              ? t("settings.status.dirty")
              : t("settings.status.idle");
  const runtimeStatusLabel =
    runtimeSaveState === "loading"
      ? t("settings.status.loading")
      : runtimeSaveState === "saving"
        ? t("settings.status.saving")
        : runtimeSaveState === "saved"
          ? t("settings.status.saved")
          : runtimeSaveState === "error"
            ? t("settings.status.error")
            : t("settings.status.idle");
  const isRuntimeBackedSettingsCategory =
    section === "agent" ||
    section === "tools" ||
    section === "visibility" ||
    (section === "workbench" && category === "modelDefaults");

  return (
    <main className="ds-settings-root">
      <SettingsSidebar
        items={visibleSettingsNavItems}
        activeCategory={category}
        navLabel={t("settings.navLabel")}
        searchLabel={t("settings.searchLabel")}
        searchPlaceholder={t("settings.searchPlaceholder")}
        searchValue={settingsSearch}
        emptyLabel={t("settings.searchEmpty")}
        showAdvanced={showAdvancedSettings}
        showAdvancedLabel={t("settings.showAdvanced")}
        showAdvancedDescription={t("settings.showAdvancedDesc")}
        footerTitle={sidebarFooterTitle}
        footerDescription={sidebarFooterDescription}
        backLabel={t("settings.backToWorkbench")}
        onSearch={setSettingsSearch}
        onToggleAdvanced={handleToggleAdvancedSettings}
        onSelect={handleSelectCategory}
        onBack={() => {
          if (ensureNoUnsavedProfileChanges()) {
            actions.setRoute(state.lastWorkbenchRoute);
          }
        }}
      />
      <form className="ds-settings-main" onSubmit={(event) => void handleSubmit(event)}>
        <header className="ds-settings-page-header">
          <div className="ds-settings-page-heading">
            <h1>{t("settings.title")}</h1>
            <p>{settingsSubtitle}</p>
          </div>
          <div className="ds-settings-page-actions">
            {section === "model" ? (
              <>
                <StatusBadge tone={saveState} title={error || undefined}>
                  {statusLabel}
                </StatusBadge>
                <button
                  className="ds-settings-primary-action"
                  type="submit"
                  disabled={
                    !hasAgentApi ||
                    saveState === "saving" ||
                    saveState === "loading" ||
                    saveState === "idle" ||
                    saveState === "saved"
                  }
                >
                  {saveState === "saving"
                    ? t("settings.saving")
                    : saveState === "saved" || saveState === "idle"
                      ? t("settings.saved")
                      : t("settings.save")}
                </button>
              </>
            ) : isRuntimeBackedSettingsCategory ? (
              <StatusBadge tone={runtimeSaveState} title={runtimeError || undefined}>
                {runtimeStatusLabel}
              </StatusBadge>
            ) : null}
          </div>
          <nav className="ds-settings-section-tabs" aria-label={t("settings.sectionNavLabel")}>
            {settingsSectionItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`ds-settings-section-tab${
                  section === item.id ? " is-active" : ""
                }`}
                aria-pressed={section === item.id}
                onClick={() => handleSelectSection(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </nav>
        </header>
        <div className="ds-settings-content">
          {section === "model" && !hasAgentApi ? (
            <div className="ds-settings-notice is-error">{t("settings.preloadMissing")}</div>
          ) : null}
          {section === "model" && error ? (
            <div className="ds-settings-notice is-error">{error}</div>
          ) : null}
          {isRuntimeBackedSettingsCategory && !hasAgentApi ? (
            <div className="ds-settings-notice is-error">{t("settings.preloadMissing")}</div>
          ) : null}
          {isRuntimeBackedSettingsCategory && runtimeError ? (
            <div className="ds-settings-notice is-error">{runtimeError}</div>
          ) : null}
          {section === "workbench" && category === "layout" && basicPreferenceError ? (
            <div className="ds-settings-notice is-error">{basicPreferenceError}</div>
          ) : null}

          {section === "basic" && category === "appearance" ? (
            <SettingsCard
              title={t("settings.sections.appearance")}
              description={t("settings.sections.appearanceDesc")}
            >
              <SettingRow
                title={t("settings.fields.locale")}
                description={t("settings.descriptions.locale")}
                controlId="settings_locale"
                control={
                  <select
                    id="settings_locale"
                    value={locale}
                    onChange={updateLocale}
                  >
                    {SUPPORTED_LOCALES.map((supportedLocale) => (
                      <option key={supportedLocale} value={supportedLocale}>
                        {t(`locales.${supportedLocale}`)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.theme")}
                description={t("settings.descriptions.theme")}
                control={
                  <div className="ds-segmented-control ds-settings-theme-control" role="group">
                    {THEME_PREFERENCES.map((theme) => (
                      <button
                        key={theme}
                        type="button"
                        className={preferences.theme === theme ? "is-active" : ""}
                        aria-pressed={preferences.theme === theme}
                        onClick={() => updateThemePreference(theme)}
                      >
                        {t(`settings.themes.${theme}`)}
                      </button>
                    ))}
                  </div>
                }
              />
              <SettingRow
                title={t("settings.fields.followSystemTheme")}
                description={t("settings.descriptions.followSystemTheme")}
                control={
                  <Toggle
                    checked={preferences.followSystemTheme}
                    label={t("settings.fields.followSystemTheme")}
                    onChange={updateFollowSystemTheme}
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "workbench" && category === "startup" ? (
            <SettingsCard
              title={t("settings.sections.startup")}
              description={t("settings.sections.startupDesc")}
            >
              <SettingRow
                title={t("settings.fields.defaultStartupView")}
                description={t("settings.descriptions.defaultStartupView")}
                controlId="default_startup_view"
                control={
                  <select
                    id="default_startup_view"
                    value={preferences.defaultStartupView}
                    onChange={updateStartupView}
                  >
                    {STARTUP_VIEWS.map((view) => (
                      <option key={view} value={view}>
                        {t(`settings.startupViews.${view}`)}
                      </option>
                    ))}
                  </select>
                }
              />
            </SettingsCard>
          ) : null}

          {section === "workbench" && category === "layout" ? (
            <SettingsCard
              title={t("settings.sections.layout")}
              description={t("settings.sections.layoutDesc")}
            >
              <SettingRow
                title={t("settings.fields.rememberLeftSidebarWidth")}
                description={t("settings.descriptions.rememberLeftSidebarWidth")}
                control={
                  <Toggle
                    checked={preferences.rememberLeftSidebarWidth}
                    label={t("settings.fields.rememberLeftSidebarWidth")}
                    onChange={(checked) =>
                      actions.updateBasicPreference("rememberLeftSidebarWidth", checked)
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.rememberRightSidebarWidth")}
                description={t("settings.descriptions.rememberRightSidebarWidth")}
                control={
                  <Toggle
                    checked={preferences.rememberRightSidebarWidth}
                    label={t("settings.fields.rememberRightSidebarWidth")}
                    onChange={(checked) =>
                      actions.updateBasicPreference("rememberRightSidebarWidth", checked)
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.defaultInspectorMode")}
                description={t("settings.descriptions.defaultInspectorMode")}
                controlId="default_inspector_mode"
                control={
                  <select
                    id="default_inspector_mode"
                    value={toDefaultInspectorModeValue(preferences.defaultInspectorMode)}
                    onChange={updateDefaultInspectorMode}
                  >
                    {DEFAULT_INSPECTOR_MODES.map((mode) => (
                      <option
                        key={toDefaultInspectorModeValue(mode)}
                        value={toDefaultInspectorModeValue(mode)}
                      >
                        {t(`settings.inspectorDefaults.${toDefaultInspectorModeValue(mode)}`)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.codeBlockCollapseLineThreshold")}
                description={t("settings.descriptions.codeBlockCollapseLineThreshold")}
                controlId="code_block_collapse_line_threshold"
                control={
                  <input
                    id="code_block_collapse_line_threshold"
                    type="number"
                    min={CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN}
                    max={CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX}
                    value={codeBlockThresholdDraft}
                    placeholder={String(CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT)}
                    aria-invalid={basicPreferenceError ? true : undefined}
                    onChange={(event) =>
                      setCodeBlockThresholdDraft(event.target.value)
                    }
                    onBlur={(event) =>
                      commitCodeBlockThresholdDraft(event.currentTarget.value)
                    }
                    onKeyDown={(event) =>
                      handleCodeBlockThresholdKeyDown(event)
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.openReasoningByDefault")}
                description={t("settings.descriptions.openReasoningByDefault")}
                control={
                  <Toggle
                    checked={preferences.openReasoningByDefault}
                    label={t("settings.fields.openReasoningByDefault")}
                    onChange={(checked) =>
                      actions.updateBasicPreference("openReasoningByDefault", checked)
                    }
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "workbench" && category === "session" ? (
            <SettingsCard
              title={t("settings.sections.session")}
              description={t("settings.sections.sessionDesc")}
            >
              <SettingRow
                title={t("settings.fields.showArchivedThreadsByDefault")}
                description={t("settings.descriptions.showArchivedThreadsByDefault")}
                control={
                  <Toggle
                    checked={preferences.showArchivedThreadsByDefault}
                    label={t("settings.fields.showArchivedThreadsByDefault")}
                    onChange={(checked) =>
                      actions.updateBasicPreference(
                        "showArchivedThreadsByDefault",
                        checked,
                      )
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.restoreLastWorkspaceOnStartup")}
                description={t("settings.descriptions.restoreLastWorkspaceOnStartup")}
                control={
                  <Toggle
                    checked={preferences.restoreLastWorkspaceOnStartup}
                    label={t("settings.fields.restoreLastWorkspaceOnStartup")}
                    onChange={(checked) =>
                      actions.updateBasicPreference(
                        "restoreLastWorkspaceOnStartup",
                        checked,
                      )
                    }
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "workbench" && category === "modelDefaults" ? (
            <SettingsCard
              title={t("settings.sections.modelDefaults")}
              description={t("settings.sections.modelDefaultsDesc")}
            >
              <SettingRow
                title={t("settings.fields.codeDefaultModelProfile")}
                description={t("settings.descriptions.codeDefaultModelProfile")}
                controlId="code_default_model_profile"
                control={
                  <select
                    id="code_default_model_profile"
                    value={runtimePreferences.codeDefaultModelProfileId ?? ""}
                    onChange={updateCodeDefaultModelProfile}
                    disabled={runtimeControlsDisabled || !profilesState}
                  >
                    <option value="">{t("settings.profileDefaults.activeProfile")}</option>
                    {profilesState?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} / {profile.config.model}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.writeDefaultModelProfile")}
                description={t("settings.descriptions.writeDefaultModelProfile")}
                controlId="write_default_model_profile"
                control={
                  <select
                    id="write_default_model_profile"
                    value={runtimePreferences.writeDefaultModelProfileId ?? ""}
                    onChange={updateWriteDefaultModelProfile}
                    disabled={runtimeControlsDisabled || !profilesState}
                  >
                    <option value="">{t("settings.profileDefaults.activeProfile")}</option>
                    {profilesState?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} / {profile.config.model}
                      </option>
                    ))}
                  </select>
                }
              />
            </SettingsCard>
          ) : null}

          {section === "workbench" && category === "attachments" ? (
            <SettingsCard
              title={t("settings.sections.attachments")}
              description={t("settings.sections.attachmentsDesc")}
            >
              <SettingRow
                title={t("settings.fields.allowComposerImageUpload")}
                description={t("settings.descriptions.allowComposerImageUpload")}
                control={
                  <Toggle
                    checked={preferences.allowComposerImageUpload}
                    label={t("settings.fields.allowComposerImageUpload")}
                    onChange={(checked) =>
                      actions.updateBasicPreference("allowComposerImageUpload", checked)
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.allowComposerImagePaste")}
                description={t("settings.descriptions.allowComposerImagePaste")}
                control={
                  <Toggle
                    checked={preferences.allowComposerImagePaste}
                    label={t("settings.fields.allowComposerImagePaste")}
                    onChange={(checked) =>
                      actions.updateBasicPreference("allowComposerImagePaste", checked)
                    }
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "model" && category === "profiles" ? (
            <SettingsCard
              title={t("settings.profiles.title")}
              description={t("settings.profiles.subtitle")}
            >
              <div className="ds-profile-toolbar">
                <button
                  className="ds-profile-action"
                  type="button"
                  disabled={!hasAgentApi || saveState === "loading" || Boolean(profileBusy)}
                  onClick={() =>
                    void handleCreateProfile(
                      t("settings.profiles.minimaxName"),
                      DEFAULT_MODEL_CONFIG,
                    )
                  }
                >
                  {t("settings.profiles.addMiniMax")}
                </button>
                <button
                  className="ds-profile-action"
                  type="button"
                  disabled={!hasAgentApi || saveState === "loading" || Boolean(profileBusy)}
                  onClick={() =>
                    void handleCreateProfile(
                      t("settings.profiles.deepseekName"),
                      DEFAULT_DEEPSEEK_MODEL_CONFIG,
                    )
                  }
                >
                  {t("settings.profiles.addDeepSeek")}
                </button>
                <button
                  className="ds-profile-action"
                  type="button"
                  disabled={!hasAgentApi || saveState === "loading" || Boolean(profileBusy)}
                  onClick={() =>
                    void handleCreateProfile(
                      t("settings.profiles.customName"),
                      createCustomModelConfig(),
                    )
                  }
                >
                  {t("settings.profiles.addCustom")}
                </button>
              </div>
              <div className="ds-profile-grid">
                {profilesState?.profiles.map((profile) => {
                  const isActive = profile.id === profilesState.activeProfileId;
                  const isBusy = profileBusy === profile.id;
                  const isConfirmingDelete = isProfileDeletePending(
                    pendingDeleteProfileId,
                    profile.id,
                  );
                  const canDeleteProfile =
                    hasAgentApi &&
                    saveState !== "loading" &&
                    !profileBusy &&
                    (profilesState?.profiles.length ?? 0) > 1;
                  return (
                    <article
                      className={`ds-profile-card${isActive ? " is-active" : ""}${
                        isConfirmingDelete ? " is-confirming-delete" : ""
                      }`}
                      key={profile.id}
                    >
                      <button
                        className="ds-profile-card-main"
                        type="button"
                        disabled={isBusy || isActive}
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => void handleActivateProfile(profile)}
                      >
                        <span className="ds-profile-card-topline">
                          <span>{profile.name}</span>
                          {isActive ? (
                            <span className="ds-profile-active">
                              {t("settings.profiles.active")}
                            </span>
                          ) : null}
                        </span>
                        <strong>{profile.config.model}</strong>
                        <span className="ds-profile-meta">
                          {profile.config.model_provide} / {profile.config.base_url}
                        </span>
                      </button>
                      <div className="ds-profile-card-actions">
                        {isConfirmingDelete ? (
                          <div
                            className="ds-profile-delete-confirm"
                            role="group"
                            aria-label={t("settings.profiles.deleteConfirm", {
                              name: profile.name,
                            })}
                          >
                            <span>{t("settings.profiles.deleteConfirmShort")}</span>
                            <button
                              type="button"
                              className="is-danger"
                              disabled={!canDeleteProfile}
                              onClick={() => void handleDeleteProfile(profile)}
                            >
                              {isBusy
                                ? t("settings.profiles.deleting")
                                : t("settings.profiles.deleteConfirmAction")}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setPendingDeleteProfileId(null)}
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={
                                !hasAgentApi ||
                                saveState === "loading" ||
                                Boolean(profileBusy)
                              }
                              onClick={() => void handleDuplicateProfile(profile)}
                            >
                              {t("settings.profiles.duplicate")}
                            </button>
                            <button
                              type="button"
                              disabled={!canDeleteProfile}
                              onClick={() => setPendingDeleteProfileId(profile.id)}
                            >
                              {t("settings.profiles.delete")}
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </SettingsCard>
          ) : null}

          {section === "model" && category === "connection" ? (
            <SettingsCard
              title={t("settings.sections.connection")}
              description={t("settings.sections.connectionDesc")}
            >
              <SettingRow
                title={t("settings.fields.profileName")}
                description={t("settings.descriptions.profileName")}
                controlId="profile_name"
                control={
                  <input
                    id="profile_name"
                    value={profileName}
                    onChange={(event) => updateProfileName(event.target.value)}
                    disabled={modelProfileControlsDisabled}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.modelProvide")}
                description={t("settings.descriptions.modelProvide")}
                controlId="model_provide"
                control={
                  <input
                    id="model_provide"
                    value={form.model_provide}
                    onChange={updateText("model_provide")}
                    disabled={modelProfileControlsDisabled}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.model")}
                description={t("settings.descriptions.model")}
                controlId="model"
                control={
                  <input
                    id="model"
                    value={form.model}
                    onChange={updateText("model")}
                    disabled={modelProfileControlsDisabled}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.protocol")}
                description={t("settings.descriptions.protocol")}
                controlId="protocol"
                control={
                  <select
                    id="protocol"
                    value={form.protocol}
                    onChange={updateProtocol}
                    disabled={modelProfileControlsDisabled}
                  >
                    {LLM_PROTOCOLS.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {t(`settings.protocols.${protocol}`)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.baseUrl")}
                description={t("settings.descriptions.baseUrl")}
                controlId="base_url"
                wide
                control={
                  <input
                    id="base_url"
                    value={form.base_url}
                    onChange={updateText("base_url")}
                    disabled={modelProfileControlsDisabled}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.apiKey")}
                description={t("settings.descriptions.apiKey")}
                controlId="OPENAI_API_KEY"
                wide
                control={
                  <SecretInput
                    id="OPENAI_API_KEY"
                    value={form.OPENAI_API_KEY}
                    visible={showApiKey}
                    autoComplete="off"
                    placeholder={t("settings.placeholders.apiKey")}
                    disabled={modelProfileControlsDisabled}
                    showLabel={t("settings.showSecret")}
                    hideLabel={t("settings.hideSecret")}
                    onChange={updateSecret}
                    onToggleVisibility={() => setShowApiKey((value) => !value)}
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "model" && category === "context" ? (
            <SettingsCard
              title={t("settings.sections.context")}
              description={t("settings.sections.contextDesc")}
            >
              <SettingRow
                title={t("settings.fields.contextWindow")}
                description={t("settings.descriptions.contextWindow")}
                controlId="model_context_window"
                control={
                  <input
                    id="model_context_window"
                    value={form.model_context_window}
                    onChange={updateText("model_context_window")}
                    disabled={modelProfileControlsDisabled}
                    inputMode="numeric"
                    placeholder={String(DEFAULT_MODEL_CONFIG.model_context_window)}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.compactLimit")}
                description={t("settings.descriptions.compactLimit")}
                controlId="model_auto_compact_token_limit"
                control={
                  <input
                    id="model_auto_compact_token_limit"
                    value={form.model_auto_compact_token_limit}
                    onChange={updateText("model_auto_compact_token_limit")}
                    disabled={modelProfileControlsDisabled}
                    inputMode="numeric"
                    placeholder={t("settings.placeholders.compactLimit")}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.maxTokens")}
                description={t("settings.descriptions.maxTokens")}
                controlId="max_tokens"
                control={
                  <input
                    id="max_tokens"
                    value={form.max_tokens}
                    onChange={updateText("max_tokens")}
                    disabled={modelProfileControlsDisabled}
                    inputMode="numeric"
                    placeholder={String(DEFAULT_MODEL_CONFIG.max_tokens)}
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "model" && category === "reasoning" ? (
            <SettingsCard
              title={t("settings.sections.reasoning")}
              description={t("settings.sections.reasoningDesc")}
            >
              <SettingRow
                title={t("settings.fields.thinking")}
                description={t("settings.descriptions.thinking")}
                control={
                  <Toggle
                    checked={form.thinking}
                    label={t("settings.fields.thinking")}
                    disabled={modelProfileControlsDisabled}
                    onChange={updateThinking}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.reasoningEffort")}
                description={t("settings.descriptions.reasoningEffort")}
                controlId="model_reasoning_effort"
                control={
                  <select
                    id="model_reasoning_effort"
                    value={form.model_reasoning_effort}
                    onChange={updateEffort}
                    disabled={modelProfileControlsDisabled}
                  >
                    {MODEL_REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {t(`settings.efforts.${effort}`)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.agentAutonomy")}
                description={t("settings.descriptions.agentAutonomy")}
                controlId="agent_autonomy"
                control={
                  <select
                    id="agent_autonomy"
                    value={form.agent_autonomy}
                    onChange={updateAutonomy}
                    disabled={modelProfileControlsDisabled}
                  >
                    {AGENT_AUTONOMY_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`settings.autonomy.${level}`)}
                      </option>
                    ))}
                  </select>
                }
              />
            </SettingsCard>
          ) : null}

          {section === "agent" && category === "compaction" ? (
            <SettingsCard
              title={t("settings.sections.compaction")}
              description={t("settings.sections.compactionDesc")}
            >
              <SettingRow
                title={t("settings.fields.compactionEnabled")}
                description={t("settings.descriptions.compactionEnabled")}
                control={
                  <Toggle
                    checked={runtimePreferences.compaction.enabled}
                    label={t("settings.fields.compactionEnabled")}
                    disabled={runtimeControlsDisabled}
                    onChange={(checked) =>
                      void updateRuntimePreferences({ compaction: { enabled: checked } })
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.compactionStrategy")}
                description={t("settings.descriptions.compactionStrategy")}
                controlId="compaction_strategy"
                control={
                  <select
                    id="compaction_strategy"
                    value={runtimePreferences.compaction.strategy}
                    onChange={updateCompactionStrategy}
                    disabled={runtimeControlsDisabled || !runtimePreferences.compaction.enabled}
                  >
                    {RUNTIME_COMPACTION_STRATEGIES.map((strategy) => (
                      <option key={strategy} value={strategy}>
                        {t(`settings.compactionStrategies.${strategy}`)}
                      </option>
                    ))}
                  </select>
                }
              />
            </SettingsCard>
          ) : null}

          {section === "agent" && category === "skills" ? (
            <SettingsCard
              title={t("settings.sections.skills")}
              description={t("settings.sections.skillsDesc")}
            >
              <SettingRow
                title={t("settings.fields.skillsEnabled")}
                description={t("settings.descriptions.skillsEnabled")}
                control={
                  <Toggle
                    checked={runtimePreferences.skills.enabled}
                    label={t("settings.fields.skillsEnabled")}
                    disabled={runtimeControlsDisabled}
                    onChange={(checked) =>
                      void updateRuntimePreferences({ skills: { enabled: checked } })
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.skillsActiveLimit")}
                description={t("settings.descriptions.skillsActiveLimit")}
                controlId="skills_active_limit"
                control={
                  <input
                    id="skills_active_limit"
                    type="number"
                    min={MIN_RUNTIME_SKILLS_ACTIVE_LIMIT}
                    max={MAX_RUNTIME_SKILLS_ACTIVE_LIMIT}
                    step={1}
                    value={skillsDraft.activeLimit}
                    disabled={runtimeControlsDisabled || !runtimePreferences.skills.enabled}
                    onChange={(event) => updateSkillsDraft("activeLimit", event.target.value)}
                    onBlur={(event) =>
                      void commitSkillsDraft("activeLimit", event.currentTarget.value)
                    }
                    onKeyDown={(event) => handleSkillsDraftKeyDown("activeLimit", event)}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.skillsInstructionBudgetBytes")}
                description={t("settings.descriptions.skillsInstructionBudgetBytes", {
                  defaultBytes: DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
                })}
                controlId="skills_instruction_budget_bytes"
                control={
                  <input
                    id="skills_instruction_budget_bytes"
                    type="number"
                    min={MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES}
                    max={MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES}
                    step={1024}
                    value={skillsDraft.instructionBudgetBytes}
                    disabled={runtimeControlsDisabled || !runtimePreferences.skills.enabled}
                    onChange={(event) =>
                      updateSkillsDraft("instructionBudgetBytes", event.target.value)
                    }
                    onBlur={(event) =>
                      void commitSkillsDraft(
                        "instructionBudgetBytes",
                        event.currentTarget.value,
                      )
                    }
                    onKeyDown={(event) =>
                      handleSkillsDraftKeyDown("instructionBudgetBytes", event)
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.skillsExtraRoots")}
                description={t("settings.descriptions.skillsExtraRoots")}
                controlId="skills_extra_roots"
                wide
                control={
                  <textarea
                    id="skills_extra_roots"
                    rows={4}
                    value={skillsDraft.extraRoots}
                    placeholder={t("settings.placeholders.skillsExtraRoots")}
                    disabled={runtimeControlsDisabled || !runtimePreferences.skills.enabled}
                    onChange={(event) => updateSkillsExtraRoots(event.target.value)}
                    onBlur={(event) => void commitSkillsExtraRoots(event.currentTarget.value)}
                    onKeyDown={handleSkillsExtraRootsKeyDown}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.skillsCatalog")}
                description={t("settings.descriptions.skillsCatalog")}
                wide
                control={
                  <div className="ds-settings-skill-catalog">
                    <div className="ds-settings-skill-catalog-toolbar">
                      <span>
                        {state.workspaceRoot || t("settings.skills.noWorkspace")}
                      </span>
                      <button
                        type="button"
                        className="ds-settings-secondary-action"
                        disabled={!state.workspaceRoot || skillCatalogLoading}
                        onClick={() => void refreshSkillCatalog()}
                      >
                        {skillCatalogLoading
                          ? t("settings.skills.loading")
                          : t("settings.skills.refresh")}
                      </button>
                    </div>
                    {skillCatalogError ? (
                      <p className="ds-settings-skill-error">{skillCatalogError}</p>
                    ) : null}
                    {!state.workspaceRoot ? (
                      <p className="ds-settings-empty-note">
                        {t("settings.skills.noWorkspaceDesc")}
                      </p>
                    ) : null}
                    {state.workspaceRoot && skillCatalog && !skillCatalogLoading ? (
                      <>
                        <div className="ds-settings-skill-meta">
                          <span>
                            {t("settings.skills.catalogSummary", {
                              count: skillCatalog.skills.length,
                              roots: skillCatalog.roots.length,
                            })}
                          </span>
                          <span>
                            {skillCatalog.enabled
                              ? t("settings.skills.enabled")
                              : t("settings.skills.disabled")}
                          </span>
                        </div>
                        {skillCatalog.validationErrors.length > 0 ? (
                          <div className="ds-settings-skill-warnings">
                            <strong>{t("settings.skills.validationWarnings")}</strong>
                            {skillCatalog.validationErrors.map((warning) => (
                              <span key={`${warning.root}:${warning.message}`}>
                                {warning.root}: {warning.message}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {skillCatalog.roots.length > 0 ? (
                          <div className="ds-settings-skill-roots">
                            <strong>{t("settings.skills.roots")}</strong>
                            {skillCatalog.roots.map((root) => (
                              <span key={`${root.scope}:${root.path}`}>
                                {t(`settings.skillScopes.${root.scope}`)} · {root.path}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {skillCatalog.skills.length === 0 ? (
                          <p className="ds-settings-empty-note">
                            {t("settings.skills.empty")}
                          </p>
                        ) : (
                          <div className="ds-settings-skill-list">
                            {skillCatalog.skills.map((skill) => (
                              <article className="ds-settings-skill-card" key={skill.id}>
                                <div className="ds-settings-skill-card-header">
                                  <div>
                                    <strong>{skill.name}</strong>
                                    <span>{skill.id}</span>
                                  </div>
                                  <span>
                                    {t(`settings.skillScopes.${skill.scope}`)} ·{" "}
                                    {t(`settings.skillRunModes.${skill.runAs}`)}
                                  </span>
                                </div>
                                {skill.description ? <p>{skill.description}</p> : null}
                                <div className="ds-settings-skill-card-meta">
                                  <span>{formatSkillTriggerSummary(skill, t)}</span>
                                  {skill.allowedTools.length > 0 ? (
                                    <span>
                                      {t("settings.skills.allowedTools", {
                                        tools: skill.allowedTools.join(", "),
                                      })}
                                    </span>
                                  ) : null}
                                  {skill.referenceCount > 0 ? (
                                    <span>
                                      {t("settings.skills.references", {
                                        count: skill.referenceCount,
                                        names: skill.referenceNames.join(", "),
                                      })}
                                    </span>
                                  ) : null}
                                </div>
                              </article>
                            ))}
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                }
              />
            </SettingsCard>
          ) : null}

          {section === "tools" && category === "permissions" ? (
            <SettingsCard
              title={t("settings.sections.permissions")}
              description={t("settings.sections.permissionsDesc")}
            >
              <SettingRow
                title={t("settings.fields.defaultApprovalPolicy")}
                description={t("settings.descriptions.defaultApprovalPolicy")}
                controlId="default_approval_policy"
                control={
                  <select
                    id="default_approval_policy"
                    value={runtimePreferences.defaultApprovalPolicy}
                    onChange={updateDefaultApprovalPolicy}
                    disabled={runtimeControlsDisabled}
                  >
                    {THREAD_APPROVAL_POLICIES.map((policy) => (
                      <option key={policy} value={policy}>
                        {t(`settings.approvalPolicies.${policy}`)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.defaultSandboxMode")}
                description={t("settings.descriptions.defaultSandboxMode")}
                controlId="default_sandbox_mode"
                control={
                  <select
                    id="default_sandbox_mode"
                    value={runtimePreferences.defaultSandboxMode}
                    onChange={updateDefaultSandboxMode}
                    disabled={runtimeControlsDisabled}
                  >
                    {THREAD_SANDBOX_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`settings.sandboxModes.${mode}`)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t("settings.fields.permissionRules")}
                description={t("settings.descriptions.permissionRules")}
                wide
                control={
                  <div className="ds-settings-permission-rules">
                    {runtimePreferences.permissionRules.length === 0 ? (
                      <p className="ds-settings-empty-note">
                        {t("settings.permissionRules.empty")}
                      </p>
                    ) : null}
                    {runtimePreferences.permissionRules.map((rule) => (
                      <div className="ds-settings-permission-rule" key={rule.id}>
                        <select
                          value={rule.tool}
                          aria-label={t("settings.fields.permissionRuleTool")}
                          disabled={runtimeControlsDisabled}
                          onChange={(event) =>
                            updateRuntimePermissionRule(rule.id, "tool", event.target.value)
                          }
                        >
                          {RUNTIME_PERMISSION_RULE_TOOLS.map((tool) => (
                            <option key={tool} value={tool}>
                              {t(`settings.permissionRuleTools.${tool}`)}
                            </option>
                          ))}
                        </select>
                        <input
                          value={permissionRulePatternDrafts[rule.id] ?? rule.pattern}
                          aria-label={t("settings.fields.permissionRulePattern")}
                          placeholder={t("settings.placeholders.permissionRulePattern")}
                          disabled={runtimeControlsDisabled}
                          onChange={(event) =>
                            updateRuntimePermissionRulePatternDraft(rule.id, event.target.value)
                          }
                          onBlur={(event) =>
                            commitRuntimePermissionRulePattern(
                              rule.id,
                              event.currentTarget.value,
                            )
                          }
                          onKeyDown={(event) =>
                            handlePermissionRulePatternKeyDown(rule.id, event)
                          }
                        />
                        <select
                          value={rule.effect}
                          aria-label={t("settings.fields.permissionRuleEffect")}
                          disabled={runtimeControlsDisabled}
                          onChange={(event) =>
                            updateRuntimePermissionRule(rule.id, "effect", event.target.value)
                          }
                        >
                          {RUNTIME_PERMISSION_RULE_EFFECTS.map((effect) => (
                            <option key={effect} value={effect}>
                              {t(`settings.permissionRuleEffects.${effect}`)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="ds-settings-secondary-action"
                          disabled={runtimeControlsDisabled}
                          onClick={() => deleteRuntimePermissionRule(rule.id)}
                        >
                          {t("settings.actions.deleteRule")}
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="ds-settings-primary-action"
                      disabled={runtimeControlsDisabled}
                      onClick={addRuntimePermissionRule}
                    >
                      {t("settings.actions.addRule")}
                    </button>
                  </div>
                }
              />
            </SettingsCard>
          ) : null}

          {section === "tools" && category === "toolAccess" ? (
            <SettingsCard
              title={t("settings.sections.toolAccess")}
              description={t("settings.sections.toolAccessDesc")}
            >
              <div className="ds-settings-tool-grid">
                {RUNTIME_TOOL_NAMES.map((toolName) => (
                  <div className="ds-settings-tool-row" key={toolName}>
                    <span>{t(`settings.toolNames.${toolName}`)}</span>
                    <Toggle
                      checked={runtimePreferences.toolAvailability.code[toolName]}
                      label={t("settings.fields.codeToolAccess")}
                      disabled={runtimeControlsDisabled}
                      onChange={(checked) =>
                        updateRuntimeToolAvailability("code", toolName, checked)
                      }
                    />
                    <Toggle
                      checked={runtimePreferences.toolAvailability.write[toolName]}
                      label={t("settings.fields.writeToolAccess")}
                      disabled={runtimeControlsDisabled}
                      onChange={(checked) =>
                        updateRuntimeToolAvailability("write", toolName, checked)
                      }
                    />
                  </div>
                ))}
              </div>
            </SettingsCard>
          ) : null}

          {section === "tools" && category === "mcpServers" ? (
            <SettingsCard
              title={t("settings.sections.mcpServers")}
              description={t("settings.sections.mcpServersDesc")}
            >
              <div className="ds-settings-mcp-list">
                {runtimePreferences.mcpServers.length === 0 ? (
                  <p className="ds-settings-empty-note">
                    {t("settings.mcpServers.empty")}
                  </p>
                ) : null}
                {runtimePreferences.mcpServers.map((server) => (
                  <article className="ds-settings-mcp-server" key={server.id}>
                    <div className="ds-settings-mcp-header">
                      <div>
                        <strong>{server.name}</strong>
                        <span>{mcpServerConnectionLabel(server, mcpServerStatuses[server.id], t)}</span>
                      </div>
                      <Toggle
                        checked={server.enabled}
                        label={t("settings.fields.mcpServerEnabled")}
                        disabled={runtimeControlsDisabled}
                        onChange={(checked) => updateMcpServer(server.id, { enabled: checked })}
                      />
                    </div>
                    <div className="ds-settings-mcp-grid">
                      <label>
                        <span>{t("settings.fields.mcpServerTransport")}</span>
                        <select
                          value={server.transport}
                          disabled={runtimeControlsDisabled}
                          onChange={(event) =>
                            updateMcpServerTransport(
                              server.id,
                              event.target.value as McpServerTransport,
                            )
                          }
                        >
                          {MCP_SERVER_TRANSPORTS.map((transport) => (
                            <option key={transport} value={transport}>
                              {t(`settings.mcpTransports.${transport}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>{t("settings.fields.mcpServerName")}</span>
                        <input
                          value={server.name}
                          disabled={runtimeControlsDisabled}
                          onChange={(event) =>
                            updateMcpServer(server.id, { name: event.target.value })
                          }
                        />
                      </label>
                      {server.transport === "stdio" ? (
                        <>
                          <label>
                            <span>{t("settings.fields.mcpServerCommand")}</span>
                            <input
                              value={server.command ?? ""}
                              placeholder={t("settings.placeholders.mcpServerCommand")}
                              disabled={runtimeControlsDisabled}
                              onChange={(event) =>
                                updateMcpServer(server.id, { command: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("settings.fields.mcpServerArgs")}</span>
                            <input
                              value={server.args.join(" ")}
                              placeholder={t("settings.placeholders.mcpServerArgs")}
                              disabled={runtimeControlsDisabled}
                              onChange={(event) =>
                                updateMcpServer(server.id, {
                                  args: splitWhitespaceList(event.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("settings.fields.mcpServerCwd")}</span>
                            <input
                              value={server.cwd ?? ""}
                              placeholder={t("settings.placeholders.mcpServerCwd")}
                              disabled={runtimeControlsDisabled}
                              onChange={(event) =>
                                updateMcpServer(server.id, {
                                  cwd: event.target.value.trim() || undefined,
                                })
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <>
                          <label>
                            <span>{t("settings.fields.mcpServerUrl")}</span>
                            <input
                              value={server.url ?? ""}
                              placeholder={t("settings.placeholders.mcpServerUrl")}
                              disabled={runtimeControlsDisabled}
                              onChange={(event) =>
                                updateMcpServer(server.id, { url: event.target.value })
                              }
                            />
                          </label>
                          <label className="is-wide">
                            <span>{t("settings.fields.mcpServerHeaders")}</span>
                            <textarea
                              key={`${server.id}:${JSON.stringify(server.headers)}:headers`}
                              defaultValue={JSON.stringify(server.headers, null, 2)}
                              disabled={runtimeControlsDisabled}
                              rows={4}
                              spellCheck={false}
                              onBlur={(event) =>
                                updateMcpServerHeaders(server.id, event.currentTarget.value)
                              }
                            />
                          </label>
                        </>
                      )}
                      <label>
                        <span>{t("settings.fields.mcpServerReadOnlyTools")}</span>
                        <input
                          value={server.readOnlyTools.join(", ")}
                          disabled={runtimeControlsDisabled}
                          onChange={(event) =>
                            updateMcpServer(server.id, {
                              readOnlyTools: splitCommaList(event.target.value),
                            })
                          }
                        />
                      </label>
                      {server.transport === "stdio" ? (
                        <label className="is-wide">
                          <span>{t("settings.fields.mcpServerEnv")}</span>
                          <textarea
                            key={`${server.id}:${JSON.stringify(server.env)}:env`}
                            defaultValue={JSON.stringify(server.env, null, 2)}
                            disabled={runtimeControlsDisabled}
                            rows={4}
                            spellCheck={false}
                            onBlur={(event) =>
                              updateMcpServerEnv(server.id, event.currentTarget.value)
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                    <McpServerSurfaceSummary
                      status={mcpServerStatuses[server.id]}
                      emptyLabel={t("settings.mcpServers.surfaceEmpty")}
                      toolsLabel={t("settings.mcpServers.tools")}
                      promptsLabel={t("settings.mcpServers.prompts")}
                      resourcesLabel={t("settings.mcpServers.resources")}
                      t={t}
                    />
                    <div className="ds-settings-mcp-actions">
                      <button
                        type="button"
                        className="ds-settings-secondary-action"
                        disabled={runtimeControlsDisabled || !window.agentApi}
                        onClick={() => void handleMcpConnect(server.id)}
                      >
                        {t("settings.actions.connectMcpServer")}
                      </button>
                      <button
                        type="button"
                        className="ds-settings-secondary-action"
                        disabled={runtimeControlsDisabled || !window.agentApi}
                        onClick={() => void handleMcpDisconnect(server.id)}
                      >
                        {t("settings.actions.disconnectMcpServer")}
                      </button>
                      <button
                        type="button"
                        className="ds-settings-secondary-action"
                        disabled={runtimeControlsDisabled || !window.agentApi}
                        onClick={() => void handleMcpRefreshTools(server.id)}
                      >
                        {t("settings.actions.refreshMcpServer")}
                      </button>
                      <button
                        type="button"
                        className="ds-settings-secondary-action"
                        disabled={runtimeControlsDisabled}
                        onClick={() => deleteMcpServer(server.id)}
                      >
                        {t("settings.actions.deleteMcpServer")}
                      </button>
                    </div>
                  </article>
                ))}
                <button
                  type="button"
                  className="ds-settings-primary-action"
                  disabled={runtimeControlsDisabled}
                  onClick={addMcpServer}
                >
                  {t("settings.actions.addMcpServer")}
                </button>
              </div>
            </SettingsCard>
          ) : null}

          {section === "tools" && category === "commandLimits" ? (
            <SettingsCard
              title={t("settings.sections.commandLimits")}
              description={t("settings.sections.commandLimitsDesc")}
            >
              <SettingRow
                title={t("settings.fields.commandTimeout")}
                description={t("settings.descriptions.commandTimeout")}
                controlId="command_timeout_ms"
                control={
                  <input
                    id="command_timeout_ms"
                    type="number"
                    min={MIN_RUNTIME_COMMAND_TIMEOUT_MS}
                    max={MAX_RUNTIME_COMMAND_TIMEOUT_MS}
                    value={commandDraft.timeoutMs}
                    placeholder={String(DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS)}
                    disabled={runtimeControlsDisabled}
                    onChange={(event) =>
                      updateCommandDraft("timeoutMs", event.target.value)
                    }
                    onBlur={(event) =>
                      void commitCommandDraft("timeoutMs", event.currentTarget.value)
                    }
                    onKeyDown={(event) => handleCommandDraftKeyDown("timeoutMs", event)}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.commandMaxOutput")}
                description={t("settings.descriptions.commandMaxOutput")}
                controlId="command_max_output_bytes"
                control={
                  <input
                    id="command_max_output_bytes"
                    type="number"
                    min={MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES}
                    max={MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES}
                    value={commandDraft.maxOutputBytes}
                    placeholder={String(DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES)}
                    disabled={runtimeControlsDisabled}
                    onChange={(event) =>
                      updateCommandDraft("maxOutputBytes", event.target.value)
                    }
                    onBlur={(event) =>
                      void commitCommandDraft(
                        "maxOutputBytes",
                        event.currentTarget.value,
                      )
                    }
                    onKeyDown={(event) =>
                      handleCommandDraftKeyDown("maxOutputBytes", event)
                    }
                  />
                }
              />
            </SettingsCard>
          ) : null}

          {section === "visibility" && category === "approvalPresentation" ? (
            <SettingsCard
              title={t("settings.sections.approvalPresentation")}
              description={t("settings.sections.approvalPresentationDesc")}
            >
              <SettingRow
                title={t("settings.fields.showDiffByDefault")}
                description={t("settings.descriptions.showDiffByDefault")}
                control={
                  <Toggle
                    checked={runtimePreferences.approvalExperience.showDiffByDefault}
                    label={t("settings.fields.showDiffByDefault")}
                    disabled={runtimeControlsDisabled}
                    onChange={(checked) =>
                      void updateRuntimePreferences({
                        approvalExperience: { showDiffByDefault: checked },
                      })
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.autoScrollOnRequest")}
                description={t("settings.descriptions.autoScrollOnRequest")}
                control={
                  <Toggle
                    checked={runtimePreferences.approvalExperience.autoScrollOnRequest}
                    label={t("settings.fields.autoScrollOnRequest")}
                    disabled={runtimeControlsDisabled}
                    onChange={(checked) =>
                      void updateRuntimePreferences({
                        approvalExperience: { autoScrollOnRequest: checked },
                      })
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.showReadOnlyToolRecords")}
                description={t("settings.descriptions.showReadOnlyToolRecords")}
                control={
                  <Toggle
                    checked={runtimePreferences.approvalExperience.showReadOnlyToolRecords}
                    label={t("settings.fields.showReadOnlyToolRecords")}
                    disabled={runtimeControlsDisabled}
                    onChange={(checked) =>
                      void updateRuntimePreferences({
                        approvalExperience: { showReadOnlyToolRecords: checked },
                      })
                    }
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.showFailureToasts")}
                description={t("settings.descriptions.showFailureToasts")}
                control={
                  <Toggle
                    checked={runtimePreferences.approvalExperience.showFailureToasts}
                    label={t("settings.fields.showFailureToasts")}
                    disabled={runtimeControlsDisabled}
                    onChange={(checked) =>
                      void updateRuntimePreferences({
                        approvalExperience: { showFailureToasts: checked },
                      })
                    }
                  />
                }
              />
            </SettingsCard>
          ) : null}
        </div>
      </form>
    </main>
  );
}

export function formatSkillTriggerSummary(
  skill: RuntimeSkillCatalogEntry,
  t: SettingsTranslator,
): string {
  const parts: string[] = [];
  if (skill.trigger.manual) {
    parts.push(t("settings.skills.manualTrigger"));
  }
  if (skill.trigger.commands.length > 0) {
    parts.push(t("settings.skills.commands", {
      values: skill.trigger.commands.join(", "),
    }));
  }
  if (skill.trigger.keywords.length > 0) {
    parts.push(t("settings.skills.keywords", {
      values: skill.trigger.keywords.join(", "),
    }));
  }
  if (skill.trigger.promptPatterns.length > 0) {
    parts.push(t("settings.skills.promptPatterns", {
      values: skill.trigger.promptPatterns.join(", "),
    }));
  }
  if (skill.trigger.fileTypes.length > 0) {
    parts.push(t("settings.skills.fileTypes", {
      values: skill.trigger.fileTypes.join(", "),
    }));
  }
  return parts.length > 0 ? parts.join(" · ") : t("settings.skills.noTriggers");
}

function McpServerSurfaceSummary({
  status,
  emptyLabel,
  toolsLabel,
  promptsLabel,
  resourcesLabel,
  t,
}: {
  status?: McpServerStatusRecord;
  emptyLabel: string;
  toolsLabel: string;
  promptsLabel: string;
  resourcesLabel: string;
  t: SettingsTranslator;
}): ReactElement {
  if (!status) {
    return <p className="ds-settings-mcp-surface-empty">{emptyLabel}</p>;
  }
  const startupStats = formatMcpStartupStats(status, t);
  return (
    <div className="ds-settings-mcp-surface">
      <div className="ds-settings-mcp-surface-counts">
        <span>{toolsLabel}: {status.toolCount}</span>
        <span>{promptsLabel}: {status.promptCount}</span>
        <span>{resourcesLabel}: {status.resourceCount}</span>
      </div>
      {startupStats ? (
        <p className="ds-settings-mcp-surface-meta">{startupStats}</p>
      ) : null}
      {status.lastError ? (
        <p className="ds-settings-mcp-surface-error">{status.lastError}</p>
      ) : null}
      <McpSurfaceList
        label={toolsLabel}
        values={status.tools.map((tool) => tool.name)}
      />
      <McpSurfaceList
        label={promptsLabel}
        values={status.prompts.map((prompt) => prompt.name)}
      />
      <McpSurfaceList
        label={resourcesLabel}
        values={status.resources.map((resource) => resource.name || resource.uri)}
      />
    </div>
  );
}

function McpSurfaceList({
  label,
  values,
}: {
  label: string;
  values: string[];
}): ReactElement | null {
  if (values.length === 0) return null;
  return (
    <div className="ds-settings-mcp-surface-list">
      <strong>{label}</strong>
      <span>{values.slice(0, 6).join(", ")}</span>
    </div>
  );
}

export function messageOfUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings consumes process-level SSE events even when no thread is active.
 * Cleanup is intentionally ordered behind a successful subscribe so route
 * changes during IPC setup cannot leave a main-process global listener alive.
 */
export function subscribeSettingsGlobalRuntimeEvents(
  sse: SettingsSseApi,
  listener: (event: RuntimeEvent) => void,
  onSubscribeError: (message: string) => void,
): () => void {
  let disposed = false;
  let subscribed = false;
  let unsubscribeStarted = false;
  const unsubscribeEvent = sse.onEvent(listener);

  const releaseGlobalSubscription = (): void => {
    if (unsubscribeStarted) return;
    unsubscribeStarted = true;
    void sse.unsubscribeGlobal().then((result) => {
      if (!result.ok && result.code !== IPC_ERROR_CODES.SSE_NOT_SUBSCRIBED) {
        console.warn("[settings] failed to unsubscribe global SSE:", result.message);
      }
    }).catch((error: unknown) => {
      console.warn("[settings] failed to unsubscribe global SSE:", error);
    });
  };

  void sse.subscribeGlobal().then((result) => {
    if (!result.ok) {
      if (!disposed) onSubscribeError(result.message);
      return;
    }
    subscribed = true;
    if (disposed) releaseGlobalSubscription();
  }).catch((error: unknown) => {
    if (!disposed) onSubscribeError(messageOfUnknownError(error));
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeEvent();
    if (subscribed) releaseGlobalSubscription();
  };
}

function isSettingsLocale(value: string): value is LocaleCode {
  return SUPPORTED_LOCALES.includes(value as LocaleCode);
}
