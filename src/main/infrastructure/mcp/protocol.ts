import type { McpToolInfo } from "../../../shared/agent-contracts.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpToolDescriptor extends McpToolInfo {
  rawName: string;
}

export interface McpCallToolContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content?: McpCallToolContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value)) return false;
  if (value.jsonrpc !== "2.0" || typeof value.id !== "number") return false;
  return "result" in value || (
    isRecord(value.error) &&
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  );
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (!isRecord(value)) return false;
  return value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    !("id" in value);
}

export function normalizeMcpToolsListResult(value: unknown): McpToolDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error("MCP tools/list result must contain a tools array.");
  }
  return value.tools.map(normalizeMcpToolDescriptor);
}

export function normalizeMcpCallToolResult(value: unknown): McpCallToolResult {
  if (!isRecord(value)) {
    throw new Error("MCP tools/call result must be an object.");
  }
  const result: McpCallToolResult = {};
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) {
      throw new Error("MCP tools/call content must be an array.");
    }
    result.content = value.content.map(normalizeMcpContentBlock);
  }
  if (value.structuredContent !== undefined) {
    result.structuredContent = value.structuredContent;
  }
  if (value.isError !== undefined) {
    if (typeof value.isError !== "boolean") {
      throw new Error("MCP tools/call isError must be a boolean.");
    }
    result.isError = value.isError;
  }
  return result;
}

export function serializeMcpCallToolResult(result: McpCallToolResult): string {
  const textBlocks = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean);
  if (textBlocks.length > 0 && result.structuredContent === undefined) {
    return textBlocks.join("\n\n");
  }
  return JSON.stringify(result);
}

function normalizeMcpToolDescriptor(value: unknown): McpToolDescriptor {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("MCP tool descriptor requires a non-empty name.");
  }
  const inputSchema = isRecord(value.inputSchema)
    ? value.inputSchema
    : { type: "object", properties: {} };
  const annotations = isRecord(value.annotations) ? value.annotations : {};
  return {
    rawName: value.name.trim(),
    name: value.name.trim(),
    description: typeof value.description === "string" ? value.description : "",
    inputSchema,
    readOnly: annotations.readOnlyHint === true,
  };
}

function normalizeMcpContentBlock(value: unknown): McpCallToolContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("MCP content block requires a string type.");
  }
  return value as McpCallToolContentBlock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
