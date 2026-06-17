import { spawn, type ChildProcess } from "node:child_process";
import {
  createShellInvocation,
  type ShellInvocation,
} from "./command-invocation.js";
import {
  createOutputCollector,
  type StreamCapture,
} from "./command-output-capture.js";
import {
  createCommandProgressReporter,
  type ToolProgressCallback,
} from "./command-progress-reporter.js";
import {
  COMMAND_KILL_GRACE_MS,
} from "../constants.js";
import {
  createCommandSpawnSpec,
} from "./command-sandbox.js";
import type { ThreadSandboxMode } from "../../../shared/agent-contracts.js";

export interface CommandOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: StreamCapture;
  stderr: StreamCapture;
}

/**
 * Runs foreground commands with bounded output, live progress, timeout, and
 * cancellation semantics. Process-tree ownership stays here so command tools
 * and interactive sessions share one interrupt/kill implementation.
 */
export async function spawnWorkspaceCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  reportProgress?: ToolProgressCallback,
  sandboxMode?: ThreadSandboxMode,
): Promise<CommandOutput> {
  return spawnWorkspaceProcess(
    createShellInvocation(command),
    cwd,
    timeoutMs,
    maxOutputBytes,
    signal,
    reportProgress,
    sandboxMode,
  );
}

export async function spawnWorkspaceProcess(
  invocation: ShellInvocation,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  reportProgress?: ToolProgressCallback,
  sandboxMode?: ThreadSandboxMode,
): Promise<CommandOutput> {
  if (signal?.aborted) {
    throw new Error("Command was interrupted.");
  }

  return new Promise<CommandOutput>((resolve, reject) => {
    const stdout = createOutputCollector(maxOutputBytes);
    const stderr = createOutputCollector(maxOutputBytes);
    const progress = createCommandProgressReporter(reportProgress);
    let timedOut = false;
    let settled = false;
    let spawned = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const spawnSpec = createCommandSpawnSpec(invocation, {
      cwd,
      sandboxMode,
      stdin: "ignore",
    });
    const child = spawn(spawnSpec.file, spawnSpec.args, spawnSpec.options);

    const killChild = (killSignal: NodeJS.Signals): void => {
      killProcessTree(child, killSignal);
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
      progress?.flush();
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      killChild("SIGTERM");
      forceKillTimer = setTimeout(() => killChild("SIGKILL"), COMMAND_KILL_GRACE_MS);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      forceKillTimer = setTimeout(() => killChild("SIGKILL"), COMMAND_KILL_GRACE_MS);
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    if (!child.stdout || !child.stderr) {
      settleReject(new Error("Command sandbox failed to create stdout/stderr pipes."));
      return;
    }
    child.stdout.on("data", (data: Buffer | string) => {
      stdout.collect(data);
      progress?.collect(data, "stdout");
    });
    child.stderr.on("data", (data: Buffer | string) => {
      stderr.collect(data);
      progress?.collect(data, "stderr");
    });
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (error) => {
      if (!spawned) {
        settleReject(new Error(`Command failed to start: ${error.message}`));
        return;
      }
      settleReject(error);
    });
    child.on("close", (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      progress?.flush();
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

export function killProcessTree(
  child: ChildProcess,
  killSignal: NodeJS.Signals,
): void {
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
}

function killWindowsProcessTree(
  child: ChildProcess,
  fallbackSignal: NodeJS.Signals,
): void {
  if (!child.pid) {
    killDirectChild(child, fallbackSignal);
    return;
  }
  const fallbackToDirectKill = (reason: string): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    console.warn(`[command-tools] taskkill ${reason}; falling back to child.kill.`);
    killDirectChild(child, fallbackSignal);
  };
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.on("error", (error) => {
    fallbackToDirectKill(`failed: ${error.message}`);
  });
  killer.on("close", (exitCode) => {
    if (exitCode !== 0) {
      fallbackToDirectKill(`exited with code ${exitCode ?? "unknown"}`);
    }
  });
}

function killDirectChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if (!isProcessAlreadyExited(error)) {
      console.warn("[command-tools] child.kill failed while stopping command:", error);
    }
  }
}

function isProcessAlreadyExited(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH";
}
