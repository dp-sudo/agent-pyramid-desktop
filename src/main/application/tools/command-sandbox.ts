import type {
  SpawnOptions,
  StdioOptions,
} from "node:child_process";
import type { ThreadSandboxMode } from "../../../shared/agent-contracts.js";
import { buildCommandEnvironment } from "./command-environment.js";

export interface CommandSandboxReport {
  mode: ThreadSandboxMode;
  cwdBoundary: "workspace-realpath";
  environment: "credential-filtered";
  stdio: "not-inherited";
  shell: "explicit";
  processCleanup: "windows-taskkill-tree" | "posix-process-group";
  osJail: {
    enabled: false;
    reason: string;
  };
}

export interface CommandSpawnSandboxOptions {
  cwd: string;
  sandboxMode?: ThreadSandboxMode;
  stdin: "ignore" | "pipe";
}

/**
 * Command sandboxing is enforced at spawn time, after ToolPolicyService has
 * made the approval/sandbox decision. Node/Electron does not provide a native
 * cross-platform OS jail, so this boundary keeps the supported guarantees
 * explicit and shared by foreground commands and long-running sessions.
 */
export function createCommandSpawnOptions(
  options: CommandSpawnSandboxOptions,
): SpawnOptions {
  return {
    cwd: options.cwd,
    env: buildCommandEnvironment(),
    shell: false,
    detached: process.platform !== "win32",
    stdio: commandStdio(options.stdin),
    windowsHide: true,
  };
}

export function describeCommandSandbox(
  sandboxMode: ThreadSandboxMode | undefined,
  platform: NodeJS.Platform = process.platform,
): CommandSandboxReport {
  return {
    mode: sandboxMode ?? "workspace-write",
    cwdBoundary: "workspace-realpath",
    environment: "credential-filtered",
    stdio: "not-inherited",
    shell: "explicit",
    processCleanup: platform === "win32"
      ? "windows-taskkill-tree"
      : "posix-process-group",
    osJail: {
      enabled: false,
      reason:
        "Node/Electron has no built-in cross-platform OS command jail; use read-only sandbox to deny command tools, and workspace-write/danger-full-access with approval for spawned commands.",
    },
  };
}

function commandStdio(stdin: "ignore" | "pipe"): StdioOptions {
  return [stdin, "pipe", "pipe"];
}
