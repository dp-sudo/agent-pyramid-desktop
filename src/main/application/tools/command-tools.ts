import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from "../../domain/agent/types";
import {
  requireWorkspace,
  resolveWorkspacePathLexically,
  resolveWorkspacePathForAccess,
  shouldSkipEntry,
  toWorkspaceRelative,
} from "./workspace-policy.js";
import { assertUtf8TextBuffer, decodeUtf8TextBuffer } from "./text-file.js";
import { isSamePath } from "../path-utils.js";
import {
  canExecute,
  createPackageManagerInvocation,
  createSelectedShellInvocation,
  createShellInvocation,
  createWslInvocation,
  findExecutableOnPath,
  getPathEntries,
  resolveDefaultPowerShellShell,
  toWslPath,
  type PackageManagerName,
  type ShellInvocation,
  type ShellKind,
} from "./command-invocation.js";
import {
  collectFileSymbols,
  collectLanguageServiceDiagnostics,
  collectProjectSymbols,
  parseTypeScriptDiagnostics,
  type ProjectSymbolSearchResult,
  type WorkspaceSymbol,
  type WorkspaceDiagnostic,
} from "./command-diagnostics.js";
import {
  detectPackageManager,
  normalizePackageScripts,
  optionalPackageManager,
  optionalPackageScriptName,
  packageInstallArgs,
  packageRunScriptArgs,
  readPackageJson,
} from "./command-package.js";
import {
  assertPlainGitPathspec,
  gitPathspecArgs,
  optionalGitLogRef,
  parseGitStatusLine,
} from "./command-git.js";
import {
  createSessionCapture,
  type SessionCapture,
} from "./command-session-capture.js";
import {
  createCommandProgressReporter,
} from "./command-progress-reporter.js";
import {
  type StreamCapture,
} from "./command-output-capture.js";
import {
  createCommandSpawnOptions,
  describeCommandSandbox,
  type CommandSandboxReport,
} from "./command-sandbox.js";
import {
  killProcessTree,
  spawnWorkspaceCommand,
  spawnWorkspaceProcess,
  type CommandOutput,
} from "./command-process-runner.js";
import {
  COMMAND_KILL_GRACE_MS,
  COMMAND_SESSION_SPAWN_TIMEOUT_MS,
  COMMAND_SESSION_STOP_TIMEOUT_EXTRA_MS,
  DEFAULT_COMMAND_SESSION_BUFFER_BYTES,
  DEFAULT_COMMAND_SESSION_TAIL_BYTES,
  DEFAULT_GIT_LOG_COUNT,
  MAX_COMMAND_BYTES,
  MAX_COMMAND_SESSION_BUFFER_BYTES,
  MAX_COMMAND_SESSION_COUNT,
  MAX_GIT_LOG_COUNT,
  MAX_REGEX_PATTERN_BYTES,
  MAX_SEARCH_FILE_BYTES,
} from "../constants.js";
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
const DEFAULT_SYMBOL_LIMIT = 200;
const MAX_SYMBOL_LIMIT = 1000;
const DEFAULT_PROJECT_SYMBOL_LIMIT = 200;
const MAX_PROJECT_SYMBOL_LIMIT = 1000;
const MAX_PROJECT_SYMBOL_FILES = 500;
const COMMAND_SESSION_SHUTDOWN_MESSAGE =
  "Command session stopped during application shutdown.";
const COMMAND_SESSION_SHUTDOWN_TIMEOUT_MS =
  COMMAND_KILL_GRACE_MS + COMMAND_SESSION_STOP_TIMEOUT_EXTRA_MS;
const COMMAND_TIMEOUT_DESCRIPTION =
  `Maximum runtime in milliseconds. Defaults to the runtime command preference ` +
  `(${DEFAULT_COMMAND_TIMEOUT_MS}). Overrides must be between ${MIN_COMMAND_TIMEOUT_MS} ` +
  `and the current runtime command preference, which cannot exceed ${MAX_COMMAND_TIMEOUT_MS}.`;

export {
  createPackageManagerInvocation,
  createShellInvocation,
  resolveDefaultPowerShellShell,
  toWslPath,
} from "./command-invocation.js";

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

interface ListSymbolsResult {
  path: string;
  symbolCount: number;
  truncated: boolean;
  symbols: WorkspaceSymbol[];
}

interface SearchSymbolsResult extends ProjectSymbolSearchResult {}

export function createCommandTools(): AgentTool[] {
  return [
    runCommandTool,
    shellCommandTool,
    gitBashCommandTool,
    powershellCommandTool,
    wslCommandTool,
    rgSearchTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitBranchTool,
    gitCommitTool,
    packageScriptsTool,
    packageInstallTool,
    packageTestTool,
    packageBuildTool,
    runLintTool,
    runFormatTool,
    runTestsTool,
    runBuildTool,
    startCommandSessionTool,
    listCommandSessionsTool,
    readCommandSessionTool,
    writeCommandSessionTool,
    stopCommandSessionTool,
    detectShellEnvironmentTool,
    diagnoseWorkspaceTool,
    diagnoseFileTool,
    listSymbolsTool,
    searchSymbolsTool,
  ];
}

/**
 * Main-process lifecycle hook for sessions that outlive a single tool call.
 * It returns bounded snapshots for shutdown diagnostics, then clears ownership
 * so a repeated Electron quit path cannot expose stale in-memory sessions.
 */
export async function shutdownCommandSessions(): Promise<CommandSessionShutdownResult> {
  return commandSessionManager.shutdown();
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
      "Run a foreground shell command inside the current workspace. Use it for tests, builds, diagnostics, and short project commands. On Windows this uses cmd.exe syntax by default; use powershell_command for PowerShell syntax, and confirm Bash/WSL availability before POSIX shell syntax. Long-running background processes are not supported.",
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

const shellCommandTool: AgentTool = {
  /**
   * This exposes an explicit shell selector while keeping the same workspace
   * cwd and approval boundary as run_command.
   */
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "shell_command",
    description:
      "Run a foreground workspace command through a selected shell. Supports default, cmd, sh, bash, Git Bash, powershell, pwsh, or a custom shell_path/shell_args. Prefer detect_shell_environment before selecting Git Bash, WSL, or POSIX shells on Windows.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command text passed to the selected shell.",
        },
        shell: {
          type: "string",
          enum: ["default", "cmd", "sh", "bash", "git_bash", "powershell", "pwsh"],
          description: "Shell family to use. Defaults to the platform default shell.",
        },
        shell_path: {
          type: "string",
          description:
            "Optional executable path for a custom shell. If provided, shell_args controls how the command is passed.",
        },
        shell_args: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional custom shell arguments. Use {command} as a placeholder; otherwise the command is appended.",
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
    const result = await executeShellCommand(input, context, "shell_command");
    return toNamedToolResult("shell_command", result);
  },
};

const gitBashCommandTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "git_bash_command",
    description:
      "Run a foreground workspace command through Git Bash on Windows, or bash on Unix-like hosts.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command text passed to bash -lc.",
        },
        git_bash_path: {
          type: "string",
          description: "Optional Git Bash bash.exe path. Defaults to detected Windows Git installation.",
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
    const result = await executeShellCommand(
      { ...input, shell: "git_bash", shell_path: optionalString(input.git_bash_path) },
      context,
      "git_bash_command",
    );
    return toNamedToolResult("git_bash_command", result);
  },
};

const powershellCommandTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "powershell_command",
    description:
      "Run a foreground workspace command through PowerShell. Use this instead of run_command when the command uses PowerShell syntax. Use executable=pwsh for PowerShell 7 or powershell for Windows PowerShell.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "PowerShell command text.",
        },
        executable: {
          type: "string",
          enum: ["pwsh", "powershell"],
          description: "PowerShell executable to use. Defaults to pwsh, then powershell on Windows.",
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
    const executable = optionalEnum(input.executable, ["pwsh", "powershell"], "executable");
    const shell = executable ?? await resolveDefaultPowerShellShell();
    const result = await executeShellCommand(
      { ...input, shell },
      context,
      "powershell_command",
    );
    return toNamedToolResult("powershell_command", result);
  },
};

const wslCommandTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "wsl_command",
    description:
      "Run a foreground workspace command through WSL using wsl.exe. Windows workspace paths are converted to /mnt/<drive>/ paths for the Linux shell.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Linux shell command passed to sh -lc inside WSL.",
        },
        distro: {
          type: "string",
          description: "Optional WSL distribution name.",
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
    const result = await executeWslCommand(input, context);
    return toNamedToolResult("wsl_command", result);
  },
};

const rgSearchTool: AgentTool = {
  metadata: {
    category: "workspace",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "rg_search",
    description:
      "Run a ripgrep-style regular expression search over UTF-8 workspace text files. Use this when literal search_files is not expressive enough.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "JavaScript regular expression pattern to search for.",
        },
        path: {
          type: "string",
          description: "Optional workspace-relative directory or file to search.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether matching is case-sensitive. Defaults to true.",
        },
        max_results: {
          type: "number",
          description:
            `Maximum matching lines to return. Defaults to 80, maximum 300.`,
        },
      },
      required: ["pattern"],
    },
  },
  async execute(input, context) {
    const result = await executeRegexSearch(input, context);
    return JSON.stringify(result);
  },
};

const gitStatusTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "git_status",
    description: "Return structured git status for the current workspace or a workspace subdirectory.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative git working tree directory. Defaults to the workspace root.",
        },
        pathspecs: {
          type: "array",
          items: { type: "string" },
          description: "Optional plain workspace-relative paths to limit status.",
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executeGitStatus(input, context);
    return JSON.stringify(result);
  },
};

const gitDiffTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "git_diff",
    description: "Return a workspace git diff, optionally staged/stat-only/path-limited.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative git working tree directory. Defaults to the workspace root.",
        },
        staged: {
          type: "boolean",
          description: "Show staged diff with --staged.",
        },
        stat: {
          type: "boolean",
          description: "Return --stat output instead of a patch.",
        },
        pathspecs: {
          type: "array",
          items: { type: "string" },
          description: "Optional plain workspace-relative paths.",
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executeGitDiff(input, context);
    return JSON.stringify(result);
  },
};

const gitLogTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "git_log",
    description: "Return structured git log entries for the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative git working tree directory. Defaults to the workspace root.",
        },
        max_count: {
          type: "number",
          description: `Maximum commits to return. Defaults to ${DEFAULT_GIT_LOG_COUNT}, maximum ${MAX_GIT_LOG_COUNT}.`,
        },
        ref: {
          type: "string",
          description: "Optional branch, tag, commit, or revision range. Git options and pathspec magic are rejected.",
        },
        pathspecs: {
          type: "array",
          items: { type: "string" },
          description: "Optional plain workspace-relative paths.",
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executeGitLog(input, context);
    return JSON.stringify(result);
  },
};

const gitBranchTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "git_branch",
    description: "Return current, local, and remote git branches for the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative git working tree directory. Defaults to the workspace root.",
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executeGitBranch(input, context);
    return JSON.stringify(result);
  },
};

const gitCommitTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "git_commit",
    description:
      "Create a git commit in the workspace. Optionally stage all changes or selected workspace-relative paths before committing.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message.",
        },
        cwd: {
          type: "string",
          description: "Workspace-relative git working tree directory. Defaults to the workspace root.",
        },
        all: {
          type: "boolean",
          description: "Stage all modified/deleted/untracked files before commit.",
        },
        pathspecs: {
          type: "array",
          items: { type: "string" },
          description: "Plain workspace-relative paths to stage before commit.",
        },
      },
      required: ["message"],
    },
  },
  async execute(input, context) {
    const result = await executeGitCommit(input, context);
    return JSON.stringify(result);
  },
};

const packageScriptsTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "package_scripts",
    description:
      "Inspect package.json scripts and detect the npm/pnpm/yarn/bun package manager for a workspace package.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative package directory. Defaults to the workspace root.",
        },
      },
    },
  },
  async execute(input, context) {
    const result = await inspectPackageScripts(input, context);
    return JSON.stringify(result);
  },
};

const packageInstallTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "package_install",
    description: "Install dependencies with the detected or specified npm/pnpm/yarn/bun package manager.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace-relative package directory. Defaults to the workspace root.",
        },
        manager: {
          type: "string",
          enum: ["npm", "pnpm", "yarn", "bun"],
          description: "Optional package manager override.",
        },
        frozen_lockfile: {
          type: "boolean",
          description: "Prefer lockfile-respecting install mode when supported.",
        },
        timeout_ms: {
          type: "number",
          description: COMMAND_TIMEOUT_DESCRIPTION,
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executePackageInstall(input, context);
    return toNamedToolResult("package_install", result);
  },
};

const packageTestTool: AgentTool = createPackageScriptCommandTool(
  "package_test",
  "Run the package test script with the detected or specified npm/pnpm/yarn/bun manager.",
  "test",
);

const packageBuildTool: AgentTool = createPackageScriptCommandTool(
  "package_build",
  "Run the package build script with the detected or specified npm/pnpm/yarn/bun manager.",
  "build",
);

const runLintTool: AgentTool = createTaskCommandTool(
  "run_lint",
  "Run the workspace lint task through the detected package manager.",
  "lint",
  ["lint"],
);

const runFormatTool: AgentTool = createTaskCommandTool(
  "run_format",
  "Run the workspace format task through the detected package manager.",
  "format",
  ["format", "format:write"],
);

const runTestsTool: AgentTool = createTaskCommandTool(
  "run_tests",
  "Run the workspace test task through the detected package manager.",
  "test",
  ["test", "tests"],
);

const runBuildTool: AgentTool = createTaskCommandTool(
  "run_build",
  "Run the workspace build task through the detected package manager.",
  "build",
  ["build"],
);

