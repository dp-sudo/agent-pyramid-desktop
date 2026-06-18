import type {
  SpawnOptions,
  StdioOptions,
} from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ThreadSandboxMode } from "../../../shared/agent-contracts.js";
import type { ShellInvocation } from "./command-invocation.js";
import { buildCommandEnvironment } from "./command-environment.js";

export const WINDOWS_COMMAND_SANDBOX_HELPER_ENV = "AGENT_WINDOWS_COMMAND_SANDBOX_HELPER";

export class CommandSandboxUnavailableError extends Error {
  readonly code = "tool_sandbox_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "CommandSandboxUnavailableError";
  }
}

type CommandSandboxEngineName = "direct" | "windows-helper" | "unavailable";

export interface CommandSandboxReport {
  mode: ThreadSandboxMode;
  cwdBoundary: "workspace-realpath";
  environment: "credential-filtered";
  stdio: "not-inherited";
  shell: "explicit";
  processCleanup: "windows-taskkill-tree" | "posix-process-group";
  osJail: {
    enabled: boolean;
    required: boolean;
    available: boolean;
    engine: CommandSandboxEngineName;
    reason?: string;
    helperPath?: string;
  };
}

export interface CommandSpawnSandboxOptions {
  cwd: string;
  sandboxMode?: ThreadSandboxMode;
  stdin: "ignore" | "pipe";
  platform?: NodeJS.Platform;
  engine?: CommandSandboxEngine;
}

export interface CommandSpawnSpec {
  file: string;
  args: string[];
  options: SpawnOptions;
  sandbox: CommandSandboxReport;
}

export interface CommandSandboxEngine {
  readonly name: CommandSandboxEngineName;
  describe(request: CommandSandboxEngineRequest): CommandSandboxReport;
  createSpawnSpec(
    invocation: ShellInvocation,
    request: CommandSandboxEngineRequest,
  ): CommandSpawnSpec;
}

interface CommandSandboxEngineRequest {
  cwd: string;
  mode: ThreadSandboxMode;
  stdin: "ignore" | "pipe";
  platform: NodeJS.Platform;
}

/**
 * Command sandboxing is enforced at spawn time, after ToolPolicyService has
 * made the approval/sandbox decision. The engine seam keeps helper/native jail
 * details out of foreground command and long-running session implementations.
 */
export function createCommandSpawnSpec(
  invocation: ShellInvocation,
  options: CommandSpawnSandboxOptions,
): CommandSpawnSpec {
  const request = createSandboxEngineRequest(options);
  const engine = options.engine ?? selectDefaultSandboxEngine(request);
  return engine.createSpawnSpec(invocation, request);
}

export function createCommandSpawnOptions(
  options: CommandSpawnSandboxOptions,
): SpawnOptions {
  return createDirectSpawnOptions(createSandboxEngineRequest(options));
}

export function describeCommandSandbox(
  sandboxMode: ThreadSandboxMode | undefined,
  platform: NodeJS.Platform = process.platform,
): CommandSandboxReport {
  const request = createSandboxEngineRequest({
    cwd: ".",
    stdin: "ignore",
    sandboxMode,
    platform,
  });
  return selectDefaultSandboxEngine(request).describe(request);
}

export function createWindowsHelperCommandSandboxEngine(
  helperPath = process.env[WINDOWS_COMMAND_SANDBOX_HELPER_ENV],
): CommandSandboxEngine {
  return {
    name: "windows-helper",
    describe(request) {
      return createBaseReport(request, createWindowsHelperJailState(helperPath));
    },
    createSpawnSpec(invocation, request) {
      const jail = createWindowsHelperJailState(helperPath);
      if (!jail.available || !jail.helperPath) {
        throw new CommandSandboxUnavailableError(windowsHelperUnavailableMessage(jail.reason));
      }
      const payload = Buffer.from(JSON.stringify({
        version: 1,
        cwd: request.cwd,
        command: {
          file: invocation.file,
          args: invocation.args,
        },
        stdin: request.stdin,
      }), "utf8").toString("base64");
      return {
        file: jail.helperPath,
        args: ["run", "--request-base64", payload],
        options: createDirectSpawnOptions(request),
        sandbox: createBaseReport(request, jail),
      };
    },
  };
}

function createSandboxEngineRequest(options: CommandSpawnSandboxOptions): CommandSandboxEngineRequest {
  return {
    cwd: options.cwd,
    mode: options.sandboxMode ?? "workspace-write",
    stdin: options.stdin,
    platform: options.platform ?? process.platform,
  };
}

