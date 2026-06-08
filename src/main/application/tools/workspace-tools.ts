import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { AgentTool } from "../../domain/agent/types";
import {
  requireWorkspace,
  resolveWorkspacePathForAccess,
  shouldSkipEntry,
  toWorkspaceRelative,
} from "./workspace-policy.js";

const DEFAULT_LIST_LIMIT = 120;
const DEFAULT_SEARCH_LIMIT = 80;
const DEFAULT_READ_LIMIT_BYTES = 80_000;
const MAX_READ_LIMIT_BYTES = 240_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

export const listFilesTool: AgentTool = {
  metadata: {
    isReadOnly: true,
    category: "workspace",
  },
  definition: {
    name: "list_files",
    description:
      "List files and directories under the current workspace. Use this before reading unknown project structure.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory path. Defaults to the workspace root.",
        },
        max_entries: {
          type: "number",
          description: "Maximum entries to return. Defaults to 120.",
        },
      },
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const relativePath = optionalString(input.path) ?? ".";
    const limit = numberInRange(input.max_entries, 1, 500, DEFAULT_LIST_LIMIT);
    const directory = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) {
      throw new Error(`list_files path is not a directory: ${relativePath}`);
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => !entry.isSymbolicLink() && !shouldSkipEntry(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const visible = visibleEntries.slice(0, limit);
    const result = await Promise.all(
      visible.map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        const childStat = await fs.lstat(fullPath);
        return {
          name: entry.name,
          path: toWorkspaceRelative(workspace, fullPath),
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? childStat.size : undefined,
          modifiedAt: childStat.mtime.toISOString(),
        };
      }),
    );

    return JSON.stringify({
      path: toWorkspaceRelative(workspace, directory) || ".",
      entries: result,
      truncated: visibleEntries.length > limit,
    });
  },
};

export const readFileTool: AgentTool = {
  metadata: {
    isReadOnly: true,
    category: "workspace",
  },
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the current workspace. Use workspace-relative paths only.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to read.",
        },
        max_bytes: {
          type: "number",
          description: "Maximum bytes to read. Defaults to 80000.",
        },
        offset_bytes: {
          type: "number",
          description: "Byte offset to start reading from. Defaults to 0.",
        },
      },
      required: ["path"],
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const relativePath = requiredString(input.path, "read_file requires a string path.");
    const maxBytes = numberInRange(input.max_bytes, 1, MAX_READ_LIMIT_BYTES, DEFAULT_READ_LIMIT_BYTES);
    const offsetBytes = numberInRange(input.offset_bytes, 0, Number.MAX_SAFE_INTEGER, 0);
    const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`read_file path is not a file: ${relativePath}`);
    }
    if (offsetBytes > stat.size) {
      throw new Error(`read_file offset is beyond end of file: ${relativePath}`);
    }
    const readBytes = Math.min(maxBytes + 1, stat.size - offsetBytes);
    const buffer = Buffer.alloc(readBytes);
    const handle = await fs.open(filePath, "r");
    let bytesRead = 0;
    try {
      const result = await handle.read(buffer, 0, readBytes, offsetBytes);
      bytesRead = result.bytesRead;
    } finally {
      await handle.close();
    }
    const sliced = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    const content = sliced.toString("utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fileInspection = await inspectFile(filePath);
    if (fileInspection.containsNul) {
      throw new Error(`read_file path appears to be binary: ${relativePath}`);
    }
    const truncated = offsetBytes + bytesRead < stat.size || bytesRead > maxBytes;
    context.readState?.set(filePath, {
      content,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256,
      fullSha256: fileInspection.sha256,
      truncated,
      offsetBytes,
      bytesRead: sliced.byteLength,
    });
    return JSON.stringify({
      path: toWorkspaceRelative(workspace, filePath),
      content,
      bytes: stat.size,
      offsetBytes,
      bytesRead: sliced.byteLength,
      modifiedAt: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      sha256,
      fullSha256: fileInspection.sha256,
      truncated,
    });
  },
};

export const searchFilesTool: AgentTool = {
  metadata: {
    isReadOnly: true,
    category: "workspace",
  },
  definition: {
    name: "search_files",
    description:
      "Search UTF-8 text files under the current workspace for a literal query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Literal text to search for.",
        },
        path: {
          type: "string",
          description: "Optional workspace-relative directory or file to search.",
        },
        max_results: {
          type: "number",
          description: "Maximum matching lines to return. Defaults to 80.",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const query = requiredString(input.query, "search_files requires a string query.");
    const relativePath = optionalString(input.path) ?? ".";
    const limit = numberInRange(input.max_results, 1, 300, DEFAULT_SEARCH_LIMIT);
    const root = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
    const stat = await fs.stat(root);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`search_files path is not a file or directory: ${relativePath}`);
    }

    const results: Array<{ path: string; line: number; text: string }> = [];
    let skippedLargeFiles = 0;
    const searchFile = async (filePath: string): Promise<void> => {
      if (results.length >= limit) return;
      const fileStat = await fs.stat(filePath);
      if (fileStat.size > MAX_SEARCH_FILE_BYTES) {
        skippedLargeFiles += 1;
        return;
      }
      if (!looksTextFile(filePath)) {
        return;
      }
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.includes(query)) {
          results.push({
            path: toWorkspaceRelative(workspace, filePath),
            line: index + 1,
            text: line.trimEnd(),
          });
          if (results.length >= limit) break;
        }
      }
    };
    if (stat.isFile()) {
      await searchFile(root);
    } else {
      await walkTextFiles(root, searchFile);
    }

    return JSON.stringify({
      query,
      path: toWorkspaceRelative(workspace, root) || ".",
      results,
      skippedLargeFiles,
      truncated: results.length >= limit,
    });
  },
};

export function createWorkspaceTools(): AgentTool[] {
  return [listFilesTool, readFileTool, searchFilesTool];
}

async function walkTextFiles(
  directory: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || shouldSkipEntry(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkTextFiles(fullPath, onFile);
    } else if (entry.isFile() && looksTextFile(entry.name)) {
      await onFile(fullPath);
    }
  }
}

function looksTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [
    "",
    ".css",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mdx",
    ".mjs",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ].includes(ext);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

async function inspectFile(filePath: string): Promise<{ sha256: string; containsNul: boolean }> {
  const hash = createHash("sha256");
  let containsNul = false;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    if (!containsNul && buffer.includes(0)) {
      containsNul = true;
    }
  }
  return { sha256: hash.digest("hex"), containsNul };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}
