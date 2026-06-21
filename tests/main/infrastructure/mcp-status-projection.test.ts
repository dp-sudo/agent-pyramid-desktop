import { describe, expect, it } from "vitest";
import {
  toMcpConnectionEvent,
  toMcpServerStatusRecord,
  toMcpSurfaceChangedEvent,
  toMcpToolListChangedEvent,
  type McpStatusProjectionInput,
} from "../../../src/main/infrastructure/mcp/status-projection";

describe("MCP status projection", () => {
  it("projects status records and runtime events from one server snapshot", () => {
    const input: McpStatusProjectionInput = {
      config: {
        id: "server-1",
        name: "local-mcp",
        transport: "stdio",
        enabled: true,
      },
      status: "connected",
      tools: [
        {
          rawName: "echo",
          name: "mcp__local-mcp__echo",
          description: "Echo",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      prompts: [
        {
          name: "summarize",
          description: "Summarize",
          arguments: [{ name: "topic", required: true }],
        },
      ],
      resources: [{ uri: "file://readme", name: "README", description: "Readme" }],
      startupStats: {
        fingerprint: "fingerprint",
        serverId: "server-1",
        serverName: "local-mcp",
        successCount: 2,
        failureCount: 1,
        lastDurationMs: 123,
      },
      lastConnectedAt: "2026-06-08T00:00:00.000Z",
    };

    expect(toMcpServerStatusRecord(input)).toEqual({
      id: "server-1",
      name: "local-mcp",
      transport: "stdio",
      enabled: true,
      status: "connected",
      toolCount: 1,
      tools: [
        {
          name: "mcp__local-mcp__echo",
          description: "Echo",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      promptCount: 1,
      prompts: [
        {
          name: "summarize",
          description: "Summarize",
          arguments: [{ name: "topic", required: true }],
        },
      ],
      resourceCount: 1,
      resources: [{ uri: "file://readme", name: "README", description: "Readme" }],
      lastStartupDurationMs: 123,
      startupSuccessCount: 2,
      startupFailureCount: 1,
      lastConnectedAt: "2026-06-08T00:00:00.000Z",
    });
    expect(toMcpConnectionEvent(input, "2026-06-08T00:00:01.000Z")).toMatchObject({
      kind: "mcp_server_connection",
      serverId: "server-1",
      status: "connected",
      toolCount: 1,
    });
    expect(toMcpToolListChangedEvent(input, "2026-06-08T00:00:01.000Z")).toMatchObject({
      kind: "mcp_tool_list_changed",
      tools: [{ name: "mcp__local-mcp__echo" }],
    });
    expect(toMcpSurfaceChangedEvent(input, "2026-06-08T00:00:01.000Z")).toMatchObject({
      kind: "mcp_surface_changed",
      promptCount: 1,
      resourceCount: 1,
    });
  });
});
