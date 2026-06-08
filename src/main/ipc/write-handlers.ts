import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import {
  WRITE_ACTION_CHANNEL,
  WRITE_CREATE_CHANNEL,
  WRITE_DELETE_CHANNEL,
  WRITE_EXPORT_CHANNEL,
  WRITE_LIST_CHANNEL,
  WRITE_GET_CHANNEL,
  WRITE_MEDIA_CHANNEL,
  WRITE_MEMORY_CHANNEL,
  WRITE_PUT_CHANNEL,
  WRITE_COMPLETE_CHANNEL,
  WRITE_RENAME_CHANNEL,
  WRITE_TREE_CHANNEL,
  WRITE_WATCH_CHANNEL,
} from "../../shared/ipc.js";
import type {
  WriteAction,
  WriteActionRequest,
  WriteActionResponse,
  WriteCreateRequest,
  WriteDeleteRequest,
  WriteExportRequest,
  WriteExportResponse,
  WriteFileEntry,
  WriteFileMutationResponse,
  WriteGetRequest,
  WriteGetResponse,
  WriteListRequest,
  WriteMediaReference,
  WriteMediaRequest,
  WriteMediaResponse,
  WriteMemoryEvidence,
  WriteMemoryRequest,
  WriteMemoryResponse,
  WritePutRequest,
  WriteRenameRequest,
  WriteTreeNode,
  WriteWatchRequest,
  WriteWatchResponse,
  WriteCompleteRequest,
  WriteCompleteResponse,
} from "../../shared/agent-contracts.js";
import { err, isWriteAction, ok } from "../../shared/agent-contracts.js";
import { decodeUtf8TextBuffer } from "../application/tools/text-file.js";

