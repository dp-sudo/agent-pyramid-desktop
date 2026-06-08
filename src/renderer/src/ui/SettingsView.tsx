import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
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
  MODEL_REASONING_EFFORTS,
  type AgentAutonomyLevel,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
  type ModelReasoningEffort,
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
import { i18n, persistLocale, setFollowSystemTheme, setTheme } from "../i18n";
import type {
  DefaultInspectorMode,
  DefaultStartupView,
  ThemePreference,
} from "./preferences";

interface SettingsFormState {
  model_provide: string;
  model: string;
  base_url: string;
  OPENAI_API_KEY: string;
  model_context_window: string;
  model_auto_compact_token_limit: string;
  max_tokens: string;
  thinking: boolean;
  model_reasoning_effort: ModelReasoningEffort;
  agent_autonomy: AgentAutonomyLevel;
}

type SaveState = "idle" | "dirty" | "loading" | "saving" | "saved" | "error";
type SettingsSection = "basic" | "model";

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
const BASIC_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "appearance",
  "startup",
  "session",
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
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [error, setError] = useState<string>("");
  const [profileBusy, setProfileBusy] = useState<string>("");
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const activeProfile = profilesState ? findActiveProfile(profilesState) : null;
  const hasAgentApi = Boolean(window.agentApi);
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
    ],
    [t],
  );
  const settingsNavItems = useMemo<SettingsSidebarItem[]>(() => {
    if (section === "basic") {
      return [
        {
          id: "appearance",
          label: t("settings.nav.appearance"),
          description: t("settings.nav.appearanceDesc"),
          marker: "01",
        },
        {
          id: "startup",
          label: t("settings.nav.startup"),
          description: t("settings.nav.startupDesc"),
          marker: "02",
        },
        {
          id: "session",
          label: t("settings.nav.session"),
          description: t("settings.nav.sessionDesc"),
          marker: "03",
        },
      ];
    }
    return [
      {
        id: "profiles",
        label: t("settings.nav.profiles"),
        description: t("settings.nav.profilesDesc"),
        marker: "01",
      },
      {
        id: "connection",
        label: t("settings.nav.connection"),
        description: t("settings.nav.connectionDesc"),
        marker: "02",
      },
      {
        id: "context",
        label: t("settings.nav.context"),
        description: t("settings.nav.contextDesc"),
        marker: "03",
      },
      {
        id: "reasoning",
        label: t("settings.nav.reasoning"),
        description: t("settings.nav.reasoningDesc"),
        marker: "04",
      },
    ];
  }, [section, t]);
  const sidebarFooterTitle =
    section === "basic"
      ? t("settings.sidebarFooter.basicTitle")
      : t("settings.sidebarFooter.modelTitle");
  const sidebarFooterDescription =
    section === "basic"
      ? t("settings.sidebarFooter.basicDescription")
      : t("settings.sidebarFooter.modelDescription");
  const settingsSubtitle =
    section === "basic"
      ? t("settings.subtitles.basic")
      : t("settings.subtitles.model");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!window.agentApi) {
        setSaveState("error");
        setError(t("settings.preloadMissing"));
        return;
      }
      const result = await window.agentApi.modelConfig.listProfiles();
      if (cancelled) return;
      if (result.ok) {
        applyProfilesState(result.value);
        setSaveState("idle");
      } else {
        setSaveState("error");
        setError(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, t]);

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

  function markDirty(): void {
    setSaveState((current) =>
      current === "loading" || current === "saving" ? current : "dirty",
    );
  }

  function ensureNoUnsavedProfileChanges(): boolean {
    if (!shouldBlockSettingsNavigation(saveState, hasUnsavedProfileChanges(activeProfile, profileName, form))) {
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
      setSaveState("saved");
    } finally {
      setProfileBusy("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (section !== "model") return;
    if (!activeProfile) {
      setSaveState("error");
      setError(t("settings.profiles.noActive"));
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

  return (
    <main className="ds-settings-root">
      <SettingsSidebar
        items={settingsNavItems}
        activeCategory={category}
        navLabel={t("settings.navLabel")}
        footerTitle={sidebarFooterTitle}
        footerDescription={sidebarFooterDescription}
        backLabel={t("settings.backToWorkbench")}
        onSelect={setCategory}
        onBack={() => {
          if (ensureNoUnsavedProfileChanges()) {
            actions.setRoute("code");
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

          {section === "basic" && category === "appearance" ? (
            <SettingsCard
              title={t("settings.sections.appearance")}
              description={t("settings.sections.appearanceDesc")}
            >
              <SettingRow
                title={t("settings.fields.locale")}
                description={t("settings.descriptions.locale")}
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

          {section === "basic" && category === "startup" ? (
            <SettingsCard
              title={t("settings.sections.startup")}
              description={t("settings.sections.startupDesc")}
            >
              <SettingRow
                title={t("settings.fields.defaultStartupView")}
                description={t("settings.descriptions.defaultStartupView")}
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
            </SettingsCard>
          ) : null}

          {section === "basic" && category === "session" ? (
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
              <SettingRow
                title={t("settings.fields.confirmThreadDelete")}
                description={t("settings.descriptions.confirmThreadDelete")}
                control={
                  <Toggle
                    checked={preferences.confirmThreadDelete}
                    label={t("settings.fields.confirmThreadDelete")}
                    onChange={(checked) =>
                      actions.updateBasicPreference("confirmThreadDelete", checked)
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
                control={
                  <input
                    id="profile_name"
                    value={profileName}
                    onChange={(event) => updateProfileName(event.target.value)}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.modelProvide")}
                description={t("settings.descriptions.modelProvide")}
                control={
                  <input
                    id="model_provide"
                    value={form.model_provide}
                    onChange={updateText("model_provide")}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.model")}
                description={t("settings.descriptions.model")}
                control={
                  <input
                    id="model"
                    value={form.model}
                    onChange={updateText("model")}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.baseUrl")}
                description={t("settings.descriptions.baseUrl")}
                wide
                control={
                  <input
                    id="base_url"
                    value={form.base_url}
                    onChange={updateText("base_url")}
                    required
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.apiKey")}
                description={t("settings.descriptions.apiKey")}
                wide
                control={
                  <SecretInput
                    id="OPENAI_API_KEY"
                    value={form.OPENAI_API_KEY}
                    visible={showApiKey}
                    autoComplete="off"
                    placeholder={t("settings.placeholders.apiKey")}
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
                control={
                  <input
                    id="model_context_window"
                    value={form.model_context_window}
                    onChange={updateText("model_context_window")}
                    inputMode="numeric"
                    placeholder={String(DEFAULT_MODEL_CONFIG.model_context_window)}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.compactLimit")}
                description={t("settings.descriptions.compactLimit")}
                control={
                  <input
                    id="model_auto_compact_token_limit"
                    value={form.model_auto_compact_token_limit}
                    onChange={updateText("model_auto_compact_token_limit")}
                    inputMode="numeric"
                    placeholder={t("settings.placeholders.compactLimit")}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.maxTokens")}
                description={t("settings.descriptions.maxTokens")}
                control={
                  <input
                    id="max_tokens"
                    value={form.max_tokens}
                    onChange={updateText("max_tokens")}
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
                    onChange={updateThinking}
                  />
                }
              />
              <SettingRow
                title={t("settings.fields.reasoningEffort")}
                description={t("settings.descriptions.reasoningEffort")}
                control={
                  <select
                    id="model_reasoning_effort"
                    value={form.model_reasoning_effort}
                    onChange={updateEffort}
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
                control={
                  <select
                    id="agent_autonomy"
                    value={form.agent_autonomy}
                    onChange={updateAutonomy}
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
        </div>
      </form>
    </main>
  );
}

function toFormState(config: ModelConfig): SettingsFormState {
  return {
    model_provide: config.model_provide,
    model: config.model,
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

function toUpdatePayload(form: SettingsFormState): ModelConfigUpdate {
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

function parseOptionalInteger(raw: string, field: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
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

function isDefaultStartupViewSetting(value: string): value is DefaultStartupView {
  return STARTUP_VIEWS.includes(value as DefaultStartupView);
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

export function shouldBlockSettingsNavigation(
  saveState: SaveState,
  hasUnsavedChanges = false,
): boolean {
  return saveState === "dirty" || (saveState === "error" && hasUnsavedChanges);
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
  }
}

export function isSettingsCategoryInSection(
  section: SettingsSection,
  category: SettingsCategory,
): boolean {
  switch (section) {
    case "basic":
      return BASIC_SETTINGS_CATEGORIES.includes(category);
    case "model":
      return MODEL_SETTINGS_CATEGORIES.includes(category);
  }
}