const startCommandSessionTool: AgentTool = {
  /**
   * Sessions intentionally outlive a single tool call. Runtime interruption
   * stops the current turn, while this manager keeps background process state
   * visible until the model or user stops the session explicitly.
   */
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "start_command_session",
    description:
      "Start a long-running workspace command session and return immediately with a session id. Use read/write/stop_command_session to interact with it.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command text for the session shell.",
        },
        shell: {
          type: "string",
          enum: ["default", "cmd", "sh", "bash", "git_bash", "powershell", "pwsh"],
          description: "Shell family. Defaults to the platform default shell.",
        },
        cwd: {
          type: "string",
          description: "Workspace-relative directory to run from. Defaults to the workspace root.",
        },
        max_buffer_bytes: {
          type: "number",
          description: `Maximum stdout/stderr bytes retained per stream. Defaults to ${DEFAULT_COMMAND_SESSION_BUFFER_BYTES}, maximum ${MAX_COMMAND_SESSION_BUFFER_BYTES}.`,
        },
      },
      required: ["command"],
    },
  },
  async execute(input, context) {
    const result = await commandSessionManager.start(input, context);
    return JSON.stringify(result);
  },
};

const listCommandSessionsTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "list_command_sessions",
    description:
      "List long-running command sessions created by the current thread and workspace. Use this to recover session ids before reading, writing, or stopping sessions.",
    inputSchema: {
      type: "object",
      properties: {
        include_output: {
          type: "boolean",
          description: "Include retained stdout/stderr tails for each session. Defaults to false.",
        },
        tail_bytes: {
          type: "number",
          description: `When include_output is true, return only this many trailing bytes per stream. Defaults to ${DEFAULT_COMMAND_SESSION_TAIL_BYTES}.`,
        },
      },
    },
  },
  async execute(input, context) {
    const result = commandSessionManager.list(input, context);
    return JSON.stringify(result);
  },
};

const readCommandSessionTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "read_command_session",
    description: "Read retained stdout/stderr and status for a long-running command session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session id returned by start_command_session.",
        },
        tail_bytes: {
          type: "number",
          description: `Return only the trailing bytes from each stream. Defaults to ${DEFAULT_COMMAND_SESSION_TAIL_BYTES}.`,
        },
      },
      required: ["session_id"],
    },
  },
  async execute(input, context) {
    const result = commandSessionManager.read(input, context);
    return JSON.stringify(result);
  },
};

const writeCommandSessionTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "write_command_session",
    description: "Write text to a running command session stdin.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session id returned by start_command_session.",
        },
        input: {
          type: "string",
          description: "Text to write to stdin.",
        },
        newline: {
          type: "boolean",
          description: "Append a newline after input. Defaults to true.",
        },
      },
      required: ["session_id", "input"],
    },
  },
  async execute(input, context) {
    const result = await commandSessionManager.write(input, context);
    return JSON.stringify(result);
  },
};

const stopCommandSessionTool: AgentTool = {
  metadata: {
    category: "command",
    isDestructive: true,
  },
  definition: {
    name: "stop_command_session",
    description: "Stop a running command session and return its final retained output.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session id returned by start_command_session.",
        },
      },
      required: ["session_id"],
    },
  },
  async execute(input, context) {
    const result = await commandSessionManager.stop(input, context);
    return JSON.stringify(result);
  },
};

const detectShellEnvironmentTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "detect_shell_environment",
    description:
      "Detect available shell executables, Git Bash, PowerShell/pwsh, WSL, PATH entries, and workspace path conversions before choosing shell-specific command syntax.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_path: {
          type: "string",
          description: "Optional absolute path to include in Windows-to-WSL path conversion output.",
        },
      },
    },
  },
  async execute(input, context) {
    const result = await detectShellEnvironment(input, context);
    return JSON.stringify(result);
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

const listSymbolsTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "list_symbols",
    description:
      "Return a structured TypeScript/JavaScript symbol outline for one UTF-8 workspace file. Use before editing unfamiliar code to identify classes, functions, methods, and exports.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative source file path to inspect.",
        },
        max_results: {
          type: "number",
          description: `Maximum symbols to return. Defaults to ${DEFAULT_SYMBOL_LIMIT}, maximum ${MAX_SYMBOL_LIMIT}.`,
        },
      },
      required: ["path"],
    },
  },
  async execute(input, context) {
    const result = await executeListSymbols(input, context);
    return {
      toolCallId: "",
      name: "list_symbols",
      content: JSON.stringify(result),
      displayResult: result,
    };
  },
};

const searchSymbolsTool: AgentTool = {
  metadata: {
    category: "command",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "search_symbols",
    description:
      "Search or list TypeScript/JavaScript symbols across the current workspace or a workspace subdirectory. Use this to find project-wide classes, functions, methods, and exports before coordinated edits.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional text matched against symbol name, kind, modifiers, or path. Omit to return a bounded project symbol map.",
        },
        path: {
          type: "string",
          description: "Optional workspace-relative directory or source file to inspect. Defaults to the workspace root.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether matching is case-sensitive. Defaults to false.",
        },
        max_results: {
          type: "number",
          description:
            `Maximum symbols to return. Defaults to ${DEFAULT_PROJECT_SYMBOL_LIMIT}, maximum ${MAX_PROJECT_SYMBOL_LIMIT}.`,
        },
      },
    },
  },
  async execute(input, context) {
    const result = await executeSearchSymbols(input, context);
    return {
      toolCallId: "",
      name: "search_symbols",
      content: JSON.stringify(result),
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
    context.reportProgress,
    context.sandboxMode,
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

async function executeShellCommand(
  input: Record<string, unknown>,
  context: AgentToolContext,
  toolName: string,
): Promise<CommandRunResult & { shell: string; shellFile: string; shellArgs: string[] }> {
  const workspace = requireWorkspace(context);
  const command = requiredCommandForTool(input.command, toolName);
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
    throw new Error(`${toolName} cwd is not a directory: ${cwdArg}`);
  }
  const shell = optionalEnum(
    input.shell,
    ["default", "cmd", "sh", "bash", "git_bash", "powershell", "pwsh"],
    "shell",
  ) ?? "default";
  const invocation = await createSelectedShellInvocation(command, {
    shell,
    shellPath: optionalString(input.shell_path),
    shellArgs: optionalStringArray(input.shell_args, "shell_args"),
  });
  const startedAt = Date.now();
  const output = await spawnWorkspaceProcess(
    invocation,
    cwdPath,
    timeoutMs,
    maxOutputBytes,
    context.signal,
    context.reportProgress,
    context.sandboxMode,
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
    shell,
    shellFile: invocation.file,
    shellArgs: invocation.args,
  };
}

async function executeWslCommand(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<CommandRunResult & { distro?: string; wslCwd: string }> {
  const workspace = requireWorkspace(context);
  const command = requiredCommandForTool(input.command, "wsl_command");
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
    throw new Error(`wsl_command cwd is not a directory: ${cwdArg}`);
  }
  const distro = optionalString(input.distro);
  const wslCwd = toWslPath(cwdPath);
  const invocation = createWslInvocation(command, wslCwd, distro);
  const startedAt = Date.now();
  const output = await spawnWorkspaceProcess(
    invocation,
    cwdPath,
    timeoutMs,
    maxOutputBytes,
    context.signal,
    context.reportProgress,
    context.sandboxMode,
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
    ...(distro ? { distro } : {}),
    wslCwd,
  };
}

async function executeRegexSearch(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  pattern: string;
  path: string;
  flags: string;
  results: Array<{ path: string; line: number; column: number; text: string; match: string }>;
  skippedLargeFiles: number;
  truncated: boolean;
}> {
  const workspace = requireWorkspace(context);
  const pattern = requiredRegexPattern(input.pattern);
  const relativePath = optionalString(input.path) ?? ".";
  const limit = numberInRange(
    input.max_results,
    1,
    300,
    80,
    "max_results",
  );
  const caseSensitive = input.case_sensitive === undefined
    ? true
    : requiredBoolean(input.case_sensitive, "case_sensitive");
  const flags = caseSensitive ? "u" : "iu";
  const regex = createLineRegex(pattern, flags);
  const root = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  const stat = await fs.stat(root);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`rg_search path is not a file or directory: ${relativePath}`);
  }
  const results: Array<{ path: string; line: number; column: number; text: string; match: string }> = [];
  let skippedLargeFiles = 0;
  const searchFile = async (filePath: string): Promise<void> => {
    if (results.length >= limit) return;
    const fileStat = await fs.stat(filePath);
    if (fileStat.size > MAX_SEARCH_FILE_BYTES) {
      skippedLargeFiles += 1;
      return;
    }
    if (!looksTextFile(filePath)) return;
    const relativeFilePath = toWorkspaceRelative(workspace, filePath);
    const content = decodeUtf8TextBuffer(
      await fs.readFile(filePath),
      relativeFilePath,
      "rg_search path",
    );
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0;
      const match = regex.exec(line);
      if (!match) continue;
      results.push({
        path: relativeFilePath,
        line: index + 1,
        column: match.index + 1,
        text: line.trimEnd(),
        match: match[0],
      });
      if (results.length >= limit) break;
    }
  };
  if (stat.isFile()) {
    await searchFile(root);
  } else {
    await walkTextFiles(root, searchFile);
  }
  return {
    pattern,
    path: toWorkspaceRelative(workspace, root) || ".",
    flags,
    results,
    skippedLargeFiles,
    truncated: results.length >= limit,
  };
}

