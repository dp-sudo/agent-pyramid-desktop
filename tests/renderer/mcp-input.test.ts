import { describe, expect, it, vi } from "vitest";
import {
  findMcpResourceReferences,
  parseMcpPromptCommand,
  resolveMcpInputReferences,
  type McpInputApi,
} from "../../src/renderer/src/ui/mcp-input";
import { err, ok } from "../../src/shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../src/shared/ipc-errors";

describe("MCP composer input", () => {
  it("parses MCP slash prompt commands conservatively", () => {
    expect(parseMcpPromptCommand("Explain this")).toEqual({ ok: true, command: null });
    expect(parseMcpPromptCommand("/mcp__docs__review README.md src/main.ts")).toEqual({
      ok: true,
      command: {
        serverSegment: "docs",
        promptSegment: "review",
        args: ["README.md", "src/main.ts"],
      },
    });
    expect(parseMcpPromptCommand("/mcp__bad")).toEqual({
      ok: false,
      message: "MCP prompt commands must use /mcp__server__prompt followed by positional arguments.",
    });
  });

  it("finds unique MCP resource references without consuming ordinary text", () => {
    expect(findMcpResourceReferences("mail test@example.com")).toEqual([]);
    expect(findMcpResourceReferences("Use @docs:file:///README.md and (@docs:file:///README.md)."))
      .toEqual([
        {
          token: "@docs:file:///README.md",
          serverSegment: "docs",
          uri: "file:///README.md",
        },
      ]);
  });

  it("resolves slash prompt output into turn text while preserving visible input", async () => {
    const api = createApi();

    await expect(resolveMcpInputReferences({
      text: "/mcp__docs__review README.md",
      threadTitle: "/mcp__docs__review README.md",
    }, api)).resolves.toEqual({
      ok: true,
      value: {
        text: "Review README.md",
        displayText: "/mcp__docs__review README.md",
        threadTitle: "/mcp__docs__review README.md",
      },
    });
    expect(api.getPrompt).toHaveBeenCalledWith({
      serverId: "server-1",
      name: "review",
      arguments: { path: "README.md" },
    });
  });

  it("injects MCP resource text after the visible user text", async () => {
    const api = createApi();

    await expect(resolveMcpInputReferences({
      text: "Summarize @docs:file:///README.md",
      threadTitle: "Summarize @docs:file:///README.md",
    }, api)).resolves.toEqual({
      ok: true,
      value: {
        text: [
          "Summarize @docs:file:///README.md",
          "",
          "MCP resources:",
          "",
          "Reference: @docs:file:///README.md",
          "Server: docs",
          "URI: file:///README.md",
          "# Readme",
        ].join("\n"),
        displayText: "Summarize @docs:file:///README.md",
        threadTitle: "Summarize @docs:file:///README.md",
      },
    });
  });

  it("returns visible errors when MCP prompt lookup fails", async () => {
    const api = createApi({
      listPrompts: vi.fn(async () => err(
        IPC_ERROR_CODES.MCP_PROMPT_LIST_FAILED,
        "MCP prompts unavailable",
      )),
    });

    await expect(resolveMcpInputReferences({
      text: "/mcp__docs__review README.md",
      threadTitle: "/mcp__docs__review README.md",
    }, api)).resolves.toEqual({
      ok: false,
      message: "MCP prompts unavailable",
    });
  });

  it("uses the provided translator for user-visible MCP parser errors", async () => {
    await expect(resolveMcpInputReferences({
      text: "/mcp__missing__review README.md",
      threadTitle: "/mcp__missing__review README.md",
    }, createApi(), testT)).resolves.toEqual({
      ok: false,
      message: "missing server missing",
    });
    expect(parseMcpPromptCommand("/mcp__bad", testT)).toEqual({
      ok: false,
      message: "bad MCP command",
    });
  });
});

function createApi(overrides: Partial<McpInputApi> = {}): McpInputApi {
  return {
    listPrompts: vi.fn(async () => ok({
      servers: [
        {
          serverId: "server-1",
          serverName: "docs",
          prompts: [
            {
              name: "review",
              description: "Review a path",
              arguments: [{ name: "path", required: true }],
            },
          ],
        },
      ],
    })),
    getPrompt: vi.fn(async () => ok({
      messages: [
        { role: "user", content: { type: "text", text: "Review README.md" } },
      ],
    })),
    listResources: vi.fn(async () => ok({
      servers: [
        {
          serverId: "server-1",
          serverName: "docs",
          resources: [
            {
              uri: "file:///README.md",
              name: "README",
              description: "",
              mimeType: "text/markdown",
            },
          ],
        },
      ],
    })),
    readResource: vi.fn(async () => ok({
      contents: [
        {
          uri: "file:///README.md",
          mimeType: "text/markdown",
          text: "# Readme",
        },
      ],
    })),
    ...overrides,
  };
}

function testT(key: string, options?: Record<string, unknown>): string {
  if (key === "composer.mcpPromptCommandInvalid") return "bad MCP command";
  if (key === "composer.mcpPromptServerNotFound") {
    return `missing server ${String(options?.server)}`;
  }
  return key;
}
