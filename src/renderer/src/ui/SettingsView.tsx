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
  LLM_PROTOCOLS,
  MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
  MODEL_REASONING_EFFORTS,
  RUNTIME_COMPACTION_STRATEGIES,
  RUNTIME_TOOL_NAMES,
  THREAD_APPROVAL_POLICIES,
  THREAD_SANDBOX_MODES,
  type AgentAutonomyLevel,
  type LlmProtocol,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
  type ModelReasoningEffort,
  type RuntimeCompactionStrategy,
  type RuntimePreferences,
  type RuntimePreferencesUpdate,
  type RuntimeToolName,
  type ThreadApprovalPolicy,
  type ThreadSandboxMode,
} from "../../../shared/agent-contracts";
import { useWorkbench } from "./store/WorkbenchContext";
import {
  SecretInput,
  SettingRow,
  SettingsCard,
  StatusBadge,
  Toggle,
} from "./components/settings/SettingsControls";
import {
  SettingsSidebar,
  type SettingsCategory,
  type SettingsSidebarItem,
} from "./components/settings/SettingsSidebar";
import {
  filterSettingsSidebarItems,
  getSettingsCategorySearchKeywords,
  isSettingsCategoryAdvanced,
} from "./components/settings/settings-search";
import { i18n, persistLocale, setFollowSystemTheme, setTheme } from "../i18n";
import {
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
  type DefaultInspectorMode,
  type DefaultStartupView,
  type ThemePreference,
} from "./preferences";

export interface SettingsFormState {
  model_provide: string;
  model: string;
  protocol: LlmProtocol;
  base_url: string;
  OPENAI_API_KEY: string;
  model_context_window: string;
  model_auto_compact_token_limit: string;
  max_tokens: string;
  thinking: boolean;
  model_reasoning_effort: ModelReasoningEffort;
  agent_autonomy: AgentAutonomyLevel;
}

export type SaveState = "idle" | "dirty" | "loading" | "saving" | "saved" | "error";
type RuntimeSaveState = Exclude<SaveState, "dirty">;
type RuntimeCommandDraftField = "timeoutMs" | "maxOutputBytes";
interface RuntimeCommandDraft {
  timeoutMs: string;
  maxOutputBytes: string;
}
type SettingsSection =
  | "basic"
  | "model"
  | "agent"
  | "tools"
  | "workbench"
  | "visibility";
type SettingsTranslator = (key: string, options?: Record<string, unknown>) => string;

interface SettingsSectionItem {
  id: SettingsSection;
  label: string;
  description: string;
}

