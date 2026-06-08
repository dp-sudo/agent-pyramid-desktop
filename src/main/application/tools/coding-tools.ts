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
  operation: "create" | "update" | "delete";
  added: number;
  removed: number;
  lines: FileDiffLine[];
}

export interface MultiFileDiffPreview {
  kind: "multi_file_diff";
  files: FileDiffPreview[];
  added: number;
  removed: number;
}

export interface FileChangeResult {
  path: string;
  operation: "create" | "update" | "delete";
  bytes: number;
  modifiedAt: string;
  mtimeMs: number;
  sha256: string;
  diff: FileDiffPreview;
}

export interface PatchApplyResult {
  files: FileChangeResult[];
  added: number;
  removed: number;
  diff: MultiFileDiffPreview;
}

export function createCodingTools(): AgentTool[] {
  return [editFileTool, writeFileTool, applyPatchTool, rollbackFileTool];
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
    const committed = await writePreparedChange(change, context, "edit_file");
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
    const committed = await writePreparedChange(change, context, "write_file");
    return toToolResult("write_file", committed);
  },
};

export const applyPatchTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "apply_patch",
    description:
      "Apply a unified diff patch to UTF-8 workspace files. Supports create and update hunks only; read existing files first so the patch can be checked against the latest content.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Unified diff patch text with ---/+++ file headers and @@ hunks.",
        },
      },
      required: ["patch"],
    },
  },
  async preview(input, context) {
    const patch = await preparePatch(input, context);
    return patch.diff;
  },
  async execute(input, context) {
    const patch = await preparePatch(input, context);
    const committed = await writePreparedChanges(patch.changes, context, "apply_patch");
    return toPatchToolResult(committed);
  },
};

export const rollbackFileTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "rollback_file",
    description:
      "Rollback the most recent agent write to a workspace file in the current app session. Use when an edit, write, patch, or previous rollback should be undone.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to rollback.",
        },
      },
      required: ["path"],
    },
  },
  async preview(input, context) {
    const change = await prepareRollback(input, context);
    return change.diff;
  },
  async execute(input, context) {
    const change = await prepareRollback(input, context);
    const committed = await writePreparedChange(change, context, "rollback_file");
    return toToolResult("rollback_file", committed);
  },
};

interface PreparedFileChange extends FileChangeResult {
  filePath: string;
  nextContent: string;
  originalContent: string;
}

interface PreparedPatch {
  changes: PreparedFileChange[];
  diff: MultiFileDiffPreview;
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

async function prepareRollback(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredString(input.path, "rollback_file requires a string path.");
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "write");
  const entry = context.fileHistory?.latest(filePath);
  if (!entry) {
    throw new Error(`rollback_file has no history for ${relativePath}.`);
  }
  if (path.resolve(entry.workspace) !== path.resolve(workspace)) {
    throw new Error(`rollback_file history does not belong to this workspace: ${relativePath}`);
  }

  const current = await readCurrentTextOrMissing(filePath, relativePath);
  const currentSha = current.exists ? sha256(current.content) : null;
  if (currentSha !== entry.afterSha256) {
    throw new Error(`rollback_file current content no longer matches the latest history entry: ${relativePath}`);
  }

  if (entry.beforeContent === null) {
    return buildPreparedChange(workspace, filePath, current.content, "", "delete");
  }
  const operation: FileChangeResult["operation"] = current.exists ? "update" : "create";
  return buildPreparedChange(workspace, filePath, current.exists ? current.content : "", entry.beforeContent, operation);
}

async function writePreparedChange(
  change: PreparedFileChange,
  context: AgentToolContext,
  toolName: string,
): Promise<PreparedFileChange> {
  const { filePath, nextContent } = change;
  if (change.operation === "delete") {
    await fs.rm(filePath, { force: true });
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, nextContent, "utf8");
  }
  const stat = change.operation === "delete" ? undefined : await fs.stat(filePath);
  const contentHash = sha256(nextContent);
  recordFileHistory(context, change, toolName);
  if (stat) {
    context.readState?.set(filePath, {
      content: nextContent,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: contentHash,
      fullSha256: contentHash,
      truncated: false,
      offsetBytes: 0,
      bytesRead: stat.size,
    });
  } else {
    context.readState?.delete(filePath);
  }
  return {
    ...change,
    bytes: stat?.size ?? 0,
    modifiedAt: stat?.mtime.toISOString() ?? new Date().toISOString(),
    mtimeMs: stat?.mtimeMs ?? 0,
    sha256: contentHash,
  };
}

