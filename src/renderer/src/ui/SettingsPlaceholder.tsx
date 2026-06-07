import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_MODEL_CONFIG,
  MODEL_REASONING_EFFORTS,
  type ModelConfig,
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
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await window.agentApi.modelConfig.get();
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setForm(toFormState(result.value));
        actions.setModelConfig(result.value);
      } else {
        setError(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const update = toUpdatePayload(form);
      const result = await window.agentApi.modelConfig.update(update);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setForm(toFormState(result.value));
      actions.setModelConfig(result.value);
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
            <button className="ds-settings-save" type="submit" disabled={saving || loading}>
              {saving ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
        </header>

        <section className="ds-settings-section">
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