const MODEL_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "profiles",
  "connection",
  "context",
  "reasoning",
];
const BASIC_SETTINGS_CATEGORIES: readonly SettingsCategory[] = ["appearance"];
const AGENT_SETTINGS_CATEGORIES: readonly SettingsCategory[] = ["compaction"];
const TOOLS_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "permissions",
  "toolAccess",
  "commandLimits",
];
const WORKBENCH_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "startup",
  "layout",
  "session",
  "modelDefaults",
  "attachments",
];
const VISIBILITY_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "approvalPresentation",
];
const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark"];
const STARTUP_VIEWS: readonly DefaultStartupView[] = ["code", "write"];
const DEFAULT_INSPECTOR_MODES: readonly DefaultInspectorMode[] = [
  null,
  "changes",
  "todo",
  "plan",
];

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
  const [commandDraft, setCommandDraft] = useState<RuntimeCommandDraft>(() =>
    toRuntimeCommandDraft(state.runtimePreferences.command),
  );
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
    () => [
      {
        id: "basic",
        label: t("settings.sectionTabs.basic"),
        description: t("settings.sectionTabs.basicDesc"),
      },
      {
        id: "model",
        label: t("settings.sectionTabs.model"),
        description: t("settings.sectionTabs.modelDesc"),
      },
      {
        id: "agent",
        label: t("settings.sectionTabs.agent"),
        description: t("settings.sectionTabs.agentDesc"),
      },
      {
        id: "tools",
        label: t("settings.sectionTabs.tools"),
        description: t("settings.sectionTabs.toolsDesc"),
      },
      {
        id: "workbench",
        label: t("settings.sectionTabs.workbench"),
        description: t("settings.sectionTabs.workbenchDesc"),
      },
      {
        id: "visibility",
        label: t("settings.sectionTabs.visibility"),
        description: t("settings.sectionTabs.visibilityDesc"),
      },
    ],
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
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

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

  function updateCompactionStrategy(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as RuntimeCompactionStrategy;
    void updateRuntimePreferences({ compaction: { strategy: value } });
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

function toFormState(config: ModelConfig): SettingsFormState {
  return {
    model_provide: config.model_provide,
    model: config.model,
    protocol: config.protocol,
    base_url: config.base_url,
    OPENAI_API_KEY: config.OPENAI_API_KEY,
    model_context_window: String(config.model_context_window),
    model_auto_compact_token_limit: String(config.model_auto_compact_token_limit),
    max_tokens: String(config.max_tokens),
    thinking: config.thinking,
    model_reasoning_effort: config.model_reasoning_effort,
    agent_autonomy: config.agent_autonomy,
  };
}

function toRuntimeCommandDraft(
  command: RuntimePreferences["command"],
): RuntimeCommandDraft {
  return {
    timeoutMs: String(command.timeoutMs),
    maxOutputBytes: String(command.maxOutputBytes),
  };
}

export function toUpdatePayload(form: SettingsFormState): ModelConfigUpdate {
  const contextWindow = parseOptionalInteger(
    form.model_context_window,
    "model_context_window",
  );
  const compactLimit = parseOptionalInteger(
    form.model_auto_compact_token_limit,
    "model_auto_compact_token_limit",
  );
  const maxTokens = parseOptionalInteger(form.max_tokens, "max_tokens");
  return {
    model_provide: form.model_provide,
    model: form.model,
    protocol: form.protocol,
    base_url: form.base_url,
    OPENAI_API_KEY: form.OPENAI_API_KEY,
    ...(contextWindow !== undefined ? { model_context_window: contextWindow } : {}),
    ...(compactLimit !== undefined
      ? { model_auto_compact_token_limit: compactLimit }
      : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    thinking: form.thinking,
    model_reasoning_effort: form.model_reasoning_effort,
    agent_autonomy: form.agent_autonomy,
  };
}

export function validateModelSettingsForm(
  form: SettingsFormState,
  currentConfig: ModelConfig,
  t: SettingsTranslator,
): string | null {
  const contextWindow = parseOptionalPositiveIntegerForValidation(
    form.model_context_window,
    t("settings.fields.contextWindow"),
    t,
  );
  if (!contextWindow.ok) return contextWindow.message;

  const compactLimit = parseOptionalPositiveIntegerForValidation(
    form.model_auto_compact_token_limit,
    t("settings.fields.compactLimit"),
    t,
  );
  if (!compactLimit.ok) return compactLimit.message;

  const maxTokens = parseOptionalPositiveIntegerForValidation(
    form.max_tokens,
    t("settings.fields.maxTokens"),
    t,
  );
  if (!maxTokens.ok) return maxTokens.message;

  const effectiveContextWindow =
    contextWindow.value ?? currentConfig.model_context_window;
  const effectiveCompactLimit =
    compactLimit.value ?? currentConfig.model_auto_compact_token_limit;
  const effectiveMaxTokens = maxTokens.value ?? currentConfig.max_tokens;

  if (effectiveCompactLimit > effectiveContextWindow) {
    return t("settings.errors.compactLimitTooLarge");
  }
  if (effectiveMaxTokens >= effectiveContextWindow) {
    return t("settings.errors.maxTokensTooLarge");
  }
  return null;
}

function parseOptionalInteger(raw: string, field: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

type IntegerValidationResult =
  | { ok: true; value: number | undefined }
  | { ok: false; message: string };

type RuntimeCommandDraftValidationResult =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

type BasicPreferenceDraftValidationResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

export function validateRuntimeCommandDraft(
  field: RuntimeCommandDraftField,
  raw: string,
  t: SettingsTranslator,
): RuntimeCommandDraftValidationResult {
  const label = field === "timeoutMs"
    ? t("settings.fields.commandTimeout")
    : t("settings.fields.commandMaxOutput");
  const min = field === "timeoutMs"
    ? MIN_RUNTIME_COMMAND_TIMEOUT_MS
    : MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
  const max = field === "timeoutMs"
    ? MAX_RUNTIME_COMMAND_TIMEOUT_MS
    : MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: t("settings.errors.positiveInteger", { field: label }),
    };
  }
  if (parsed < min || parsed > max) {
    return {
      ok: false,
      message: t("settings.errors.integerRange", { field: label, min, max }),
    };
  }
  return { ok: true, value: parsed };
}

export function validateCodeBlockCollapseLineThreshold(
  raw: string,
  t: SettingsTranslator,
): BasicPreferenceDraftValidationResult {
  const label = t("settings.fields.codeBlockCollapseLineThreshold");
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: t("settings.errors.positiveInteger", { field: label }),
    };
  }
  if (
    parsed < CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN ||
    parsed > CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX
  ) {
    return {
      ok: false,
      message: t("settings.errors.integerRange", {
        field: label,
        min: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
        max: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
      }),
    };
  }
  return { ok: true, value: parsed };
}

