import { describe, expect, it } from "vitest";
import {
  MCP_SECRET_VALUE_MASK,
  isMcpServerConfigs,
  isMcpServerTransport,
  redactMcpServerConfigForRenderer,
} from "../../src/shared/mcp-contracts";
import {
  MCP_SECRET_VALUE_MASK as BARREL_MCP_SECRET_VALUE_MASK,
  isMcpServerTransport as isBarrelMcpServerTransport,
} from "../../src/shared/agent-contracts";

describe("mcp contracts", () => {
  it("owns MCP config guards while the shared barrel keeps compatibility", () => {
    const localServer = {
      id: "server-1",
      name: "docs mcp",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      headers: {},
      enabled: true,
      readOnlyTools: [],
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };
    const remoteServer = {
      id: "server-2",
      name: "docs_mcp",
      transport: "streamable-http",
      args: [],
      env: {},
      url: "https://mcp.example.test/mcp",
      headers: {},
      enabled: true,
      readOnlyTools: [],
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };

    expect(isMcpServerTransport("stdio")).toBe(true);
    expect(isBarrelMcpServerTransport("streamable-http")).toBe(true);
    expect(isMcpServerConfigs([localServer])).toBe(true);
    expect(isMcpServerConfigs([localServer, remoteServer])).toBe(false);
  });

  it("redacts MCP secrets for renderer copies", () => {
    const redacted = redactMcpServerConfigForRenderer({
      id: "server-1",
      name: "remote-mcp",
      transport: "streamable-http",
      args: [],
      env: { MCP_TOKEN: "token", PUBLIC_FLAG: "visible" },
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer token", "X-Trace": "trace" },
      enabled: true,
      readOnlyTools: [],
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    });

    expect(MCP_SECRET_VALUE_MASK).toBe("********");
    expect(BARREL_MCP_SECRET_VALUE_MASK).toBe(MCP_SECRET_VALUE_MASK);
    expect(redacted.env).toEqual({ MCP_TOKEN: MCP_SECRET_VALUE_MASK, PUBLIC_FLAG: "visible" });
    expect(redacted.headers).toEqual({ Authorization: MCP_SECRET_VALUE_MASK, "X-Trace": "trace" });
  });
});