async function executeGitStatus(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  command: string[];
  cwd: string;
  exitCode: number | null;
  branch: string | null;
  entries: Array<{ xy: string; path: string; originalPath?: string }>;
  stdout: string;
  stderr: string;
}> {
  const { workspace, cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "git_status");
  const pathspecs = await resolvePathspecs(input.pathspecs, workspace, "git_status");
  const args = ["status", "--short", "--branch", "--untracked-files=all", ...gitPathspecArgs(pathspecs)];
  const output = await executeGitCommand(args, cwdPath, context);
  const lines = output.stdout.text.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branch = branchLine ? branchLine.slice(3).trim() : null;
  const entries = lines
    .filter((line) => !line.startsWith("## "))
    .map(parseGitStatusLine);
  return {
    command: ["git", ...args],
    cwd,
    exitCode: output.exitCode,
    branch,
    entries,
    stdout: output.stdout.text,
    stderr: output.stderr.text,
  };
}

async function executeGitDiff(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<CommandRunResult & { commandArgs: string[] }> {
  const { cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "git_diff");
  const staged = input.staged === undefined ? false : requiredBoolean(input.staged, "staged");
  const stat = input.stat === undefined ? false : requiredBoolean(input.stat, "stat");
  const pathspecs = await resolvePathspecs(input.pathspecs, requireWorkspace(context), "git_diff");
  const args = [
    "-c",
    "diff.external=",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    ...(staged ? ["--staged"] : []),
    ...(stat ? ["--stat"] : []),
    ...gitPathspecArgs(pathspecs),
  ];
  const startedAt = Date.now();
  const output = await executeGitCommand(args, cwdPath, context);
  return commandOutputToRunResult(["git", ...args].join(" "), cwd, startedAt, output, {
    commandArgs: ["git", ...args],
  });
}

async function executeGitLog(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  command: string[];
  cwd: string;
  exitCode: number | null;
  commits: Array<{
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    date: string;
    subject: string;
  }>;
  stderr: string;
}> {
  const { workspace, cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "git_log");
  const maxCount = numberInRange(
    input.max_count,
    1,
    MAX_GIT_LOG_COUNT,
    DEFAULT_GIT_LOG_COUNT,
    "max_count",
  );
  const ref = optionalGitLogRef(input.ref);
  const pathspecs = await resolvePathspecs(input.pathspecs, workspace, "git_log");
  const format = "%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s";
  const args = [
    "log",
    `--max-count=${maxCount}`,
    "--date=iso-strict",
    `--pretty=format:${format}`,
    ...(ref ? [ref] : []),
    ...gitPathspecArgs(pathspecs),
  ];
  const output = await executeGitCommand(args, cwdPath, context);
  const commits = output.stdout.text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash = "", shortHash = "", authorName = "", authorEmail = "", date = "", subject = ""] =
        line.split("\x1f");
      return { hash, shortHash, authorName, authorEmail, date, subject };
    });
  return {
    command: ["git", ...args],
    cwd,
    exitCode: output.exitCode,
    commits,
    stderr: output.stderr.text,
  };
}

async function executeGitBranch(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  command: string[];
  cwd: string;
  exitCode: number | null;
  current: string | null;
  branches: Array<{ name: string; current: boolean; remote: boolean; raw: string }>;
  stderr: string;
}> {
  const { cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "git_branch");
  const args = ["branch", "--all", "--verbose", "--no-abbrev"];
  const output = await executeGitCommand(args, cwdPath, context);
  const branches = output.stdout.text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      // `git branch --all --verbose` prefixes every line with exactly two
      // characters: `* ` for the current branch, `  ` for non-current locals
      // and remote-tracking branches, and `+ ` for worktree entries.
      const current = line.startsWith("*");
      const rawName = line.slice(2).trim().split(/\s+/, 1)[0] ?? "";
      return {
        name: rawName,
        current,
        remote: rawName.startsWith("remotes/"),
        raw: line,
      };
    });
  return {
    command: ["git", ...args],
    cwd,
    exitCode: output.exitCode,
    current: branches.find((branch) => branch.current)?.name ?? null,
    branches,
    stderr: output.stderr.text,
  };
}

async function executeGitCommit(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  cwd: string;
  staged: boolean;
  add?: CommandRunResult;
  commit: CommandRunResult;
}> {
  const { workspace, cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "git_commit");
  const message = requiredLimitedString(input.message, "git_commit requires a non-empty message.", 10_000);
  const all = input.all === undefined ? false : requiredBoolean(input.all, "all");
  const pathspecs = await resolvePathspecs(input.pathspecs, workspace, "git_commit");
  let addResult: CommandRunResult | undefined;
  if (all || pathspecs.length > 0) {
    const addArgs = ["add", ...(all ? ["-A"] : gitPathspecArgs(pathspecs))];
    const startedAt = Date.now();
    const addOutput = await executeGitCommand(addArgs, cwdPath, context);
    addResult = commandOutputToRunResult(
      ["git", ...addArgs].join(" "),
      cwd,
      startedAt,
      addOutput,
    );
    if (addResult.exitCode !== 0) {
      throw new Error(formatFailedCommandMessage("git_commit staging failed", addResult));
    }
  }
  const commitArgs = ["commit", "-m", message];
  const startedAt = Date.now();
  const commitOutput = await executeGitCommand(commitArgs, cwdPath, context);
  return {
    cwd,
    staged: Boolean(addResult),
    ...(addResult ? { add: addResult } : {}),
    commit: commandOutputToRunResult(
      ["git", "commit", "-m", "<message>"].join(" "),
      cwd,
      startedAt,
      commitOutput,
    ),
  };
}