function selectDefaultSandboxEngine(request: CommandSandboxEngineRequest): CommandSandboxEngine {
  if (request.mode === "workspace-write") {
    if (request.platform === "win32") {
      return createWindowsHelperCommandSandboxEngine();
    }
    return unavailableCommandSandboxEngine(
      "workspace-write command execution requires an OS jail on this platform, but no supported jail engine is configured.",
    );
  }
  return directCommandSandboxEngine;
}

const directCommandSandboxEngine: CommandSandboxEngine = {
  name: "direct",
  describe(request) {
    return createBaseReport(request, {
      enabled: false,
      required: false,
      available: true,
      engine: "direct",
      reason: directSandboxReason(request),
    });
  },
  createSpawnSpec(invocation, request) {
    return {
      file: invocation.file,
      args: invocation.args,
      options: createDirectSpawnOptions(request),
      sandbox: this.describe(request),
    };
  },
};

function unavailableCommandSandboxEngine(reason: string): CommandSandboxEngine {
  return {
    name: "unavailable",
    describe(request) {
      return createBaseReport(request, {
        enabled: false,
        required: true,
        available: false,
        engine: "unavailable",
        reason,
      });
    },
    createSpawnSpec(_invocation, request) {
      const report = this.describe(request);
      throw new CommandSandboxUnavailableError(
        [
          "Command sandbox is unavailable; refusing workspace-write command execution.",
          report.osJail.reason,
          "Switch the thread to danger-full-access only if host command execution is intended.",
        ].filter(Boolean).join(" "),
      );
    },
  };
}

function createDirectSpawnOptions(request: CommandSandboxEngineRequest): SpawnOptions {
  return {
    cwd: request.cwd,
    env: buildCommandEnvironment(),
    shell: false,
    detached: request.platform !== "win32",
    stdio: commandStdio(request.stdin),
    windowsHide: true,
  };
}

function isAbsoluteHelperPath(helperPath: string): boolean {
  return path.isAbsolute(helperPath) || path.win32.isAbsolute(helperPath);
}

function createWindowsHelperJailState(
  helperPath: string | undefined,
): CommandSandboxReport["osJail"] {
  const normalizedHelperPath = helperPath?.trim();
  if (!normalizedHelperPath) {
    return {
      enabled: false,
      required: true,
      available: false,
      engine: "windows-helper",
      reason: `Windows command sandbox helper is not configured. Set ${WINDOWS_COMMAND_SANDBOX_HELPER_ENV} to the helper executable path.`,
    };
  }
  if (!isAbsoluteHelperPath(normalizedHelperPath)) {
    return {
      enabled: false,
      required: true,
      available: false,
      engine: "windows-helper",
      helperPath: normalizedHelperPath,
      reason: `Windows command sandbox helper path must be absolute: ${normalizedHelperPath}`,
    };
  }
  if (!existsSync(normalizedHelperPath)) {
    return {
      enabled: false,
      required: true,
      available: false,
      engine: "windows-helper",
      helperPath: normalizedHelperPath,
      reason: `Windows command sandbox helper was not found: ${normalizedHelperPath}`,
    };
  }
  return {
    enabled: true,
    required: true,
    available: true,
    engine: "windows-helper",
    helperPath: normalizedHelperPath,
  };
}

function createBaseReport(
  request: CommandSandboxEngineRequest,
  osJail: CommandSandboxReport["osJail"],
): CommandSandboxReport {
  return {
    mode: request.mode,
    cwdBoundary: "workspace-realpath",
    environment: "credential-filtered",
    stdio: "not-inherited",
    shell: "explicit",
    processCleanup: request.platform === "win32"
      ? "windows-taskkill-tree"
      : "posix-process-group",
    osJail,
  };
}

function directSandboxReason(request: CommandSandboxEngineRequest): string {
  if (request.mode === "danger-full-access") {
    return "danger-full-access permits host command execution without an OS jail after policy and approval checks.";
  }
  if (request.mode === "read-only") {
    return "read-only mode only allows tools marked read-only; command write-capable tools are denied before spawn.";
  }
  return "workspace-write requires a dedicated OS jail engine; direct execution is only valid for read-only-denied or danger-full-access flows.";
}

function windowsHelperUnavailableMessage(reason: string | undefined): string {
  return [
    "Windows command sandbox helper is unavailable; refusing workspace-write command execution.",
    reason,
    "Switch the thread to danger-full-access only if host command execution is intended.",
  ].filter(Boolean).join(" ");
}

function commandStdio(stdin: "ignore" | "pipe"): StdioOptions {
  return [stdin, "pipe", "pipe"];
}
