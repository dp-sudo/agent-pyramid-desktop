import type { AgentTool, AgentToolContext } from "../../domain/agent/types.js";
import {
  MCP_FACADE_CALL_READ_TOOL_RAW_NAME,
  MCP_FACADE_CALL_TOOL_RAW_NAME,
  MCP_FACADE_DESCRIBE_TOOL_RAW_NAME,
  MCP_FACADE_SEARCH_TOOLS_RAW_NAME,
  namespaceMcpToolName,
  toMcpNameSegment,
} from "../../../shared/mcp-names.js";
import type { McpToolDescriptor } from "./protocol.js";
import type { McpToolCallOutput } from "./client.js";

export const MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD = 24;
const MCP_FACADE_SEARCH_DEFAULT_LIMIT = 20;
const MCP_FACADE_SEARCH_MAX_LIMIT = 50;

export interface McpFacadeServerSurface {
  id: string;
  name: string;
  tools: readonly McpToolDescriptor[];
}

export interface ConnectedMcpFacadeServerSurface extends McpFacadeServerSurface {
  callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallOutput>;
}

export type EnsureConnectedMcpFacadeServer =
  (serverId: string) => Promise<ConnectedMcpFacadeServerSurface>;

export function shouldUseProgressiveDiscoveryFacade(
  tools: readonly McpToolDescriptor[],
): boolean {
  return tools.length > MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD;
}

export function createProgressiveDiscoveryTools(
  server: McpFacadeServerSurface,
  ensureConnectedServer: EnsureConnectedMcpFacadeServer,
): AgentTool[] {
  return [
    toSearchMcpToolsTool(server),
    toDescribeMcpToolTool(server),
    toCallMcpToolFacade(server, ensureConnectedServer, { readOnlyOnly: true }),
    toCallMcpToolFacade(server, ensureConnectedServer, { readOnlyOnly: false }),
  ];
}

export function resolveMcpFacadeTargetTool(
  server: McpFacadeServerSurface,
  targetName: string,
): McpToolDescriptor {
  const targetSegment = toMcpNameSegment(targetName);
  const tool = server.tools.find((candidate) =>
    candidate.name === targetName ||
    candidate.rawName === targetName ||
    toMcpNameSegment(candidate.rawName) === targetSegment
  );
  if (!tool) {
    throw new Error(`MCP tool is not registered on ${server.name}: ${targetName}`);
  }
  return tool;
}

