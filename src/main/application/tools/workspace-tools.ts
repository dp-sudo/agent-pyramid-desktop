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
import {
  createUtf8TextStreamValidator,
  decodeUtf8TextBuffer,
  decodeUtf8TextPrefix,
} from "./text-file.js";
import { MAX_SEARCH_FILE_BYTES } from "../constants.js";

const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 500;
const DEFAULT_LIST_LIMIT = 120;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 300;
const DEFAULT_SEARCH_LIMIT = 80;
const READ_LIMIT_MIN_BYTES = 1;
const MAX_READ_LIMIT_BYTES = 240_000;
const DEFAULT_READ_LIMIT_BYTES = 80_000;
const DEFAULT_READ_OFFSET_BYTES = 0;

const listFilesTool: AgentTool = {
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
          description:
            `Maximum entries to return. Defaults to ${DEFAULT_LIST_LIMIT}, maximum ${LIST_LIMIT_MAX}.`,
        },
      },
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const relativePath = optionalString(input.path, "path") ?? ".";
    const limit = numberInRange(
      input.max_entries,
      LIST_LIMIT_MIN,
      LIST_LIMIT_MAX,
      DEFAULT_LIST_LIMIT,
      "max_entries",
    );
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

const readFileTool: AgentTool = {
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
          description:
            `Maximum bytes to read. Defaults to ${DEFAULT_READ_LIMIT_BYTES}, maximum ${MAX_READ_LIMIT_BYTES}.`,
        },
        offset_bytes: {
          type: "number",
          description: `Byte offset to start reading from. Defaults to ${DEFAULT_READ_OFFSET_BYTES}.`,
        },
      },
      required: ["path"],
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const relativePath = requiredString(input.path, "read_file requires a string path.", "path");
    const maxBytes = numberInRange(
      input.max_bytes,
      READ_LIMIT_MIN_BYTES,
      MAX_READ_LIMIT_BYTES,
      DEFAULT_READ_LIMIT_BYTES,
      "max_bytes",
    );
    const offsetBytes = numberInRange(
      input.offset_bytes,
      DEFAULT_READ_OFFSET_BYTES,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_READ_OFFSET_BYTES,
      "offset_bytes",
    );
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
    const truncated = offsetBytes + bytesRead < stat.size || bytesRead > maxBytes;
    const decoded = truncated
      ? decodeUtf8TextPrefix(sliced, relativePath, "read_file path")
      : {
          content: decodeUtf8TextBuffer(sliced, relativePath, "read_file path"),
          bytesDecoded: sliced.byteLength,
        };
    if (sliced.byteLength > 0 && decoded.bytesDecoded === 0) {
      throw new Error(`read_file max_bytes ended before a complete UTF-8 character: ${relativePath}`);
    }
    const content = decoded.content;
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fileInspection = await inspectFile(filePath, relativePath);
    context.readState?.set(filePath, {
      content,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256,
      fullSha256: fileInspection.sha256,
      truncated,
      offsetBytes,
      bytesRead: decoded.bytesDecoded,
    });
    return JSON.stringify({
      path: toWorkspaceRelative(workspace, filePath),
      content,
      bytes: stat.size,
      offsetBytes,
      bytesRead: decoded.bytesDecoded,
      modifiedAt: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      sha256,
      fullSha256: fileInspection.sha256,
      truncated,
    });
  },
};

const searchFilesTool: AgentTool = {
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
          description:
            `Maximum matching lines to return. Defaults to ${DEFAULT_SEARCH_LIMIT}, maximum ${SEARCH_LIMIT_MAX}.`,
        },
      },
      required: ["query"],
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const query = requiredString(input.query, "search_files requires a string query.", "query");
    const relativePath = optionalString(input.path, "path") ?? ".";
    const limit = numberInRange(
      input.max_results,
      SEARCH_LIMIT_MIN,
      SEARCH_LIMIT_MAX,
      DEFAULT_SEARCH_LIMIT,
      "max_results",
    );
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
      const relativeFilePath = toWorkspaceRelative(workspace, filePath);
      const content = decodeUtf8TextBuffer(
        await fs.readFile(filePath),
        relativeFilePath,
        "search_files path",
      );
      const lines = content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.includes(query)) {
          results.push({
            path: relativeFilePath,
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

function requiredString(value: unknown, message: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error(`${name} cannot contain NUL bytes.`);
  }
  return value.trim();
}

async function inspectFile(
  filePath: string,
  relativePath: string,
): Promise<{ sha256: string }> {
  const hash = createHash("sha256");
  const textValidator = createUtf8TextStreamValidator(relativePath, "read_file path");
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    textValidator.push(buffer);
  }
  textValidator.finish();
  return { sha256: hash.digest("hex") };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${name} cannot contain NUL bytes.`);
  }
  return value.trim() || undefined;
}

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
