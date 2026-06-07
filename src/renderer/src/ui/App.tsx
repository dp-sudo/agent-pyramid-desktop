import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentStageEvent,
  LlmProtocol
} from "../../../shared/agent-contracts";
import { DEFAULT_LOCALE, isSupportedLocale, SUPPORTED_LOCALES, type LocaleCode } from "../../../shared/locale";
import { persistLocale } from "../i18n";

export function App(): ReactElement {
  const { i18n, t } = useTranslation();
  const currentLocale = isSupportedLocale(i18n.resolvedLanguage ?? i18n.language)
    ? i18n.resolvedLanguage ?? i18n.language
    : DEFAULT_LOCALE;
  const [protocol, setProtocol] = useState<LlmProtocol>("anthropic-compatible");
  const [model, setModel] = useState("MiniMax-M3");
  const [apiKey, setApiKey] = useState("");
  const [goal, setGoal] = useState(() => t("defaults.goal"));
  const [systemPrompt, setSystemPrompt] = useState(() => t("defaults.systemPrompt"));
  const [maxTokens, setMaxTokens] = useState(1024);
  const [temperature, setTemperature] = useState(1);
  const [response, setResponse] = useState<AgentRunResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const canRun = useMemo(
    () => goal.trim().length > 0 && apiKey.trim().length > 0 && model.trim().length > 0 && !isRunning,
    [apiKey, goal, isRunning, model]
  );

  function handleLanguageChange(locale: LocaleCode): void {
    i18n
      .changeLanguage(locale)
      .then(() => persistLocale(locale))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to change interface language: ${message}`);
      });
  }

  async function runAgent(): Promise<void> {
    const request: AgentRunRequest = {
      goal,
      protocol,
      model,
      apiKey,
      maxTokens,
      temperature,
      systemPrompt
    };

    setIsRunning(true);
    setResponse(null);

    try {
      const result = await window.agentApi.run(request);
      setResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResponse({
        status: "failed",
        output: message,
        trace: []
      });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">{t("app.eyebrow")}</p>
          <h1>{t("app.title")}</h1>
        </div>
        <div className="topbar-actions">
          <label className="language-field">
            <span>{t("app.languageLabel")}</span>
            <select value={currentLocale} onChange={(event) => handleLanguageChange(event.target.value as LocaleCode)}>
              {SUPPORTED_LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`locales.${locale}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="status-strip" aria-label={t("app.architectureLayersLabel")}>
            <span>{t("layers.domain")}</span>
            <span>{t("layers.core")}</span>
            <span>{t("layers.application")}</span>
            <span>{t("layers.infrastructure")}</span>
            <span>{t("layers.desktop")}</span>
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="panel config-panel">
          <div className="panel-heading">
            <h2>{t("runtime.title")}</h2>
            <p>{t("runtime.description")}</p>
          </div>

          <label className="field">
            <span>{t("fields.protocol")}</span>
            <select value={protocol} onChange={(event) => setProtocol(event.target.value as LlmProtocol)}>
              <option value="anthropic-compatible">{t("protocols.anthropic")}</option>
              <option value="openai-compatible">{t("protocols.openai")}</option>
            </select>
          </label>

          <label className="field">
            <span>{t("fields.model")}</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>

          <label className="field">
            <span>{t("fields.apiKey")}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("fields.apiKeyPlaceholder")}
            />
          </label>

          <div className="split-fields">
            <label className="field">
              <span>{t("fields.maxTokens")}</span>
              <input
                type="number"
                min={1}
                max={8192}
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>{t("fields.temperature")}</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(event) => setTemperature(Number(event.target.value))}
              />
            </label>
          </div>
        </aside>

        <section className="panel task-panel">
          <div className="panel-heading">
            <h2>{t("task.title")}</h2>
            <p>{t("task.description")}</p>
          </div>

          <label className="field">
            <span>{t("fields.systemPrompt")}</span>
            <textarea
              className="system-prompt"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>

          <label className="field grow">
            <span>{t("fields.goal")}</span>
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
          </label>

          <button className="run-button" type="button" disabled={!canRun} onClick={() => void runAgent()}>
            {isRunning ? t("run.running") : t("run.idle")}
          </button>
        </section>

        <section className="panel result-panel">
          <div className="panel-heading">
            <h2>{t("result.title")}</h2>
            <p>{response ? t(`status.${response.status}`) : t("result.waiting")}</p>
          </div>

          <TraceList trace={response?.trace ?? []} />

          <div className="output-block">
            <div className="output-title">{t("result.output")}</div>
            <pre>{response?.output ?? t("result.outputPlaceholder")}</pre>
          </div>

          {response?.reasoning ? (
            <div className="output-block secondary">
              <div className="output-title">{t("result.reasoning")}</div>
              <pre>{response.reasoning}</pre>
            </div>
          ) : null}

          {response?.usage ? (
            <div className="usage-grid">
              <UsageItem label={t("usage.input")} value={response.usage.inputTokens} />
              <UsageItem label={t("usage.output")} value={response.usage.outputTokens} />
              <UsageItem label={t("usage.total")} value={response.usage.totalTokens} />
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function TraceList({ trace }: { trace: AgentStageEvent[] }): ReactElement {
  const { t } = useTranslation();

  if (trace.length === 0) {
    return (
      <div className="empty-trace">
        <span>{t("traceStages.observe")}</span>
        <span>{t("traceStages.reason")}</span>
        <span>{t("traceStages.act")}</span>
      </div>
    );
  }

  return (
    <ol className="trace-list">
      {trace.map((event, index) => (
        <li key={`${event.timestamp}-${index}`} className={`trace-item ${event.stage}`}>
          <div className="stage-mark">{t(`traceStages.${event.stage}`)}</div>
          <div>
            <h3>{event.title}</h3>
            <p>{event.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function UsageItem({ label, value }: { label: string; value?: number }): ReactElement {
  return (
    <div>
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}
