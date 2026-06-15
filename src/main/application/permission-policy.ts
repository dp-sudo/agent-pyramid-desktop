import type {
  RuntimePermissionRule,
  RuntimePermissionRuleEffect,
} from "../../shared/agent-contracts.js";
import { mcpPermissionValueFromToolName } from "../../shared/mcp-names.js";

export type PermissionPolicyDecision = RuntimePermissionRuleEffect | "none";

const DECISION_PRIORITY: Record<RuntimePermissionRuleEffect, number> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

const COMMAND_POLICY_TOOL_NAMES = new Set([
  "run_command",
  "shell_command",
  "git_bash_command",
  "powershell_command",
  "wsl_command",
  "start_command_session",
]);

const WRITE_POLICY_TOOL_NAMES = new Set([
  "edit_file",
  "multi_edit",
  "write_file",
  "delete_file",
  "apply_patch",
  "rollback_file",
]);

export interface PermissionPolicyInput {
  toolName: string;
  args: Record<string, unknown>;
  rules: readonly RuntimePermissionRule[];
}

/**
 * Per-call permission rules are an approval shortcut only: sandbox/path
 * enforcement remains in AgentRuntime and the tools themselves. The evaluator
 * is pure so rule priority and pattern matching cannot drift across callers.
 */
export function evaluatePermission(input: PermissionPolicyInput): PermissionPolicyDecision {
  const candidate = buildPermissionCandidate(input.toolName, input.args);
  if (!candidate) {
    return "none";
  }

  let decision: PermissionPolicyDecision = "none";
  let priority = 0;
  for (const rule of input.rules) {
    if (
      rule.tool !== candidate.tool ||
      !matchesCandidatePattern(candidate.tool, rule.pattern, candidate.value)
    ) {
      continue;
    }
    const nextPriority = DECISION_PRIORITY[rule.effect];
    if (nextPriority > priority) {
      decision = rule.effect;
      priority = nextPriority;
    }
  }
  return decision;
}

export function buildPermissionCandidate(
  toolName: string,
  args: Record<string, unknown>,
): { tool: RuntimePermissionRule["tool"]; value: string } | null {
  if (COMMAND_POLICY_TOOL_NAMES.has(toolName)) {
    return typeof args.command === "string"
      ? { tool: "command", value: normalizeCommandValue(args.command) }
      : null;
  }
  if (!WRITE_POLICY_TOOL_NAMES.has(toolName)) {
    return buildMcpPermissionCandidate(toolName);
  }
  if (toolName === "apply_patch") {
    if (typeof args.patch !== "string") {
      return null;
    }
    const paths = extractUnifiedDiffTargetPaths(args.patch);
    return paths.length > 0 ? { tool: "write", value: paths.join("\n") } : null;
  }
  return typeof args.path === "string"
    ? { tool: "write", value: normalizePermissionPath(args.path) }
    : null;
}

function buildMcpPermissionCandidate(
  toolName: string,
): { tool: RuntimePermissionRule["tool"]; value: string } | null {
  const value = mcpPermissionValueFromToolName(toolName);
  return value ? { tool: "mcp", value } : null;
}

export function matchesPermissionPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const values = value.split("\n").map((entry) => entry.trim()).filter(Boolean);
  return values.some((entry) => wildcardToRegExp(normalizedPattern).test(entry));
}

function matchesCandidatePattern(
  tool: RuntimePermissionRule["tool"],
  pattern: string,
  value: string,
): boolean {
  if (tool === "command" && matchesCommandPrefixPattern(pattern, value)) {
    return true;
  }
  return matchesPermissionPattern(pattern, value);
}

function matchesCommandPrefixPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeCommandValue(pattern);
  if (!normalizedPattern.endsWith(":*")) {
    return false;
  }
  const prefix = normalizedPattern.slice(0, -2).trim();
  if (!prefix) {
    return false;
  }
  const values = value.split("\n").map((entry) => normalizeCommandValue(entry)).filter(Boolean);
  return values.some((entry) => entry === prefix || entry.startsWith(`${prefix} `));
}

export function extractUnifiedDiffTargetPaths(patch: string): string[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const paths: string[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].startsWith("--- ") || !lines[index + 1].startsWith("+++ ")) {
      continue;
    }
    const oldPath = parsePatchPathToken(lines[index].slice(4));
    const newPath = parsePatchPathToken(lines[index + 1].slice(4));
    const targetPath = newPath ?? oldPath;
    if (targetPath) {
      paths.push(normalizePermissionPath(targetPath));
    }
    index += 1;
  }
  return [...new Set(paths)];
}

function parsePatchPathToken(raw: string): string | null {
  const token = raw.trim().split(/\s+/)[0];
  if (!token || token === "/dev/null") {
    return null;
  }
  return token.startsWith("a/") || token.startsWith("b/")
    ? token.slice(2)
    : token;
}

function normalizeCommandValue(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/");
}

function normalizePermissionPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function wildcardToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