async function inspectPackageScripts(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  cwd: string;
  manager: PackageManagerName;
  packageManagerField?: string;
  scripts: Record<string, string>;
}> {
  const { cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "package_scripts");
  const packageJson = await readPackageJson(cwdPath);
  const manager = optionalPackageManager(input.manager) ?? await detectPackageManager(cwdPath, packageJson);
  return {
    cwd,
    manager,
    ...(typeof packageJson.packageManager === "string"
      ? { packageManagerField: packageJson.packageManager }
      : {}),
    scripts: normalizePackageScripts(packageJson.scripts),
  };
}

async function executePackageInstall(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<CommandRunResult & { manager: PackageManagerName; commandArgs: string[] }> {
  const { cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, "package_install");
  const packageJson = await readPackageJson(cwdPath);
  const manager = optionalPackageManager(input.manager) ?? await detectPackageManager(cwdPath, packageJson);
  const frozenLockfile = input.frozen_lockfile === undefined
    ? false
    : requiredBoolean(input.frozen_lockfile, "frozen_lockfile");
  const args = packageInstallArgs(manager, frozenLockfile, cwdPath);
  return executePackageCommand(manager, args, cwdPath, cwd, input, context);
}

function createPackageScriptCommandTool(
  name: string,
  description: string,
  defaultScript: string,
): AgentTool {
  return {
    metadata: {
      category: "command",
      isDestructive: true,
    },
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace-relative package directory. Defaults to the workspace root.",
          },
          manager: {
            type: "string",
            enum: ["npm", "pnpm", "yarn", "bun"],
            description: "Optional package manager override.",
          },
          script: {
            type: "string",
            description: `Script name to run. Defaults to ${defaultScript}. Must be a package script identifier, not a package-manager option.`,
          },
          timeout_ms: {
            type: "number",
            description: COMMAND_TIMEOUT_DESCRIPTION,
          },
        },
      },
    },
    async execute(input, context) {
      const script = optionalPackageScriptName(input.script) ?? defaultScript;
      const result = await executePackageScript(input, context, name, script);
      return toNamedToolResult(name, result);
    },
  };
}

function createTaskCommandTool(
  name: string,
  description: string,
  task: string,
  scriptCandidates: string[],
): AgentTool {
  return {
    metadata: {
      category: "command",
      isDestructive: true,
    },
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace-relative package directory. Defaults to the workspace root.",
          },
          manager: {
            type: "string",
            enum: ["npm", "pnpm", "yarn", "bun"],
            description: "Optional package manager override.",
          },
          timeout_ms: {
            type: "number",
            description: COMMAND_TIMEOUT_DESCRIPTION,
          },
        },
      },
    },
    async execute(input, context) {
      const { cwdPath } = await resolveWorkspaceDirectory(input, context, name);
      const packageJson = await readPackageJson(cwdPath);
      const scripts = normalizePackageScripts(packageJson.scripts);
      const script = scriptCandidates.find((candidate) => scripts[candidate] !== undefined);
      if (!script) {
        throw new Error(`${name} could not find a package script for ${task}.`);
      }
      const result = await executePackageScript(input, context, name, script);
      return toNamedToolResult(name, result);
    },
  };
}

async function executePackageScript(
  input: Record<string, unknown>,
  context: AgentToolContext,
  toolName: string,
  script: string,
): Promise<CommandRunResult & { manager: PackageManagerName; commandArgs: string[]; script: string }> {
  const { cwdPath, cwd } = await resolveWorkspaceDirectory(input, context, toolName);
  const packageJson = await readPackageJson(cwdPath);
  const scripts = normalizePackageScripts(packageJson.scripts);
  if (scripts[script] === undefined) {
    throw new Error(`${toolName} package script not found: ${script}`);
  }
  const manager = optionalPackageManager(input.manager) ?? await detectPackageManager(cwdPath, packageJson);
  const args = packageRunScriptArgs(manager, script);
  const result = await executePackageCommand(manager, args, cwdPath, cwd, input, context);
  return { ...result, script };
}

async function executePackageCommand(
  manager: PackageManagerName,
  args: string[],
  cwdPath: string,
  cwd: string,
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<CommandRunResult & { manager: PackageManagerName; commandArgs: string[] }> {
  const timeoutMs = numberInRange(
    input.timeout_ms,
    MIN_COMMAND_TIMEOUT_MS,
    commandTimeoutMs(context),
    commandTimeoutMs(context),
    "timeout_ms",
  );
  const maxOutputBytes = commandMaxOutputBytes(context);
  const startedAt = Date.now();
  const output = await spawnWorkspaceProcess(
    createPackageManagerInvocation(manager, args),
    cwdPath,
    timeoutMs,
    maxOutputBytes,
    context.signal,
    context.reportProgress,
    context.sandboxMode,
  );
  return commandOutputToRunResult(
    [manager, ...args].join(" "),
    cwd,
    startedAt,
    output,
    { manager, commandArgs: [manager, ...args] },
  );
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

async function executeListSymbols(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<ListSymbolsResult> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredPath(input.path, "list_symbols requires a string path.");
  const maxResults = numberInRange(
    input.max_results,
    1,
    MAX_SYMBOL_LIMIT,
    DEFAULT_SYMBOL_LIMIT,
    "max_results",
  );
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`list_symbols path is not a file: ${relativePath}`);
  }
  await assertTextFile(filePath, relativePath, "list_symbols path");
  const normalizedTarget = toWorkspaceRelative(workspace, filePath);
  const outline = await collectFileSymbols(workspace, filePath, maxResults);
  return {
    path: normalizedTarget,
    symbolCount: outline.symbols.length,
    truncated: outline.truncated,
    symbols: outline.symbols,
  };
}

async function executeSearchSymbols(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<SearchSymbolsResult> {
  const workspace = requireWorkspace(context);
  const query = optionalLimitedString(input.query, MAX_REGEX_PATTERN_BYTES, "query");
  const relativePath = optionalString(input.path) ?? ".";
  const maxResults = numberInRange(
    input.max_results,
    1,
    MAX_PROJECT_SYMBOL_LIMIT,
    DEFAULT_PROJECT_SYMBOL_LIMIT,
    "max_results",
  );
  const caseSensitive = input.case_sensitive === undefined
    ? false
    : requiredBoolean(input.case_sensitive, "case_sensitive");
  const rootPath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`search_symbols path is not a file or directory: ${relativePath}`);
  }
  if (stat.isFile()) {
    await assertTextFile(rootPath, relativePath, "search_symbols path");
  }
  return collectProjectSymbols(workspace, rootPath, {
    ...(query ? { query } : {}),
    caseSensitive,
    maxSymbols: maxResults,
    maxFiles: MAX_PROJECT_SYMBOL_FILES,
  });
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
    context.reportProgress,
    context.sandboxMode,
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
    if (error instanceof SyntaxError) {
      throw new Error(`diagnose_workspace package.json is invalid in ${cwdPath}: ${error.message}`);
    }
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  return "npx --no-install tsc --noEmit";
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

