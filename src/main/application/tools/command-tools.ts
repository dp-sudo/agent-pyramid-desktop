import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import ts from "typescript";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../../domain/agent/types";
import {
  requireWorkspace,
  resolveWorkspacePathForAccess,
  toWorkspaceRelative,
} from "./workspace-policy.js";
import { assertUtf8TextBuffer } from "./text-file.js";
import { isPathInsideOrEqual, isSamePath } from "../path-utils.js";
import {
  DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
  MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  MIN_RUNTIME_COMMAND_TIMEOUT_MS,
} from "../../../shared/agent-contracts.js";

const DEFAULT_COMMAND_TIMEOUT_MS = DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS;
const MIN_COMMAND_TIMEOUT_MS = MIN_RUNTIME_COMMAND_TIMEOUT_MS;
const MAX_COMMAND_TIMEOUT_MS = MAX_RUNTIME_COMMAND_TIMEOUT_MS;
const DEFAULT_COMMAND_MAX_OUTPUT_BYTES = DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
const MIN_COMMAND_MAX_OUTPUT_BYTES = MIN_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
const MAX_COMMAND_MAX_OUTPUT_BYTES = MAX_RUNTIME_COMMAND_MAX_OUTPUT_BYTES;
const MAX_COMMAND_BYTES = 4_096;
const KILL_GRACE_MS = 1_000;
const COMMAND_TIMEOUT_DESCRIPTION =
  `Maximum runtime in milliseconds. Defaults to the runtime command preference ` +
  `(${DEFAULT_COMMAND_TIMEOUT_MS}). Overrides must be between ${MIN_COMMAND_TIMEOUT_MS} ` +
  `and the current runtime command preference, which cannot exceed ${MAX_COMMAND_TIMEOUT_MS}.`;

interface CommandRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface WorkspaceDiagnostic {
  path: string;
  line: number;
  column: number;
  code: string;
  severity: "error" | "warning" | "suggestion" | "message";
  message: string;
  source: "typecheck" | "language_service";
}

interface DiagnoseWorkspaceResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  diagnostics: WorkspaceDiagnostic[];
  diagnosticCount: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  rawOutput: string;
}

interface DiagnoseFileResult extends DiagnoseWorkspaceResult {
  path: string;
}

export function createCommandTools(): AgentTool[] {
  return [runCommandTool, diagnoseWorkspaceTool, diagnoseFileTool];
}

const runCommandTool: AgentTool = {
  /**
   * Shell-backed commands are treated as destructive because cwd sandboxing
   * constrains where the process starts, not what the shell can do.
   */
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "run_command",
    description:
      "Run a foreground shell command inside the current workspace. Use it for tests, builds, diagnostics, and short project commands. Long-running background processes are not supported.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run.",
        },
        cwd: {
          type: "string",
          description: "Workspace-relative directory to run from. Defaults to the workspace root.",
        },
        timeout_ms: {
          type: "number",
          description: COMMAND_TIMEOUT_DESCRIPTION,
        },
      },
      required: ["command"],
    },
  },
  async execute(input, context) {
    const result = await executeRunCommand(input, context);
    return toToolResult(result);
  },
};

const diagnoseWorkspaceTool: AgentTool = {
  /**
   * Workspace diagnostics may execute package scripts, so they use the same
   * approval boundary as command execution instead of read-only bypass.
   */
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "diagnose_workspace",
    description:
      "Run the workspace TypeScript/typecheck diagnostics and return structured errors. Prefer this after edits or patches in TypeScript projects.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative directory to diagnose. Defaults to the workspace root.",
        },
        timeout_ms: {
          type: "number",
          description: COMMAND_TIMEOUT_DESCRIPTION,
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executeDiagnoseWorkspace(input, context);
    return {
      toolCallId: "",
      name: "diagnose_workspace",
      content: JSON.stringify({
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        diagnosticCount: result.diagnosticCount,
        diagnostics: result.diagnostics,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      }),
      displayResult: result,
    };
  },
};

const diagnoseFileTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "diagnose_file",
    description:
      "Run workspace TypeScript/typecheck diagnostics and return only diagnostics for one UTF-8 workspace file. Use after editing a specific TypeScript file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to diagnose.",
        },
      },
      required: ["path"],
    },
  },
  async execute(input, context) {
    const result = await executeDiagnoseFile(input, context);
    return {
      toolCallId: "",
      name: "diagnose_file",
      content: JSON.stringify({
        path: result.path,
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        diagnosticCount: result.diagnosticCount,
        diagnostics: result.diagnostics,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      }),
      displayResult: result,
    };
  },
};

async function executeRunCommand(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<CommandRunResult> {
  const workspace = requireWorkspace(context);
  const command = requiredCommand(input.command);
  const cwdArg = optionalString(input.cwd) ?? ".";
  const timeoutMs = numberInRange(
    input.timeout_ms,
    MIN_COMMAND_TIMEOUT_MS,
    commandTimeoutMs(context),
    commandTimeoutMs(context),
    "timeout_ms",
  );
  const maxOutputBytes = commandMaxOutputBytes(context);
  const cwdPath = await resolveWorkspacePathForAccess(workspace, cwdArg, "read");
  const stat = await fs.stat(cwdPath);
  if (!stat.isDirectory()) {
    throw new Error(`run_command cwd is not a directory: ${cwdArg}`);
  }

  const startedAt = Date.now();
  const output = await spawnWorkspaceCommand(
    command,
    cwdPath,
    timeoutMs,
    maxOutputBytes,
    context.signal,
  );
  return {
    command,
    cwd: toWorkspaceRelative(workspace, cwdPath) || ".",
    exitCode: output.exitCode,
    signal: output.signal,
    timedOut: output.timedOut,
    durationMs: Date.now() - startedAt,
    stdout: output.stdout.text,
    stderr: output.stderr.text,
    stdoutBytes: output.stdout.bytes,
    stderrBytes: output.stderr.bytes,
    stdoutTruncated: output.stdout.truncated,
    stderrTruncated: output.stderr.truncated,
  };
}

async function executeDiagnoseFile(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<DiagnoseFileResult> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredPath(input.path, "diagnose_file requires a string path.");
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`diagnose_file path is not a file: ${relativePath}`);
  }
  await assertTextFile(filePath, relativePath);
  const normalizedTarget = toWorkspaceRelative(workspace, filePath);
  const startedAt = Date.now();
  const diagnostics = await collectLanguageServiceDiagnostics(workspace, filePath);
  return {
    command: "typescript-language-service",
    cwd: ".",
    exitCode: diagnostics.length > 0 ? 1 : 0,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    path: normalizedTarget,
    diagnostics,
    diagnosticCount: diagnostics.length,
    stdoutTruncated: false,
    stderrTruncated: false,
    rawOutput: "",
  };
}

async function executeDiagnoseWorkspace(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<DiagnoseWorkspaceResult> {
  const workspace = requireWorkspace(context);
  const cwdArg = optionalString(input.cwd) ?? ".";
  const timeoutMs = numberInRange(
    input.timeout_ms,
    MIN_COMMAND_TIMEOUT_MS,
    commandTimeoutMs(context),
    commandTimeoutMs(context),
    "timeout_ms",
  );
  const maxOutputBytes = commandMaxOutputBytes(context);
  const cwdPath = await resolveWorkspacePathForAccess(workspace, cwdArg, "read");
  const stat = await fs.stat(cwdPath);
  if (!stat.isDirectory()) {
    throw new Error(`diagnose_workspace cwd is not a directory: ${cwdArg}`);
  }
  const command = await resolveDiagnosticCommand(cwdPath);
  const startedAt = Date.now();
  const output = await spawnWorkspaceCommand(
    command,
    cwdPath,
    timeoutMs,
    maxOutputBytes,
    context.signal,
  );
  const rawOutput = joinCommandOutput(output.stdout.text, output.stderr.text);
  const cwd = toWorkspaceRelative(workspace, cwdPath) || ".";
  const diagnostics = parseTypeScriptDiagnostics(rawOutput, workspace, cwdPath);
  return {
    command,
    cwd,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    durationMs: Date.now() - startedAt,
    diagnostics,
    diagnosticCount: diagnostics.length,
    stdoutTruncated: output.stdout.truncated,
    stderrTruncated: output.stderr.truncated,
    rawOutput,
  };
}

async function resolveDiagnosticCommand(cwdPath: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(cwdPath, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof packageJson.scripts?.typecheck === "string") {
      return "npm run typecheck";
    }
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  return "npx --no-install tsc --noEmit";
}

interface StreamCapture {
  text: string;
  bytes: number;
  truncated: boolean;
}

interface CommandOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: StreamCapture;
  stderr: StreamCapture;
}

