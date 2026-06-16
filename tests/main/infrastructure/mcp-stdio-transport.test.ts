import { describe, expect, it } from "vitest";
import { buildMcpStdioEnvironment } from "../../../src/main/infrastructure/mcp/stdio-transport";

describe("StdioMcpTransport", () => {
  it("filters inherited credential-like environment while preserving explicit MCP env", () => {
    const environment = buildMcpStdioEnvironment(
      {
        MCP_TOKEN: "explicit-token",
        PATH: "explicit-path",
      },
      {
        HOME: "/home/user",
        OPENAI_API_KEY: "inherited-secret",
        CUSTOM_SECRET: "inherited-secret",
        PATH: "inherited-path",
      },
    );

    expect(environment.HOME).toBe("/home/user");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.CUSTOM_SECRET).toBeUndefined();
    expect(environment.PATH).toBe("explicit-path");
    expect(environment.MCP_TOKEN).toBe("explicit-token");
  });
});