function toNamedToolResult(name: string, result: unknown): AgentToolResult {
  return {
    toolCallId: "",
    name,
    content: JSON.stringify(result),
    displayResult: result,
  };
}

function commandOutputToRunResult<T extends Record<string, unknown> = Record<string, never>>(
  command: string,
  cwd: string,
  startedAt: number,
  output: CommandOutput,
  extra?: T,
): CommandRunResult & T {
  return {
    command,
    cwd,
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
    ...(extra ?? {} as T),
  };
}

function formatFailedCommandMessage(prefix: string, result: CommandRunResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return `${prefix} with exit code ${result.exitCode ?? "null"}: ${detail}`;
}

async function resolveWorkspaceDirectory(
  input: Record<string, unknown>,
  context: AgentToolContext,
  toolName: string,
): Promise<{ workspace: string; cwdPath: string; cwd: string }> {
  const workspace = requireWorkspace(context);
  const cwdArg = optionalString(input.cwd) ?? ".";
  const cwdPath = await resolveWorkspacePathForAccess(workspace, cwdArg, "read");
  const stat = await fs.stat(cwdPath);
  if (!stat.isDirectory()) {
    throw new Error(`${toolName} cwd is not a directory: ${cwdArg}`);
  }
  return {
    workspace,
    cwdPath,
    cwd: toWorkspaceRelative(workspace, cwdPath) || ".",
  };
}

async function executeGitCommand(
  args: string[],
  cwdPath: string,
  context: AgentToolContext,
): Promise<CommandOutput> {
  return spawnWorkspaceProcess(
    { file: "git", args },
    cwdPath,
    commandTimeoutMs(context),
    commandMaxOutputBytes(context),
    context.signal,
    context.reportProgress,
    context.sandboxMode,
  );
}

async function resolvePathspecs(
  value: unknown,
  workspace: string,
  toolName: string,
): Promise<string[]> {
  const pathspecs = optionalStringArray(value, "pathspecs") ?? [];
  for (const pathspec of pathspecs) {
    assertPlainGitPathspec(pathspec, toolName);
    resolveWorkspacePathLexically(workspace, pathspec);
    if (pathspec.includes("\0")) {
      throw new Error(`${toolName} pathspec cannot contain NUL bytes.`);
    }
  }
  return pathspecs;
}