export function shouldDisableRuntimePreferenceControls(
  hasAgentApi: boolean,
  runtimeSaveState: RuntimeSaveState,
): boolean {
  return !hasAgentApi || runtimeSaveState === "loading" || runtimeSaveState === "saving";
}

export function mergeRuntimePreferencesUpdates(
  current: RuntimePreferencesUpdate | null,
  update: RuntimePreferencesUpdate,
): RuntimePreferencesUpdate {
  if (!current) {
    return cloneRuntimePreferencesUpdate(update);
  }
  return {
    ...current,
    ...update,
    ...(current.toolAvailability || update.toolAvailability
      ? {
          toolAvailability: {
            ...current.toolAvailability,
            ...update.toolAvailability,
            code: {
              ...current.toolAvailability?.code,
              ...update.toolAvailability?.code,
            },
            write: {
              ...current.toolAvailability?.write,
              ...update.toolAvailability?.write,
            },
          },
        }
      : {}),
    ...(current.approvalExperience || update.approvalExperience
      ? {
          approvalExperience: {
            ...current.approvalExperience,
            ...update.approvalExperience,
          },
        }
      : {}),
    ...(current.command || update.command
      ? { command: { ...current.command, ...update.command } }
      : {}),
    ...(current.compaction || update.compaction
      ? { compaction: { ...current.compaction, ...update.compaction } }
      : {}),
  };
}

function cloneRuntimePreferencesUpdate(
  update: RuntimePreferencesUpdate,
): RuntimePreferencesUpdate {
  return mergeRuntimePreferencesUpdates({}, update);
}

export function messageOfUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseOptionalPositiveIntegerForValidation(
  raw: string,
  fieldLabel: string,
  t: SettingsTranslator,
): IntegerValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: t("settings.errors.positiveInteger", { field: fieldLabel }),
    };
  }
  return { ok: true, value: parsed };
}

function findActiveProfile(
  state: ModelConfigProfilesState,
): ModelConfigProfile | null {
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    state.profiles[0] ??
    null
  );
}

function createCustomModelConfig(): ModelConfig {
  return {
    ...DEFAULT_MODEL_CONFIG,
    model_provide: "Custom",
    model: "gpt-4.1",
    base_url: "https://api.openai.com/v1",
    thinking: false,
  };
}

function isSettingsLocale(value: string): value is LocaleCode {
  return SUPPORTED_LOCALES.includes(value as LocaleCode);
}

function isLlmProtocolSetting(value: string): value is LlmProtocol {
  return LLM_PROTOCOLS.includes(value as LlmProtocol);
}

function isDefaultStartupViewSetting(value: string): value is DefaultStartupView {
  return STARTUP_VIEWS.includes(value as DefaultStartupView);
}

function emptyStringToNullableProfileId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function toDefaultInspectorModeValue(mode: DefaultInspectorMode): string {
  return mode ?? "closed";
}

export function toDefaultInspectorMode(value: string): DefaultInspectorMode {
  if (value === "changes" || value === "todo" || value === "plan") return value;
  return null;
}

export function isProfileDeletePending(
  pendingDeleteProfileId: string | null,
  profileId: string,
): boolean {
  return pendingDeleteProfileId === profileId;
}

export function prunePendingProfileDeleteId(
  pendingDeleteProfileId: string | null,
  profiles: readonly Pick<ModelConfigProfile, "id">[],
): string | null {
  if (!pendingDeleteProfileId) return null;
  return profiles.some((profile) => profile.id === pendingDeleteProfileId)
    ? pendingDeleteProfileId
    : null;
}

export function shouldBlockSettingsNavigation(
  saveState: SaveState,
  hasUnsavedChanges = false,
): boolean {
  return saveState === "dirty" || (saveState === "error" && hasUnsavedChanges);
}

export function shouldAllowSettingsCategorySelection(
  currentCategory: SettingsCategory,
  nextCategory: SettingsCategory,
  saveState: SaveState,
  hasUnsavedChanges = false,
): boolean {
  return (
    currentCategory === nextCategory ||
    !shouldBlockSettingsNavigation(saveState, hasUnsavedChanges)
  );
}

