import type {
  McpServerConfig,
  McpServerConfigUpdate,
  McpServerStatusRecord,
} from "../../../shared/agent-contracts";
import { toMcpNameSegment } from "../../../shared/mcp-names";
import {
  createRuntimePreferenceId,
  type SettingsTranslator,
} from "./settings-runtime-model";

export function cloneMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    args: [...server.args],
    env: { ...server.env },
    headers: { ...server.headers },
    readOnlyTools: [...server.readOnlyTools],
  };
}

export function createDefaultMcpServer(name: string): McpServerConfig {
  const now = new Date().toISOString();
  return {
    id: createRuntimePreferenceId(),
    name,
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    headers: {},
    enabled: false,
    readOnlyTools: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createUniqueMcpServerName(
  baseName: string,
  servers: readonly Pick<McpServerConfig, "name">[],
): string {
  const trimmedBaseName = baseName.trim() || "local-mcp";
  const usedNames = new Set<string>();
  const usedNameSegments = new Set<string>();
  for (const server of servers) {
    const trimmedName = server.name.trim();
    if (trimmedName) {
      usedNames.add(trimmedName);
      usedNameSegments.add(toMcpNameSegment(trimmedName));
    }
  }
  if (
    !usedNames.has(trimmedBaseName) &&
    !usedNameSegments.has(toMcpNameSegment(trimmedBaseName))
  ) {
    return trimmedBaseName;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${trimmedBaseName}-${suffix}`;
    if (
      !usedNames.has(candidate) &&
      !usedNameSegments.has(toMcpNameSegment(candidate))
    ) {
      return candidate;
    }
  }
}

export function updateMcpServerConfigs(
  servers: readonly McpServerConfig[],
  id: string,
  update: McpServerConfigUpdate,
): McpServerConfig[] {
  const updatedAt = new Date().toISOString();
  return servers.map((server) =>
    server.id === id
      ? {
          ...server,
          ...update,
          args: update.args ? [...update.args] : server.args,
          env: update.env ? { ...update.env } : server.env,
          headers: update.headers ? { ...update.headers } : server.headers,
          readOnlyTools: update.readOnlyTools
            ? [...update.readOnlyTools]
            : server.readOnlyTools,
          updatedAt,
        }
      : server,
  );
}

export function mcpServerConnectionLabel(
  server: McpServerConfig,
  status: McpServerStatusRecord | undefined,
  t: SettingsTranslator,
): string {
  if (!status) {
    return server.transport === "stdio"
      ? server.command ?? t("settings.mcpServers.unconfigured")
      : server.url ?? t("settings.mcpServers.unconfigured");
  }
  return t("settings.mcpServers.statusSummary", {
    status: t(`settings.mcpStatuses.${status.status}`),
    tools: status.toolCount,
    prompts: status.promptCount,
    resources: status.resourceCount,
  });
}

export function formatMcpStartupStats(
  status: McpServerStatusRecord,
  t: SettingsTranslator,
): string | null {
  if (status.lastStartupDurationMs === undefined &&
    status.startupSuccessCount === undefined &&
    status.startupFailureCount === undefined) {
    return null;
  }
  return t("settings.mcpServers.startupStats", {
    duration: status.lastStartupDurationMs ?? 0,
    successes: status.startupSuccessCount ?? 0,
    failures: status.startupFailureCount ?? 0,
  });
}
