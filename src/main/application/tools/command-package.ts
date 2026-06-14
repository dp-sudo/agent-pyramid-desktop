import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { MAX_PACKAGE_SCRIPT_NAME_BYTES } from "../constants.js";
import type { PackageManagerName } from "./command-invocation.js";

export interface PackageJsonShape {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

export async function readPackageJson(cwdPath: string): Promise<PackageJsonShape> {
  const packageJsonPath = path.join(cwdPath, "package.json");
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("package.json must contain a JSON object.");
    }
    return parsed;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      throw new Error(`package.json not found in ${cwdPath}.`);
    }
    throw error;
  }
}

export function normalizePackageScripts(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (typeof command === "string") {
      scripts[name] = command;
    }
  }
  return scripts;
}

/**
 * Resolves the package manager without invoking package-manager shims. Explicit
 * packageManager metadata wins over lockfiles, preserving the existing command
 * tool behavior before process execution starts.
 */
export async function detectPackageManager(
  cwdPath: string,
  packageJson: PackageJsonShape,
): Promise<PackageManagerName> {
  if (typeof packageJson.packageManager === "string") {
    const [manager] = packageJson.packageManager.split("@");
    if (isPackageManagerName(manager)) return manager;
  }
  const lockfiles: Array<[string, PackageManagerName]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ];
  for (const [fileName, manager] of lockfiles) {
    if (await pathExists(path.join(cwdPath, fileName))) return manager;
  }
  return "npm";
}

export function packageRunScriptArgs(manager: PackageManagerName, script: string): string[] {
  switch (manager) {
    case "npm":
    case "pnpm":
    case "bun":
      return ["run", script];
    case "yarn":
      return ["run", script];
    default:
      return assertNever(manager);
  }
}

export function packageInstallArgs(
  manager: PackageManagerName,
  frozenLockfile: boolean,
  cwdPath: string,
): string[] {
  switch (manager) {
    case "npm":
      if (!frozenLockfile) return ["install"];
      if (
        existsSync(path.join(cwdPath, "package-lock.json")) ||
        existsSync(path.join(cwdPath, "npm-shrinkwrap.json"))
      ) {
        return ["ci"];
      }
      throw new Error("package_install frozen_lockfile requires package-lock.json or npm-shrinkwrap.json for npm.");
    case "pnpm":
      return ["install", ...(frozenLockfile ? ["--frozen-lockfile"] : [])];
    case "yarn":
      return ["install", ...(frozenLockfile ? ["--frozen-lockfile"] : [])];
    case "bun":
      return ["install", ...(frozenLockfile ? ["--frozen-lockfile"] : [])];
    default:
      return assertNever(manager);
  }
}

export function optionalPackageManager(value: unknown): PackageManagerName | undefined {
  if (value === undefined) return undefined;
  if (!isPackageManagerName(value)) {
    throw new Error("manager must be npm, pnpm, yarn, or bun.");
  }
  return value;
}

function isPackageManagerName(value: unknown): value is PackageManagerName {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

export function optionalPackageScriptName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const script = requiredLimitedString(
    value,
    "script must be a non-empty string.",
    MAX_PACKAGE_SCRIPT_NAME_BYTES,
  );
  if (/[\x01-\x1f\x7f\s]/.test(script)) {
    throw new Error("script cannot contain whitespace or control characters.");
  }
  if (script.startsWith("-")) {
    throw new Error(`script must be a package script name, not a package-manager option: ${script}`);
  }
  if (!/^[A-Za-z0-9_./:=@+-]+$/.test(script)) {
    throw new Error(`script contains unsupported characters: ${script}`);
  }
  return script;
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