interface ShellInvocation {
  file: string;
  args: string[];
}

async function spawnWorkspaceCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<CommandOutput> {
  if (signal?.aborted) {
    throw new Error("Command was interrupted.");
  }

  return new Promise<CommandOutput>((resolve, reject) => {
    const stdout = createOutputCollector(maxOutputBytes);
    const stderr = createOutputCollector(maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const shell = createShellInvocation(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    /**
     * Command execution owns its child process group so runtime interruption and
     * timeout cannot leave a foreground verification command running unseen.
     */
    const killChild = (killSignal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        killWindowsProcessTree(child, killSignal);
      } else if (child.pid) {
        try {
          process.kill(-child.pid, killSignal);
        } catch (error) {
          if (!isProcessAlreadyExited(error)) {
            child.kill(killSignal);
          }
        }
      } else {
        child.kill(killSignal);
      }
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      killChild("SIGTERM");
      forceKillTimer = setTimeout(() => killChild("SIGKILL"), KILL_GRACE_MS);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      forceKillTimer = setTimeout(() => killChild("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    child.stdout.on("data", stdout.collect);
    child.stderr.on("data", stderr.collect);
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted && !timedOut) {
        reject(new Error("Command was interrupted."));
        return;
      }
      resolve({
        exitCode,
        signal: childSignal,
        timedOut,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      });
    });
  });
}

function killWindowsProcessTree(
  child: ChildProcess,
  fallbackSignal: NodeJS.Signals,
): void {
  if (!child.pid) {
    child.kill(fallbackSignal);
    return;
  }
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.on("error", (error) => {
    console.warn("[command-tools] taskkill failed; falling back to child.kill:", error);
    child.kill(fallbackSignal);
  });
}

export function createShellInvocation(command: string): ShellInvocation {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    file: process.env.SHELL || "/bin/sh",
    args: ["-c", command],
  };
}

function createOutputCollector(maxOutputBytes: number): {
  collect(data: Buffer | string): void;
  finish(): StreamCapture;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let storedBytes = 0;
  let truncated = false;

  return {
    collect(data) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytes += buffer.length;
      const remaining = maxOutputBytes - storedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        storedBytes += remaining;
        truncated = true;
        return;
      }
      chunks.push(buffer);
      storedBytes += buffer.length;
    },
    finish() {
      return {
        text: Buffer.concat(chunks, storedBytes).toString("utf8"),
        bytes,
        truncated,
      };
    },
  };
}

function commandMaxOutputBytes(context: AgentToolContext): number {
  const value = context.commandDefaults?.maxOutputBytes ?? DEFAULT_COMMAND_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(value)) {
    return DEFAULT_COMMAND_MAX_OUTPUT_BYTES;
  }
  return Math.min(
    MAX_COMMAND_MAX_OUTPUT_BYTES,
    Math.max(MIN_COMMAND_MAX_OUTPUT_BYTES, Math.floor(value)),
  );
}

function commandTimeoutMs(context: AgentToolContext): number {
  const value = context.commandDefaults?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(value)) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.min(
    MAX_COMMAND_TIMEOUT_MS,
    Math.max(MIN_COMMAND_TIMEOUT_MS, Math.floor(value)),
  );
}

function toToolResult(result: CommandRunResult): AgentToolResult {
  return {
    toolCallId: "",
    name: "run_command",
    content: JSON.stringify(result),
    displayResult: result,
  };
}

function parseTypeScriptDiagnostics(
  output: string,
  workspace: string,
  diagnosticBasePath: string,
): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    const fullPath = path.resolve(diagnosticBasePath, match[1]);
    diagnostics.push({
      path: toWorkspaceRelative(workspace, fullPath),
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      severity: "error",
      message: match[5],
      source: "typecheck",
    });
  }
  return diagnostics;
}

