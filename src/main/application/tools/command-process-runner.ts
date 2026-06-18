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

export interface ProcessSpawnWaitOptions {
  failureMessagePrefix: string;
  timeoutMs?: number;
  onSpawnAccepted?: () => void;
  formatFailure?: (error: Error) => Error;
  createCurrentError?: () => Error | undefined;
  createCloseError?: (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => Error | undefined;
}

/**
 * Centralizes the spawn-startup contract for command tools: callers only treat
 * a command as started after Node reports a pid/spawn event, while pre-spawn
 * errors and early closes stay traceable to the tool call that attempted spawn.
 */
export function waitForProcessSpawn(
  child: ChildProcess,
  options: ProcessSpawnWaitOptions,
): Promise<void> {
  if (typeof child.pid === "number") {
    options.onSpawnAccepted?.();
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
      }
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      options.onSpawnAccepted?.();
      cleanup();
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(options.formatFailure?.(error) ?? new Error(`${options.failureMessagePrefix}: ${error.message}`));
    };
    const onSpawn = (): void => {
      settleResolve();
    };
    const onError = (error: Error): void => {
      settleReject(error);
    };
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      settleReject(
        options.createCloseError?.(exitCode, signal) ??
          new Error(`process closed before spawn event (exitCode: ${exitCode}, signal: ${signal})`),
      );
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("close", onClose);
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        settleReject(new Error("timed out waiting for process spawn"));
      }, options.timeoutMs);
    }
    if (typeof child.pid === "number") {
      settleResolve();
      return;
    }
    const currentError = options.createCurrentError?.();
    if (currentError) {
      settleReject(currentError);
    }
  });
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
    let forceKillTimer: NodeJS.Timeout | undefined;

    const spawnSpec = createCommandSpawnSpec(invocation, {
      cwd,
      sandboxMode,
      stdin: "ignore",
    });
    const child = spawn(spawnSpec.file, spawnSpec.args, spawnSpec.options);
    let spawnAccepted = typeof child.pid === "number";

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
    void waitForProcessSpawn(child, {
      failureMessagePrefix: "Command failed to start",
      onSpawnAccepted: () => {
        spawnAccepted = true;
      },
      formatFailure: (error) =>
        error.message === "Command was interrupted."
          ? error
          : new Error(`Command failed to start: ${error.message}`),
      createCloseError: (exitCode, childSignal) => {
        if (signal?.aborted && !timedOut) {
          return new Error("Command was interrupted.");
        }
        return new Error(`process closed before spawn event (exitCode: ${exitCode}, signal: ${childSignal})`);
      },
    }).catch(settleReject);
    child.on("error", (error) => {
      if (!spawnAccepted) return;
      settleReject(error);
    });
    child.on("close", (exitCode, childSignal) => {
      if (settled) return;
      if (!spawnAccepted) {
        if (signal?.aborted && !timedOut) {
          settleReject(new Error("Command was interrupted."));
        }
        return;
      }
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
