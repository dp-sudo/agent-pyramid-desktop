import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfig,
} from "../../../shared/agent-contracts.js";
import {
  namespaceMcpToolName,
  toMcpNameSegment,
} from "../../../shared/mcp-names.js";
import type { McpToolDescriptor } from "./protocol.js";

const MCP_CACHE_DIRNAME = "mcp";
const MCP_CACHE_FILENAME = "cache.json";
const MCP_CACHE_VERSION = 1;
const TMP_SUFFIX = ".tmp";

export interface McpCachedSurface {
  fingerprint: string;
  serverId: string;
  serverName: string;
  updatedAt: string;
  capabilities: Record<string, unknown>;
  tools: McpToolDescriptor[];
  prompts: McpPromptInfo[];
  resources: McpResourceInfo[];
}

export interface McpStartupStatsRecord {
  fingerprint: string;
  serverId: string;
  serverName: string;
  successCount: number;
  failureCount: number;
  lastDurationMs: number;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  lastError?: string;
}

interface McpCacheFile {
  version: typeof MCP_CACHE_VERSION;
  surfaces: Record<string, McpCachedSurface>;
  startupStats: Record<string, McpStartupStatsRecord>;
}

/**
 * MCP cache persistence is a pure optimization boundary: corrupted cache files
 * or fingerprint mismatches are ignored and the host falls back to a live MCP
 * handshake. Stored records never include raw env/header values, only a hash of
 * the runtime config plus public tool/prompt/resource descriptors.
 */
