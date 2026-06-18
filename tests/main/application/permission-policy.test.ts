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
      { id: "allow-tests", tool: "command", pattern: "run_command command=\"npm test\":*", effect: "allow" },
      { id: "deny-tests", tool: "command", pattern: "run_command command=\"npm test\":*", effect: "deny" },
      { id: "ask-tests", tool: "command", pattern: "run_command command=\"npm test\":*", effect: "ask" },
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
        { id: "test-prefix", tool: "command", pattern: "run_command command=\"npm test*", effect: "allow" },
      ],
    })).toBe("allow");
  });

  it("keeps legacy bare command rules matching structured command candidates", () => {
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test -- tests/main/application/permission-policy.test.ts" },
      rules: [
        { id: "legacy-prefix", tool: "command", pattern: "npm test:*", effect: "allow" },
      ],
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test && npm run build" },
      rules: [
        { id: "legacy-prefix", tool: "command", pattern: "npm test:*", effect: "allow" },
      ],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test" },
      rules: [
        {
          id: "legacy-exact",
          tool: "command",
          pattern: "npm test",
          effect: "deny",
          match: "exact",
        },
      ],
    })).toBe("deny");
  });

  it("keeps command prefix scopes from covering appended shell operators", () => {
    const prefixRule: RuntimePermissionRule = {
      id: "test-prefix",
      tool: "command",
      pattern: "run_command command=\"npm test\":*",
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

  it("keeps structured command prefix scopes inside the selected execution context", () => {
    const prefixRule: RuntimePermissionRule = {
      id: "test-prefix",
      tool: "command",
      pattern: "run_command command=\"npm test\":* cwd=packages/app",
      effect: "allow",
    };

    expect(evaluatePermission({
      toolName: "run_command",
      args: {
        command: "npm test -- tests/main/application/permission-policy.test.ts",
        cwd: "packages/app",
      },
      rules: [prefixRule],
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test -- tests/main/application/permission-policy.test.ts" },
      rules: [prefixRule],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "run_command",
      args: {
        command: "npm test -- tests/main/application/permission-policy.test.ts",
        cwd: "packages/other",
      },
      rules: [prefixRule],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "shell_command",
      args: {
        command: "npm test -- tests/main/application/permission-policy.test.ts",
        cwd: "packages/app",
      },
      rules: [prefixRule],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test && npm run build", cwd: "packages/app" },
      rules: [prefixRule],
    })).toBe("none");
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

  it("requires allow rules to cover every apply_patch target path", () => {
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

    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "src", tool: "write", pattern: "src/**/*.ts", effect: "allow" },
      ],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "src", tool: "write", pattern: "src/**/*.ts", effect: "allow" },
        { id: "docs", tool: "write", pattern: "docs/*.md", effect: "allow" },
      ],
    })).toBe("allow");
  });

  it("lets ask or deny rules override multi-target apply_patch allow coverage", () => {
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

    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "src", tool: "write", pattern: "src/**/*.ts", effect: "allow" },
        { id: "docs", tool: "write", pattern: "docs/*.md", effect: "ask" },
      ],
    })).toBe("ask");
    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "src", tool: "write", pattern: "src/**/*.ts", effect: "allow" },
        { id: "docs-ask", tool: "write", pattern: "docs/*.md", effect: "ask" },
        { id: "docs-deny", tool: "write", pattern: "docs/*.md", effect: "deny" },
      ],
    })).toBe("deny");
  });

  it("extracts apply_patch targets with spaces, quotes, and C-style escapes", () => {
    const utf8Name = Buffer.from([0xe6, 0xb5, 0x8b, 0xe8, 0xaf, 0x95]).toString("utf8");
    const patch = [
      "--- \"a/src/My File.ts\"\t2026-01-01 00:00:00",
      "+++ \"b/src/My File.ts\"\t2026-01-01 00:00:00",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- \"a/src/quote\\\"name.ts\"",
      "+++ \"b/src/quote\\\"name.ts\"",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- \"a/src/\\346\\265\\213\\350\\257\\225.ts\"",
      "+++ \"b/src/\\346\\265\\213\\350\\257\\225.ts\"",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(extractUnifiedDiffTargetPaths(patch)).toEqual([
      "src/My File.ts",
      "src/quote\"name.ts",
      `src/${utf8Name}.ts`,
    ]);
    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "space-path", tool: "write", pattern: "src/My File.ts", effect: "allow" },
      ],
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "space-path", tool: "write", pattern: "src/My File.ts", effect: "allow" },
        { id: "quote-path", tool: "write", pattern: "src/quote\"name.ts", effect: "allow" },
        { id: "utf8-path", tool: "write", pattern: `src/${utf8Name}.ts`, effect: "allow" },
      ],
    })).toBe("allow");
  });

  it("does not build apply_patch permission candidates from invalid file paths", () => {
    const patch = [
      "--- a/src/file.ts",
      `+++ b/src/file.ts${"\0"}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(() => extractUnifiedDiffTargetPaths(patch))
      .toThrow("apply_patch file path is invalid.");
    expect(buildPermissionCandidate("apply_patch", { patch })).toBeNull();
    expect(evaluatePermission({
      toolName: "apply_patch",
      args: { patch },
      rules: [
        { id: "src", tool: "write", pattern: "src/*", effect: "allow" },
      ],
    })).toBe("none");
  });

  it("returns none when no rule or no per-call candidate matches", () => {
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm run build" },
      rules: [
        { id: "tests", tool: "command", pattern: "run_command command=\"npm test*", effect: "allow" },
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
    expect(buildPermissionCandidate("run_command", {
      command: "git status",
      cwd: "packages/app",
    })).toEqual({
      tool: "command",
      value: "run_command command=\"git status\" cwd=packages/app",
    });
    expect(buildPermissionCandidate("shell_command", {
      command: "git status",
      shell: "bash",
      shell_path: "/bin/bash",
      shell_args: ["-lc", "{command}"],
      cwd: "packages/app",
    })).toEqual({
      tool: "command",
      value: "shell_command command=\"git status\" cwd=packages/app shell=bash shell_path=/bin/bash shell_args=[\"-lc\",\"{command}\"]",
    });
    expect(buildPermissionCandidate("start_command_session", {
      command: "npm run dev",
      cwd: "packages/app",
    })).toEqual({
      tool: "command",
      value: "start_command_session command=\"npm run dev\" cwd=packages/app",
    });
    expect(buildPermissionCandidate("edit_file", { path: "src\\main\\index.ts" })).toEqual({
      tool: "write",
      value: "src/main/index.ts",
    });
    expect(buildPermissionCandidate("multi_edit", { path: "./src/main/index.ts" })).toEqual({
      tool: "write",
      value: "src/main/index.ts",
    });
    expect(buildPermissionCandidate("git_commit", {
      all: true,
      cwd: "packages/app",
      message: "ship",
    })).toEqual({
      tool: "command",
      value: "git commit --stage=all -m=<message> @ packages/app",
    });
    expect(buildPermissionCandidate("package_install", {
      manager: "pnpm",
      frozen_lockfile: true,
      cwd: "packages/app",
    })).toEqual({
      tool: "command",
      value: "package install --manager=pnpm --frozen-lockfile @ packages/app",
    });
    expect(buildPermissionCandidate("run_tests", { manager: "npm" })).toEqual({
      tool: "command",
      value: "package run test --manager=npm",
    });
    expect(buildPermissionCandidate("diagnose_workspace", { cwd: "src" })).toEqual({
      tool: "command",
      value: "diagnose_workspace @ src",
    });
    expect(buildPermissionCandidate("write_command_session", {
      session_id: "session-1",
      input: "q",
    })).toEqual({
      tool: "command",
      value: "write_command_session:session-1 input=\"q\" newline=lf",
    });
    expect(buildPermissionCandidate("write_command_session", {
      session_id: "session-1",
      input: "q",
      newline: false,
    })).toEqual({
      tool: "command",
      value: "write_command_session:session-1 input=\"q\" newline=none",
    });
    expect(evaluatePermission({
      toolName: "run_tests",
      args: { manager: "npm" },
      rules: [
        { id: "allow-run-tests", tool: "command", pattern: "package run test:*", effect: "allow" },
      ],
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "package_install",
      args: { manager: "pnpm", frozen_lockfile: true },
      rules: [
        { id: "deny-install", tool: "command", pattern: "package install*", effect: "deny" },
      ],
    })).toBe("deny");
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
    expect(buildPermissionCandidate("write_command_session", { session_id: "session-1" })).toBeNull();
  });

  it("scopes write_command_session permission to the exact stdin payload", () => {
    const rules: RuntimePermissionRule[] = [
      {
        id: "allow-q",
        tool: "command",
        pattern: "write_command_session:session-1 input=\"q\" newline=lf",
        effect: "allow",
        match: "exact",
      },
    ];

    expect(evaluatePermission({
      toolName: "write_command_session",
      args: { session_id: "session-1", input: "q" },
      rules,
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "write_command_session",
      args: { session_id: "session-1", input: "quit" },
      rules,
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "write_command_session",
      args: { session_id: "session-1", input: "q", newline: false },
      rules,
    })).toBe("none");
  });

  it("scopes shell-like command permissions to tool and cwd context", () => {
    const rules: RuntimePermissionRule[] = [
      {
        id: "allow-run-command-tests",
        tool: "command",
        pattern: "run_command command=\"npm test\" cwd=packages/app",
        effect: "allow",
        match: "exact",
      },
    ];

    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test", cwd: "packages/app" },
      rules,
    })).toBe("allow");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test" },
      rules,
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "shell_command",
      args: { command: "npm test", cwd: "packages/app" },
      rules,
    })).toBe("none");
    expect(evaluatePermission({
      toolName: "run_command",
      args: { command: "npm test", cwd: "packages/other" },
      rules,
    })).toBe("none");
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
          pattern: "run_command command=\"npm test -- --name file?.ts\"",
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
          pattern: "run_command command=\"npm test -- --name file?.ts\"",
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
