import { promises as fs, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../../domain/agent/types";
import {
  PLAN_STEP_STATUSES,
  type PlanStepStatus,
} from "../../../shared/agent-contracts.js";
import {
  assertNoSymlinkInPath,
  getErrorCode,
  requireWorkspace,
  resolveWorkspacePathLexically,
  resolveWorkspacePathForAccess,
  toWorkspaceRelative,
} from "./workspace-policy.js";
import { parseUnifiedDiffFilePath } from "../unified-diff-path.js";
import {
  decodeUtf8TextBuffer,
  openTextFileNoFollow,
  writeUtf8TextFileNoFollow,
} from "./text-file.js";
import { isSamePath } from "../path-utils.js";

const MAX_EDIT_FILE_BYTES = 1_000_000;

interface FileDiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

interface FileDiffPreview {
  kind: "file_diff";
  path: string;
  operation: "create" | "update" | "delete";
  added: number;
  removed: number;
  lines: FileDiffLine[];
}

interface MultiFileDiffPreview {
  kind: "multi_file_diff";
  files: FileDiffPreview[];
  added: number;
  removed: number;
}

interface FileChangeResult {
  path: string;
  operation: "create" | "update" | "delete";
  bytes: number;
  modifiedAt: string;
  mtimeMs: number;
  sha256: string;
  diff: FileDiffPreview;
}

interface PatchApplyResult {
  files: FileChangeResult[];
  added: number;
  removed: number;
  diff: MultiFileDiffPreview;
}

type EditPlanFileAction = "create" | "update" | "delete" | "rollback" | "inspect";

interface EditPlanFile {
  path: string;
  action: EditPlanFileAction;
  reason?: string;
}

interface EditPlanStep {
  title: string;
  status: PlanStepStatus;
}

interface EditPlanResult {
  title?: string;
  summary?: string;
  files: EditPlanFile[];
  steps: EditPlanStep[];
  verification: string[];
}

export function createCodingTools(): AgentTool[] {
  return [
    createEditPlanTool,
    editFileTool,
    multiEditTool,
    writeFileTool,
    deleteFileTool,
    applyPatchTool,
    rollbackFileTool,
  ];
}

const createEditPlanTool: AgentTool = {
  metadata: {
    category: "plan",
    isReadOnly: true,
    isDestructive: false,
  },
  definition: {
    name: "create_edit_plan",
    description:
      "Create a visible coordination plan before a code change touches multiple files through separate edit/write/delete calls. Include the files, planned actions, and verification steps.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional short title for the edit plan.",
        },
        summary: {
          type: "string",
          description: "Short explanation of the coordinated change.",
        },
        files: {
          type: "array",
          minItems: 2,
          description: "Workspace-relative files expected to be touched.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Workspace-relative file path.",
              },
              action: {
                type: "string",
                enum: ["create", "update", "delete", "rollback", "inspect"],
                description: "Planned action for this file.",
              },
              reason: {
                type: "string",
                description: "Why this file is part of the coordinated change.",
              },
            },
            required: ["path", "action"],
          },
        },
        steps: {
          type: "array",
          description: "Optional ordered implementation steps. Generated from files when omitted.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "A concise step title.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["title"],
          },
        },
        verification: {
          type: "array",
          description: "Optional commands or checks expected after the edits.",
          items: { type: "string" },
        },
      },
      required: ["files"],
    },
  },
  async execute(input, context) {
    return createVisibleEditPlan(input, context);
  },
};

