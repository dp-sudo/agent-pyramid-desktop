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
      const fullPath = resolveSafe(request.workspace, request.path);
      const content = await fs.readFile(fullPath, "utf8");
      return ok({ path: request.path, content });
    } catch (error) {
      return err("WRITE_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(WRITE_PUT_CHANNEL, async (_event, request: WritePutRequest) => {
    try {
      const fullPath = resolveSafe(request.workspace, request.path);
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
      // The local inline-completion service is intentionally a stub for
      // the initial implementation. The renderer falls back to a
      // client-side heuristic (next-sentence suggestion) when this
      // returns a 0.0 score, see chat store `completeInline` action.
      const trimmedPrefix = request.prefix.trim();
      if (trimmedPrefix.length < 12) {
        return ok({ completion: "", score: 0, truncated: false });
      }
      return ok({ completion: "", score: 0, truncated: false });
    },
  );
}

async function listMarkdownFiles(workspace: string, search: string): Promise<WriteFileEntry[]> {
  const out: WriteFileEntry[] = [];
  const needle = search.trim().toLowerCase();
  await walk(workspace, async (file) => {
    if (!MARKDOWN_EXT.includes(path.extname(file).toLowerCase())) return;
    const relative = path.relative(workspace, file).replaceAll("\\", "/");
    if (needle && !relative.toLowerCase().includes(needle)) return;
    const stat = await fs.stat(file);
    out.push({ path: relative, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  });
  out.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return out;
}

async function walk(dir: string, onFile: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

function resolveSafe(workspace: string, relative: string): string {
  const normalized = path
    .resolve(workspace, relative)
    .replaceAll("\\", "/");
  const workspaceNormalized = path.resolve(workspace).replaceAll("\\", "/") + "/";
  if (!normalized.startsWith(workspaceNormalized) && normalized !== workspaceNormalized.slice(0, -1)) {
    throw new Error("Path escapes workspace");
  }
  return normalized;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