export class McpCacheStore {
  private readonly cacheDir: string;
  private readonly cachePath: string;
  private state: McpCacheFile = emptyCacheFile();
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(userDataDir: string) {
    this.cacheDir = path.join(userDataDir, MCP_CACHE_DIRNAME);
    this.cachePath = path.join(this.cacheDir, MCP_CACHE_FILENAME);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.cacheDir, { recursive: true });
    if (!existsSync(this.cachePath)) {
      this.state = emptyCacheFile();
      this.initialized = true;
      return;
    }
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      this.state = normalizeCacheFile(JSON.parse(raw) as unknown);
    } catch (error) {
      console.warn("[mcp-cache] failed to read MCP cache, starting empty:", error);
      this.state = emptyCacheFile();
    }
    this.initialized = true;
  }

  getSurface(config: McpServerConfig): McpCachedSurface | null {
    const surface = this.state.surfaces[config.id];
    if (!surface) return null;
    if (surface.fingerprint !== fingerprintMcpServerConfig(config)) {
      return null;
    }
    return cloneCachedSurface(surface);
  }

  getStartupStats(config: McpServerConfig): McpStartupStatsRecord | null {
    const stats = this.state.startupStats[config.id];
    if (!stats) return null;
    if (stats.fingerprint !== fingerprintMcpServerConfig(config)) {
      return null;
    }
    return { ...stats };
  }

  async saveSurface(
    config: McpServerConfig,
    surface: Omit<McpCachedSurface, "fingerprint" | "serverId" | "serverName" | "updatedAt">,
  ): Promise<void> {
    await this.serialized(async () => {
      this.state.surfaces[config.id] = {
        fingerprint: fingerprintMcpServerConfig(config),
        serverId: config.id,
        serverName: config.name,
        updatedAt: new Date().toISOString(),
        capabilities: cloneRecord(surface.capabilities),
        tools: uniqueToolsByName(surface.tools
          .filter((tool) => isToolDescriptorForServer(config.name, tool))
          .map(cloneTool)),
        prompts: uniquePromptsBySegment(surface.prompts.map(normalizePrompt).filter(isPresent)),
        resources: surface.resources.map((resource) => ({ ...resource })),
      };
      await this.writeState();
    });
  }

  async recordStartup(
    config: McpServerConfig,
    outcome: { durationMs: number; ok: true } | { durationMs: number; ok: false; error: string },
  ): Promise<McpStartupStatsRecord> {
    let next: McpStartupStatsRecord = {
      fingerprint: fingerprintMcpServerConfig(config),
      serverId: config.id,
      serverName: config.name,
      successCount: 0,
      failureCount: 0,
      lastDurationMs: Math.max(0, Math.round(outcome.durationMs)),
    };
    await this.serialized(async () => {
      const fingerprint = fingerprintMcpServerConfig(config);
      const previous = this.state.startupStats[config.id];
      const base = previous?.fingerprint === fingerprint
        ? previous
        : {
            fingerprint,
            serverId: config.id,
            serverName: config.name,
            successCount: 0,
            failureCount: 0,
            lastDurationMs: 0,
          };
      const timestamp = new Date().toISOString();
      next = {
        ...base,
        serverName: config.name,
        lastDurationMs: Math.max(0, Math.round(outcome.durationMs)),
        successCount: outcome.ok ? base.successCount + 1 : base.successCount,
        failureCount: outcome.ok ? base.failureCount : base.failureCount + 1,
        ...(outcome.ok ? { lastSucceededAt: timestamp, lastError: undefined } : {}),
        ...(!outcome.ok ? { lastFailedAt: timestamp, lastError: outcome.error } : {}),
      };
      this.state.startupStats[config.id] = next;
      await this.writeState();
    });
    return { ...next };
  }

  private async writeState(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tmp = this.cachePath + TMP_SUFFIX;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(this.state, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.cachePath);
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function fingerprintMcpServerConfig(config: McpServerConfig): string {
  const payload = stableStringify({
    name: config.name,
    transport: config.transport,
    command: config.command ?? "",
    args: config.args,
    env: config.env,
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    headers: config.headers,
    readOnlyTools: sortedUniqueStrings(config.readOnlyTools),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function emptyCacheFile(): McpCacheFile {
  return {
    version: MCP_CACHE_VERSION,
    surfaces: {},
    startupStats: {},
  };
}

function normalizeCacheFile(value: unknown): McpCacheFile {
  if (!isRecord(value) || value.version !== MCP_CACHE_VERSION) {
    return emptyCacheFile();
  }
  return {
    version: MCP_CACHE_VERSION,
    surfaces: normalizeSurfaceMap(value.surfaces),
    startupStats: normalizeStartupStatsMap(value.startupStats),
  };
}

function normalizeSurfaceMap(value: unknown): Record<string, McpCachedSurface> {
  if (!isRecord(value)) return {};
  const surfaces: Record<string, McpCachedSurface> = {};
  for (const [id, rawSurface] of Object.entries(value)) {
    const surface = normalizeSurface(rawSurface);
    if (surface && surface.serverId === id) {
      surfaces[id] = surface;
    }
  }
  return surfaces;
}

function normalizeSurface(value: unknown): McpCachedSurface | null {
  if (!isRecord(value) ||
    typeof value.fingerprint !== "string" ||
    typeof value.serverId !== "string" ||
    typeof value.serverName !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.prompts) ||
    !Array.isArray(value.resources)) {
    return null;
  }
  const serverName = value.serverName;
  return {
    fingerprint: value.fingerprint,
    serverId: value.serverId,
    serverName,
    updatedAt: value.updatedAt,
    capabilities: isRecord(value.capabilities) ? cloneRecord(value.capabilities) : {},
    tools: uniqueToolsByName(value.tools
      .map((tool) => normalizeTool(tool, serverName))
      .filter(isPresent)),
    prompts: uniquePromptsBySegment(value.prompts.map(normalizePrompt).filter(isPresent)),
    resources: value.resources.map(normalizeResource).filter(isPresent),
  };
}

function normalizeStartupStatsMap(value: unknown): Record<string, McpStartupStatsRecord> {
  if (!isRecord(value)) return {};
  const stats: Record<string, McpStartupStatsRecord> = {};
  for (const [id, rawStats] of Object.entries(value)) {
    const record = normalizeStartupStats(rawStats);
    if (record && record.serverId === id) {
      stats[id] = record;
    }
  }
  return stats;
}

function normalizeStartupStats(value: unknown): McpStartupStatsRecord | null {
  if (!isRecord(value) ||
    typeof value.fingerprint !== "string" ||
    typeof value.serverId !== "string" ||
    typeof value.serverName !== "string" ||
    !isNonNegativeInteger(value.successCount) ||
    !isNonNegativeInteger(value.failureCount) ||
    !isNonNegativeInteger(value.lastDurationMs)) {
    return null;
  }
  return {
    fingerprint: value.fingerprint,
    serverId: value.serverId,
    serverName: value.serverName,
    successCount: value.successCount,
    failureCount: value.failureCount,
    lastDurationMs: value.lastDurationMs,
    ...(typeof value.lastSucceededAt === "string" ? { lastSucceededAt: value.lastSucceededAt } : {}),
    ...(typeof value.lastFailedAt === "string" ? { lastFailedAt: value.lastFailedAt } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

function normalizeTool(value: unknown, serverName: string): McpToolDescriptor | null {
  if (!isRecord(value) ||
    typeof value.rawName !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.readOnly !== "boolean") {
    return null;
  }
  if (!isNamespacedToolNameForServer(serverName, value.rawName, value.name)) {
    return null;
  }
  return {
    rawName: value.rawName,
    name: value.name,
    description: value.description,
    inputSchema: isRecord(value.inputSchema) ? cloneRecord(value.inputSchema) : {},
    readOnly: value.readOnly,
  };
}

function normalizePrompt(value: unknown): McpPromptInfo | null {
  if (!isRecord(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.description !== "string" ||
    !Array.isArray(value.arguments)) {
    return null;
  }
  const args = normalizePromptArguments(value.arguments);
  if (!args) return null;
  return {
    name: value.name.trim(),
    description: value.description,
    arguments: args,
  };
}

function normalizePromptArguments(
  values: readonly unknown[],
): McpPromptInfo["arguments"] | null {
  const names = new Set<string>();
  const args: McpPromptInfo["arguments"] = [];
  for (const value of values) {
    const arg = normalizePromptArgument(value);
    if (!arg || names.has(arg.name)) return null;
    names.add(arg.name);
    args.push(arg);
  }
  return args;
}

function normalizePromptArgument(value: unknown): McpPromptInfo["arguments"][number] | null {
  if (!isRecord(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.required !== "boolean") {
    return null;
  }
  return {
    name: value.name.trim(),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    required: value.required,
  };
}

function normalizeResource(value: unknown): McpResourceInfo | null {
  if (!isRecord(value) ||
    typeof value.uri !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string") {
    return null;
  }
  return {
    uri: value.uri,
    name: value.name,
    description: value.description,
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
  };
}

function cloneCachedSurface(surface: McpCachedSurface): McpCachedSurface {
  return {
    ...surface,
    capabilities: cloneRecord(surface.capabilities),
    tools: surface.tools.map(cloneTool),
    prompts: surface.prompts.map(clonePrompt),
    resources: surface.resources.map((resource) => ({ ...resource })),
  };
}

function cloneTool(tool: McpToolDescriptor): McpToolDescriptor {
  return {
    ...tool,
    inputSchema: cloneRecord(tool.inputSchema),
  };
}

function clonePrompt(prompt: McpPromptInfo): McpPromptInfo {
  return {
    ...prompt,
    arguments: prompt.arguments.map((argument) => ({ ...argument })),
  };
}

function isToolDescriptorForServer(serverName: string, tool: McpToolDescriptor): boolean {
  return isNamespacedToolNameForServer(serverName, tool.rawName, tool.name);
}

function isNamespacedToolNameForServer(
  serverName: string,
  rawName: string,
  toolName: string,
): boolean {
  return rawName.trim().length > 0 && toolName === namespaceMcpToolName(serverName, rawName);
}

function uniqueToolsByName(tools: McpToolDescriptor[]): McpToolDescriptor[] {
  const seen = new Set<string>();
  const unique: McpToolDescriptor[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    unique.push(tool);
  }
  return unique;
}

function uniquePromptsBySegment(prompts: McpPromptInfo[]): McpPromptInfo[] {
  const seen = new Set<string>();
  const unique: McpPromptInfo[] = [];
  for (const prompt of prompts) {
    const segment = toMcpNameSegment(prompt.name);
    if (seen.has(segment)) continue;
    seen.add(segment);
    unique.push(prompt);
  }
  return unique;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sortedUniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