const editFileTool: AgentTool = {
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

const multiEditTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "multi_edit",
    description:
      "Apply multiple exact string replacements to one UTF-8 workspace text file atomically. Each edit runs against the result of the previous edit; the file is written only if every edit succeeds.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to edit.",
        },
        edits: {
          type: "array",
          minItems: 1,
          description: "Ordered edit steps to apply in memory before one final write.",
          items: {
            type: "object",
            properties: {
              old_string: {
                type: "string",
                description: "Exact text currently in the file at this step.",
              },
              new_string: {
                type: "string",
                description: "Replacement text for this step.",
              },
              replace_all: {
                type: "boolean",
                description: "Set true only when every occurrence for this step should be replaced.",
              },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  async preview(input, context) {
    const change = await prepareMultiEdit(input, context);
    return change.diff;
  },
  async execute(input, context) {
    const change = await prepareMultiEdit(input, context);
    const committed = await writePreparedChange(change, context, "multi_edit");
    return toToolResult("multi_edit", committed);
  },
};

const writeFileTool: AgentTool = {
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

const deleteFileTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "delete_file",
    description:
      "Delete a UTF-8 workspace text file after it has been read. Use when a file should be removed and rollback_file may need to restore it.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to delete.",
        },
      },
      required: ["path"],
    },
  },
  async preview(input, context) {
    const change = await prepareDelete(input, context);
    return change.diff;
  },
  async execute(input, context) {
    const change = await prepareDelete(input, context);
    const committed = await writePreparedChange(change, context, "delete_file");
    return toToolResult("delete_file", committed);
  },
};

