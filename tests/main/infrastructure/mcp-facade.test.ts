import { describe, expect, it, vi } from "vitest";
import {
  MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD,
  createProgressiveDiscoveryTools,
  resolveMcpFacadeTargetTool,
  shouldUseProgressiveDiscoveryFacade,
} from "../../../src/main/infrastructure/mcp/mcp-facade";
import type {
  ConnectedMcpFacadeServerSurface,
  McpFacadeServerSurface,
} from "../../../src/main/infrastructure/mcp/mcp-facade";
import type { AgentToolResult } from "../../../src/main/domain/agent/types";
import type { McpToolDescriptor } from "../../../src/main/infrastructure/mcp/protocol";

describe("MCP facade tools", () => {
  it("selects progressive discovery only for large catalogs", () => {
    expect(shouldUseProgressiveDiscoveryFacade(tools(MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD)))
      .toBe(false);
    expect(shouldUseProgressiveDiscoveryFacade(tools(MCP_PROGRESSIVE_DISCOVERY_TOOL_THRESHOLD + 1)))
      .toBe(true);
  });

  it("searches and describes tools without requiring a live connection", async () => {
    const server = surface([tool("read_alpha", true), tool("write_beta", false)]);
    const facadeTools = createProgressiveDiscoveryTools(server, async () => connected(server));

    const search = toolResult(await facadeTools[0].execute({ query: "alpha" }, {
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    expect(JSON.parse(search.content)).toMatchObject({
      serverId: "server-1",
      serverName: "local-mcp",
      totalToolCount: 2,
      matchCount: 1,
      tools: [{ rawName: "read_alpha", readOnly: true }],
    });

    const describe = toolResult(await facadeTools[1].execute({ tool_name: "write_beta" }, {
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    expect(JSON.parse(describe.content)).toMatchObject({
      tool: {
        name: "mcp__local-mcp__write_beta",
        rawName: "write_beta",
        inputSchema: { type: "object" },
      },
    });
  });

  it("calls read-only and write-capable tools through the connected surface", async () => {
    const server = surface([tool("read_alpha", true), tool("write_beta", false)]);
    const callTool = vi.fn(async () => ({
      content: "called",
      displayResult: { ok: true },
      isError: false,
    }));
    const facadeTools = createProgressiveDiscoveryTools(server, async () =>
      connected(server, callTool)
    );

    await expect(facadeTools[2].execute({ tool_name: "write_beta" }, {
      threadId: "thread-1",
      turnId: "turn-1",
    })).rejects.toThrow("MCP tool is not read-only on local-mcp: write_beta.");

    const result = toolResult(await facadeTools[3].execute({
      tool_name: "write_beta",
      arguments: { text: "hello" },
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    expect(callTool).toHaveBeenCalledWith(
      "mcp__local-mcp__write_beta",
      { text: "hello" },
      { signal: undefined },
    );
    expect(result.displayResult).toMatchObject({
      serverId: "server-1",
      serverName: "local-mcp",
      toolName: "write_beta",
      namespacedToolName: "mcp__local-mcp__write_beta",
      result: { ok: true },
    });
  });

  it("resolves target tools by namespaced, raw, or normalized raw name", () => {
    const server = surface([tool("write beta", false)]);

    expect(resolveMcpFacadeTargetTool(server, "mcp__local-mcp__write_beta").rawName)
      .toBe("write beta");
    expect(resolveMcpFacadeTargetTool(server, "write beta").rawName).toBe("write beta");
    expect(resolveMcpFacadeTargetTool(server, "write_beta").rawName).toBe("write beta");
    expect(() => resolveMcpFacadeTargetTool(server, "missing")).toThrow(
      "MCP tool is not registered on local-mcp: missing",
    );
  });
});

function surface(surfaceTools: readonly McpToolDescriptor[]): McpFacadeServerSurface {
  return {
    id: "server-1",
    name: "local-mcp",
    tools: surfaceTools,
  };
}

function connected(
  server: McpFacadeServerSurface,
  callTool = vi.fn(),
): ConnectedMcpFacadeServerSurface {
  return {
    ...server,
    callTool,
  };
}

function tools(count: number): McpToolDescriptor[] {
  return Array.from({ length: count }, (_, index) => tool(`tool_${index}`, true));
}

function tool(rawName: string, readOnly: boolean): McpToolDescriptor {
  return {
    name: `mcp__local-mcp__${rawName.replace(/\W+/g, "_")}`,
    rawName,
    description: `${rawName} description`,
    inputSchema: { type: "object" },
    readOnly,
  };
}

function toolResult(result: string | AgentToolResult): AgentToolResult {
  if (typeof result === "string") {
    throw new Error("Expected structured tool result.");
  }
  return result;
}
