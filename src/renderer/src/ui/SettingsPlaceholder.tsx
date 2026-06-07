import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_DEEPSEEK_MODEL_CONFIG,
  DEFAULT_MODEL_CONFIG,
  MODEL_REASONING_EFFORTS,
  type ModelConfig,
  type ModelConfigProfile,
  type ModelConfigProfilesState,
  type ModelConfigUpdate,
  type ModelReasoningEffort,
} from "../../../shared/agent-contracts";
import { useWorkbench } from "./store/WorkbenchContext";
import { Pill } from "./components/primitives/Pill";

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
}

export function SettingsPlaceholder(): ReactElement {
  const { t } = useTranslation();
  const { actions } = useWorkbench();
  const [form, setForm] = useState<SettingsFormState>(() =>
    toFormState(DEFAULT_MODEL_CONFIG),
  );
  const [profileName, setProfileName] = useState(DEFAULT_MODEL_CONFIG.model_provide);
  const [profilesState, setProfilesState] = useState<ModelConfigProfilesState | null>(
    null,
  );
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileBusy, setProfileBusy] = useState<string>("");

  const activeProfile = profilesState
    ? findActiveProfile(profilesState)
    : null;
  const hasAgentApi = Boolean(window.agentApi);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!window.agentApi) {
        setLoading(false);
        setError(t("settings.preloadMissing"));
        return;
      }
      const result = await window.agentApi.modelConfig.listProfiles();
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        applyProfilesState(result.value);
      } else {
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
    }
  }

  function updateText(
    field: keyof Omit<SettingsFormState, "thinking" | "model_reasoning_effort">,
  ): (event: ChangeEvent<HTMLInputElement>) => void {
    return (event) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };
  }

  function updateThinking(event: ChangeEvent<HTMLInputElement>): void {
    setForm((current) => ({ ...current, thinking: event.target.checked }));
  }

  function updateEffort(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value as ModelReasoningEffort;
    setForm((current) => ({ ...current, model_reasoning_effort: value }));
  }

  async function handleActivateProfile(profile: ModelConfigProfile): Promise<void> {
    setProfileBusy(profile.id);
    setStatus("");
    setError("");
    try {
      const result = await window.agentApi.modelConfig.activateProfile({
        id: profile.id,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      applyProfilesState(result.value);
    } finally {
      setProfileBusy("");
    }
  }

  async function handleCreateProfile(
    name: string,
    config: ModelConfig,
  ): Promise<void> {
    setProfileBusy("create");
    setStatus("");
    setError("");
    try {
      const result = await window.agentApi.modelConfig.createProfile({
        name,
        config,
        activate: true,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      applyProfilesState(result.value);
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
    setProfileBusy(profile.id);
    setStatus("");
    setError("");
    try {
      const result = await window.agentApi.modelConfig.deleteProfile({
        id: profile.id,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      applyProfilesState(result.value);
    } finally {
      setProfileBusy("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeProfile) {
      setError(t("settings.profiles.noActive"));
      return;
    }
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const update = toUpdatePayload(form);
      const result = await window.agentApi.modelConfig.updateProfile({
        id: activeProfile.id,
        name: profileName,
        config: update,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const updatedProfile = result.value;
      setProfilesState((current) =>
        current
          ? {
              ...current,
              profiles: current.profiles.map((profile) =>
                profile.id === updatedProfile.id ? updatedProfile : profile,
              ),
            }
          : current,
      );
      setForm(toFormState(updatedProfile.config));
      setProfileName(updatedProfile.name);
      actions.setModelConfig(updatedProfile.config);
      setStatus(t("settings.saved"));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="ds-stage-surface">
      <form className="ds-settings-page" onSubmit={(event) => void handleSubmit(event)}>
        <header className="ds-settings-header">
          <div>
            <h1>{t("settings.title")}</h1>
            <p>{t("settings.subtitle")}</p>
          </div>
          <div className="ds-settings-actions">
            <Pill onClick={() => actions.setRoute("code")}>
              {t("settings.backToWorkbench")}
            </Pill>
            <button
              className="ds-settings-save"
              type="submit"
              disabled={!hasAgentApi || saving || loading}
            >
              {saving ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
        </header>

        <section className="ds-profile-section" aria-label={t("settings.profiles.title")}>
          <div className="ds-profile-section-header">
            <div>
              <h2>{t("settings.profiles.title")}</h2>
              <p>{t("settings.profiles.subtitle")}</p>
            </div>
            <div className="ds-profile-actions">
              <button
                className="ds-profile-action"
                type="button"
                disabled={!hasAgentApi || loading || Boolean(profileBusy)}
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
                disabled={!hasAgentApi || loading || Boolean(profileBusy)}
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
                disabled={!hasAgentApi || loading || Boolean(profileBusy)}
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
          </div>

          <div className="ds-profile-grid">
            {profilesState?.profiles.map((profile) => {
              const isActive = profile.id === profilesState.activeProfileId;
              const isBusy = profileBusy === profile.id;
              return (
                <article
                  className={`ds-profile-card${isActive ? " is-active" : ""}`}
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
                    <button
                      type="button"
                      disabled={!hasAgentApi || loading || Boolean(profileBusy)}
                      onClick={() => void handleDuplicateProfile(profile)}
                    >
                      {t("settings.profiles.duplicate")}
                    </button>
                    <button
                      type="button"
                      disabled={
                        loading ||
                        !hasAgentApi ||
                        Boolean(profileBusy) ||
                        (profilesState?.profiles.length ?? 0) <= 1
                      }
                      onClick={() => void handleDeleteProfile(profile)}
                    >
                      {t("settings.profiles.delete")}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="ds-settings-section">
          <div className="ds-settings-field">
            <label htmlFor="profile_name">{t("settings.fields.profileName")}</label>
            <input
              id="profile_name"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              required
            />
          </div>
          <div className="ds-settings-field">
            <label htmlFor="model_provide">{t("settings.fields.modelProvide")}</label>
            <input
              id="model_provide"
              value={form.model_provide}
              onChange={updateText("model_provide")}
              required
            />
          </div>
          <div className="ds-settings-field">
            <label htmlFor="model">{t("settings.fields.model")}</label>
            <input id="model" value={form.model} onChange={updateText("model")} required />
          </div>
          <div className="ds-settings-field is-wide">
            <label htmlFor="base_url">{t("settings.fields.baseUrl")}</label>
            <input
              id="base_url"
              value={form.base_url}
              onChange={updateText("base_url")}
              required
            />
          </div>
          <div className="ds-settings-field is-wide">
            <label htmlFor="OPENAI_API_KEY">{t("settings.fields.apiKey")}</label>
            <input
              id="OPENAI_API_KEY"
              value={form.OPENAI_API_KEY}
              onChange={updateText("OPENAI_API_KEY")}
              type="password"
              autoComplete="off"
            />
          </div>
        </section>

        <section className="ds-settings-section">
          <div className="ds-settings-field">
            <label htmlFor="model_context_window">
              {t("settings.fields.contextWindow")}
            </label>
            <input
              id="model_context_window"
              value={form.model_context_window}
              onChange={updateText("model_context_window")}
              inputMode="numeric"
              placeholder={String(DEFAULT_MODEL_CONFIG.model_context_window)}
            />
          </div>
          <div className="ds-settings-field">
            <label htmlFor="model_auto_compact_token_limit">
              {t("settings.fields.compactLimit")}
            </label>
            <input
              id="model_auto_compact_token_limit"
              value={form.model_auto_compact_token_limit}
              onChange={updateText("model_auto_compact_token_limit")}
              inputMode="numeric"
              placeholder={t("settings.placeholders.compactLimit")}
            />
          </div>
          <div className="ds-settings-field">
            <label htmlFor="max_tokens">{t("settings.fields.maxTokens")}</label>
            <input
              id="max_tokens"
              value={form.max_tokens}
              onChange={updateText("max_tokens")}
              inputMode="numeric"
              placeholder={String(DEFAULT_MODEL_CONFIG.max_tokens)}
            />
          </div>
        </section>

        <section className="ds-settings-section">
          <label className="ds-settings-toggle" htmlFor="thinking">
            <input
              id="thinking"
              checked={form.thinking}
              onChange={updateThinking}
              type="checkbox"
            />
            <span>{t("settings.fields.thinking")}</span>
          </label>
          <div className="ds-settings-field">
            <label htmlFor="model_reasoning_effort">
              {t("settings.fields.reasoningEffort")}
            </label>
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
          </div>
        </section>

        {status ? <div className="ds-settings-status">{status}</div> : null}
        {error ? <div className="ds-settings-error">{error}</div> : null}
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