const applyPatchTool: AgentTool = {
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

const rollbackFileTool: AgentTool = {
  metadata: {
    category: "workspace",
    isDestructive: true,
  },
  definition: {
    name: "rollback_file",
    description:
      "Rollback the most recent agent write to a workspace file in the current app session. Use when an edit, multi-edit, write, patch, or previous rollback should be undone.",
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
  workspace: string;
  filePath: string;
  nextContent: string;
  originalContent: string;
}

interface PreparedPatch {
  changes: PreparedFileChange[];
  diff: MultiFileDiffPreview;
}

interface RollbackSource {
  kind: "history" | "checkpoint";
  threadId: string;
  workspace: string;
  beforeContent: string | null;
  afterSha256: string | null;
}

interface MultiEditStep {
  oldString: string;
  newString: string;
  replaceAll: boolean;
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
  await assertNoSymlinkInPath(workspace, relativePath, "read", "Coding tools");
  const { content } = await readEditableTextFile(filePath, relativePath);
  assertFreshRead(context, filePath, content);
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

async function prepareMultiEdit(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredString(input.path, "multi_edit requires a string path.");
  const edits = requiredMultiEditSteps(input.edits);
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  await assertNoSymlinkInPath(workspace, relativePath, "read", "Coding tools");
  const { content } = await readEditableTextFile(filePath, relativePath);
  assertFreshRead(context, filePath, content);

  let nextContent = content;
  for (const [index, edit] of edits.entries()) {
    const label = `multi_edit edit ${index + 1}`;
    if (edit.oldString === edit.newString) {
      throw new Error(`${label} old_string and new_string are identical.`);
    }
    if (!edit.oldString) {
      throw new Error(`${label} requires a non-empty old_string.`);
    }

    const matches = countOccurrences(nextContent, edit.oldString);
    if (matches === 0) {
      throw new Error(`${label} old_string was not found in ${relativePath}.`);
    }
    if (matches > 1 && !edit.replaceAll) {
      throw new Error(
        `${label} found ${matches} matches in ${relativePath}. Provide more context or set replace_all to true.`,
      );
    }
    nextContent = edit.replaceAll
      ? nextContent.split(edit.oldString).join(edit.newString)
      : nextContent.replace(edit.oldString, edit.newString);
  }

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
  await assertNoSymlinkInPath(workspace, relativePath, "write", "Coding tools");
  let original = "";
  let operation: FileChangeResult["operation"] = "create";

  try {
    const { content: currentContent } = await readEditableTextFile(filePath, relativePath);
    if (createOnly) {
      throw new Error(`write_file create_only is true but file already exists: ${relativePath}`);
    }
    if (!overwrite) {
      throw new Error(`write_file requires overwrite: true for existing file ${relativePath}.`);
    }
    assertFreshRead(context, filePath, currentContent);
    original = currentContent;
    operation = "update";
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  return buildPreparedChange(workspace, filePath, original, content, operation);
}

async function prepareDelete(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredString(input.path, "delete_file requires a string path.");
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "read");
  await assertNoSymlinkInPath(workspace, relativePath, "read", "Coding tools");
  const { content } = await readEditableTextFile(filePath, relativePath);
  assertFreshRead(context, filePath, content);
  return buildPreparedChange(workspace, filePath, content, "", "delete");
}

async function prepareRollback(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Promise<PreparedFileChange> {
  const workspace = requireWorkspace(context);
  const relativePath = requiredString(input.path, "rollback_file requires a string path.");
  const filePath = await resolveWorkspacePathForAccess(workspace, relativePath, "write");
  await assertNoSymlinkInPath(workspace, relativePath, "write", "Coding tools");
  const normalizedRelativePath = toWorkspaceRelative(workspace, filePath);
  const historyEntry = context.fileHistory?.latest(filePath);
  const source: RollbackSource | null = historyEntry
    ? {
        kind: "history",
        threadId: historyEntry.threadId,
        workspace: historyEntry.workspace,
        beforeContent: historyEntry.beforeContent,
        afterSha256: historyEntry.afterSha256,
      }
    : await resolveCheckpointRollbackSource(
        context,
        workspace,
        normalizedRelativePath,
      );
  if (!source) {
    throw new Error(`rollback_file has no history for ${relativePath}.`);
  }
  if (!isSamePath(path.resolve(source.workspace), path.resolve(workspace))) {
    throw new Error(`rollback_file history does not belong to this workspace: ${relativePath}`);
  }
  if (source.threadId !== context.threadId) {
    throw new Error(`rollback_file history does not belong to this thread: ${relativePath}`);
  }

  const current = await readCurrentTextOrMissing(filePath, relativePath);
  const currentSha = current.exists ? sha256(current.content) : null;
  if (currentSha !== source.afterSha256) {
    throw new Error(
      `rollback_file current content no longer matches the latest ${source.kind} entry: ${relativePath}`,
    );
  }

  if (source.beforeContent === null) {
    return buildPreparedChange(workspace, filePath, current.content, "", "delete");
  }
  const operation: FileChangeResult["operation"] = current.exists ? "update" : "create";
  return buildPreparedChange(
    workspace,
    filePath,
    current.exists ? current.content : "",
    source.beforeContent,
    operation,
  );
}

async function resolveCheckpointRollbackSource(
  context: AgentToolContext,
  workspace: string,
  relativePath: string,
): Promise<RollbackSource | null> {
  const snapshot = await context.checkpoint?.latestFileSnapshot?.({
    threadId: context.threadId,
    workspace,
    relativePath,
  });
  if (!snapshot) return null;
  return {
    kind: "checkpoint",
    threadId: snapshot.threadId,
    workspace: snapshot.workspace,
    beforeContent: snapshot.beforeContent,
    afterSha256: snapshot.afterSha256,
  };
}

async function writePreparedChange(
  change: PreparedFileChange,
  context: AgentToolContext,
  toolName: string,
): Promise<PreparedFileChange> {
  await recordFileCheckpoint(context, change, toolName);
  await commitPreparedChange(change);
  const contentHash = sha256(change.nextContent);
  let stat: Stats | undefined;
  try {
    // Post-write stat is best-effort metadata; if it fails (file evicted by a
    // hook, anti-virus scanner, etc.) the bytes are already on disk, so the
    // single-file tool must roll back to the pre-write content just like
    // apply_patch does when one of its files hits the same failure.
    stat = change.operation === "delete" ? undefined : await fs.stat(change.filePath);
  } catch (error) {
    try {
      await restoreCommittedChanges([{
        ...change,
        bytes: change.operation === "delete" ? 0 : Buffer.byteLength(change.nextContent, "utf8"),
        modifiedAt: new Date().toISOString(),
        mtimeMs: 0,
        sha256: contentHash,
      }]);
    } catch (rollbackError) {
      throw new Error(
        `${toolName} failed: ${messageOf(error)}; rollback failed: ${messageOf(rollbackError)}`,
      );
    }
    throw error;
  }
  recordFileHistory(context, change, toolName);
  updateReadStateForCommittedChange(context, change, stat, contentHash);
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
  for (const change of changes) {
    await recordFileCheckpoint(context, change, toolName);
  }
  const committed: PreparedFileChange[] = [];
  try {
    for (const change of changes) {
      await commitPreparedChange(change);
      const contentHash = sha256(change.nextContent);
      // Register the write for rollback before collecting post-write metadata;
      // stat can fail after bytes reached disk, and apply_patch must stay all-or-nothing.
      const committedChange: PreparedFileChange = {
        ...change,
        bytes: change.operation === "delete" ? 0 : Buffer.byteLength(change.nextContent, "utf8"),
        modifiedAt: new Date().toISOString(),
        mtimeMs: 0,
        sha256: contentHash,
      };
      committed.push(committedChange);
      const stat = change.operation === "delete" ? undefined : await fs.stat(change.filePath);
      committed[committed.length - 1] = {
        ...committedChange,
        bytes: stat?.size ?? 0,
        modifiedAt: stat?.mtime.toISOString() ?? new Date().toISOString(),
        mtimeMs: stat?.mtimeMs ?? 0,
        sha256: contentHash,
      };
    }
  } catch (error) {
    try {
      await restoreCommittedChanges(committed);
    } catch (rollbackError) {
      throw new Error(
        `apply_patch failed: ${messageOf(error)}; rollback failed: ${messageOf(rollbackError)}`,
      );
    }
    throw error;
  }

  for (const change of committed) {
    recordFileHistory(context, change, toolName);
    if (change.operation === "delete") {
      context.readState?.delete(change.filePath);
      continue;
    }
    context.readState?.set(change.filePath, {
      content: change.nextContent,
      mtimeMs: change.mtimeMs,
      size: change.bytes,
      sha256: change.sha256,
      fullSha256: change.sha256,
      truncated: false,
      offsetBytes: 0,
      bytesRead: change.bytes,
    });
  }
  return committed;
}

async function commitPreparedChange(change: PreparedFileChange): Promise<void> {
  if (change.operation === "delete") {
    await assertPreparedChangePathStillAllowed(change, "read");
    await assertPreparedChangeStillFresh(change);
    await fs.rm(change.filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(change.filePath), { recursive: true });
  await assertPreparedChangePathStillAllowed(change, "write");
  await assertPreparedChangeStillFresh(change);
  await writeUtf8TextFileNoFollow(change.filePath, change.nextContent, {
    exclusive: change.operation === "create",
    label: "Coding tool write",
    relativePath: change.path,
  });
}

async function assertPreparedChangePathStillAllowed(
  change: PreparedFileChange,
  access: "read" | "write",
): Promise<void> {
  const resolved = await resolveWorkspacePathForAccess(change.workspace, change.path, access);
  await assertNoSymlinkInPath(change.workspace, change.path, access, "Coding tools");
  if (!isSamePath(path.resolve(resolved), path.resolve(change.filePath))) {
    throw new Error(`Path changed before write: ${change.path}. Read it again before writing.`);
  }
}

async function assertPreparedChangeStillFresh(change: PreparedFileChange): Promise<void> {
  if (change.operation === "create") {
    try {
      await fs.lstat(change.filePath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    throw new Error(`File changed before write: ${change.path}. Read it again before writing.`);
  }

  const current = await readCurrentTextOrMissing(change.filePath, change.path);
  if (!current.exists || sha256(current.content) !== sha256(change.originalContent)) {
    throw new Error(`File changed before write: ${change.path}. Read it again before writing.`);
  }
}

function updateReadStateForCommittedChange(
  context: AgentToolContext,
  change: PreparedFileChange,
  stat: Stats | undefined,
  contentHash: string,
): void {
  if (stat) {
    context.readState?.set(change.filePath, {
      content: change.nextContent,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: contentHash,
      fullSha256: contentHash,
      truncated: false,
      offsetBytes: 0,
      bytesRead: stat.size,
    });
  } else {
    context.readState?.delete(change.filePath);
  }
}

async function restoreCommittedChanges(committed: PreparedFileChange[]): Promise<void> {
  const failures: string[] = [];
  for (const change of [...committed].reverse()) {
    try {
      if (change.operation === "create") {
        await fs.rm(change.filePath, { force: true });
      } else {
        await fs.mkdir(path.dirname(change.filePath), { recursive: true });
        await writeUtf8TextFileNoFollow(change.filePath, change.originalContent, {
          label: "Coding tool rollback",
          relativePath: change.path,
        });
      }
    } catch (error) {
      failures.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`apply_patch failed and rollback also failed: ${failures.join("; ")}`);
  }
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
  const seenTargets: string[] = [];

  for (const file of files) {
    const targetPath = file.newPath ?? file.oldPath;
    if (!targetPath) {
      throw new Error("apply_patch file header is missing a target path.");
    }
    const operation: FileChangeResult["operation"] = file.oldPath === undefined ? "create" : "update";
    const filePath = await resolveWorkspacePathForAccess(workspace, targetPath, operation === "create" ? "write" : "read");
    await assertNoSymlinkInPath(workspace, targetPath, operation === "create" ? "write" : "read", "Coding tools");
    if (seenTargets.some((seenTarget) => isSamePath(seenTarget, filePath))) {
      throw new Error(`apply_patch contains duplicate file sections for ${targetPath}.`);
    }
    seenTargets.push(filePath);
    let original = "";
    if (operation === "update") {
      const { content } = await readEditableTextFile(filePath, targetPath);
      assertFreshRead(context, filePath, content);
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
  const handle = await openTextFileNoFollow(filePath, {
    label: "Coding tool read",
    relativePath,
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${relativePath}`);
    }
    if (stat.size > MAX_EDIT_FILE_BYTES) {
      throw new Error(`File is too large to edit: ${relativePath}`);
    }
    const buffer = await handle.readFile();
    return {
      content: decodeUtf8TextBuffer(buffer, relativePath, "File"),
      stat,
    };
  } finally {
    await handle.close();
  }
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
  noNewlineAtEnd?: boolean;
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
    if (isUnsupportedPatchMetadata(line)) {
      throw new Error("apply_patch does not support renaming or copying files.");
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
    if (oldPath !== undefined && oldPath !== newPath) {
      throw new Error("apply_patch does not support renaming or copying files.");
    }
    index += 1;

    const hunks: ParsedPatchHunk[] = [];
    while (index < lines.length) {
      if (lines[index].startsWith("diff --git ") || isPatchFileHeaderAt(lines, index)) {
        break;
      }
      if (isUnsupportedPatchMetadata(lines[index])) {
        throw new Error("apply_patch does not support renaming or copying files.");
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
        if (
          hunkLine.startsWith("@@ ") ||
          hunkLine.startsWith("diff --git ") ||
          isPatchFileHeaderAt(lines, index)
        ) {
          break;
        }
        if (hunkLine === "\\ No newline at end of file") {
          const previous = hunkLines.at(-1);
          if (!previous) {
            throw new Error("apply_patch no-newline marker has no preceding hunk line.");
          }
          previous.noNewlineAtEnd = true;
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

function isUnsupportedPatchMetadata(line: string): boolean {
  return line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ");
}

function isPatchFileHeaderAt(lines: string[], index: number): boolean {
  return lines[index].startsWith("--- ") && lines[index + 1]?.startsWith("+++ ");
}

function parsePatchPath(raw: string): string | undefined {
  return parseUnifiedDiffFilePath(raw, "apply_patch file path is invalid.");
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
  const originalLines = splitLineRecords(originalContent);
  const nextLines: TextLineRecord[] = [];
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
        nextLines.push({
          text: line.text,
          newline: line.noNewlineAtEnd
            ? null
            : resolveAddedLineEnding(originalLines, originalIndex, nextLines),
        });
        continue;
      }
      const current = originalLines[originalIndex];
      const expectedMissingFinalNewline = Boolean(line.noNewlineAtEnd);
      if (
        !current ||
        current.text !== line.text ||
        (expectedMissingFinalNewline ? current.newline !== null : current.newline === null)
      ) {
        throw new Error(`apply_patch hunk does not match ${relativePath}.`);
      }
      if (line.type === "context") {
        nextLines.push(current);
      }
      originalIndex += 1;
    }
  }

  nextLines.push(...originalLines.slice(originalIndex));
  return joinLineRecords(nextLines, relativePath);
}

function assertHunkCounts(hunk: ParsedPatchHunk, relativePath: string): void {
  const removedOrContext = hunk.lines.filter((line) => line.type !== "added").length;
  const addedOrContext = hunk.lines.filter((line) => line.type !== "removed").length;
  if (removedOrContext !== hunk.oldCount || addedOrContext !== hunk.newCount) {
    throw new Error(`apply_patch hunk line counts do not match header in ${relativePath}.`);
  }
}

function assertFreshRead(
  context: AgentToolContext,
  filePath: string,
  content: string,
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
    workspace,
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

function createVisibleEditPlan(
  input: Record<string, unknown>,
  context: AgentToolContext,
): AgentToolResult {
  const plan = normalizeEditPlan(input, context);
  return {
    toolCallId: "",
    name: "create_edit_plan",
    content: JSON.stringify(plan),
    displayResult: plan,
  };
}

function normalizeEditPlan(
  input: Record<string, unknown>,
  context: AgentToolContext,
): EditPlanResult {
  const workspace = requireWorkspace(context);
  const title = optionalNonEmptyString(input.title, "title");
  const summary = optionalNonEmptyString(input.summary, "summary");
  const files = parseEditPlanFiles(input.files, workspace);
  const verification = parseOptionalStringList(input.verification, "verification");
  const parsedSteps = parseOptionalEditPlanSteps(input.steps);
  const steps = parsedSteps.length > 0
    ? parsedSteps
    : [
        ...files.map((file) => ({
          title: `${capitalize(file.action)} ${file.path}${file.reason ? `: ${file.reason}` : ""}`,
          status: "pending" as const,
        })),
        ...verification.map((entry) => ({
          title: `Verify: ${entry}`,
          status: "pending" as const,
        })),
      ];
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    files,
    steps,
    verification,
  };
}

function parseEditPlanFiles(value: unknown, workspace: string): EditPlanFile[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("create_edit_plan requires at least two planned files.");
  }
  const files = value.map((entry, index) => parseEditPlanFile(entry, index, workspace));
  const seen: string[] = [];
  for (const file of files) {
    if (seen.some((seenPath) => isSamePath(seenPath, file.path))) {
      throw new Error(`create_edit_plan file path is duplicated: ${file.path}`);
    }
    seen.push(file.path);
  }
  return files;
}

function parseEditPlanFile(
  value: unknown,
  index: number,
  workspace: string,
): EditPlanFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`create_edit_plan file ${index + 1} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const pathValue = requiredPlanString(raw.path, `create_edit_plan file ${index + 1} requires path.`);
  const fullPath = resolveWorkspacePathLexically(workspace, pathValue);
  const normalizedPath = toWorkspaceRelative(workspace, fullPath);
  const action = parseEditPlanAction(raw.action, index);
  const reason = optionalNonEmptyString(raw.reason, `file ${index + 1} reason`);
  return {
    path: normalizedPath,
    action,
    ...(reason ? { reason } : {}),
  };
}

function parseEditPlanAction(value: unknown, index: number): EditPlanFileAction {
  if (
    value === "create" ||
    value === "update" ||
    value === "delete" ||
    value === "rollback" ||
    value === "inspect"
  ) {
    return value;
  }
  throw new Error(`create_edit_plan file ${index + 1} action must be create, update, delete, rollback, or inspect.`);
}

function parseOptionalEditPlanSteps(value: unknown): EditPlanStep[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("create_edit_plan steps must be an array.");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`create_edit_plan step ${index + 1} must be an object.`);
    }
    const raw = entry as Record<string, unknown>;
    return {
      title: requiredPlanString(raw.title, `create_edit_plan step ${index + 1} requires title.`),
      status: parseEditPlanStepStatus(raw.status),
    };
  });
}

function parseEditPlanStepStatus(value: unknown): PlanStepStatus {
  if (value === undefined) return "pending";
  if (typeof value === "string" && PLAN_STEP_STATUSES.includes(value as PlanStepStatus)) {
    return value as PlanStepStatus;
  }
  throw new Error("create_edit_plan step status must be pending, in_progress, or completed.");
}

function parseOptionalStringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`create_edit_plan ${name} must be an array of strings.`);
  }
  return value.map((entry, index) =>
    requiredPlanString(entry, `create_edit_plan ${name} entry ${index + 1} must be a non-empty string.`),
  );
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`create_edit_plan ${name} must be a string.`);
  }
  if (value.includes("\0")) {
    throw new Error("create_edit_plan strings cannot contain NUL bytes.");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredPlanString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("create_edit_plan strings cannot contain NUL bytes.");
  }
  return value.trim();
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
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
    operation: toolName === "rollback_file" ? "rollback" : change.operation,
    beforeContent: change.operation === "create" ? null : change.originalContent,
    afterContent: change.operation === "delete" ? null : change.nextContent,
    beforeSha256: change.operation === "create" ? null : sha256(change.originalContent),
    afterSha256: change.operation === "delete" ? null : sha256(change.nextContent),
  });
}

