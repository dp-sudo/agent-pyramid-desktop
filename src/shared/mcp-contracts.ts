import { isIsoTimestampString } from "./contract-primitives.js";
import { toMcpNameSegment } from "./mcp-names.js";

export const MCP_SERVER_TRANSPORTS = ["stdio", "streamable-http"] as const;
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number];
export const MCP_SERVER_STATUSES = [
  "disconnected",
  "connecting",
  "cached",
  "lazy",
  "connected",
  "failed",
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpServerTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  readOnlyTools: string[];
  createdAt: string;
  updatedAt: string;
}

export type McpServerConfigUpdate = Partial<
  Pick<
    McpServerConfig,
    | "name"
    | "transport"
    | "command"
    | "args"
    | "env"
    | "cwd"
    | "url"
    | "headers"
    | "enabled"
    | "readOnlyTools"
  >
>;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpPromptArgumentInfo {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: McpPromptArgumentInfo[];
}

export interface McpPromptMessage {
  role: string;
  content: unknown;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContent[];
}

export interface McpServerStatusRecord {
  id: string;
  name: string;
  transport: McpServerTransport;
  enabled: boolean;
  status: McpServerStatus;
  toolCount: number;
  tools: McpToolInfo[];
  promptCount: number;
  prompts: McpPromptInfo[];
  resourceCount: number;
  resources: McpResourceInfo[];
  lastStartupDurationMs?: number;
  startupSuccessCount?: number;
  startupFailureCount?: number;
  lastConnectedAt?: string;
  lastError?: string;
}

export const MCP_SECRET_VALUE_MASK = "********";
const MCP_SECRET_KEY_PATTERN =
  /(?:authorization|bearer|token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|refresh[_-]?key|private[_-]?key|x-api-key|api-key|key)/i;

export function isMcpSecretRecordKey(key: string): boolean {
  return MCP_SECRET_KEY_PATTERN.test(key);
}

export function redactMcpStringRecordForRenderer(
  record: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      value && isMcpSecretRecordKey(key) ? MCP_SECRET_VALUE_MASK : value,
    ]),
  );
}

export function redactMcpServerConfigForRenderer(
  server: McpServerConfig,
): McpServerConfig {
  return {
    ...server,
    args: [...server.args],
    env: redactMcpStringRecordForRenderer(server.env),
    headers: redactMcpStringRecordForRenderer(server.headers),
    readOnlyTools: [...server.readOnlyTools],
  };
}

export function isMcpServerTransport(value: unknown): value is McpServerTransport {
  return typeof value === "string" &&
    MCP_SERVER_TRANSPORTS.includes(value as McpServerTransport);
}

export function isMcpServerStatus(value: unknown): value is McpServerStatus {
  return typeof value === "string" &&
    MCP_SERVER_STATUSES.includes(value as McpServerStatus);
}

export function isMcpServerConfigs(value: unknown): value is McpServerConfig[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  const nameSegments = new Set<string>();
  for (const server of value) {
    if (!isMcpServerConfig(server)) return false;
    const idKey = server.id.trim();
    const nameKey = server.name.trim();
    const nameSegmentKey = toMcpNameSegment(nameKey);
    if (ids.has(idKey) || names.has(nameKey) || nameSegments.has(nameSegmentKey)) return false;
    ids.add(idKey);
    names.add(nameKey);
    nameSegments.add(nameSegmentKey);
  }
  return true;
}

export function isMcpToolInfo(value: unknown): value is McpToolInfo {
  if (!isRecord(value)) return false;
  return hasNonBlankString(value, "name") &&
    hasString(value, "description") &&
    isRecord(value.inputSchema) &&
    typeof value.readOnly === "boolean";
}

export function isHttpUrl(value: unknown): value is string {
  if (!isNonBlankStringWithoutNul(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    void error;
    return false;
  }
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isRecord(value)) return false;
  const baseValid = isNonBlankStringWithoutNul(value.id) &&
    isNonBlankStringWithoutNul(value.name) &&
    isMcpServerTransport(value.transport) &&
    (value.command === undefined || isNonBlankStringWithoutNul(value.command)) &&
    Array.isArray(value.args) &&
    value.args.every(isStringWithoutNul) &&
    isStringRecordWithoutNul(value.env) &&
    (value.cwd === undefined || isNonBlankStringWithoutNul(value.cwd)) &&
    (value.url === undefined || isHttpUrl(value.url)) &&
    isStringRecordWithoutNul(value.headers) &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.readOnlyTools) &&
    value.readOnlyTools.every(isNonBlankStringWithoutNul) &&
    isIsoTimestampString(value.createdAt) &&
    isIsoTimestampString(value.updatedAt);
  if (!baseValid) return false;
  if (value.transport === "stdio") {
    return isNonBlankStringWithoutNul(value.command);
  }
  return isHttpUrl(value.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNonBlankString(value: Record<string, unknown>, key: string): boolean {
  const text = value[key];
  return typeof text === "string" && text.trim().length > 0;
}

function isStringWithoutNul(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function isNonBlankStringWithoutNul(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isStringRecordWithoutNul(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (!isNonBlankStringWithoutNul(key) || !isStringWithoutNul(entry)) return false;
    const normalizedKey = key.trim();
    if (keys.has(normalizedKey)) return false;
    keys.add(normalizedKey);
  }
  return true;
}
