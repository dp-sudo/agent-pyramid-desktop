const MCP_NAME_SEGMENT_SOURCE = "[A-Za-z0-9-](?:[A-Za-z0-9_-]*[A-Za-z0-9-])?";
const MCP_TOOL_NAME_PATTERN = new RegExp(
  `^mcp__(${MCP_NAME_SEGMENT_SOURCE})__(${MCP_NAME_SEGMENT_SOURCE})$`,
);

export const MCP_NAME_SEGMENT_PATTERN = new RegExp(`^${MCP_NAME_SEGMENT_SOURCE}$`);
export const MCP_FACADE_SEARCH_TOOLS_RAW_NAME = "search_tools";
export const MCP_FACADE_DESCRIBE_TOOL_RAW_NAME = "describe_tool";
export const MCP_FACADE_CALL_READ_TOOL_RAW_NAME = "call_read_tool";
export const MCP_FACADE_CALL_TOOL_RAW_NAME = "call_tool";

export function toMcpNameSegment(value: string): string {
  return tryMcpNameSegment(value) ?? "tool";
}

export function namespaceMcpToolName(serverName: string, rawToolName: string): string {
  return `mcp__${toMcpNameSegment(serverName)}__${toMcpNameSegment(rawToolName)}`;
}

export function mcpPermissionValueFromToolName(toolName: string): string | null {
  const parts = parseMcpToolName(toolName);
  return parts ? `${parts.server}/${parts.tool}` : null;
}

export function mcpPermissionValueFromFacadeCall(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const parts = parseMcpToolName(toolName);
  if (!parts || !isMcpFacadeCallToolSegment(parts.tool)) {
    return null;
  }
  if (typeof args.tool_name !== "string") {
    return null;
  }
  const target = permissionTargetSegment(parts.server, args.tool_name);
  return target ? `${parts.server}/${target}` : null;
}

export function isMcpFacadeCallToolName(toolName: string): boolean {
  const parts = parseMcpToolName(toolName);
  return Boolean(parts && isMcpFacadeCallToolSegment(parts.tool));
}

export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  const match = MCP_TOOL_NAME_PATTERN.exec(toolName);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

function permissionTargetSegment(serverSegment: string, targetName: string): string | null {
  if (!targetName.trim() || targetName.includes("\0")) {
    return null;
  }
  const parsed = parseMcpToolName(targetName);
  if (parsed) {
    return parsed.server === serverSegment ? parsed.tool : null;
  }
  return tryMcpNameSegment(targetName);
}

function isMcpFacadeCallToolSegment(toolSegment: string): boolean {
  return toolSegment === MCP_FACADE_CALL_TOOL_RAW_NAME ||
    toolSegment === MCP_FACADE_CALL_READ_TOOL_RAW_NAME;
}

function tryMcpNameSegment(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    // Collapse internal `_+` runs to a single `_` so a server/tool name cannot
    // smuggle the `__` separator that namespaces use (mcp__<server>__<tool>).
    // Without this, a server named `foo__bar` would produce segment `foo__bar`
    // and visually collide with the namespace boundary (L-8).
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized && MCP_NAME_SEGMENT_PATTERN.test(normalized) ? normalized : null;
}
