const MCP_NAME_SEGMENT_SOURCE = "[A-Za-z0-9-](?:[A-Za-z0-9_-]*[A-Za-z0-9-])?";
const MCP_TOOL_NAME_PATTERN = new RegExp(
  `^mcp__(${MCP_NAME_SEGMENT_SOURCE})__(${MCP_NAME_SEGMENT_SOURCE})$`,
);

export const MCP_NAME_SEGMENT_PATTERN = new RegExp(`^${MCP_NAME_SEGMENT_SOURCE}$`);

export function toMcpNameSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

export function namespaceMcpToolName(serverName: string, rawToolName: string): string {
  return `mcp__${toMcpNameSegment(serverName)}__${toMcpNameSegment(rawToolName)}`;
}

export function mcpPermissionValueFromToolName(toolName: string): string | null {
  const match = MCP_TOOL_NAME_PATTERN.exec(toolName);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
