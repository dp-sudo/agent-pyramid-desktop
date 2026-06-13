import { ipcMain } from "electron";
import {
  MCP_SERVERS_CONNECT_CHANNEL,
  MCP_SERVERS_DISCONNECT_CHANNEL,
  MCP_SERVERS_LIST_CHANNEL,
  MCP_TOOLS_LIST_CHANNEL,
  MCP_TOOLS_REFRESH_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  McpServerConnectRequest,
  McpServerDisconnectRequest,
  McpServerRefreshToolsRequest,
  McpServerToolsRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { McpHost } from "../infrastructure/mcp/host.js";

export function registerMcpHandlers(host: McpHost): void {
  ipcMain.handle(MCP_SERVERS_LIST_CHANNEL, async () => {
    try {
      return ok({ servers: host.listServers() });
    } catch (error) {
      return err(IPC_ERROR_CODES.MCP_SERVER_LIST_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(MCP_SERVERS_CONNECT_CHANNEL, async (_event, input: unknown) => {
    try {
      const request = parseServerConnectRequest(input);
      return ok(await host.connect(request.serverId));
    } catch (error) {
      return err(IPC_ERROR_CODES.MCP_SERVER_CONNECT_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(MCP_SERVERS_DISCONNECT_CHANNEL, async (_event, input: unknown) => {
    try {
      const request = parseServerDisconnectRequest(input);
      return ok(await host.disconnect(request.serverId));
    } catch (error) {
      return err(IPC_ERROR_CODES.MCP_SERVER_DISCONNECT_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(MCP_TOOLS_LIST_CHANNEL, async (_event, input: unknown) => {
    try {
      const request = parseServerToolsRequest(input);
      return ok({ servers: host.listTools(request.serverId) });
    } catch (error) {
      return err(IPC_ERROR_CODES.MCP_TOOL_LIST_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(MCP_TOOLS_REFRESH_CHANNEL, async (_event, input: unknown) => {
    try {
      const request = parseServerRefreshToolsRequest(input);
      return ok(await host.refreshTools(request.serverId));
    } catch (error) {
      return err(IPC_ERROR_CODES.MCP_TOOL_REFRESH_FAILED, messageOf(error));
    }
  });
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

function requestObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
