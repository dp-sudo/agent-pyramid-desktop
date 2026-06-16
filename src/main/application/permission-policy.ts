import type {
  RuntimePermissionRule,
  RuntimePermissionRuleEffect,
} from "../../shared/agent-contracts.js";
import {
  isMcpFacadeCallToolName,
  mcpPermissionValueFromFacadeCall,
  mcpPermissionValueFromToolName,
} from "../../shared/mcp-names.js";
import { parseUnifiedDiffFilePath } from "./unified-diff-path.js";

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

const COMMAND_PREFIX_UNSAFE_CONTINUATION_PATTERN = /&&|\|\||;;|[;&|<>`]|\$\(/;

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
      !matchesCandidateRule(candidate.tool, rule, candidate.value)
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
    return buildMcpPermissionCandidate(toolName, args);
  }
  if (toolName === "apply_patch") {
    if (typeof args.patch !== "string") {
      return null;
    }
    let paths: string[];
    try {
      paths = extractUnifiedDiffTargetPaths(args.patch);
    } catch {
      return null;
    }
    return paths.length > 0 ? { tool: "write", value: paths.join("\n") } : null;
  }
  return typeof args.path === "string"
    ? { tool: "write", value: normalizePermissionPath(args.path) }
    : null;
}

function buildMcpPermissionCandidate(
  toolName: string,
  args: Record<string, unknown> = {},
): { tool: RuntimePermissionRule["tool"]; value: string } | null {
  const facadeValue = mcpPermissionValueFromFacadeCall(toolName, args);
  if (facadeValue) {
    return { tool: "mcp", value: facadeValue };
  }
  if (isMcpFacadeCallToolName(toolName)) {
    return null;
  }
  const value = mcpPermissionValueFromToolName(toolName);
  return value ? { tool: "mcp", value } : null;
}

export function buildExactPermissionRuleForCall(input: {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  effect: RuntimePermissionRuleEffect;
}): RuntimePermissionRule | null {
  const candidate = buildPermissionCandidate(input.toolName, input.args);
  if (!candidate) return null;
  return {
    id: input.id,
    tool: candidate.tool,
    pattern: candidate.value,
    effect: input.effect,
    match: "exact",
  };
}

export function matchesPermissionPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const values = value.split("\n").map((entry) => entry.trim()).filter(Boolean);
  return values.some((entry) => wildcardToRegExp(normalizedPattern).test(entry));
}

function matchesCandidateRule(
  tool: RuntimePermissionRule["tool"],
  rule: RuntimePermissionRule,
  value: string,
): boolean {
  if (rule.match === "exact") {
    return matchesExactPermissionPattern(rule.pattern, value);
  }
  if (tool === "command" && matchesCommandPrefixPattern(rule.pattern, value)) {
    return true;
  }
  return matchesPermissionPattern(rule.pattern, value);
}

export function matchesExactPermissionPattern(pattern: string, value: string): boolean {
  const approvedValues = new Set(splitPermissionValues(pattern));
  const candidateValues = splitPermissionValues(value);
  return candidateValues.length > 0 &&
    candidateValues.every((entry) => approvedValues.has(entry));
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
  return values.some((entry) => {
    if (entry === prefix) {
      return true;
    }
    if (!entry.startsWith(`${prefix} `)) {
      return false;
    }
    return isSafeCommandPrefixContinuation(entry.slice(prefix.length).trimStart());
  });
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
  return parseUnifiedDiffFilePath(raw, "apply_patch file path is invalid.") ?? null;
}

function normalizeCommandValue(command: string): string {
  return command.trim().replace(/\r\n|\r|\n/g, " ; ").replace(/\s+/g, " ");
}

function isSafeCommandPrefixContinuation(continuation: string): boolean {
  return !COMMAND_PREFIX_UNSAFE_CONTINUATION_PATTERN.test(continuation);
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/");
}

function normalizePermissionPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function splitPermissionValues(value: string): string[] {
  return value.split("\n").map((entry) => entry.trim()).filter(Boolean);
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
