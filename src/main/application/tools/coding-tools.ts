import { promises as fs, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../../domain/agent/types";
import {
  requireWorkspace,
  resolveWorkspacePathForAccess,
  toWorkspaceRelative,
} from "./workspace-policy.js";

const MAX_EDIT_FILE_BYTES = 1_000_000;

export interface FileDiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

export interface FileDiffPreview {
  kind: "file_diff";
  path: string;
  operation: "create" | "update";
  added: number;
  removed: number;
  lines: FileDiffLine[];
}

export interface FileChangeResult {
  path: string;
  operation: "create" | "update";
  bytes: number;
  modifiedAt: string;
  mtimeMs: number;
  sha256: string;
  diff: FileDiffPreview;
}

export function createCodingTools(): AgentTool[] {
  return [editFileTool, writeFileTool];
}

export const editFileTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "edit_file",
    description:
      "Edit a UTF-8 workspace text file by replacing an exact old_string with new_string. Read the file first and provide enough context for a unique match unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to edit.",
        },
        old_string: {
          type: "string",
          description: "Exact text currently in the file.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description: "Set true only when every occurrence should be replaced.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async preview(input, context) {
    const change = await prepareEdit(input, context);
    return change.diff;
  },
  async execute(input, context) {
    const change = await prepareEdit(input, context);
    const committed = await writePreparedChange(change, context);
    return toToolResult("edit_file", committed);
  },
};

export const writeFileTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "write_file",
    description:
      "Create or replace a UTF-8 workspace text file. For existing files, read the file first so the write can be checked against the latest content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to write.",
        },
        content: {
          type: "string",
          description: "Complete file content to write.",
        },
        create_only: {
          type: "boolean",
          description: "If true, fail when the file already exists.",
        },
        overwrite: {
          type: "boolean",
          description: "Set true when intentionally replacing an existing file.",
        },
      },
      required: ["path", "content"],
    },
  },
  async preview(input, context) {
    const change = await prepareWrite(input, context);
    return change.diff;
  },
  async execute(input, context) {
    const change = await prepareWrite(input, context);
    const committed = await writePreparedChange(change, context);
    return toToolResult("write_file", committed);
  },
};

interface PreparedFileChange extends FileChangeResult {
  filePath: string;
  nextContent: string;
}

async function prepareEdit(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredString(input.path, "edit_file requires a string path.");
  const oldString = requiredRawString(input.old_string, "edit_file requires old_string.");
  const newString = requiredRawString(input.new_string, "edit_file requires new_string.");
  const replaceAll = optionalBoolean(input.replace_all, false, "replace_all must be a boolean.");
  if (oldString === newString) {
    throw new Error("edit_file old_string and new_string are identical.");
  }
  if (!oldString) {
    throw new Error("edit_file requires a non-empty old_string. Use write_file to create files.");
  }

  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  const { content, stat } = await readEditableTextFile(filePath, relativePath);
  assertFreshRead(context, filePath, content, stat);
  const matches = countOccurrences(content, oldString);
  if (matches === 0) {
    throw new Error(`edit_file old_string was not found in ${relativePath}.`);
  }
  if (matches > 1 && !replaceAll) {
    throw new Error(
      `edit_file found ${matches} matches in ${relativePath}. Provide more context or set replace_all to true.`,
    );
  }

  const nextContent = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  return buildPreparedChange(workspace, filePath, content, nextContent, "update");
}

async function prepareWrite(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredString(input.path, "write_file requires a string path.");
  const content = requiredRawString(input.content, "write_file requires content.");
  const createOnly = optionalBoolean(input.create_only, false, "create_only must be a boolean.");
  const overwrite = optionalBoolean(input.overwrite, false, "overwrite must be a boolean.");
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "write");
  let original = "";
  let operation: FileChangeResult["operation"] = "create";

  try {
    const { content: currentContent, stat } = await readEditableTextFile(filePath, relativePath);
    if (createOnly) {
      throw new Error(`write_file create_only is true but file already exists: ${relativePath}`);
    }
    if (!overwrite) {
      throw new Error(`write_file requires overwrite: true for existing file ${relativePath}.`);
    }
    assertFreshRead(context, filePath, currentContent, stat);
    original = currentContent;
    operation = "update";
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  return buildPreparedChange(workspace, filePath, original, content, operation);
}