async function collectLanguageServiceDiagnostics(
  workspace: string,
  filePath: string,
): Promise<WorkspaceDiagnostic[]> {
  const configPath = findTsConfig(workspace, filePath);
  const parsed = configPath
    ? parseTsConfig(configPath)
    : {
        fileNames: [filePath],
        options: {
          strict: true,
          noEmit: true,
          allowJs: true,
          checkJs: true,
        } satisfies ts.CompilerOptions,
      };
  const rootFileNames = uniqueStrings([...parsed.fileNames, filePath]);
  const versions = new Map<string, string>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => rootFileNames,
    getScriptVersion: (scriptName) => {
      const normalized = path.resolve(scriptName);
      const cached = versions.get(normalized);
      if (cached) return cached;
      const modified = ts.sys.getModifiedTime?.(normalized)?.getTime() ?? 0;
      const version = String(modified);
      versions.set(normalized, version);
      return version;
    },
    getScriptSnapshot: (scriptName) => {
      if (!ts.sys.fileExists(scriptName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(scriptName) ?? "");
    },
    getCurrentDirectory: () => workspace,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const diagnostics = [
    ...service.getSyntacticDiagnostics(filePath),
    ...service.getSemanticDiagnostics(filePath),
    ...service.getSuggestionDiagnostics(filePath),
  ];
  service.dispose();
  return diagnostics.map((diagnostic) => toWorkspaceDiagnostic(diagnostic, workspace, filePath));
}

function findTsConfig(workspace: string, filePath: string): string | undefined {
  let current = path.dirname(filePath);
  const root = path.resolve(workspace);
  while (isPathInsideOrEqual(root, current)) {
    const candidate = path.join(current, "tsconfig.json");
    if (ts.sys.fileExists(candidate)) return candidate;
    if (isSamePath(current, root)) break;
    current = path.dirname(current);
  }
  const rootCandidate = path.join(root, "tsconfig.json");
  return ts.sys.fileExists(rootCandidate) ? rootCandidate : undefined;
}

function parseTsConfig(configPath: string): {
  fileNames: string[];
  options: ts.CompilerOptions;
} {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatTsDiagnosticMessage(configFile.error));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatTsDiagnosticMessage).join("\n"));
  }
  return {
    fileNames: parsed.fileNames,
    options: parsed.options,
  };
}

function toWorkspaceDiagnostic(
  diagnostic: ts.Diagnostic,
  workspace: string,
  fallbackFilePath: string,
): WorkspaceDiagnostic {
  const file = diagnostic.file;
  const sourceFilePath = file?.fileName ?? fallbackFilePath;
  const start = diagnostic.start ?? 0;
  const position = file
    ? file.getLineAndCharacterOfPosition(start)
    : { line: 0, character: 0 };
  return {
    path: toWorkspaceRelative(workspace, sourceFilePath),
    line: position.line + 1,
    column: position.character + 1,
    code: `TS${diagnostic.code}`,
    severity: diagnosticCategoryToSeverity(diagnostic.category),
    message: formatTsDiagnosticMessage(diagnostic),
    source: "language_service",
  };
}

function diagnosticCategoryToSeverity(category: ts.DiagnosticCategory): WorkspaceDiagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "message";
  }
}

function formatTsDiagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function joinCommandOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((value) => value.length > 0).join(stdout && stderr ? "\n" : "");
}

function requiredCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("run_command requires a non-empty command string.");
  }
  if (value.includes("\0")) {
    throw new Error("run_command command cannot contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES) {
    throw new Error(`run_command command exceeds ${MAX_COMMAND_BYTES} bytes.`);
  }
  return value.trim();
}

function requiredPath(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("path cannot contain NUL bytes.");
  }
  return value.trim();
}

async function assertTextFile(filePath: string, relativePath: string): Promise<void> {
  const sample = await fs.readFile(filePath);
  assertUtf8TextBuffer(sample, relativePath, "diagnose_file path");
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("cwd must be a string.");
  }
  return value.trim() || undefined;
}

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function isProcessAlreadyExited(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH";
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}
