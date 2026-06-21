import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfig,
  McpServerStatusRecord,
  McpToolInfo,
  RuntimeEvent,
} from "../../../shared/agent-contracts.js";
import type { McpToolDescriptor } from "./protocol.js";
import type { McpStartupStatsRecord } from "./cache-store.js";

export interface McpStatusProjectionInput {
  config: Pick<McpServerConfig, "id" | "name" | "transport" | "enabled">;
  status: McpServerStatusRecord["status"];
  tools: readonly McpToolDescriptor[];
  prompts: readonly McpPromptInfo[];
  resources: readonly McpResourceInfo[];
  startupStats?: McpStartupStatsRecord;
  lastConnectedAt?: string;
  lastError?: string;
}

export function toMcpToolInfo(tool: McpToolDescriptor): McpToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly,
  };
}

export function toMcpPromptInfo(prompt: McpPromptInfo): McpPromptInfo {
  return {
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments.map((argument) => ({ ...argument })),
  };
}

export function toMcpServerStatusRecord(
  input: McpStatusProjectionInput,
): McpServerStatusRecord {
  return {
    id: input.config.id,
    name: input.config.name,
    transport: input.config.transport,
    enabled: input.config.enabled,
    status: input.status,
    toolCount: input.tools.length,
    tools: input.tools.map(toMcpToolInfo),
    promptCount: input.prompts.length,
    prompts: input.prompts.map(toMcpPromptInfo),
    resourceCount: input.resources.length,
    resources: input.resources.map((resource) => ({ ...resource })),
    ...(input.startupStats
      ? {
          lastStartupDurationMs: input.startupStats.lastDurationMs,
          startupSuccessCount: input.startupStats.successCount,
          startupFailureCount: input.startupStats.failureCount,
        }
      : {}),
    ...(input.lastConnectedAt ? { lastConnectedAt: input.lastConnectedAt } : {}),
    ...(input.lastError ? { lastError: input.lastError } : {}),
  };
}

export function toMcpConnectionEvent(
  input: McpStatusProjectionInput,
  occurredAt: string,
): Extract<RuntimeEvent, { kind: "mcp_server_connection" }> {
  return {
    kind: "mcp_server_connection",
    serverId: input.config.id,
    serverName: input.config.name,
    status: input.status,
    toolCount: input.tools.length,
    occurredAt,
    ...(input.lastError ? { message: input.lastError } : {}),
  };
}

export function toMcpToolListChangedEvent(
  input: McpStatusProjectionInput,
  occurredAt: string,
): Extract<RuntimeEvent, { kind: "mcp_tool_list_changed" }> {
  return {
    kind: "mcp_tool_list_changed",
    serverId: input.config.id,
    serverName: input.config.name,
    toolCount: input.tools.length,
    tools: input.tools.map(toMcpToolInfo),
    occurredAt,
  };
}

export function toMcpSurfaceChangedEvent(
  input: McpStatusProjectionInput,
  occurredAt: string,
): Extract<RuntimeEvent, { kind: "mcp_surface_changed" }> {
  return {
    kind: "mcp_surface_changed",
    serverId: input.config.id,
    serverName: input.config.name,
    promptCount: input.prompts.length,
    resourceCount: input.resources.length,
    occurredAt,
  };
}