function toSearchMcpToolsTool(server: McpFacadeServerSurface): AgentTool {
  const name = namespaceMcpToolName(server.name, MCP_FACADE_SEARCH_TOOLS_RAW_NAME);
  return {
    definition: {
      name,
      description:
        `Search the ${server.name} MCP tool catalog before describing or calling a specific tool.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional case-insensitive text matched against tool names and descriptions.",
            maxLength: 120,
          },
          max_results: {
            type: "integer",
            description: `Maximum summaries to return. Defaults to ${MCP_FACADE_SEARCH_DEFAULT_LIMIT}, maximum ${MCP_FACADE_SEARCH_MAX_LIMIT}.`,
            minimum: 1,
            maximum: MCP_FACADE_SEARCH_MAX_LIMIT,
          },
        },
      },
    },
    metadata: {
      category: "command",
      isReadOnly: true,
      isDestructive: false,
    },
    execute: async (input) => {
      const query = optionalFacadeString(input.query, "query");
      const maxResults = optionalFacadeInteger(
        input.max_results,
        "max_results",
        MCP_FACADE_SEARCH_DEFAULT_LIMIT,
        MCP_FACADE_SEARCH_MAX_LIMIT,
      );
      const normalizedQuery = query?.toLocaleLowerCase();
      const matches = normalizedQuery
        ? server.tools.filter((tool) => mcpToolMatchesQuery(tool, normalizedQuery))
        : server.tools;
      const visible = matches.slice(0, maxResults);
      const result = {
        serverId: server.id,
        serverName: server.name,
        totalToolCount: server.tools.length,
        ...(query ? { query } : {}),
        matchCount: matches.length,
        truncated: matches.length > visible.length,
        tools: visible.map(toFacadeToolSummary),
      };
      return {
        toolCallId: "",
        name,
        content: JSON.stringify(result),
        displayResult: result,
      };
    },
  };
}

function toDescribeMcpToolTool(server: McpFacadeServerSurface): AgentTool {
  const name = namespaceMcpToolName(server.name, MCP_FACADE_DESCRIBE_TOOL_RAW_NAME);
  return {
    definition: {
      name,
      description:
        `Describe one ${server.name} MCP tool and return its input schema before calling it.`,
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "Tool name from search_tools output; accepts either namespaced name or raw MCP name.",
            minLength: 1,
            maxLength: 160,
          },
        },
        required: ["tool_name"],
      },
    },
    metadata: {
      category: "command",
      isReadOnly: true,
      isDestructive: false,
    },
    execute: async (input) => {
      const tool = resolveMcpFacadeTargetTool(
        server,
        requiredFacadeString(input.tool_name, "tool_name"),
      );
      const result = {
        serverId: server.id,
        serverName: server.name,
        tool: toFacadeToolDescription(tool),
      };
      return {
        toolCallId: "",
        name,
        content: JSON.stringify(result),
        displayResult: result,
      };
    },
  };
}

function toCallMcpToolFacade(
  server: McpFacadeServerSurface,
  ensureConnectedServer: EnsureConnectedMcpFacadeServer,
  options: { readOnlyOnly: boolean },
): AgentTool {
  const rawName = options.readOnlyOnly
    ? MCP_FACADE_CALL_READ_TOOL_RAW_NAME
    : MCP_FACADE_CALL_TOOL_RAW_NAME;
  const name = namespaceMcpToolName(server.name, rawName);
  return {
    definition: {
      name,
      description: options.readOnlyOnly
        ? `Call a read-only ${server.name} MCP tool selected from search_tools output.`
        : `Call a write-capable ${server.name} MCP tool selected from search_tools output after approval.`,
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "Tool name from search_tools output; accepts either namespaced name or raw MCP name.",
            minLength: 1,
            maxLength: 160,
          },
          arguments: {
            type: "object",
            description: "Arguments matching the selected MCP tool input schema.",
          },
        },
        required: ["tool_name"],
      },
    },
    metadata: {
      category: "command",
      isReadOnly: options.readOnlyOnly,
      isDestructive: !options.readOnlyOnly,
    },
    execute: async (input, context: AgentToolContext) => {
      const targetName = requiredFacadeString(input.tool_name, "tool_name");
      const requestedTarget = resolveMcpFacadeTargetTool(server, targetName);
      if (options.readOnlyOnly && !requestedTarget.readOnly) {
        throw new Error(
          `MCP tool is not read-only on ${server.name}: ${requestedTarget.rawName}. Use ${MCP_FACADE_CALL_TOOL_RAW_NAME} instead.`,
        );
      }
      const args = optionalFacadeArguments(input.arguments);
      const connected = await ensureConnectedServer(server.id);
      const liveTarget = resolveMcpFacadeTargetTool(connected, targetName);
      if (options.readOnlyOnly && !liveTarget.readOnly) {
        throw new Error(
          `MCP tool is not read-only on ${server.name}: ${liveTarget.rawName}. Use ${MCP_FACADE_CALL_TOOL_RAW_NAME} instead.`,
        );
      }
      const result = await connected.callTool(liveTarget.name, args, {
        signal: context.signal,
      });
      if (result.isError) {
        throw new Error(result.content);
      }
      return {
        toolCallId: "",
        name,
        content: result.content,
        displayResult: {
          serverId: server.id,
          serverName: server.name,
          toolName: liveTarget.rawName,
          namespacedToolName: liveTarget.name,
          result: result.displayResult,
        },
      };
    },
  };
}

function mcpToolMatchesQuery(tool: McpToolDescriptor, normalizedQuery: string): boolean {
  return (
    tool.name.toLocaleLowerCase().includes(normalizedQuery) ||
    tool.rawName.toLocaleLowerCase().includes(normalizedQuery) ||
    tool.description.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function toFacadeToolSummary(tool: McpToolDescriptor): {
  name: string;
  rawName: string;
  description: string;
  readOnly: boolean;
} {
  return {
    name: tool.name,
    rawName: tool.rawName,
    description: tool.description,
    readOnly: tool.readOnly,
  };
}

function toFacadeToolDescription(tool: McpToolDescriptor): {
  name: string;
  rawName: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
} {
  return {
    ...toFacadeToolSummary(tool),
    inputSchema: tool.inputSchema,
  };
}

function optionalFacadeArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP facade arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function optionalFacadeInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxValue) {
    throw new Error(`MCP facade ${name} must be an integer between 1 and ${maxValue}.`);
  }
  return value;
}

function optionalFacadeString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = requiredFacadeString(value, name);
  return text || undefined;
}

function requiredFacadeString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`MCP facade ${name} must be a string.`);
  }
  if (value.includes("\0")) {
    throw new Error("MCP facade strings cannot contain NUL bytes.");
  }
  return value.trim();
}