const MARKDOWN_EXT = [".md", ".mdx", ".markdown"];
const WRITE_MEMORY_DEFAULT_LIMIT = 5;
const WRITE_MEMORY_MAX_LIMIT = 12;
const WRITE_MEMORY_SNIPPET_CHARS = 420;
const WRITE_LARGE_FILE_BYTES = 1_000_000;
const WRITE_MEDIA_PREVIEW_MAX_BYTES = 2_000_000;
const WRITE_MEDIA_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".pytest_cache",
  ".vscode",
  "DeepSeek",
  "__test_logs__",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "tmp",
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
      return ok(await getMarkdownFileForEdit(request.workspace, request.path));
    } catch (error) {
      return err("WRITE_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_PUT_CHANNEL, async (_event, request: WritePutRequest) => {
    try {
      const fullPath = await resolveWritePathForAccess(request.workspace, request.path, "write");
      await assertWritableMarkdownSize(fullPath, request.path);
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

  ipcMain.handle(
    WRITE_ACTION_CHANNEL,
    async (_event, request: WriteActionRequest): Promise<{ ok: true; value: WriteActionResponse } | { ok: false; code: string; message: string }> => {
      try {
        resolveWritePath(request.workspace, request.path);
        return ok({ action: parseWriteAction(request) });
      } catch (error) {
        return err("WRITE_ACTION_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(
    WRITE_MEMORY_CHANNEL,
    async (_event, request: WriteMemoryRequest): Promise<{ ok: true; value: WriteMemoryResponse } | { ok: false; code: string; message: string }> => {
      try {
        return ok(await retrieveWriteMemory(request));
      } catch (error) {
        return err("WRITE_MEMORY_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(WRITE_TREE_CHANNEL, async (_event, request: WriteListRequest) => {
    try {
      return ok(await buildWriteTree(request.workspace, request.search ?? ""));
    } catch (error) {
      return err("WRITE_TREE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_CREATE_CHANNEL, async (_event, request: WriteCreateRequest) => {
    try {
      return ok(await createMarkdownFile(request));
    } catch (error) {
      return err("WRITE_CREATE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_RENAME_CHANNEL, async (_event, request: WriteRenameRequest) => {
    try {
      return ok(await renameMarkdownFile(request));
    } catch (error) {
      return err("WRITE_RENAME_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_DELETE_CHANNEL, async (_event, request: WriteDeleteRequest) => {
    try {
      return ok(await deleteMarkdownFile(request));
    } catch (error) {
      return err("WRITE_DELETE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_EXPORT_CHANNEL, async (_event, request: WriteExportRequest) => {
    try {
      return ok(await exportMarkdownFile(request));
    } catch (error) {
      return err("WRITE_EXPORT_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_MEDIA_CHANNEL, async (_event, request: WriteMediaRequest) => {
    try {
      return ok(await resolveMarkdownMediaReferences(request));
    } catch (error) {
      return err("WRITE_MEDIA_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_WATCH_CHANNEL, async (_event, request: WriteWatchRequest) => {
    try {
      return ok(await checkMarkdownFileChange(request));
    } catch (error) {
      return err("WRITE_WATCH_FAILED", messageOf(error));
    }
  });
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

export async function readMarkdownFileContent(
  workspace: string,
  relativePath: string,
): Promise<string> {
  const fullPath = await resolveWritePathForAccess(workspace, relativePath, "read");
  return decodeUtf8TextBuffer(
    await fs.readFile(fullPath),
    relativePath,
    "write.get path",
  );
}

export async function getMarkdownFileForEdit(
  workspace: string,
  relativePath: string,
): Promise<WriteGetResponse> {
  const fullPath = await resolveWritePathForAccess(workspace, relativePath, "read");
  const stat = await fs.stat(fullPath);
  const largeFile = stat.size > WRITE_LARGE_FILE_BYTES;
  if (largeFile) {
    return {
      path: relativePath,
      content: "",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      readonly: true,
      reason: `File is larger than ${WRITE_LARGE_FILE_BYTES} bytes.`,
    };
  }
  return {
    path: relativePath,
    content: decodeUtf8TextBuffer(
      await fs.readFile(fullPath),
      relativePath,
      "write.get path",
    ),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    readonly: false,
  };
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

export function parseWriteAction(request: WriteActionRequest): WriteAction {
  const parsed = parseJsonActionPayload(request.rawAction);
  if (!isWriteAction(parsed)) {
    throw new Error("Write action payload is not a supported Write action.");
  }
  validateWriteActionForRequest(parsed, request);
  return parsed;
}

export async function listMarkdownFiles(workspace: string, search: string): Promise<WriteFileEntry[]> {
  const root = resolveWorkspaceRoot(workspace);
  const out: WriteFileEntry[] = [];
  const needle = search.trim().toLowerCase();
  await walk(root, async (file) => {
    if (!MARKDOWN_EXT.includes(path.extname(file).toLowerCase())) return;
    const relative = toWorkspaceRelative(root, file);
    if (needle && !relative.toLowerCase().includes(needle)) return;
    const stat = await statMarkdownCandidate(file, relative);
    if (!stat) return;
    out.push(toWriteFileEntry(relative, stat));
  });
  out.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return out;
}

export async function buildWriteTree(workspace: string, search: string): Promise<WriteTreeNode[]> {
  const files = await listMarkdownFiles(workspace, search);
  const rootNodes: WriteTreeNode[] = [];
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/");
    let level = rootNodes;
    let currentPath = "";
    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      if (isFile) {
        level.push({
          kind: "file",
          name: segment,
          path: file.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          readonly: file.readonly,
          ...(file.reason ? { reason: file.reason } : {}),
        });
        continue;
      }
      let directory = level.find(
        (node) => node.kind === "directory" && node.path === currentPath,
      );
      if (!directory) {
        directory = {
          kind: "directory",
          name: segment,
          path: currentPath,
          children: [],
        };
        level.push(directory);
      }
      level = directory.children ?? [];
    }
  }
  sortWriteTree(rootNodes);
  return rootNodes;
}

export async function createMarkdownFile(
  request: WriteCreateRequest,
): Promise<WriteFileMutationResponse> {
  const fullPath = await resolveWritePathForAccess(request.workspace, request.path, "write");
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, request.content ?? "", { encoding: "utf8", flag: "wx" });
  const stat = await fs.stat(fullPath);
  return toWriteFileMutationResponse(request.path, stat);
}

export async function renameMarkdownFile(
  request: WriteRenameRequest,
): Promise<WriteFileMutationResponse> {
  const sourcePath = await resolveWritePathForAccess(request.workspace, request.fromPath, "read");
  const targetPath = await resolveWritePathForAccess(request.workspace, request.toPath, "write");
  await assertTargetDoesNotExist(targetPath, request.toPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rename(sourcePath, targetPath);
  const stat = await fs.stat(targetPath);
  return toWriteFileMutationResponse(request.toPath, stat);
}

export async function deleteMarkdownFile(
  request: WriteDeleteRequest,
): Promise<{ path: string }> {
  const fullPath = await resolveWritePathForAccess(request.workspace, request.path, "read");
  await fs.unlink(fullPath);
  return { path: request.path };
}

export async function exportMarkdownFile(
  request: WriteExportRequest,
): Promise<WriteExportResponse> {
  return {
    path: request.path,
    suggestedName: path.basename(request.path),
    markdown: await readMarkdownFileContent(request.workspace, request.path),
  };
}

export async function resolveMarkdownMediaReferences(
  request: WriteMediaRequest,
): Promise<WriteMediaResponse> {
  resolveWritePath(request.workspace, request.path);
  const references: WriteMediaReference[] = [];
  const mediaPattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of request.content.matchAll(mediaPattern)) {
    const alt = match[1] ?? "";
    const rawTarget = match[2] ?? "";
    const external = isExternalMediaTarget(rawTarget);
    if (external) {
      references.push({ alt, rawTarget, path: null, exists: false, external });
      continue;
    }
    const normalized = path.posix.normalize(
      path.posix.join(path.posix.dirname(request.path), decodeURIComponent(rawTarget)),
    );
    const resolved = resolveWorkspacePathForMedia(request.workspace, normalized);
    const preview = await createMediaPreview(resolved);
    references.push({
      alt,
      rawTarget,
      path: normalized,
      exists: preview.exists,
      external,
      ...(preview.mimeType ? { mimeType: preview.mimeType } : {}),
      ...(preview.dataUrl ? { dataUrl: preview.dataUrl } : {}),
      ...(preview.reason ? { previewUnavailableReason: preview.reason } : {}),
    });
  }
  return { path: request.path, references };
}

export async function checkMarkdownFileChange(
  request: WriteWatchRequest,
): Promise<WriteWatchResponse> {
  try {
    const fullPath = await resolveWritePathForAccess(request.workspace, request.path, "read");
    const stat = await fs.stat(fullPath);
    const modifiedAt = stat.mtime.toISOString();
    const changed =
      (request.knownModifiedAt !== undefined && request.knownModifiedAt !== modifiedAt) ||
      (request.knownSize !== undefined && request.knownSize !== stat.size);
    return {
      path: request.path,
      exists: true,
      changed,
      size: stat.size,
      modifiedAt,
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { path: request.path, exists: false, changed: true };
    }
    throw error;
  }
}

export async function retrieveWriteMemory(
  request: WriteMemoryRequest,
): Promise<WriteMemoryResponse> {
  const query = request.query.trim();
  if (!query) return { query, evidence: [] };
  const limit = clampMemoryLimit(request.limit);
  const files = await listMarkdownFiles(request.workspace, "");
  const queryTokens = tokenizeForWriteMemory(query);
  if (queryTokens.length === 0) return { query, evidence: [] };

  const evidence: WriteMemoryEvidence[] = [];
  for (const file of files) {
    const content = await readMarkdownFileContent(request.workspace, file.path);
    const segments = segmentWriteMemoryContent(content);
    for (const segment of segments) {
      const score = scoreWriteMemorySegment(queryTokens, segment.text, file.path === request.activePath);
      if (score <= 0) continue;
      evidence.push({
        id: `${file.path}:${segment.start}:${segment.end}`,
        path: file.path,
        start: segment.start,
        end: segment.end,
        score,
        snippet: segment.text,
      });
    }
  }

  evidence.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { query, evidence: evidence.slice(0, limit) };
}

async function walk(
  dir: string,
  onFile: (file: string) => Promise<void>,
  isRoot = true,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!isRoot && isSkippableScanError(error)) {
      warnSkippedWriteScanPath(dir, error);
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile, false);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

async function statMarkdownCandidate(file: string, relativePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (isSkippableScanError(error)) {
      warnSkippedWriteScanPath(relativePath, error);
      return null;
    }
    throw error;
  }
}

function clampMemoryLimit(limit: number | undefined): number {
  if (limit === undefined) return WRITE_MEMORY_DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return WRITE_MEMORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(WRITE_MEMORY_MAX_LIMIT, Math.floor(limit)));
}

function segmentWriteMemoryContent(content: string): Array<{ start: number; end: number; text: string }> {
  const paragraphs: Array<{ start: number; end: number; text: string }> = [];
  const pattern = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  for (const match of content.matchAll(pattern)) {
    const text = match[0].trim();
    if (!text) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (text.length <= WRITE_MEMORY_SNIPPET_CHARS) {
      paragraphs.push({ start, end, text });
      continue;
    }
    paragraphs.push({
      start,
      end: Math.min(end, start + WRITE_MEMORY_SNIPPET_CHARS),
      text: `${text.slice(0, WRITE_MEMORY_SNIPPET_CHARS).trimEnd()}…`,
    });
  }
  return paragraphs;
}

function scoreWriteMemorySegment(
  queryTokens: string[],
  segmentText: string,
  activeFile: boolean,
): number {
  const segmentTokens = tokenizeForWriteMemory(segmentText);
  if (segmentTokens.length === 0) return 0;
  const segmentTokenCounts = new Map<string, number>();
  for (const token of segmentTokens) {
    segmentTokenCounts.set(token, (segmentTokenCounts.get(token) ?? 0) + 1);
  }
  let matches = 0;
  let frequencyScore = 0;
  for (const token of new Set(queryTokens)) {
    const count = segmentTokenCounts.get(token) ?? 0;
    if (count === 0) continue;
    matches += 1;
    frequencyScore += count / (count + 1.2);
  }
  if (matches === 0) return 0;
  const coverage = matches / new Set(queryTokens).size;
  const lengthPenalty = Math.sqrt(segmentTokens.length);
  const activeBoost = activeFile ? 0.18 : 0;
  return Math.round((coverage + frequencyScore / lengthPenalty + activeBoost) * 1000) / 1000;
}

function tokenizeForWriteMemory(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu);
  return Array.from(new Set(tokens ?? [])).filter((token) => token.length >= 2);
}

function toWriteFileEntry(relative: string, stat: { size: number; mtime: Date }): WriteFileEntry {
  const readonly = stat.size > WRITE_LARGE_FILE_BYTES;
  return {
    path: relative,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    readonly,
    ...(readonly ? { reason: `File is larger than ${WRITE_LARGE_FILE_BYTES} bytes.` } : {}),
  };
}

function toWriteFileMutationResponse(
  relative: string,
  stat: { size: number; mtime: Date },
): WriteFileMutationResponse {
  return {
    path: relative,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function sortWriteTree(nodes: WriteTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortWriteTree(node.children);
  }
}

async function assertWritableMarkdownSize(fullPath: string, relativePath: string): Promise<void> {
  try {
    const stat = await fs.stat(fullPath);
    if (stat.size > WRITE_LARGE_FILE_BYTES) {
      throw new Error(`Large Markdown files are read-only in Write mode: ${relativePath}`);
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function assertTargetDoesNotExist(fullPath: string, relativePath: string): Promise<void> {
  try {
    await fs.lstat(fullPath);
    throw new Error(`Target already exists: ${relativePath}`);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return;
    throw error;
  }
}

function resolveWorkspacePathForMedia(workspace: string, relative: string): string {
  const root = resolveWorkspaceRoot(workspace);
  const resolved = path.resolve(root, relative);
  assertWithinWorkspace(root, resolved, relative);
  assertAllowedWorkspacePath(root, resolved, relative);
  return resolved;
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.stat(fullPath);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function createMediaPreview(
  fullPath: string,
): Promise<{ exists: boolean; mimeType?: string; dataUrl?: string; reason?: string }> {
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return { exists: true, reason: "Media target is not a file." };
    const mimeType = WRITE_MEDIA_MIME_TYPES.get(path.extname(fullPath).toLowerCase());
    if (!mimeType) return { exists: true, reason: "Media type is not previewable." };
    if (stat.size > WRITE_MEDIA_PREVIEW_MAX_BYTES) {
      return { exists: true, mimeType, reason: "Media file is too large to preview." };
    }
    const data = await fs.readFile(fullPath);
    return {
      exists: true,
      mimeType,
      dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return { exists: false };
    throw error;
  }
}

function isExternalMediaTarget(rawTarget: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(rawTarget) ||
    rawTarget.startsWith("data:") ||
    rawTarget.startsWith("#");
}

export function resolveWritePath(workspace: string, relative: string): string {
  const root = resolveWorkspaceRoot(workspace);
  const resolved = path.resolve(root, relative);
  assertWithinWorkspace(root, resolved, relative);
  assertAllowedWorkspacePath(root, resolved, relative);
  assertMarkdownFilePath(relative);
  return resolved;
}

function resolveWorkspaceRoot(workspace: string): string {
  if (!workspace.trim()) {
    throw new Error("Workspace path is required.");
  }
  if (!path.isAbsolute(workspace.trim())) {
    throw new Error("Workspace path must be absolute.");
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

function isSkippableScanError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== undefined && ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(code);
}

function warnSkippedWriteScanPath(target: string, error: unknown): void {
  console.warn(`[write] skipped workspace scan path: ${target}: ${messageOf(error)}`);
}

function assertMarkdownFilePath(relativePath: string): void {
  if (!MARKDOWN_EXT.includes(path.extname(relativePath).toLowerCase())) {
    throw new Error(`Write service only supports Markdown files: ${relativePath}`);
  }
}

function emptyCompletion(): WriteCompleteResponse {
  return { completion: "", score: 0, truncated: false };
}

function parseJsonActionPayload(rawAction: string): unknown {
  const source = extractJsonPayload(rawAction).trim();
  if (!source) {
    throw new Error("Write action payload is empty.");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Write action payload is not valid JSON: ${messageOf(error)}`);
  }
}

function extractJsonPayload(rawAction: string): string {
  const fenced = rawAction.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1] ?? rawAction;
}

function validateWriteActionForRequest(action: WriteAction, request: WriteActionRequest): void {
  if (action.kind === "write:assistant-context") {
    if (action.path !== null && action.path !== request.path) {
      throw new Error(`Write action path does not match request path: ${action.path}`);
    }
    return;
  }
  if (action.path !== request.path) {
    throw new Error(`Write action path does not match request path: ${action.path}`);
  }
  if (action.kind === "write:inline-complete") {
    if (!Number.isInteger(action.cursor) || action.cursor < 0) {
      throw new Error("Write inline completion cursor must be a non-negative integer.");
    }
    if (action.score < 0 || action.score > 1) {
      throw new Error("Write inline completion score must be between 0 and 1.");
    }
    return;
  }
  if (action.scope.path !== request.path) {
    throw new Error(`Write inline edit scope path does not match request path: ${action.scope.path}`);
  }
  if (
    !Number.isInteger(action.scope.start) ||
    !Number.isInteger(action.scope.end) ||
    action.scope.start < 0 ||
    action.scope.end < action.scope.start
  ) {
    throw new Error("Write inline edit scope must use a valid non-negative range.");
  }
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