async function detectShellEnvironment(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<{
  platform: NodeJS.Platform;
  defaultShell: string | null;
  pathEntries: string[];
  executables: Record<string, { found: boolean; path?: string }>;
  gitBashCandidates: Array<{ path: string; exists: boolean }>;
  workspacePath?: string;
  wslWorkspacePath?: string;
  sandbox: CommandSandboxReport;
}> {
  const workspacePath = optionalString(input.workspace_path) ?? context.workspace;
  const executables = {
    git: await findExecutableOnPath(["git"]),
    bash: await findExecutableOnPath(process.platform === "win32" ? ["bash.exe", "bash"] : ["bash"]),
    sh: await findExecutableOnPath(process.platform === "win32" ? ["sh.exe", "sh"] : ["sh"]),
    powershell: await findExecutableOnPath(["powershell.exe", "powershell"]),
    pwsh: await findExecutableOnPath(["pwsh.exe", "pwsh"]),
    wsl: await findExecutableOnPath(["wsl.exe", "wsl"]),
  };
  const gitBashCandidatePaths = gitBashDetectionCandidates();
  const gitBashCandidates = await Promise.all(
    gitBashCandidatePaths.map(async (candidate) => ({
      path: candidate,
      exists: await canExecute(candidate),
    })),
  );
  return {
    platform: process.platform,
    defaultShell: process.platform === "win32"
      ? process.env.ComSpec ?? null
      : process.env.SHELL ?? null,
    pathEntries: getPathEntries(),
    executables,
    gitBashCandidates,
    sandbox: describeCommandSandbox(context.sandboxMode),
    ...(workspacePath ? { workspacePath, wslWorkspacePath: toWslPath(workspacePath) } : {}),
  };
}

function gitBashDetectionCandidates(): string[] {
  if (process.platform !== "win32") return ["bash"];
  return [
    process.env.GIT_BASH_PATH,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : undefined,
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

class CommandSessionManager {
  private readonly sessions = new Map<string, CommandSession>();
  private shutdownPromise: Promise<CommandSessionShutdownResult> | undefined;

  async start(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<CommandSessionSnapshot> {
    this.pruneExitedSessions();
    if (this.sessions.size >= MAX_COMMAND_SESSION_COUNT) {
      throw new Error(`start_command_session allows at most ${MAX_COMMAND_SESSION_COUNT} sessions.`);
    }
    const workspace = requireWorkspace(context);
    const command = requiredCommandForTool(input.command, "start_command_session");
    if (context.signal?.aborted) {
      throw new Error("Command was interrupted.");
    }
    const cwdArg = optionalString(input.cwd) ?? ".";
    const cwdPath = await resolveWorkspacePathForAccess(workspace, cwdArg, "read");
    const stat = await fs.stat(cwdPath);
    if (!stat.isDirectory()) {
      throw new Error(`start_command_session cwd is not a directory: ${cwdArg}`);
    }
    const shell = optionalEnum(
      input.shell,
      ["default", "cmd", "sh", "bash", "git_bash", "powershell", "pwsh"],
      "shell",
    ) ?? "default";
    const maxBufferBytes = numberInRange(
      input.max_buffer_bytes,
      MIN_COMMAND_MAX_OUTPUT_BYTES,
      MAX_COMMAND_SESSION_BUFFER_BYTES,
      DEFAULT_COMMAND_SESSION_BUFFER_BYTES,
      "max_buffer_bytes",
    );
    const invocation = await createSelectedShellInvocation(command, { shell });
    if (context.signal?.aborted) {
      throw new Error("Command was interrupted.");
    }
    const progress = createCommandProgressReporter(context.reportProgress);
    const child = spawn(invocation.file, invocation.args, createCommandSpawnOptions({
      cwd: cwdPath,
      sandboxMode: context.sandboxMode,
      stdin: "pipe",
    }));
    const now = new Date().toISOString();
    const session: CommandSession = {
      id: randomUUID(),
      threadId: context.threadId,
      workspace,
      command,
      cwd: toWorkspaceRelative(workspace, cwdPath) || ".",
      cwdPath,
      shell,
      invocation,
      child,
      status: "running",
      startedAt: now,
      updatedAt: now,
      stdout: createSessionCapture(maxBufferBytes),
      stderr: createSessionCapture(maxBufferBytes),
    };
    child.stdout?.on("data", (data: Buffer | string) => {
      session.stdout.collect(data);
      progress?.collect(data, "stdout");
      session.updatedAt = new Date().toISOString();
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      session.stderr.collect(data);
      progress?.collect(data, "stderr");
      session.updatedAt = new Date().toISOString();
    });
    child.on("error", (error) => {
      progress?.flush();
      session.status = "failed";
      session.error = error.message;
      session.updatedAt = new Date().toISOString();
    });
    child.on("close", (exitCode, signal) => {
      progress?.flush();
      if (session.status === "failed") {
        session.exitCode = exitCode;
        session.signal = signal;
        session.updatedAt = new Date().toISOString();
        return;
      }
      session.status = "exited";
      session.exitCode = exitCode;
      session.signal = signal;
      session.updatedAt = new Date().toISOString();
    });
    const onAbort = (): void => {
      session.status = "failed";
      session.error = "Command was interrupted.";
      session.updatedAt = new Date().toISOString();
      killProcessTree(child, "SIGTERM");
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    this.sessions.set(session.id, session);
    try {
      await this.waitForSessionSpawn(session);
      if (context.signal?.aborted) {
        throw new Error("Command was interrupted.");
      }
      return this.snapshot(session, DEFAULT_COMMAND_SESSION_TAIL_BYTES);
    } catch (error) {
      progress?.flush();
      this.sessions.delete(session.id);
      killProcessTree(child, "SIGKILL");
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  list(input: Record<string, unknown>, context: AgentToolContext): CommandSessionListResult {
    const workspace = requireWorkspace(context);
    const includeOutput = input.include_output === undefined
      ? false
      : requiredBoolean(input.include_output, "include_output");
    const tailBytes = numberInRange(
      input.tail_bytes,
      1,
      MAX_COMMAND_SESSION_BUFFER_BYTES,
      DEFAULT_COMMAND_SESSION_TAIL_BYTES,
      "tail_bytes",
    );
    const sessions = [...this.sessions.values()]
      .filter((session) =>
        session.threadId === context.threadId && isSamePath(session.workspace, workspace)
      )
      .map((session) => this.listEntry(session, includeOutput, tailBytes));

    return {
      sessionCount: sessions.length,
      sessions,
    };
  }

  read(input: Record<string, unknown>, context: AgentToolContext): CommandSessionSnapshot {
    const session = this.requireSession(input.session_id, context, "read_command_session");
    const tailBytes = numberInRange(
      input.tail_bytes,
      1,
      MAX_COMMAND_SESSION_BUFFER_BYTES,
      DEFAULT_COMMAND_SESSION_TAIL_BYTES,
      "tail_bytes",
    );
    return this.snapshot(session, tailBytes);
  }

  async write(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<{ sessionId: string; bytesWritten: number }> {
    const session = this.requireSession(input.session_id, context, "write_command_session");
    if (session.status !== "running") {
      throw new Error(`write_command_session session is not running: ${session.id}`);
    }
    const text = requiredSessionInput(
      input.input,
      "write_command_session requires a string input.",
      MAX_COMMAND_BYTES,
    );
    const newline = input.newline === undefined ? true : requiredBoolean(input.newline, "newline");
    const payload = newline ? `${text}\n` : text;
    const bytesWritten = await this.writeSessionInput(session, payload);
    session.updatedAt = new Date().toISOString();
    return {
      sessionId: session.id,
      bytesWritten,
    };
  }

  async stop(input: Record<string, unknown>, context: AgentToolContext): Promise<CommandSessionSnapshot> {
    const session = this.requireSession(input.session_id, context, "stop_command_session");
    if (session.status === "running") {
      session.status = "stopping";
      killProcessTree(session.child, "SIGTERM");
      if (session.stopForceKillTimer) {
        clearTimeout(session.stopForceKillTimer);
      }
      session.stopForceKillTimer = setTimeout(() => {
        session.stopForceKillTimer = undefined;
        killProcessTree(session.child, "SIGKILL");
      }, COMMAND_KILL_GRACE_MS);
      session.updatedAt = new Date().toISOString();
    }
    if (session.status === "stopping") {
      await this.waitForTerminalSession(
        session,
        COMMAND_KILL_GRACE_MS + COMMAND_SESSION_STOP_TIMEOUT_EXTRA_MS,
      );
    }
    return this.snapshot(session, DEFAULT_COMMAND_SESSION_TAIL_BYTES);
  }

  async shutdown(): Promise<CommandSessionShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownOnce().finally(() => {
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }

  private requireSession(
    value: unknown,
    context: AgentToolContext,
    toolName: string,
  ): CommandSession {
    const id = requiredLimitedString(value, "session_id must be a non-empty string.", 128);
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Command session not found: ${id}`);
    }
    const workspace = requireWorkspace(context);
    if (session.threadId !== context.threadId || !isSamePath(session.workspace, workspace)) {
      throw new Error(`${toolName} session does not belong to this thread workspace: ${id}`);
    }
    return session;
  }

  private pruneExitedSessions(): void {
    for (const [id, session] of this.sessions) {
      if (session.status !== "running" && session.status !== "stopping") {
        this.sessions.delete(id);
      }
    }
  }

  private async shutdownOnce(): Promise<CommandSessionShutdownResult> {
    const sessions = [...this.sessions.values()];
    const activeSessions = sessions.filter((session) => this.isActiveSession(session));
    const shutdownErrors: Error[] = [];

    await Promise.all(
      activeSessions.map(async (session) => {
        try {
          await this.stopSessionForShutdown(session);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          session.status = "failed";
          session.error = message;
          session.updatedAt = new Date().toISOString();
          shutdownErrors.push(error instanceof Error ? error : new Error(message));
        }
      }),
    );

    const result = {
      sessionCount: sessions.length,
      stoppedSessionCount: activeSessions.length,
      sessions: sessions.map((session) => this.snapshot(session, DEFAULT_COMMAND_SESSION_TAIL_BYTES)),
    };
    this.sessions.clear();

    if (shutdownErrors.length > 0) {
      throw new AggregateError(shutdownErrors, "Command session shutdown failed.");
    }
    return result;
  }

  private async stopSessionForShutdown(session: CommandSession): Promise<void> {
    if (!this.isActiveSession(session)) return;
    if (session.stopForceKillTimer) {
      clearTimeout(session.stopForceKillTimer);
      session.stopForceKillTimer = undefined;
    }
    session.status = "stopping";
    session.error = COMMAND_SESSION_SHUTDOWN_MESSAGE;
    session.updatedAt = new Date().toISOString();
    killProcessTree(session.child, "SIGTERM");
    session.stopForceKillTimer = setTimeout(() => {
      session.stopForceKillTimer = undefined;
      killProcessTree(session.child, "SIGKILL");
    }, COMMAND_KILL_GRACE_MS);
    await this.waitForTerminalSession(session, COMMAND_SESSION_SHUTDOWN_TIMEOUT_MS);
  }

  private isActiveSession(session: CommandSession): boolean {
    return session.status === "running" || session.status === "stopping";
  }

  private async waitForSessionSpawn(session: CommandSession): Promise<void> {
    // start_command_session must only return a usable session id after the OS
    // accepted the child process. A pid covers already-emitted spawn events,
    // while close/error/timeout keep startup failures traceable to this call.
    if (typeof session.child.pid === "number") return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        session.child.off("spawn", onSpawn);
        session.child.off("error", onError);
        session.child.off("close", onClose);
      };
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`start_command_session failed to start command: ${error.message}`));
      };
      const onSpawn = (): void => {
        settleResolve();
      };
      const onError = (error: Error): void => {
        settleReject(error);
      };
      const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (session.status === "failed") {
          settleReject(new Error(session.error ?? "unknown spawn failure"));
          return;
        }
        settleReject(
          new Error(`process closed before spawn event (exitCode: ${exitCode}, signal: ${signal})`),
        );
      };
      const timeout = setTimeout(() => {
        settleReject(new Error("timed out waiting for process spawn"));
      }, COMMAND_SESSION_SPAWN_TIMEOUT_MS);
      session.child.once("spawn", onSpawn);
      session.child.once("error", onError);
      session.child.once("close", onClose);
      if (typeof session.child.pid === "number") {
        settleResolve();
        return;
      }
      if (session.status === "failed") {
        settleReject(new Error(session.error ?? "unknown spawn failure"));
      }
    });
  }

  private async waitForTerminalSession(
    session: CommandSession,
    timeoutMs: number,
  ): Promise<void> {
    if (session.status !== "running" && session.status !== "stopping") return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        if (session.stopForceKillTimer) {
          clearTimeout(session.stopForceKillTimer);
          session.stopForceKillTimer = undefined;
        }
        session.child.off("close", onSettled);
        session.child.off("error", onSettled);
      };
      const onSettled = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`stop_command_session timed out waiting for session to stop: ${session.id}`));
      }, timeoutMs);
      session.child.once("close", onSettled);
      session.child.once("error", onSettled);
      if (session.status !== "running" && session.status !== "stopping") {
        onSettled();
      }
    });
  }

  private async writeSessionInput(
    session: CommandSession,
    payload: string,
  ): Promise<number> {
    const stdin = session.child.stdin;
    if (!stdin || !stdin.writable || stdin.destroyed || stdin.writableEnded) {
      throw new Error(`write_command_session stdin is not writable: ${session.id}`);
    }
    const bytesWritten = Buffer.byteLength(payload, "utf8");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        stdin.off("error", onError);
        stdin.off("close", onClose);
        session.child.off("close", onChildClose);
      };
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onError = (error: Error): void => {
        settleReject(new Error(`write_command_session stdin write failed: ${error.message}`));
      };
      const onClose = (): void => {
        settleReject(new Error(`write_command_session stdin closed before input was written: ${session.id}`));
      };
      const onChildClose = (): void => {
        settleReject(new Error(`write_command_session session closed before input was written: ${session.id}`));
      };
      stdin.once("error", onError);
      stdin.once("close", onClose);
      session.child.once("close", onChildClose);
      stdin.write(payload, (error?: Error | null) => {
        if (error) {
          settleReject(new Error(`write_command_session stdin write failed: ${error.message}`));
          return;
        }
        settleResolve();
      });
    });
    return bytesWritten;
  }

  private snapshot(session: CommandSession, tailBytes: number): CommandSessionSnapshot {
    return {
      sessionId: session.id,
      command: session.command,
      cwd: session.cwd,
      shell: session.shell,
      shellFile: session.invocation.file,
      pid: session.child.pid ?? null,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      error: session.error,
      stdout: session.stdout.snapshot(tailBytes),
      stderr: session.stderr.snapshot(tailBytes),
    };
  }

  private listEntry(
    session: CommandSession,
    includeOutput: boolean,
    tailBytes: number,
  ): CommandSessionListEntry {
    const entry: CommandSessionListEntry = {
      sessionId: session.id,
      command: session.command,
      cwd: session.cwd,
      shell: session.shell,
      shellFile: session.invocation.file,
      pid: session.child.pid ?? null,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      error: session.error,
    };
    if (includeOutput) {
      entry.stdout = session.stdout.snapshot(tailBytes);
      entry.stderr = session.stderr.snapshot(tailBytes);
    }
    return entry;
  }
}

interface CommandSession {
  id: string;
  threadId: string;
  workspace: string;
  command: string;
  cwd: string;
  cwdPath: string;
  shell: ShellKind;
  invocation: ShellInvocation;
  child: ChildProcess;
  status: "running" | "stopping" | "exited" | "failed";
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stopForceKillTimer?: NodeJS.Timeout;
  stdout: SessionCapture;
  stderr: SessionCapture;
}

interface CommandSessionSnapshot {
  sessionId: string;
  command: string;
  cwd: string;
  shell: ShellKind;
  shellFile: string;
  pid: number | null;
  status: CommandSession["status"];
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stdout: StreamCapture;
  stderr: StreamCapture;
}

interface CommandSessionListResult {
  sessionCount: number;
  sessions: CommandSessionListEntry[];
}

interface CommandSessionListEntry {
  sessionId: string;
  command: string;
  cwd: string;
  shell: ShellKind;
  shellFile: string;
  pid: number | null;
  status: CommandSession["status"];
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stdout?: StreamCapture;
  stderr?: StreamCapture;
}

interface CommandSessionShutdownResult {
  sessionCount: number;
  stoppedSessionCount: number;
  sessions: CommandSessionSnapshot[];
}

const commandSessionManager = new CommandSessionManager();

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

function requiredCommandForTool(value: unknown, toolName: string): string {
  return requiredLimitedString(
    value,
    `${toolName} requires a non-empty command string.`,
    MAX_COMMAND_BYTES,
  );
}

function requiredLimitedString(value: unknown, message: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("string value cannot contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`string value exceeds ${maxBytes} bytes.`);
  }
  return value.trim();
}

function requiredSessionInput(value: unknown, message: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("string value cannot contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`string value exceeds ${maxBytes} bytes.`);
  }
  return value;
}

function requiredRegexPattern(value: unknown): string {
  return requiredLimitedString(
    value,
    "rg_search requires a non-empty pattern string.",
    MAX_REGEX_PATTERN_BYTES,
  );
}

function optionalLimitedString(
  value: unknown,
  maxBytes: number,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("\0")) {
    throw new Error(`${name} cannot contain NUL bytes.`);
  }
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} bytes.`);
  }
  return trimmed;
}

function createLineRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`rg_search pattern is invalid: ${message}`);
  }
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

async function assertTextFile(
  filePath: string,
  relativePath: string,
  label = "diagnose_file path",
): Promise<void> {
  const sample = await fs.readFile(filePath);
  assertUtf8TextBuffer(sample, relativePath, label);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("optional string value must be a string.");
  }
  if (value.includes("\0")) {
    throw new Error("optional string value cannot contain NUL bytes.");
  }
  return value.trim() || undefined;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${name} entries must be non-empty strings.`);
    }
    if (entry.includes("\0")) {
      throw new Error(`${name} entries cannot contain NUL bytes.`);
    }
    return entry.trim();
  });
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
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

async function walkTextFiles(
  directory: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || shouldSkipCommandSearchEntry(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkTextFiles(fullPath, onFile);
    } else if (entry.isFile() && looksTextFile(entry.name)) {
      await onFile(fullPath);
    }
  }
}

function shouldSkipCommandSearchEntry(name: string): boolean {
  return shouldSkipEntry(name) || name === ".hg" || name === ".svn";
}

function looksTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [
    "",
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".md",
    ".mdx",
    ".mjs",
    ".py",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
  ].includes(ext);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}
