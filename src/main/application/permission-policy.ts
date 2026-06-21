import type {
  RuntimePermissionRule,
  RuntimePermissionRuleEffect,
} from "../../shared/agent-contracts.js";
import {
  isMcpFacadeCallToolName,
  mcpPermissionValueFromFacadeCall,
  mcpPermissionValueFromToolName,
} from "../../shared/mcp-names.js";
import { getRuntimeToolPermissionCandidate } from "../../shared/runtime-tool-contracts.js";
import { parseUnifiedDiffFilePath } from "./unified-diff-path.js";

export type PermissionPolicyDecision = RuntimePermissionRuleEffect | "none";

const DECISION_PRIORITY: Record<RuntimePermissionRuleEffect, number> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

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
  const candidateValues = splitPermissionValues(candidate.value);
  if (candidate.tool === "write" && candidateValues.length > 1) {
    return evaluateMultiValueWritePermission(candidate.tool, candidateValues, input.rules);
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

function evaluateMultiValueWritePermission(
  tool: RuntimePermissionRule["tool"],
  values: readonly string[],
  rules: readonly RuntimePermissionRule[],
): PermissionPolicyDecision {
  const allowedValues = new Set<string>();
  let hasAskMatch = false;

  for (const rule of rules) {
    if (rule.tool !== tool) {
      continue;
    }
    const matchingValues = values.filter((value) =>
      matchesSingleCandidateRule(tool, rule, value)
    );
    if (matchingValues.length === 0) {
      continue;
    }
    if (rule.effect === "deny") {
      return "deny";
    }
    if (rule.effect === "ask") {
      hasAskMatch = true;
      continue;
    }
    for (const value of matchingValues) {
      allowedValues.add(value);
    }
  }

  if (hasAskMatch) {
    return "ask";
  }
  return values.every((value) => allowedValues.has(value)) ? "allow" : "none";
}

export function buildPermissionCandidate(
  toolName: string,
  args: Record<string, unknown>,
): { tool: RuntimePermissionRule["tool"]; value: string } | null {
  switch (getRuntimeToolPermissionCandidate(toolName)) {
    case "shell_command": {
      const value = buildShellCommandPermissionValue(toolName, args);
      return value ? { tool: "command", value } : null;
    }
    case "generated_command": {
      const value = buildGeneratedCommandPermissionValue(toolName, args);
      return value ? { tool: "command", value: normalizeCommandValue(value) } : null;
    }
    case "apply_patch": {
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
    case "write_path":
      return typeof args.path === "string"
        ? { tool: "write", value: normalizePermissionPath(args.path) }
        : null;
    case null:
      return buildMcpPermissionCandidate(toolName, args);
  }
}

function buildShellCommandPermissionValue(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (typeof args.command !== "string") return null;
  const segments = [
    toolName,
    `command=${JSON.stringify(normalizeCommandValue(args.command))}`,
  ];
  appendShellCommandContextSegments(segments, toolName, args);
  return normalizeCommandValue(segments.join(" "));
}

function appendShellCommandContextSegments(
  segments: string[],
  toolName: string,
  args: Record<string, unknown>,
): void {
  const cwd = optionalNonBlankString(args.cwd);
  if (cwd) {
    segments.push(`cwd=${normalizePermissionPath(cwd)}`);
  }
  if (toolName === "shell_command") {
    const shell = optionalNonBlankString(args.shell);
    const shellPath = optionalNonBlankString(args.shell_path);
    const shellArgs = optionalPermissionStringArray(args.shell_args);
    if (shell) segments.push(`shell=${shell}`);
    if (shellPath) segments.push(`shell_path=${normalizePermissionPath(shellPath)}`);
    if (shellArgs) segments.push(`shell_args=${JSON.stringify(shellArgs)}`);
  }
  if (toolName === "git_bash_command") {
    const gitBashPath = optionalNonBlankString(args.git_bash_path);
    if (gitBashPath) segments.push(`git_bash_path=${normalizePermissionPath(gitBashPath)}`);
  }
  if (toolName === "powershell_command") {
    const executable = optionalNonBlankString(args.executable);
    if (executable) segments.push(`executable=${executable}`);
  }
  if (toolName === "wsl_command") {
    const distro = optionalNonBlankString(args.distro);
    if (distro) segments.push(`distro=${distro}`);
  }
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
  if (!sessionId) return null;
  if (action === "stop_command_session") {
    return `${action}:${sessionId}`;
  }
  const input = optionalSessionInputValue(args.input);
  if (input === null) return null;
  const newline = args.newline === false ? "none" : "lf";
  return `${action}:${sessionId} input=${input} newline=${newline}`;
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

function optionalSessionInputValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return JSON.stringify(normalizeCommandValue(value));
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
  return splitPermissionValues(value).some((entry) =>
    matchesSingleCandidateRule(tool, rule, entry)
  );
}

function matchesSingleCandidateRule(
  tool: RuntimePermissionRule["tool"],
  rule: RuntimePermissionRule,
  value: string,
): boolean {
  // Shell-like command candidates now include the tool name and execution
  // context. Bare command patterns are still accepted as a legacy compatibility
  // path, but they only match the parsed command field and cannot scope cwd.
  if (rule.match === "exact") {
    return matchesExactPermissionPattern(rule.pattern, value) ||
      (tool === "command" && matchesStructuredCommandFieldExactPattern(rule.pattern, value));
  }
  if (tool === "command" && matchesCommandPrefixPattern(rule.pattern, value)) {
    return true;
  }
  return matchesPermissionPattern(rule.pattern, value) ||
    (tool === "command" && matchesStructuredCommandFieldPattern(rule.pattern, value));
}

export function matchesExactPermissionPattern(pattern: string, value: string): boolean {
  const approvedValues = new Set(splitPermissionValues(pattern));
  const candidateValues = splitPermissionValues(value);
  return candidateValues.length > 0 &&
    candidateValues.every((entry) => approvedValues.has(entry));
}

function matchesCommandPrefixPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeCommandValue(pattern);
  const structuredPattern = parseStructuredCommandPrefixPattern(normalizedPattern);
  if (structuredPattern) {
    return splitPermissionValues(value).some((entry) => {
      const candidate = parseStructuredCommandCandidate(normalizeCommandValue(entry));
      return candidate !== null &&
        candidate.beforeCommand === structuredPattern.beforeCommand &&
        (!structuredPattern.afterCommand ||
          candidate.afterCommand === structuredPattern.afterCommand) &&
        matchesSafeCommandPrefix(structuredPattern.commandPrefix, candidate.command);
    });
  }
  if (!normalizedPattern.endsWith(":*")) {
    return false;
  }
  const prefix = normalizedPattern.slice(0, -2).trim();
  if (!prefix) {
    return false;
  }
  const values = value.split("\n").map((entry) => normalizeCommandValue(entry)).filter(Boolean);
  return values.some((entry) => {
    const candidate = parseStructuredCommandCandidate(entry);
    return matchesSafeCommandPrefix(prefix, entry) ||
      (candidate !== null && matchesSafeCommandPrefix(prefix, candidate.command));
  });
}

function matchesStructuredCommandFieldExactPattern(pattern: string, value: string): boolean {
  const approvedCommands = new Set(
    splitPermissionValues(pattern).map((entry) => normalizeCommandValue(entry)),
  );
  const candidateValues = splitPermissionValues(value);
  return candidateValues.length > 0 &&
    candidateValues.every((entry) => {
      const candidate = parseStructuredCommandCandidate(normalizeCommandValue(entry));
      return candidate !== null && approvedCommands.has(candidate.command);
    });
}

function matchesStructuredCommandFieldPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeCommandValue(pattern);
  const expression = wildcardToRegExp(normalizedPattern);
  return splitPermissionValues(value).some((entry) => {
    const candidate = parseStructuredCommandCandidate(normalizeCommandValue(entry));
    return candidate !== null && expression.test(candidate.command);
  });
}

