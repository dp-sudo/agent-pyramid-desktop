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

const SHELL_COMMAND_POLICY_TOOL_NAMES = new Set([
  "run_command",
  "shell_command",
  "git_bash_command",
  "powershell_command",
  "wsl_command",
  "start_command_session",
]);

const GENERATED_COMMAND_POLICY_TOOL_NAMES = new Set([
  "git_commit",
  "package_install",
  "package_test",
  "package_build",
  "run_lint",
  "run_format",
  "run_tests",
  "run_build",
  "write_command_session",
  "stop_command_session",
  "diagnose_workspace",
]);

const PACKAGE_SCRIPT_DEFAULTS: Record<string, string> = {
  package_test: "test",
  package_build: "build",
};

const TASK_COMMAND_LABELS: Record<string, string> = {
  run_lint: "lint",
  run_format: "format",
  run_tests: "test",
  run_build: "build",
};

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
  if (SHELL_COMMAND_POLICY_TOOL_NAMES.has(toolName)) {
    return typeof args.command === "string"
      ? { tool: "command", value: normalizeCommandValue(args.command) }
      : null;
  }
  if (GENERATED_COMMAND_POLICY_TOOL_NAMES.has(toolName)) {
    const value = buildGeneratedCommandPermissionValue(toolName, args);
    return value ? { tool: "command", value: normalizeCommandValue(value) } : null;
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
    } catch (_error) {
      // Invalid patch headers cannot be converted into a precise write rule candidate.
      // Returning null keeps approval policy from granting access on ambiguous paths.
      return null;
    }
    return paths.length > 0 ? { tool: "write", value: paths.join("\n") } : null;
  }
  return typeof args.path === "string"
    ? { tool: "write", value: normalizePermissionPath(args.path) }
    : null;
}

function buildGeneratedCommandPermissionValue(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case "git_commit":
      return buildGitCommitPermissionValue(args);
    case "package_install":
      return buildPackageInstallPermissionValue(args);
    case "package_test":
    case "package_build":
      return buildPackageScriptPermissionValue(toolName, args);
    case "run_lint":
    case "run_format":
    case "run_tests":
    case "run_build":
      return buildTaskCommandPermissionValue(toolName, args);
    case "write_command_session":
      return buildCommandSessionPermissionValue("write_command_session", args);
    case "stop_command_session":
      return buildCommandSessionPermissionValue("stop_command_session", args);
    case "diagnose_workspace":
      return appendOptionalCwd("diagnose_workspace", args);
    default:
      return null;
  }
}

function buildGitCommitPermissionValue(args: Record<string, unknown>): string {
  const segments = ["git commit"];
  if (args.all === true) {
    segments.push("--stage=all");
  } else {
    const pathspecs = optionalPermissionStringArray(args.pathspecs);
    if (pathspecs && pathspecs.length > 0) {
      segments.push(`--stage=${pathspecs.map(normalizePermissionPath).join(",")}`);
    }
  }
  segments.push("-m=<message>");
  return appendOptionalCwd(segments.join(" "), args);
}

function buildPackageInstallPermissionValue(args: Record<string, unknown>): string {
  const segments = ["package install"];
  const manager = optionalPackageManagerValue(args.manager);
  if (manager) {
    segments.push(`--manager=${manager}`);
  }
  if (args.frozen_lockfile === true) {
    segments.push("--frozen-lockfile");
  }
  return appendOptionalCwd(segments.join(" "), args);
}

function buildPackageScriptPermissionValue(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const defaultScript = PACKAGE_SCRIPT_DEFAULTS[toolName];
  if (!defaultScript) {
    return null;
  }
  return buildPackageRunPermissionValue(
    optionalNonBlankString(args.script) ?? defaultScript,
    args,
  );
}

function buildTaskCommandPermissionValue(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const task = TASK_COMMAND_LABELS[toolName];
  return task ? buildPackageRunPermissionValue(task, args) : null;
}

function buildPackageRunPermissionValue(
  script: string,
  args: Record<string, unknown>,
): string {
  const segments = ["package run", script];
  const manager = optionalPackageManagerValue(args.manager);
  if (manager) {
    segments.push(`--manager=${manager}`);
  }
  return appendOptionalCwd(segments.join(" "), args);
}

function buildCommandSessionPermissionValue(
  action: "write_command_session" | "stop_command_session",
  args: Record<string, unknown>,
): string | null {
  const sessionId = optionalNonBlankString(args.session_id);
  return sessionId ? `${action}:${sessionId}` : null;
}

function appendOptionalCwd(value: string, args: Record<string, unknown>): string {
  const cwd = optionalNonBlankString(args.cwd);
  return cwd ? `${value} @ ${normalizePermissionPath(cwd)}` : value;
}

function optionalPackageManagerValue(value: unknown): string | null {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun"
    ? value
    : null;
}

function optionalNonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalPermissionStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : null;
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
