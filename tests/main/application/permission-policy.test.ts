import { describe, expect, it } from "vitest";
import {
  buildPermissionCandidate,
  evaluatePermission,
  extractUnifiedDiffTargetPaths,
  matchesExactPermissionPattern,
  matchesPermissionPattern,
} from "../../../src/main/application/permission-policy";
import type { RuntimePermissionRule } from "../../../src/shared/agent-contracts";

describe("permission-policy", () => {
  it("applies deny over ask over allow regardless of rule order", () => {
    const rules: RuntimePermissionRule[] = [
      { id: "allow-tests", tool: "command", pattern: "npm test:*", effect: "allow" },
      { id: "deny-tests", tool: "command", pattern: "npm test:*", effect: "deny" },
      { id: "ask-tests", tool: "command", pattern: "npm test:*", effect: "ask" },
    ];

    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test -- tests/main/application/permission-policy.test.ts" },
      rules,
    })).toBe("deny");
  });

  it("matches command wildcards against normalized shell text", () => {
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: " npm   test -- --runInBand " },
      rules: [
        { id: "test-prefix", tool: "command", pattern: "npm test*", effect: "allow" },
      ],
    })).toBe("allow");
  });

  it("keeps command prefix scopes from covering appended shell operators", () => {
    const prefixRule: RuntimePermissionRule = {
      id: "test-prefix",
      tool: "command",
      pattern: "npm test:*",
      effect: "allow",
    };

    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test -- tests/main/application/permission-policy.test.ts" },
      rules: [prefixRule],
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test" },
      rules: [prefixRule],
    })).toBe("allow");

    for (const command of [
      "npm test && npm run build",
      "npm test || true",
      "npm test; npm run build",
      "npm test | tee output.txt",
      "npm test > output.txt",
      "npm test `whoami`",
      "npm test $(whoami)",
      "npm test\nnpm run build",
    ]) {
      expect(evaluatePermission({
        toolName: "run_command",
        args: { command },
        rules: [prefixRule],
      })).toBe("none");
    }
  });

  it("matches workspace write path globs", () => {
    expect(evaluatePermission({
      toolName: "write_file",
      args: { path: "./src/main/application/permission-policy.ts" },
      rules: [
        { id: "src-ts", tool: "write", pattern: "src/*.ts", effect: "ask" },
      ],
    })).toBe("ask");
  });

  it("matches apply_patch when any target path matches", () => {
    const patch = [
      "--- a/src/main/old.ts",
      "+++ b/src/main/new.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/docs/old.md",
      "+++ b/docs/new.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(extractUnifiedDiffTargetPaths(patch)).toEqual([
      "src/main/new.ts",
      "docs/new.md",
    ]);
    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "docs", tool: "write", pattern: "docs/*.md", effect: "deny" },
      ],
    })).toBe("deny");
  });

  it("returns none when no rule or no per-call candidate matches", () => {
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm run build" },
      rules: [
        { id: "tests", tool: "command", pattern: "npm test*", effect: "allow" },
      ],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "git_status",
      args: {},
      rules: [
        { id: "git", tool: "command", pattern: "git *", effect: "deny" },
      ],
    })).toBe("none");
  });

  it("builds candidates only for command and write calls with matching arguments", () => {
    expect(buildPermissionCandidate("shell_command", { command: "git status" })).toEqual({
      tool: "command",
      value: "git status",
    });
    expect(buildPermissionCandidate("edit_file", { path: "src\\main\\index.ts" })).toEqual({
      tool: "write",
      value: "src/main/index.ts",
    });
    expect(buildPermissionCandidate("multi_edit", { path: "./src/main/index.ts" })).toEqual({
      tool: "write",
      value: "src/main/index.ts",
    });
    expect(buildPermissionCandidate("mcp__local-mcp__echo", {})).toEqual({
      tool: "mcp",
      value: "local-mcp/echo",
    });
    expect(buildPermissionCandidate("mcp__local-mcp__call_tool", {
      tool_name: "write_beta",
    })).toEqual({
      tool: "mcp",
      value: "local-mcp/write_beta",
    });
    expect(buildPermissionCandidate("mcp__local-mcp__call_tool", {
      tool_name: "mcp__local-mcp__write_beta",
    })).toEqual({
      tool: "mcp",
      value: "local-mcp/write_beta",
    });
    expect(buildPermissionCandidate("mcp__local-mcp__call_read_tool", {
      tool_name: "read alpha",
    })).toEqual({
      tool: "mcp",
      value: "local-mcp/read_alpha",
    });
    expect(buildPermissionCandidate("mcp__local_mcp__echo_tool", {})).toEqual({
      tool: "mcp",
      value: "local_mcp/echo_tool",
    });
    expect(buildPermissionCandidate("mcp__local-mcp__call_tool", {
      tool_name: "mcp__other__write_beta",
    })).toBeNull();
    expect(buildPermissionCandidate("mcp__bad", {})).toBeNull();
    expect(buildPermissionCandidate("mcp__/bad__echo", {})).toBeNull();
    expect(buildPermissionCandidate("mcp___bad__echo", {})).toBeNull();
    expect(buildPermissionCandidate("mcp__bad___echo", {})).toBeNull();
    expect(buildPermissionCandidate("mcp__bad__echo_", {})).toBeNull();
    expect(buildPermissionCandidate("write_command_session", { input: "q" })).toBeNull();
  });

  it("evaluates MCP facade call permission rules against the selected target tool", () => {
    expect(evaluatePermission({
      toolName: "mcp__local-mcp__call_tool",
      args: { tool_name: "write_beta", arguments: { text: "hello" } },
      rules: [
        { id: "allow-beta", tool: "mcp", pattern: "local-mcp/write_beta", effect: "allow" },
      ],
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "mcp__local-mcp__call_tool",
      args: { tool_name: "write_beta", arguments: { text: "hello" } },
      rules: [
        { id: "allow-facade", tool: "mcp", pattern: "local-mcp/call_tool", effect: "allow" },
      ],
    })).toBe("none");
  });

  it("supports basic wildcard matching without treating regex syntax specially", () => {
    expect(matchesPermissionPattern("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchesPermissionPattern("src/*.ts", "src/index.tsx")).toBe(false);
    expect(matchesPermissionPattern("file?.ts", "file1.ts")).toBe(true);
    expect(matchesPermissionPattern("file?.ts", "file10.ts")).toBe(false);
    expect(matchesPermissionPattern("src/[abc].ts", "src/a.ts")).toBe(false);
  });

  it("matches exact permission rules without expanding wildcard characters", () => {
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test -- --name file1.ts" },
      rules: [
        {
          id: "exact-test",
          tool: "command",
          pattern: "npm test -- --name file?.ts",
          effect: "allow",
          match: "exact",
        },
      ],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test -- --name file?.ts" },
      rules: [
        {
          id: "exact-test",
          tool: "command",
          pattern: "npm test -- --name file?.ts",
          effect: "allow",
          match: "exact",
        },
      ],
    })).toBe("allow");
  });

  it("requires every multi-value candidate to be covered by exact permission rules", () => {
    expect(matchesExactPermissionPattern("src/a.ts\ndocs/a.md", "docs/a.md")).toBe(true);
    expect(matchesExactPermissionPattern("src/a.ts\ndocs/a.md", "src/a.ts\ndocs/a.md")).toBe(true);
    expect(matchesExactPermissionPattern("src/a.ts\ndocs/a.md", "src/a.ts\nsecret.env")).toBe(false);
  });
});
