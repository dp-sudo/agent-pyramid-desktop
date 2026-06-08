import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import {
  WRITE_LIST_CHANNEL,
  WRITE_GET_CHANNEL,
  WRITE_PUT_CHANNEL,
  WRITE_COMPLETE_CHANNEL,
} from "../../shared/ipc.js";
import type {
  WriteFileEntry,
  WriteGetRequest,
  WriteListRequest,
  WritePutRequest,
  WriteCompleteRequest,
  WriteCompleteResponse,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";

const MARKDOWN_EXT = [".md", ".mdx", ".markdown"];
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "DeepSeek",
  "dist",
  "node_modules",
  "out",
]);

export function registerWriteHandlers(): void {
  ipcMain.handle(WRITE_LIST_CHANNEL, async (_event, request: WriteListRequest) => {
    try {
      const files = await listMarkdownFiles(request.workspace, request.search ?? "");
      return ok(files);
    } catch (error) {
      return err("WRITE_LIST_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_GET_CHANNEL, async (_event, request: WriteGetRequest) => {
    try {
      const fullPath = await resolveWritePathForAccess(request.workspace, request.path, "read");
      const content = await fs.readFile(fullPath, "utf8");
      return ok({ path: request.path, content });
    } catch (error) {
      return err("WRITE_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_PUT_CHANNEL, async (_event, request: WritePutRequest) => {
    try {
      const fullPath = await resolveWritePathForAccess(request.workspace, request.path, "write");
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, request.content, "utf8");
      return ok({ path: request.path, bytes: Buffer.byteLength(request.content, "utf8") });
    } catch (error) {
      return err("WRITE_PUT_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(
    WRITE_COMPLETE_CHANNEL,
    async (_event, request: WriteCompleteRequest): Promise<{ ok: true; value: WriteCompleteResponse } | { ok: false; code: string; message: string }> => {
      try {
        resolveWritePath(request.workspace, request.path);
        return ok(completeMarkdownInline(request));
      } catch (error) {
        return err("WRITE_COMPLETE_FAILED", messageOf(error));
      }
    },
  );
}

export async function resolveWritePathForAccess(
  workspace: string,
  relative: string,
  access: "read" | "write",
): Promise<string> {
  const root = resolveWorkspaceRoot(workspace);
  const resolved = resolveWritePath(workspace, relative);
  const realRoot = await fs.realpath(root);
  assertWithinWorkspace(realRoot, realRoot, relative);
  assertAllowedWorkspacePath(realRoot, realRoot, relative);

  try {
    const realResolved = await fs.realpath(resolved);
    assertWithinWorkspace(realRoot, realResolved, relative);
    assertAllowedWorkspacePath(realRoot, realResolved, relative);
    return resolved;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT" || access === "read") {
      throw error;
    }
    await assertTargetIsNotSymlink(resolved, relative);
  }

  const realParent = await resolveExistingParentRealpath(root, resolved, relative);
  assertWithinWorkspace(realRoot, realParent, relative);
  assertAllowedWorkspacePath(realRoot, realParent, relative);
  return resolved;
}

export function completeMarkdownInline(request: WriteCompleteRequest): WriteCompleteResponse {
  if (request.prefix.trim().length < 10 || request.suffix.trimStart()) {
    return emptyCompletion();
  }

  const currentLine = request.prefix.split(/\r?\n/).at(-1) ?? "";
  const task = currentLine.match(/^(\s*)- \[[ xX]\]\s+\S/);
  if (task) {
    return { completion: `\n${task[1]}- [ ] `, score: 0.58, truncated: false };
  }

  const bullet = currentLine.match(/^(\s*)([-*+])\s+\S/);
  if (bullet) {
    return { completion: `\n${bullet[1]}${bullet[2]} `, score: 0.56, truncated: false };
  }

  const numbered = currentLine.match(/^(\s*)(\d+)\.\s+\S/);
  if (numbered) {
    return {
      completion: `\n${numbered[1]}${Number(numbered[2]) + 1}. `,
      score: 0.56,
      truncated: false,
    };
  }

  const quote = currentLine.match(/^(\s*)>\s+\S/);
  if (quote) {
    return { completion: `\n${quote[1]}> `, score: 0.52, truncated: false };
  }

  return emptyCompletion();
}

export async function listMarkdownFiles(workspace: string, search: string): Promise<WriteFileEntry[]> {
  const root = resolveWorkspaceRoot(workspace);
  const out: WriteFileEntry[] = [];
  const needle = search.trim().toLowerCase();
  await walk(root, async (file) => {
    if (!MARKDOWN_EXT.includes(path.extname(file).toLowerCase())) return;
    const relative = toWorkspaceRelative(root, file);
    if (needle && !relative.toLowerCase().includes(needle)) return;
    const stat = await fs.stat(file);
    out.push({ path: relative, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  });
  out.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return out;
}

async function walk(dir: string, onFile: (file: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

export function resolveWritePath(workspace: string, relative: string): string {
  const root = resolveWorkspaceRoot(workspace);
  const resolved = path.resolve(root, relative);
  assertWithinWorkspace(root, resolved, relative);
  assertAllowedWorkspacePath(root, resolved, relative);
  return resolved;
}

function resolveWorkspaceRoot(workspace: string): string {
  if (!workspace.trim()) {
    throw new Error("Workspace path is required.");
  }
  return path.resolve(workspace);
}

function assertWithinWorkspace(root: string, resolved: string, relativePath: string): void {
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
}

function assertAllowedWorkspacePath(root: string, resolved: string, relativePath: string): void {
  const relative = path.relative(root, resolved);
  if (!relative) return;
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.some(isSkippedSegment)) {
    throw new Error(`Path is skipped by write service policy: ${relativePath}`);
  }
}

function toWorkspaceRelative(workspace: string, fullPath: string): string {
  return path.relative(workspace, fullPath).replaceAll(path.sep, "/");
}

function shouldSkipEntry(name: string): boolean {
  return isSkippedSegment(name);
}

function isSkippedSegment(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}

function emptyCompletion(): WriteCompleteResponse {
  return { completion: "", score: 0, truncated: false };
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