export function shouldDisableModelProfileControls(
  hasAgentApi: boolean,
  saveState: SaveState,
  profileBusy: string,
): boolean {
  return !hasAgentApi ||
    saveState === "loading" ||
    saveState === "saving" ||
    Boolean(profileBusy);
}

export function canSubmitModelSettingsSection(
  section: SettingsSection,
  category: SettingsCategory,
): boolean {
  return section === "model" && category !== "profiles";
}

export function clearDeletedDefaultProfileReferences(
  preferences: RuntimePreferences,
  deletedProfileId: string,
): RuntimePreferences {
  const codeDefaultModelProfileId =
    preferences.codeDefaultModelProfileId === deletedProfileId
      ? null
      : preferences.codeDefaultModelProfileId;
  const writeDefaultModelProfileId =
    preferences.writeDefaultModelProfileId === deletedProfileId
      ? null
      : preferences.writeDefaultModelProfileId;
  if (
    codeDefaultModelProfileId === preferences.codeDefaultModelProfileId &&
    writeDefaultModelProfileId === preferences.writeDefaultModelProfileId
  ) {
    return preferences;
  }
  return {
    ...preferences,
    codeDefaultModelProfileId,
    writeDefaultModelProfileId,
  };
}

export function resolveRuntimePreferencesAfterProfileActivationRefreshFailure(
  preferences: RuntimePreferences,
): RuntimePreferences {
  return preferences;
}

function hasUnsavedProfileChanges(
  activeProfile: ModelConfigProfile | null,
  profileName: string,
  form: SettingsFormState,
): boolean {
  if (!activeProfile) return false;
  return (
    profileName !== activeProfile.name ||
    form.model_provide !== activeProfile.config.model_provide ||
    form.model !== activeProfile.config.model ||
    form.protocol !== activeProfile.config.protocol ||
    form.base_url !== activeProfile.config.base_url ||
    form.OPENAI_API_KEY !== activeProfile.config.OPENAI_API_KEY ||
    form.model_context_window !== String(activeProfile.config.model_context_window) ||
    form.model_auto_compact_token_limit !==
      String(activeProfile.config.model_auto_compact_token_limit) ||
    form.max_tokens !== String(activeProfile.config.max_tokens) ||
    form.thinking !== activeProfile.config.thinking ||
    form.model_reasoning_effort !== activeProfile.config.model_reasoning_effort ||
    form.agent_autonomy !== activeProfile.config.agent_autonomy
  );
}

export function getDefaultCategoryForSection(
  section: SettingsSection,
): SettingsCategory {
  switch (section) {
    case "basic":
      return "appearance";
    case "model":
      return "profiles";
    case "agent":
      return "compaction";
    case "tools":
      return "permissions";
    case "workbench":
      return "startup";
    case "visibility":
      return "approvalPresentation";
  }
}

export function isSettingsCategoryInSection(
  section: SettingsSection,
  category: SettingsCategory,
): boolean {
  return getSettingsCategoriesForSection(section).includes(category);
}

export function getFirstVisibleSettingsCategoryForSection(
  section: SettingsSection,
  showAdvanced: boolean,
): SettingsCategory | null {
  return getSettingsCategoriesForSection(section)
    .find((category) => showAdvanced || !isSettingsCategoryAdvanced(category)) ?? null;
}

function getSettingsCategoriesForSection(
  section: SettingsSection,
): readonly SettingsCategory[] {
  switch (section) {
    case "basic":
      return BASIC_SETTINGS_CATEGORIES;
    case "model":
      return MODEL_SETTINGS_CATEGORIES;
    case "agent":
      return AGENT_SETTINGS_CATEGORIES;
    case "tools":
      return TOOLS_SETTINGS_CATEGORIES;
    case "workbench":
      return WORKBENCH_SETTINGS_CATEGORIES;
    case "visibility":
      return VISIBILITY_SETTINGS_CATEGORIES;
  }
}

function getSettingsNavItems(
  section: SettingsSection,
  t: SettingsTranslator,
): SettingsSidebarItem[] {
  return getSettingsCategoriesForSection(section).map((category, index) => ({
    id: category,
    label: t(`settings.nav.${category}`),
    description: t(`settings.nav.${category}Desc`),
    marker: String(index + 1).padStart(2, "0"),
    advanced: isSettingsCategoryAdvanced(category),
    searchKeywords: getSettingsCategorySearchKeywords(category, t),
  }));
}
