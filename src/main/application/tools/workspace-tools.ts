import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "../../domain/agent/types";

const DEFAULT_LIST_LIMIT = 120;
const DEFAULT_SEARCH_LIMIT = 80;
const DEFAULT_READ_LIMIT_BYTES = 80_000;
const MAX_READ_LIMIT_BYTES = 240_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "DeepSeek",
  "dist",
  "node_modules",
  "out",
]);

export const listFilesTool: AgentTool = {
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
    const directory = await resolveReadablePath(workspace, relativePath);
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
      },
      required: ["path"],
    },
  },
  async execute(input, context) {
    const workspace = requireWorkspace(context);
    const relativePath = requiredString(input.path, "read_file requires a string path.");
    const maxBytes = numberInRange(input.max_bytes, 1, MAX_READ_LIMIT_BYTES, DEFAULT_READ_LIMIT_BYTES);
    const filePath = await resolveReadablePath(workspace, relativePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`read_file path is not a file: ${relativePath}`);
    }
    const readBytes = Math.min(maxBytes + 1, stat.size);
    const buffer = Buffer.alloc(readBytes);
    const handle = await fs.open(filePath, "r");
    let bytesRead = 0;
    try {
      const result = await handle.read(buffer, 0, readBytes, 0);
      bytesRead = result.bytesRead;
    } finally {
      await handle.close();
    }
    const sliced = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    return JSON.stringify({
      path: toWorkspaceRelative(workspace, filePath),
      content: sliced.toString("utf8"),
      bytes: stat.size,
      truncated: bytesRead > maxBytes || stat.size > maxBytes,
    });
  },
};

export const searchFilesTool: AgentTool = {
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
    const root = await resolveReadablePath(workspace, relativePath);
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

function requireWorkspace(context: AgentToolContext): string {
  if (!context.workspace?.trim()) {
    throw new Error("Workspace tools require an active thread workspace.");
  }
  return path.resolve(context.workspace);
}

async function resolveReadablePath(workspace: string, relativePath: string): Promise<string> {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, relativePath);
  assertWithinWorkspace(root, resolved, relativePath);
  assertAllowedWorkspacePath(root, resolved, relativePath);

  const realRoot = await fs.realpath(root);
  const realResolved = await fs.realpath(resolved);
  assertWithinWorkspace(realRoot, realResolved, relativePath);
  assertAllowedWorkspacePath(realRoot, realResolved, relativePath);
  return resolved;
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
    throw new Error(`Path is skipped by workspace tool policy: ${relativePath}`);
  }
}

function toWorkspaceRelative(workspace: string, fullPath: string): string {
  return path.relative(workspace, fullPath).replaceAll(path.sep, "/");
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

function shouldSkipEntry(name: string): boolean {
  return isSkippedSegment(name);
}

function isSkippedSegment(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
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
