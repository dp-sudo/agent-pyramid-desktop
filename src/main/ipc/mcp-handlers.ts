import {
  MCP_SERVERS_CONNECT_CHANNEL,
  MCP_SERVERS_DISCONNECT_CHANNEL,
  MCP_SERVERS_LIST_CHANNEL,
  MCP_SURFACE_REFRESH_CHANNEL,
  MCP_PROMPTS_GET_CHANNEL,
  MCP_PROMPTS_LIST_CHANNEL,
  MCP_RESOURCES_LIST_CHANNEL,
  MCP_RESOURCES_READ_CHANNEL,
  MCP_TOOLS_LIST_CHANNEL,
  MCP_TOOLS_REFRESH_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  McpServerConnectRequest,
  McpServerDisconnectRequest,
  McpPromptGetRequest,
  McpResourceReadRequest,
  McpServerPromptsRequest,
  McpServerResourcesRequest,
  McpServerRefreshToolsRequest,
  McpServerToolsRequest,
} from "../../shared/agent-contracts.js";
import type { McpHost } from "../infrastructure/mcp/host.js";
import { registerIpcResultHandler, requestObject } from "./ipc-result-handler.js";

export function registerMcpHandlers(host: McpHost): void {
  registerIpcResultHandler(MCP_SERVERS_LIST_CHANNEL, IPC_ERROR_CODES.MCP_SERVER_LIST_FAILED, () => ({
    servers: host.listServers(),
  }));

  registerIpcResultHandler(
    MCP_SERVERS_CONNECT_CHANNEL,
    IPC_ERROR_CODES.MCP_SERVER_CONNECT_FAILED,
    async (_event, input: unknown) => {
      const request = parseServerConnectRequest(input);
      return await host.connect(request.serverId);
    },
  );

  registerIpcResultHandler(
    MCP_SERVERS_DISCONNECT_CHANNEL,
    IPC_ERROR_CODES.MCP_SERVER_DISCONNECT_FAILED,
    async (_event, input: unknown) => {
      const request = parseServerDisconnectRequest(input);
      return await host.disconnect(request.serverId);
    },
  );

  registerIpcResultHandler(
    MCP_TOOLS_LIST_CHANNEL,
    IPC_ERROR_CODES.MCP_TOOL_LIST_FAILED,
    (_event, input: unknown) => {
      const request = parseServerToolsRequest(input);
      return { servers: host.listTools(request.serverId) };
    },
  );

  registerIpcResultHandler(
    MCP_TOOLS_REFRESH_CHANNEL,
    IPC_ERROR_CODES.MCP_TOOL_REFRESH_FAILED,
    async (_event, input: unknown) => {
      const request = parseServerRefreshToolsRequest(input);
      return await host.refreshTools(request.serverId);
    },
  );

  registerIpcResultHandler(
    MCP_SURFACE_REFRESH_CHANNEL,
    IPC_ERROR_CODES.MCP_SURFACE_REFRESH_FAILED,
    async (_event, input: unknown) => {
      const request = parseServerRefreshToolsRequest(input);
      return await host.refreshSurface(request.serverId);
    },
  );

  registerIpcResultHandler(
    MCP_PROMPTS_LIST_CHANNEL,
    IPC_ERROR_CODES.MCP_PROMPT_LIST_FAILED,
    (_event, input: unknown) => {
      const request = parseServerPromptsRequest(input);
      return { servers: host.listPrompts(request.serverId) };
    },
  );

  registerIpcResultHandler(
    MCP_PROMPTS_GET_CHANNEL,
    IPC_ERROR_CODES.MCP_PROMPT_GET_FAILED,
    async (_event, input: unknown) => {
      const request = parsePromptGetRequest(input);
      return await host.getPrompt(request.serverId, request.name, request.arguments ?? {});
    },
  );

  registerIpcResultHandler(
    MCP_RESOURCES_LIST_CHANNEL,
    IPC_ERROR_CODES.MCP_RESOURCE_LIST_FAILED,
    (_event, input: unknown) => {
      const request = parseServerResourcesRequest(input);
      return { servers: host.listResources(request.serverId) };
    },
  );

  registerIpcResultHandler(
    MCP_RESOURCES_READ_CHANNEL,
    IPC_ERROR_CODES.MCP_RESOURCE_READ_FAILED,
    async (_event, input: unknown) => {
      const request = parseResourceReadRequest(input);
      return await host.readResource(request.serverId, request.uri);
    },
  );
}

export function parseServerConnectRequest(input: unknown): McpServerConnectRequest {
  const value = requestObject(input, "MCP server connect request");
  return {
    serverId: requiredString(value.serverId, "MCP serverId is required."),
  };
}

export function parseServerDisconnectRequest(input: unknown): McpServerDisconnectRequest {
  const value = requestObject(input, "MCP server disconnect request");
  return {
    serverId: requiredString(value.serverId, "MCP serverId is required."),
  };
}

export function parseServerToolsRequest(input: unknown): McpServerToolsRequest {
  if (input === undefined || input === null) return {};
  const value = requestObject(input, "MCP tools list request");
  return {
    ...(value.serverId !== undefined
      ? { serverId: requiredString(value.serverId, "MCP serverId must be a string.") }
      : {}),
  };
}

export function parseServerRefreshToolsRequest(input: unknown): McpServerRefreshToolsRequest {
  const value = requestObject(input, "MCP tools refresh request");
  return {
    serverId: requiredString(value.serverId, "MCP serverId is required."),
  };
}

export function parseServerPromptsRequest(input: unknown): McpServerPromptsRequest {
  return parseServerToolsRequest(input);
}

export function parsePromptGetRequest(input: unknown): McpPromptGetRequest {
  const value = requestObject(input, "MCP prompt get request");
  return {
    serverId: requiredString(value.serverId, "MCP serverId is required."),
    name: requiredString(value.name, "MCP prompt name is required."),
    ...(value.arguments !== undefined
      ? { arguments: optionalStringRecord(value.arguments, "MCP prompt arguments") }
      : {}),
  };
}

export function parseServerResourcesRequest(input: unknown): McpServerResourcesRequest {
  return parseServerToolsRequest(input);
}

export function parseResourceReadRequest(input: unknown): McpResourceReadRequest {
  const value = requestObject(input, "MCP resource read request");
  return {
    serverId: requiredString(value.serverId, "MCP serverId is required."),
    uri: requiredString(value.uri, "MCP resource uri is required."),
  };
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  const trimmed = value.trim();
  if (trimmed.includes("\0")) {
    throw new Error(message);
  }
  return trimmed;
}

function optionalStringRecord(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || !key.trim() || key.includes("\0") || entry.includes("\0")) {
      throw new Error(`${name} must contain only string values without NUL bytes.`);
    }
    const parsedKey = key.trim();
    if (parsed[parsedKey] !== undefined) {
      throw new Error(`${name}.${parsedKey} key is duplicated.`);
    }
    parsed[parsedKey] = entry;
  }
  return parsed;
}