async function recordFileCheckpoint(
  context: AgentToolContext,
  change: PreparedFileChange,
  toolName: string,
): Promise<void> {
  const workspace = requireWorkspace(context);
  await context.checkpoint?.recordFileSnapshot({
    threadId: context.threadId,
    turnId: context.turnId,
    toolName,
    workspace,
    relativePath: change.path,
    operation: toolName === "rollback_file" ? "rollback" : change.operation,
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

type TextLineEnding = "\n" | "\r\n";

interface TextLineRecord {
  text: string;
  newline: TextLineEnding | null;
}

/**
 * Unified diff lines only tell us whether a line has a final newline, not
 * which newline bytes were used. Keep existing per-line EOLs and choose a
 * local/default EOL only for newly added lines.
 */
function splitLineRecords(content: string): TextLineRecord[] {
  if (content.length === 0) return [];
  const lines: TextLineRecord[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") {
      continue;
    }
    const hasCarriageReturn = index > start && content[index - 1] === "\r";
    lines.push({
      text: content.slice(start, hasCarriageReturn ? index - 1 : index),
      newline: hasCarriageReturn ? "\r\n" : "\n",
    });
    start = index + 1;
  }
  if (start < content.length) {
    lines.push({ text: content.slice(start), newline: null });
  }
  return lines;
}

function joinLineRecords(lines: TextLineRecord[], relativePath: string): string {
  let content = "";
  for (const [index, line] of lines.entries()) {
    if (line.newline === null && index < lines.length - 1) {
      throw new Error(`apply_patch no-newline marker is not at file end in ${relativePath}.`);
    }
    content += line.text;
    if (line.newline !== null) {
      content += line.newline;
    }
  }
  return content;
}

function resolveAddedLineEnding(
  originalLines: TextLineRecord[],
  originalIndex: number,
  nextLines: TextLineRecord[],
): TextLineEnding {
  return originalLines[originalIndex]?.newline ??
    nextLines.at(-1)?.newline ??
    inferDefaultLineEnding(originalLines);
}

function inferDefaultLineEnding(lines: TextLineRecord[]): TextLineEnding {
  let lf = 0;
  let crlf = 0;
  let first: TextLineEnding | undefined;
  for (const line of lines) {
    if (line.newline === null) {
      continue;
    }
    first ??= line.newline;
    if (line.newline === "\r\n") {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  if (crlf > lf) return "\r\n";
  if (lf > crlf) return "\n";
  return first ?? "\n";
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

function requiredMultiEditSteps(value: unknown): MultiEditStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("multi_edit requires a non-empty edits array.");
  }
  return value.map((entry, index) => {
    const step = requiredRecord(entry, `multi_edit edit ${index + 1} must be an object.`);
    return {
      oldString: requiredRawString(
        step.old_string,
        `multi_edit edit ${index + 1} requires old_string.`,
      ),
      newString: requiredRawString(
        step.new_string,
        `multi_edit edit ${index + 1} requires new_string.`,
      ),
      replaceAll: optionalBoolean(
        step.replace_all,
        false,
        `multi_edit edit ${index + 1} replace_all must be a boolean.`,
      ),
    };
  });
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
