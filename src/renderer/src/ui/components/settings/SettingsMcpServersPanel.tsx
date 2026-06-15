import type { ReactElement } from "react";
import {
  MCP_SERVER_TRANSPORTS,
  type McpServerConfig,
  type McpServerConfigUpdate,
  type McpServerStatusRecord,
  type McpServerTransport,
} from "../../../../../shared/agent-contracts";
import {
  formatMcpStartupStats,
  mcpServerConnectionLabel,
} from "../../settings-mcp-model";
import {
  splitCommaList,
  splitWhitespaceList,
  type SettingsTranslator,
} from "../../settings-runtime-model";
import {
  SettingsCard,
  Toggle,
} from "./SettingsControls";

export interface SettingsMcpServersPanelProps {
  t: SettingsTranslator;
  servers: McpServerConfig[];
  statuses: Record<string, McpServerStatusRecord>;
  runtimeControlsDisabled: boolean;
  hasAgentApi: boolean;
  onAddServer: () => void;
  onUpdateServer: (id: string, update: McpServerConfigUpdate) => void;
  onUpdateServerTransport: (id: string, transport: McpServerTransport) => void;
  onUpdateServerEnv: (id: string, raw: string) => void;
  onUpdateServerHeaders: (id: string, raw: string) => void;
  onDeleteServer: (id: string) => void;
  onConnectServer: (id: string) => void | Promise<void>;
  onDisconnectServer: (id: string) => void | Promise<void>;
  onRefreshServerTools: (id: string) => void | Promise<void>;
}

export function SettingsMcpServersPanel({
  t,
  servers,
  statuses,
  runtimeControlsDisabled,
  hasAgentApi,
  onAddServer,
  onUpdateServer,
  onUpdateServerTransport,
  onUpdateServerEnv,
  onUpdateServerHeaders,
  onDeleteServer,
  onConnectServer,
  onDisconnectServer,
  onRefreshServerTools,
}: SettingsMcpServersPanelProps): ReactElement {
  return (
    <SettingsCard
      title={t("settings.sections.mcpServers")}
      description={t("settings.sections.mcpServersDesc")}
    >
      <div className="ds-settings-mcp-list">
        {servers.length === 0 ? (
          <p className="ds-settings-empty-note">
            {t("settings.mcpServers.empty")}
          </p>
        ) : null}
        {servers.map((server) => (
          <article className="ds-settings-mcp-server" key={server.id}>
            <div className="ds-settings-mcp-header">
              <div>
                <strong>{server.name}</strong>
                <span>{mcpServerConnectionLabel(server, statuses[server.id], t)}</span>
              </div>
              <Toggle
                checked={server.enabled}
                label={t("settings.fields.mcpServerEnabled")}
                disabled={runtimeControlsDisabled}
                onChange={(checked) => onUpdateServer(server.id, { enabled: checked })}
              />
            </div>
            <div className="ds-settings-mcp-grid">
              <label>
                <span>{t("settings.fields.mcpServerTransport")}</span>
                <select
                  value={server.transport}
                  disabled={runtimeControlsDisabled}
                  onChange={(event) =>
                    onUpdateServerTransport(
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
                    onUpdateServer(server.id, { name: event.target.value })
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
                        onUpdateServer(server.id, { command: event.target.value })
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
                        onUpdateServer(server.id, {
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
                        onUpdateServer(server.id, {
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
                        onUpdateServer(server.id, { url: event.target.value })
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
                        onUpdateServerHeaders(server.id, event.currentTarget.value)
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
                    onUpdateServer(server.id, {
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
                      onUpdateServerEnv(server.id, event.currentTarget.value)
                    }
                  />
                </label>
              ) : null}
            </div>
            <McpServerSurfaceSummary
              status={statuses[server.id]}
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
                disabled={runtimeControlsDisabled || !hasAgentApi}
                onClick={() => void onConnectServer(server.id)}
              >
                {t("settings.actions.connectMcpServer")}
              </button>
              <button
                type="button"
                className="ds-settings-secondary-action"
                disabled={runtimeControlsDisabled || !hasAgentApi}
                onClick={() => void onDisconnectServer(server.id)}
              >
                {t("settings.actions.disconnectMcpServer")}
              </button>
              <button
                type="button"
                className="ds-settings-secondary-action"
                disabled={runtimeControlsDisabled || !hasAgentApi}
                onClick={() => void onRefreshServerTools(server.id)}
              >
                {t("settings.actions.refreshMcpServer")}
              </button>
              <button
                type="button"
                className="ds-settings-secondary-action"
                disabled={runtimeControlsDisabled}
                onClick={() => onDeleteServer(server.id)}
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
          onClick={onAddServer}
        >
          {t("settings.actions.addMcpServer")}
        </button>
      </div>
    </SettingsCard>
  );
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
