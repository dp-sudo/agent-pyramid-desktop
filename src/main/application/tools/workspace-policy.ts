import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentWorkspaceCapability } from "../../domain/agent/types";
import {
  isPathInsideOrEqual,
  toPortableRelativePath,
} from "../path-utils.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "DeepSeek",
  "dist",
  "external-references",
  "node_modules",
  "out",
]);

export type WorkspacePathAccess = "read" | "write";

export interface WorkspacePathPolicyOptions {
  skippedPathMessage?: (relativePath: string) => string;
}

/**
 * Workspace file access shares one path policy so tools and IPC services cannot
 * drift. The lexical check catches obvious traversal before realpath, then the
 * realpath/parent checks close symlink escape paths for existing and new files.
 */
export async function resolveWorkspacePathForAccess(
  workspace: string,
  relativePath: string,
  access: WorkspacePathAccess,
  options: WorkspacePathPolicyOptions = {},
): Promise<string> {
  const root = resolveWorkspaceRoot(workspace);
  const resolved = resolveWorkspacePathFromRoot(root, relativePath, options);

  const realRoot = await fs.realpath(root);
  assertWithinWorkspace(realRoot, realRoot, relativePath);
  assertAllowedWorkspacePath(realRoot, realRoot, relativePath, options);

  try {
    const realResolved = await fs.realpath(resolved);
    assertWithinWorkspace(realRoot, realResolved, relativePath);
    assertAllowedWorkspacePath(realRoot, realResolved, relativePath, options);
    return resolved;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT" || access === "read") {
      throw error;
    }
  }

  const realParent = await resolveExistingParentRealpath(root, resolved, relativePath);
  assertWithinWorkspace(realRoot, realParent, relativePath);
  assertAllowedWorkspacePath(realRoot, realParent, relativePath, options);
  await assertTargetIsNotSymlink(resolved, relativePath);
  return resolved;
}

export function requireWorkspace(context: AgentWorkspaceCapability): string {
  if (!context.workspace?.trim()) {
    throw new Error("Workspace tools require an active thread workspace.");
  }
  return resolveWorkspaceRoot(context.workspace);
}

export function resolveWorkspacePathLexically(
  workspace: string,
  relativePath: string,
  options: WorkspacePathPolicyOptions = {},
): string {
  return resolveWorkspacePathFromRoot(resolveWorkspaceRoot(workspace), relativePath, options);
}

export function resolveWorkspaceRoot(workspace: string): string {
  const normalized = workspace.trim();
  if (!normalized) {
    throw new Error("Workspace path is required.");
  }
  if (!path.isAbsolute(normalized)) {
    throw new Error("Workspace path must be absolute.");
  }
  return path.resolve(normalized);
}

function resolveWorkspacePathFromRoot(
  root: string,
  relativePath: string,
  options: WorkspacePathPolicyOptions,
): string {
  const resolved = path.resolve(root, relativePath);
  assertWithinWorkspace(root, resolved, relativePath);
  assertAllowedWorkspacePath(root, resolved, relativePath, options);
  return resolved;
}

export function toWorkspaceRelative(workspace: string, fullPath: string): string {
  return toPortableRelativePath(resolveWorkspaceRoot(workspace), fullPath);
}

export function shouldSkipEntry(name: string): boolean {
  return isSkippedSegment(name);
}

function assertAllowedWorkspacePath(
  root: string,
  resolved: string,
  relativePath: string,
  options: WorkspacePathPolicyOptions,
): void {
  const relative = path.relative(root, resolved);
  if (!relative) return;
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.some(isSkippedSegment)) {
    throw new Error(formatSkippedPathMessage(relativePath, options));
  }
}

function assertWithinWorkspace(root: string, resolved: string, relativePath: string): void {
  if (!isPathInsideOrEqual(root, resolved)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
}

function isSkippedSegment(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}

function formatSkippedPathMessage(
  relativePath: string,
  options: WorkspacePathPolicyOptions,
): string {
  return options.skippedPathMessage?.(relativePath) ??
    `Path is skipped by workspace tool policy: ${relativePath}`;
}

async function resolveExistingParentRealpath(
  lexicalRoot: string,
  targetPath: string,
  relativePath: string,
): Promise<string> {
  let current = path.dirname(targetPath);
  while (current !== path.dirname(current)) {
    assertWithinWorkspace(lexicalRoot, current, relativePath);
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
      current = path.dirname(current);
    }
  }
  throw new Error(`Path escapes workspace: ${relativePath}`);
}

async function assertTargetIsNotSymlink(targetPath: string, relativePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Path escapes workspace: ${relativePath}`);
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
