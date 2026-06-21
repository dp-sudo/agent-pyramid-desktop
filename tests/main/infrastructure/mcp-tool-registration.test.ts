import { describe, expect, it } from "vitest";
import { MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD } from "../../../src/main/infrastructure/mcp/host";
import { planMcpToolRegistration } from "../../../src/main/infrastructure/mcp/tool-registration";
import type { McpToolDescriptor } from "../../../src/main/infrastructure/mcp/protocol";

describe("MCP tool registration planning", () => {
  it("uses direct live or lazy registration below the facade threshold", () => {
    const tools = makeTools(MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD);

    expect(planMcpToolRegistration(tools)).toEqual({
      mode: "live",
      useFacade: false,
      lazy: false,
    });
    expect(planMcpToolRegistration(tools, { lazy: true })).toEqual({
      mode: "lazy",
      useFacade: false,
      lazy: true,
    });
  });

  it("uses facade registration above the progressive discovery threshold", () => {
    const tools = makeTools(MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD + 1);

    expect(planMcpToolRegistration(tools)).toEqual({
      mode: "facade",
      useFacade: true,
      lazy: false,
    });
    expect(planMcpToolRegistration(tools, { lazy: true })).toEqual({
      mode: "lazy_facade",
      useFacade: true,
      lazy: true,
    });
  });
});

function makeTools(count: number): McpToolDescriptor[] {
  return Array.from({ length: count }, (_, index) => ({
    rawName: `tool-${index}`,
    name: `mcp__server__tool-${index}`,
    description: `Tool ${index}`,
    inputSchema: { type: "object" },
    readOnly: true,
  }));
}
