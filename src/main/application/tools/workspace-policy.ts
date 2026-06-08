import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentToolContext } from "../../domain/agent/types";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "DeepSeek",
  "dist",
  "node_modules",
  "out",
]);

export type WorkspacePathAccess = "read" | "write";

/**
 * Workspace tools share one path policy so read and write capabilities cannot
 * drift. The lexical check catches obvious traversal before realpath, then the
 * realpath/parent checks close symlink escape paths for existing and new files.
 */
export async function resolveWorkspacePathForAccess(
  workspace: string,
  relativePath: string,
  access: WorkspacePathAccess,
): Promise<string> {
  const root = resolveWorkspaceRoot(workspace);
  const resolved = path.resolve(root, relativePath);
  assertWithinWorkspace(root, resolved, relativePath);
  assertAllowedWorkspacePath(root, resolved, relativePath);

  const realRoot = await fs.realpath(root);
  assertWithinWorkspace(realRoot, realRoot, relativePath);
  assertAllowedWorkspacePath(realRoot, realRoot, relativePath);

  try {
    const realResolved = await fs.realpath(resolved);
    assertWithinWorkspace(realRoot, realResolved, relativePath);
    assertAllowedWorkspacePath(realRoot, realResolved, relativePath);
    return resolved;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT" || access === "read") {
      throw error;
    }
  }

  const realParent = await resolveExistingParentRealpath(root, resolved, relativePath);
  assertWithinWorkspace(realRoot, realParent, relativePath);
  assertAllowedWorkspacePath(realRoot, realParent, relativePath);
  await assertTargetIsNotSymlink(resolved, relativePath);
  return resolved;
}

export function requireWorkspace(context: AgentToolContext): string {
  if (!context.workspace?.trim()) {
    throw new Error("Workspace tools require an active thread workspace.");
  }
  return resolveWorkspaceRoot(context.workspace);
}

export function resolveWorkspaceRoot(workspace: string): string {
  if (!workspace.trim()) {
    throw new Error("Workspace path is required.");
  }
  return path.resolve(workspace);
}

export function toWorkspaceRelative(workspace: string, fullPath: string): string {
  return path.relative(resolveWorkspaceRoot(workspace), fullPath).replaceAll(path.sep, "/");
}

export function shouldSkipEntry(name: string): boolean {
  return isSkippedSegment(name);
}

export function assertAllowedWorkspacePath(
  root: string,
  resolved: string,
  relativePath: string,
): void {
  const relative = path.relative(root, resolved);
  if (!relative) return;
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.some(isSkippedSegment)) {
    throw new Error(`Path is skipped by workspace tool policy: ${relativePath}`);
  }
}

export function assertWithinWorkspace(root: string, resolved: string, relativePath: string): void {
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
}

function isSkippedSegment(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
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