interface StructuredCommandPrefixPattern {
  beforeCommand: string;
  commandPrefix: string;
  afterCommand: string;
}

interface StructuredCommandCandidate {
  beforeCommand: string;
  command: string;
  afterCommand: string;
}

function parseStructuredCommandPrefixPattern(
  pattern: string,
): StructuredCommandPrefixPattern | null {
  const commandValueStart = findStructuredCommandValueStart(pattern);
  if (commandValueStart === null) {
    return null;
  }
  const command = parseJsonStringAt(pattern, commandValueStart);
  if (!command || !command.value.trim()) {
    return null;
  }
  const markerEnd = command.end + 2;
  if (pattern.slice(command.end, markerEnd) !== ":*") {
    return null;
  }
  return {
    beforeCommand: pattern.slice(0, commandValueStart),
    commandPrefix: normalizeCommandValue(command.value),
    afterCommand: pattern.slice(markerEnd),
  };
}

function parseStructuredCommandCandidate(value: string): StructuredCommandCandidate | null {
  const commandValueStart = findStructuredCommandValueStart(value);
  if (commandValueStart === null) {
    return null;
  }
  const command = parseJsonStringAt(value, commandValueStart);
  if (!command) {
    return null;
  }
  return {
    beforeCommand: value.slice(0, commandValueStart),
    command: normalizeCommandValue(command.value),
    afterCommand: value.slice(command.end),
  };
}

function findStructuredCommandValueStart(value: string): number | null {
  const marker = "command=";
  const firstSpaceIndex = value.indexOf(" ");
  if (
    firstSpaceIndex <= 0 ||
    getRuntimeToolPermissionCandidate(value.slice(0, firstSpaceIndex)) !== "shell_command"
  ) {
    return null;
  }
  const markerIndex = value.indexOf(marker);
  return markerIndex >= 0 ? markerIndex + marker.length : null;
}

function parseJsonStringAt(
  value: string,
  start: number,
): { value: string; end: number } | null {
  if (value[start] !== "\"") {
    return null;
  }
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] !== "\"") {
      continue;
    }
    const literal = value.slice(start, index + 1);
    try {
      const parsed = JSON.parse(literal) as unknown;
      return typeof parsed === "string" ? { value: parsed, end: index + 1 } : null;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function matchesSafeCommandPrefix(prefix: string, command: string): boolean {
  if (command === prefix) {
    return true;
  }
  if (!command.startsWith(`${prefix} `)) {
    return false;
  }
  return isSafeCommandPrefixContinuation(command.slice(prefix.length).trimStart());
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