async function writePreparedChanges(
  changes: PreparedFileChange[],
  context: AgentToolContext,
  toolName: string,
): Promise<PreparedFileChange[]> {
  const committed: PreparedFileChange[] = [];
  for (const change of changes) {
    committed.push(await writePreparedChange(change, context, toolName));
  }
  return committed;
}

async function preparePatch(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedPatch> {
  const workspace = requireWorkspace(context);
  const patchText = requiredRawString(input.patch, "apply_patch requires patch.");
  if (!patchText.trim()) {
    throw new Error("apply_patch requires a non-empty patch.");
  }
  const files = parseUnifiedDiff(patchText);
  const changes: PreparedFileChange[] = [];

  for (const file of files) {
    const targetPath = file.newPath ?? file.oldPath;
    if (!targetPath) {
      throw new Error("apply_patch file header is missing a target path.");
    }
    const operation: FileChangeResult["operation"] = file.oldPath === undefined ? "create" : "update";
    const filePath = await resolveWorkspacePathForAccess(workspace, targetPath, operation === "create" ? "write" : "read");
    let original = "";
    if (operation === "update") {
      const { content, stat } = await readEditableTextFile(filePath, targetPath);
      assertFreshRead(context, filePath, content, stat);
      original = content;
    } else {
      try {
        await fs.stat(filePath);
        throw new Error(`apply_patch create target already exists: ${targetPath}`);
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    }
    const nextContent = applyHunks(original, file.hunks, targetPath);
    changes.push(buildPreparedChange(workspace, filePath, original, nextContent, operation));
  }

  if (changes.length === 0) {
    throw new Error("apply_patch did not contain any file changes.");
  }
  const filesPreview = changes.map((change) => change.diff);
  return {
    changes,
    diff: {
      kind: "multi_file_diff",
      files: filesPreview,
      added: filesPreview.reduce((sum, file) => sum + file.added, 0),
      removed: filesPreview.reduce((sum, file) => sum + file.removed, 0),
    },
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

async function readCurrentTextOrMissing(
  filePath: string,
  relativePath: string,
): Promise<{ exists: true; content: string; stat: Stats } | { exists: false; content: "" }> {
  try {
    const { content, stat } = await readEditableTextFile(filePath, relativePath);
    return { exists: true, content, stat };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { exists: false, content: "" };
    }
    throw error;
  }
}

interface ParsedPatchFile {
  oldPath?: string;
  newPath?: string;
  hunks: ParsedPatchHunk[];
}

interface ParsedPatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedPatchLine[];
}

interface ParsedPatchLine {
  type: "context" | "added" | "removed";
  text: string;
}

function parseUnifiedDiff(patchText: string): ParsedPatchFile[] {
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const files: ParsedPatchFile[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    if (!line.startsWith("--- ")) {
      index += 1;
      continue;
    }

    const oldPath = parsePatchPath(line.slice(4));
    index += 1;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw new Error("apply_patch expected +++ after --- file header.");
    }
    const newPath = parsePatchPath(lines[index].slice(4));
    if (oldPath === undefined && newPath === undefined) {
      throw new Error("apply_patch does not support deleting files.");
    }
    if (newPath === undefined) {
      throw new Error("apply_patch does not support deleting files.");
    }
    index += 1;

    const hunks: ParsedPatchHunk[] = [];
    while (index < lines.length) {
      if (lines[index].startsWith("diff --git ") || lines[index].startsWith("--- ")) {
        break;
      }
      if (!lines[index].startsWith("@@ ")) {
        index += 1;
        continue;
      }
      const parsed = parseHunkHeader(lines[index]);
      index += 1;
      const hunkLines: ParsedPatchLine[] = [];
      while (index < lines.length) {
        const hunkLine = lines[index];
        if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("diff --git ") || hunkLine.startsWith("--- ")) {
          break;
        }
        if (hunkLine === "\\ No newline at end of file") {
          index += 1;
          continue;
        }
        if (hunkLine.startsWith(" ")) {
          hunkLines.push({ type: "context", text: hunkLine.slice(1) });
        } else if (hunkLine.startsWith("+")) {
          hunkLines.push({ type: "added", text: hunkLine.slice(1) });
        } else if (hunkLine.startsWith("-")) {
          hunkLines.push({ type: "removed", text: hunkLine.slice(1) });
        } else {
          throw new Error(`apply_patch invalid hunk line: ${hunkLine}`);
        }
        index += 1;
      }
      hunks.push({ ...parsed, lines: hunkLines });
    }
    if (hunks.length === 0) {
      throw new Error(`apply_patch file has no hunks: ${newPath ?? oldPath ?? "<unknown>"}`);
    }
    files.push({ oldPath, newPath, hunks });
  }
  return files;
}

