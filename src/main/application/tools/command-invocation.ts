import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";

export type ShellKind =
  | "default"
  | "cmd"
  | "sh"
  | "bash"
  | "git_bash"
  | "powershell"
  | "pwsh";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export interface ShellInvocation {
  file: string;
  args: string[];
}

/**
 * Builds shell invocations without starting a process. Command tools use this
 * as the single shell selection boundary before spawn-time sandbox and approval
 * checks run in command-tools.ts.
 */
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

export async function createSelectedShellInvocation(
  command: string,
  options: {
    shell: ShellKind;
    shellPath?: string;
    shellArgs?: string[];
  },
): Promise<ShellInvocation> {
  if (options.shellPath) {
    return {
      file: options.shellPath,
      args: applyShellArgs(options.shellArgs ?? ["-lc", "{command}"], command),
    };
  }
  switch (options.shell) {
    case "default":
      return createShellInvocation(command);
    case "cmd":
      return {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", command],
      };
    case "sh":
      return { file: process.platform === "win32" ? "sh.exe" : "/bin/sh", args: ["-c", command] };
    case "bash":
      return { file: "bash", args: ["-lc", command] };
    case "git_bash":
      return { file: await resolveGitBashExecutable(), args: ["-lc", command] };
    case "powershell":
      return createPowerShellInvocation(command, "powershell");
    case "pwsh":
      return createPowerShellInvocation(command, "pwsh");
    default:
      return assertNever(options.shell);
  }
}

function createPowerShellInvocation(
  command: string,
  executable: "pwsh" | "powershell",
): ShellInvocation {
  return {
    file: executable,
    args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
  };
}

/**
 * `powershell_command` promises a PowerShell 7 preference while preserving
 * Windows hosts that only ship Windows PowerShell, so the default executable
 * is resolved from PATH before falling back to the previous `pwsh` behavior.
 */
export async function resolveDefaultPowerShellShell(): Promise<"pwsh" | "powershell"> {
  if (process.platform !== "win32") {
    return "pwsh";
  }
  const pwsh = await findExecutableOnPath(["pwsh.exe", "pwsh"]);
  if (pwsh.found) {
    return "pwsh";
  }
  const powershell = await findExecutableOnPath(["powershell.exe", "powershell"]);
  return powershell.found ? "powershell" : "pwsh";
}

export function createWslInvocation(
  command: string,
  wslCwd: string,
  distro?: string,
): ShellInvocation {
  const linuxCommand = `cd ${quotePosix(wslCwd)} && ${command}`;
  return {
    file: "wsl.exe",
    args: [
      ...(distro ? ["-d", distro] : []),
      "--",
      "sh",
      "-lc",
      linuxCommand,
    ],
  };
}

function applyShellArgs(args: string[], command: string): string[] {
  if (args.some((arg) => arg.includes("{command}"))) {
    return args.map((arg) => arg.replaceAll("{command}", command));
  }
  return [...args, command];
}

async function resolveGitBashExecutable(): Promise<string> {
  if (process.platform !== "win32") {
    return "bash";
  }
  const explicit = process.env.GIT_BASH_PATH;
  const candidates = [
    explicit,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : undefined,
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await canExecute(candidate)) return candidate;
  }
  return "bash.exe";
}

export function createPackageManagerInvocation(
  manager: PackageManagerName,
  args: string[],
): ShellInvocation {
  if (process.platform === "win32") {
    return createShellInvocation([manager, ...args].map(quoteCmdArg).join(" "));
  }
  return { file: manager, args };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function toWslPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

export async function findExecutableOnPath(
  names: string[],
): Promise<{ found: boolean; path?: string }> {
  const pathEntries = getPathEntries();
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
    : [""];
  for (const entry of pathEntries) {
    for (const name of names) {
      const hasExt = path.extname(name).length > 0;
      const candidateNames = hasExt ? [name] : extensions.map((ext) => `${name}${ext.toLowerCase()}`);
      for (const candidateName of candidateNames) {
        const candidate = path.join(entry, candidateName);
        if (await canExecute(candidate)) {
          return { found: true, path: candidate };
        }
      }
    }
  }
  return { found: false };
}

export function getPathEntries(): string[] {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  return rawPath.split(path.delimiter).filter((entry) => entry.length > 0);
}

export async function canExecute(filePath: string): Promise<boolean> {
  try {
    await fs.access(
      filePath,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.F_OK | fsConstants.X_OK,
    );
    return true;
  } catch (error) {
    if (
      hasNodeErrorCode(error, "ENOENT") ||
      hasNodeErrorCode(error, "EACCES") ||
      hasNodeErrorCode(error, "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