async function writePreparedChange(
  change: PreparedFileChange,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const { filePath, nextContent } = change;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextContent, "utf8");
  const stat = await fs.stat(filePath);
  const contentHash = sha256(nextContent);
  context.readState?.set(filePath, {
    content: nextContent,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: contentHash,
    truncated: false,
  });
  return {
    ...change,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    sha256: contentHash,
  };
}

async function readEditableTextFile(
  filePath: string,
  relativePath: string,
): Promise<{ content: string; stat: Stats }> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${relativePath}`);
  }
  if (stat.size > MAX_EDIT_FILE_BYTES) {
    throw new Error(`File is too large to edit: ${relativePath}`);
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    throw new Error(`File appears to be binary: ${relativePath}`);
  }
  return {
    content: buffer.toString("utf8"),
    stat,
  };
}

function assertFreshRead(
  context: AgentToolContext,
  filePath: string,
  content: string,
  stat: Stats,
): void {
  const readState = context.readState?.get(filePath);
  if (!readState) {
    throw new Error("Read the file with read_file before attempting to edit or overwrite it.");
  }
  if (readState.truncated) {
    throw new Error("The last read_file result was truncated. Read the complete file before writing.");
  }
  if (sha256(content) !== readState.sha256) {
    throw new Error("File has been modified since it was read. Read it again before writing.");
  }
}

function buildPreparedChange(
  workspace: string,
  filePath: string,
  originalContent: string,
  nextContent: string,
  operation: FileChangeResult["operation"],
): PreparedFileChange {
  const hash = sha256(nextContent);
  const diff = buildFileDiff(
    toWorkspaceRelative(workspace, filePath),
    originalContent,
    nextContent,
    operation,
  );
  return {
    filePath,
    nextContent,
    path: diff.path,
    operation,
    bytes: Buffer.byteLength(nextContent, "utf8"),
    modifiedAt: new Date().toISOString(),
    mtimeMs: 0,
    sha256: hash,
    diff,
  };
}

function buildFileDiff(
  relativePath: string,
  originalContent: string,
  nextContent: string,
  operation: FileDiffPreview["operation"],
): FileDiffPreview {
  const originalLines = splitLines(originalContent);
  const nextLines = splitLines(nextContent);
  const prefixLength = commonPrefixLength(originalLines, nextLines);
  const suffixLength = commonSuffixLength(originalLines, nextLines, prefixLength);
  const originalMiddle = originalLines.slice(prefixLength, originalLines.length - suffixLength);
  const nextMiddle = nextLines.slice(prefixLength, nextLines.length - suffixLength);
  const beforeContext = originalLines.slice(Math.max(0, prefixLength - 3), prefixLength);
  const afterContext = originalLines.slice(
    originalLines.length - suffixLength,
    Math.min(originalLines.length, originalLines.length - suffixLength + 3),
  );
  return {
    kind: "file_diff",
    path: relativePath,
    operation,
    removed: originalMiddle.length,
    added: nextMiddle.length,
    lines: [
      ...beforeContext.map((text) => ({ type: "context" as const, text })),
      ...originalMiddle.map((text) => ({ type: "removed" as const, text })),
      ...nextMiddle.map((text) => ({ type: "added" as const, text })),
      ...afterContext.map((text) => ({ type: "context" as const, text })),
    ],
  };
}

function toToolResult(toolName: string, change: PreparedFileChange): AgentToolResult {
  const displayResult: FileChangeResult = {
    path: change.path,
    operation: change.operation,
    bytes: change.bytes,
    modifiedAt: change.modifiedAt,
    mtimeMs: change.mtimeMs,
    sha256: change.sha256,
    diff: change.diff,
  };
  return {
    toolCallId: "",
    name: toolName,
    content: JSON.stringify({
      path: change.path,
      operation: change.operation,
      bytes: change.bytes,
      added: change.diff.added,
      removed: change.diff.removed,
      sha256: change.sha256,
    }),
    displayResult,
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function commonPrefixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string[], b: string[], prefixLength: number): number {
  const max = Math.min(a.length, b.length) - prefixLength;
  let length = 0;
  while (
    length < max &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length) {
    const index = value.indexOf(search, offset);
    if (index === -1) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

function requiredRawString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, message: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