function parsePatchPath(raw: string): string | undefined {
  const token = raw.trim().split(/\s+/)[0];
  if (token === "/dev/null") return undefined;
  const normalized = token.startsWith("a/") || token.startsWith("b/")
    ? token.slice(2)
    : token;
  if (!normalized || normalized.includes("\0")) {
    throw new Error("apply_patch file path is invalid.");
  }
  return normalized;
}

function parseHunkHeader(header: string): Omit<ParsedPatchHunk, "lines"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) {
    throw new Error(`apply_patch invalid hunk header: ${header}`);
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function applyHunks(
  originalContent: string,
  hunks: ParsedPatchHunk[],
  relativePath: string,
): string {
  const originalLines = splitLines(originalContent);
  const nextLines: string[] = [];
  let originalIndex = 0;

  for (const hunk of hunks) {
    assertHunkCounts(hunk, relativePath);
    const hunkStartIndex = Math.max(0, hunk.oldStart - 1);
    if (hunkStartIndex < originalIndex) {
      throw new Error(`apply_patch hunks overlap in ${relativePath}.`);
    }
    nextLines.push(...originalLines.slice(originalIndex, hunkStartIndex));
    originalIndex = hunkStartIndex;

    for (const line of hunk.lines) {
      if (line.type === "added") {
        nextLines.push(line.text);
        continue;
      }
      const current = originalLines[originalIndex];
      if (current !== line.text) {
        throw new Error(`apply_patch hunk does not match ${relativePath}.`);
      }
      if (line.type === "context") {
        nextLines.push(current);
      }
      originalIndex += 1;
    }
  }

  nextLines.push(...originalLines.slice(originalIndex));
  return withTrailingNewline(nextLines);
}

function assertHunkCounts(hunk: ParsedPatchHunk, relativePath: string): void {
  const removedOrContext = hunk.lines.filter((line) => line.type !== "added").length;
  const addedOrContext = hunk.lines.filter((line) => line.type !== "removed").length;
  if (removedOrContext !== hunk.oldCount || addedOrContext !== hunk.newCount) {
    throw new Error(`apply_patch hunk line counts do not match header in ${relativePath}.`);
  }
}

function withTrailingNewline(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
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
  const currentSha = sha256(content);
  if (readState.fullSha256) {
    if (currentSha !== readState.fullSha256) {
      throw new Error("File has been modified since it was read. Read it again before writing.");
    }
    return;
  }
  if (readState.truncated) {
    throw new Error("The last read_file result was truncated and has no full file hash. Read the file again before writing.");
  }
  if (currentSha !== readState.sha256) {
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
    originalContent,
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

function recordFileHistory(
  context: AgentToolContext,
  change: PreparedFileChange,
  toolName: string,
): void {
  const workspace = requireWorkspace(context);
  context.fileHistory?.push({
    threadId: context.threadId,
    turnId: context.turnId,
    toolName,
    workspace,
    filePath: change.filePath,
    relativePath: change.path,
    operation: toolName === "rollback_file" ? "rollback" : change.operation === "create" ? "create" : "update",
    beforeContent: change.operation === "create" ? null : change.originalContent,
    afterContent: change.operation === "delete" ? null : change.nextContent,
    beforeSha256: change.operation === "create" ? null : sha256(change.originalContent),
    afterSha256: change.operation === "delete" ? null : sha256(change.nextContent),
  });
}

function toPatchToolResult(changes: PreparedFileChange[]): AgentToolResult {
  const files: FileChangeResult[] = changes.map((change) => ({
    path: change.path,
    operation: change.operation,
    bytes: change.bytes,
    modifiedAt: change.modifiedAt,
    mtimeMs: change.mtimeMs,
    sha256: change.sha256,
    diff: change.diff,
  }));
  const diff: MultiFileDiffPreview = {
    kind: "multi_file_diff",
    files: files.map((file) => file.diff),
    added: files.reduce((sum, file) => sum + file.diff.added, 0),
    removed: files.reduce((sum, file) => sum + file.diff.removed, 0),
  };
  const displayResult: PatchApplyResult = {
    files,
    added: diff.added,
    removed: diff.removed,
    diff,
  };
  return {
    toolCallId: "",
    name: "apply_patch",
    content: JSON.stringify({
      files: files.map((file) => ({
        path: file.path,
        operation: file.operation,
        bytes: file.bytes,
        added: file.diff.added,
        removed: file.diff.removed,
        sha256: file.sha256,
      })),
      added: diff.added,
      removed: diff.removed,
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
