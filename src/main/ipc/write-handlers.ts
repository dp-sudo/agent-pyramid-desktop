import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import {
  WRITE_LIST_CHANNEL,
  WRITE_GET_CHANNEL,
  WRITE_PUT_CHANNEL,
  WRITE_COMPLETE_CHANNEL,
  WRITE_CREATE_CHANNEL,
  WRITE_RENAME_CHANNEL,
  WRITE_DELETE_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  IpcResult,
  WriteFileEntry,
  WriteGetRequest,
  WriteListRequest,
  WritePutRequest,
  WriteCompleteRequest,
  WriteCompleteResponse,
  WriteCreateRequest,
  WriteRenameRequest,
  WriteDeleteRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import { messageOfIpcError as messageOf } from "./ipc-result-handler.js";
import {
  decodeUtf8TextBuffer,
  openTextFileNoFollow,
  writeUtf8TextFileNoFollow,
} from "../application/tools/text-file.js";
import type { JsonlThreadStore } from "../persistence/index.js";
import {
  resolveWorkspacePathForAccess as resolveSharedWorkspacePathForAccess,
  resolveWorkspacePathLexically,
  resolveWorkspaceRoot,
  shouldSkipEntry,
  toWorkspaceRelative,
} from "../application/tools/workspace-policy.js";

const MARKDOWN_EXT = [".md", ".mdx", ".markdown"];
const WRITE_WORKSPACE_POLICY_OPTIONS = {
  skippedPathMessage: (relativePath: string) =>
    `Path is skipped by write service policy: ${relativePath}`,
};

export function registerWriteHandlers(store: JsonlThreadStore): void {
  // Write IPC is a renderer file-service boundary, not an agent tool surface.
  // Renderer requests carry only a thread id. The workspace root is resolved
  // from the main-owned thread record so compromised renderer code cannot pick
  // an arbitrary filesystem root and ask the Markdown service to operate there.
  ipcMain.handle(WRITE_LIST_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseWriteListRequest(request);
      const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
      const files = await listMarkdownFiles(workspace, parsed.search ?? "");
      return ok(files);
    } catch (error) {
      return err(IPC_ERROR_CODES.WRITE_LIST_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(WRITE_GET_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseWriteGetRequest(request);
      const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
      const content = await readMarkdownFileContent(workspace, parsed.path);
      return ok({ path: parsed.path, content });
    } catch (error) {
      return err(IPC_ERROR_CODES.WRITE_GET_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(WRITE_PUT_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseWritePutRequest(request);
      const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
      const bytes = await writeMarkdownFileContent(
        workspace,
        parsed.path,
        parsed.content,
      );
      return ok({ path: parsed.path, bytes });
    } catch (error) {
      return err(IPC_ERROR_CODES.WRITE_PUT_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(WRITE_CREATE_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseWriteCreateRequest(request);
      const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
      const bytes = await createMarkdownFileContent(
        workspace,
        parsed.path,
        parsed.content ?? "",
      );
      return ok({ path: parsed.path, content: parsed.content ?? "", bytes });
    } catch (error) {
      return err(IPC_ERROR_CODES.WRITE_CREATE_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(WRITE_RENAME_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseWriteRenameRequest(request);
      const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
      await renameMarkdownFile(workspace, parsed.path, parsed.newPath);
      return ok({ path: parsed.path, newPath: parsed.newPath });
    } catch (error) {
      return err(IPC_ERROR_CODES.WRITE_RENAME_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(WRITE_DELETE_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseWriteDeleteRequest(request);
      const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
      await deleteMarkdownFile(workspace, parsed.path);
      return ok({ path: parsed.path });
    } catch (error) {
      return err(IPC_ERROR_CODES.WRITE_DELETE_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(
    WRITE_COMPLETE_CHANNEL,
    async (_event, request: unknown): Promise<IpcResult<WriteCompleteResponse>> => {
      try {
        const parsed = parseWriteCompleteRequest(request);
        const workspace = await resolveWriteWorkspaceForThread(store, parsed.threadId);
        resolveWritePath(workspace, parsed.path);
        return ok(completeMarkdownInline(parsed));
      } catch (error) {
        return err(IPC_ERROR_CODES.WRITE_COMPLETE_FAILED, messageOf(error));
      }
    },
  );
}

export function parseWriteListRequest(request: unknown): WriteListRequest {
  const value = parseWriteRequestObject(request, "Write list request");
  const threadId = requiredString(value.threadId, "Write list threadId must be a string.");
  const search = optionalString(value.search, "Write list search must be a string.");
  return {
    threadId,
    ...(search !== undefined ? { search } : {}),
  };
}

export function parseWriteGetRequest(request: unknown): WriteGetRequest {
  const value = parseWriteRequestObject(request, "Write get request");
  return {
    threadId: requiredString(value.threadId, "Write get threadId must be a string."),
    path: requiredString(value.path, "Write get path must be a string."),
  };
}

export function parseWritePutRequest(request: unknown): WritePutRequest {
  const value = parseWriteRequestObject(request, "Write put request");
  return {
    threadId: requiredString(value.threadId, "Write put threadId must be a string."),
    path: requiredString(value.path, "Write put path must be a string."),
    content: requiredString(value.content, "Write put content must be a string."),
  };
}

export function parseWriteCreateRequest(request: unknown): WriteCreateRequest {
  const value = parseWriteRequestObject(request, "Write create request");
  const content = optionalString(value.content, "Write create content must be a string.");
  return {
    threadId: requiredString(value.threadId, "Write create threadId must be a string."),
    path: requiredString(value.path, "Write create path must be a string."),
    ...(content !== undefined ? { content } : {}),
  };
}

export function parseWriteRenameRequest(request: unknown): WriteRenameRequest {
  const value = parseWriteRequestObject(request, "Write rename request");
  return {
    threadId: requiredString(value.threadId, "Write rename threadId must be a string."),
    path: requiredString(value.path, "Write rename path must be a string."),
    newPath: requiredString(value.newPath, "Write rename newPath must be a string."),
  };
}

export function parseWriteDeleteRequest(request: unknown): WriteDeleteRequest {
  const value = parseWriteRequestObject(request, "Write delete request");
  return {
    threadId: requiredString(value.threadId, "Write delete threadId must be a string."),
    path: requiredString(value.path, "Write delete path must be a string."),
  };
}

export function parseWriteCompleteRequest(request: unknown): WriteCompleteRequest {
  const value = parseWriteRequestObject(request, "Write complete request");
  return {
    threadId: requiredString(value.threadId, "Write complete threadId must be a string."),
    path: requiredString(value.path, "Write complete path must be a string."),
    prefix: requiredString(value.prefix, "Write complete prefix must be a string."),
    suffix: requiredString(value.suffix, "Write complete suffix must be a string."),
  };
}

export async function resolveWriteWorkspaceForThread(
  store: JsonlThreadStore,
  threadId: string,
): Promise<string> {
  const thread = await store.getThread(threadId);
  if (!thread) {
    throw new Error(`Write thread was not found: ${threadId}`);
  }
  if (thread.mode !== "write") {
    throw new Error(`Write service requires a write-mode thread: ${threadId}`);
  }
  return thread.workspace;
}

function parseWriteRequestObject(
  request: unknown,
  name: string,
): Record<string, unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error(`${name} must be an object.`);
  }
  return request as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error(message.replace("must be a string.", "cannot contain NUL bytes."));
  }
  return value;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, message);
}

export async function resolveWritePathForAccess(
  workspace: string,
  relative: string,
  access: "read" | "write",
): Promise<string> {
  const resolved = await resolveSharedWorkspacePathForAccess(
    workspace,
    relative,
    access,
    WRITE_WORKSPACE_POLICY_OPTIONS,
  );
  assertMarkdownFilePath(relative);
  return resolved;
}

export async function readMarkdownFileContent(
  workspace: string,
  relativePath: string,
): Promise<string> {
  const fullPath = await resolveWritePathForAccess(workspace, relativePath, "read");
  const handle = await openTextFileNoFollow(fullPath, {
    label: "Write get",
    relativePath,
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Write get path is not a file: ${relativePath}`);
    }
    return decodeUtf8TextBuffer(
      await handle.readFile(),
      relativePath,
      "write.get path",
    );
  } finally {
    await handle.close();
  }
}

export async function writeMarkdownFileContent(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<number> {
  const fullPath = await resolveWritePathForAccess(workspace, relativePath, "write");
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const checkedFullPath = await resolveWritePathForAccess(workspace, relativePath, "write");
  if (path.resolve(checkedFullPath) !== path.resolve(fullPath)) {
    throw new Error(`Path changed before write: ${relativePath}`);
  }
  await writeUtf8TextFileNoFollow(fullPath, content, {
    label: "Write put",
    relativePath,
  });
  return Buffer.byteLength(content, "utf8");
}

export async function createMarkdownFileContent(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<number> {
  const fullPath = await resolveWritePathForAccess(workspace, relativePath, "write");
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const checkedFullPath = await resolveWritePathForAccess(workspace, relativePath, "write");
  if (path.resolve(checkedFullPath) !== path.resolve(fullPath)) {
    throw new Error(`Path changed before create: ${relativePath}`);
  }
  await writeUtf8TextFileNoFollow(fullPath, content, {
    exclusive: true,
    label: "Write create",
    relativePath,
  });
  return Buffer.byteLength(content, "utf8");
}

export async function renameMarkdownFile(
  workspace: string,
  currentRelativePath: string,
  nextRelativePath: string,
): Promise<void> {
  if (currentRelativePath === nextRelativePath) {
    throw new Error("Write rename source and target must be different.");
  }
  const currentFullPath = await resolveWritePathForAccess(
    workspace,
    currentRelativePath,
    "read",
  );
  const nextFullPath = await resolveWritePathForAccess(workspace, nextRelativePath, "write");
  await fs.mkdir(path.dirname(nextFullPath), { recursive: true });
  const checkedNextFullPath = await resolveWritePathForAccess(
    workspace,
    nextRelativePath,
    "write",
  );
  if (path.resolve(checkedNextFullPath) !== path.resolve(nextFullPath)) {
    throw new Error(`Path changed before rename: ${nextRelativePath}`);
  }
  const source = await openTextFileNoFollow(currentFullPath, {
    label: "Write rename source",
    relativePath: currentRelativePath,
  });
  let content: string;
  try {
    const stat = await source.stat();
    if (!stat.isFile()) {
      throw new Error(`Write rename source is not a file: ${currentRelativePath}`);
    }
    content = decodeUtf8TextBuffer(
      await source.readFile(),
      currentRelativePath,
      "write.rename source",
    );
  } finally {
    await source.close();
  }
  await writeUtf8TextFileNoFollow(nextFullPath, content, {
    exclusive: true,
    label: "Write rename",
    relativePath: nextRelativePath,
  });
  try {
    await fs.rm(currentFullPath, { force: false });
  } catch (error) {
    try {
      // Rename is implemented as copy-then-delete to preserve the no-follow
      // source read and exclusive target write boundaries. If deleting the
      // source fails, remove the target created by this attempt so callers do
      // not observe a failed rename as a duplicate document.
      const rollbackTarget = await resolveWritePathForAccess(
        workspace,
        nextRelativePath,
        "write",
      );
      if (path.resolve(rollbackTarget) !== path.resolve(nextFullPath)) {
        throw new Error(`Path changed before rename rollback: ${nextRelativePath}`);
      }
      await fs.rm(rollbackTarget, { force: true });
    } catch (rollbackError) {
      throw new Error(
        `Write rename failed: ${messageOf(error)}; rollback failed: ${messageOf(rollbackError)}`,
      );
    }
    throw error;
  }
}

export async function deleteMarkdownFile(
  workspace: string,
  relativePath: string,
): Promise<void> {
  const fullPath = await resolveWritePathForAccess(workspace, relativePath, "read");
  await fs.rm(fullPath, { force: false });
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
  const resolved = resolveWorkspacePathLexically(
    workspace,
    relative,
    WRITE_WORKSPACE_POLICY_OPTIONS,
  );
  assertMarkdownFilePath(relative);
  return resolved;
}

function assertMarkdownFilePath(relativePath: string): void {
  if (!MARKDOWN_EXT.includes(path.extname(relativePath).toLowerCase())) {
    throw new Error(`Write service only supports Markdown files: ${relativePath}`);
  }
}

function emptyCompletion(): WriteCompleteResponse {
  return { completion: "", score: 0, truncated: false };
}
