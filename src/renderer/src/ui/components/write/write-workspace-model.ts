import type {
  Item,
  WriteFileEntry,
} from "../../../../../shared/agent-contracts";
import { formatBytes } from "../../format";
import { getTimelineItemTurnId, sortTimelineItems } from "../chat/timeline-model";
import {
  COMPLETION_MIN_TRAILING_CHARS,
  WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
  WRITE_COMPLETION_PREFIX_MAX_CHARS,
  WRITE_COMPLETION_SUFFIX_MAX_CHARS,
} from "./write-constants";

const WRITE_CONTEXT_MENU_WIDTH_PX = 176;
const WRITE_CONTEXT_MENU_HEIGHT_PX = 124;
const WRITE_CONTEXT_MENU_VIEWPORT_MARGIN_PX = 8;
const WRITE_MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"] as const;

export type WriteStatus = "idle" | "loading" | "saving" | "saved" | "error";

export interface WriteEditorSelectionState {
  selectionStart: number;
  selectionEnd: number;
}

export type WriteDocumentPathValidationError =
  | "empty"
  | "directory"
  | "empty-segment"
  | "dot-segment"
  | "drive-root"
  | "extension"
  | "filename";

export interface WriteAssistantPromptPayload {
  text: string;
  attachmentIds: string[];
  mode: "agent" | "plan";
  goalMode: boolean;
  displayText: string;
  threadTitle: string;
}

export type WriteWorkspaceSelectionResult = string | boolean | void;

export interface WriteDocumentViewState {
  activePath: string | null;
  content: string;
  savedContent: string;
  completion: string;
  selection: WriteEditorSelectionState;
}

export interface WriteSaveStateInput {
  activePath: string | null;
  workspaceRoot: string;
  content: string;
  savedContent: string;
  status: WriteStatus;
}

export interface WriteDirtyDocumentInput {
  activePath: string | null;
  workspaceRoot: string;
  content: string;
  savedContent: string;
}

export function shouldDisableWriteSave(input: WriteSaveStateInput): boolean {
  return (
    !input.activePath ||
    !input.workspaceRoot ||
    input.status === "loading" ||
    input.status === "saving" ||
    input.content === input.savedContent
  );
}

export function shouldSaveWriteFileBeforeSwitch(input: WriteDirtyDocumentInput): boolean {
  return Boolean(input.activePath && input.workspaceRoot && input.content !== input.savedContent);
}

export function shouldSaveWriteFileBeforeDocumentDelete(
  input: WriteDirtyDocumentInput & { deletingPath: string },
): boolean {
  if (input.activePath === input.deletingPath) return false;
  return shouldSaveWriteFileBeforeSwitch(input);
}

export function shouldWarnBeforeLeavingWriteDocument(input: WriteDirtyDocumentInput): boolean {
  return shouldSaveWriteFileBeforeSwitch(input);
}

export function shouldApplyWriteOpenResult(input: {
  requestId: number;
  latestRequestId: number;
  requestedWorkspace: string;
  currentWorkspace: string;
  requestedPath: string;
  returnedPath?: string;
}): boolean {
  return (
    input.requestId === input.latestRequestId &&
    input.requestedWorkspace === input.currentWorkspace &&
    (input.returnedPath === undefined || input.returnedPath === input.requestedPath)
  );
}

export function shouldApplyWriteCompletionResult(input: {
  requestId: number;
  latestRequestId: number;
  requestedWorkspace: string;
  currentWorkspace: string;
  requestedPath: string;
  currentPath: string | null;
}): boolean {
  return (
    input.requestId === input.latestRequestId &&
    input.requestedWorkspace === input.currentWorkspace &&
    input.requestedPath === input.currentPath
  );
}

export async function shouldUseSelectedWriteWorkspace(
  workspace: string,
  onWorkspaceSelected?: (
    workspace: string
  ) => WriteWorkspaceSelectionResult | Promise<WriteWorkspaceSelectionResult>,
): Promise<boolean> {
  return (await onWorkspaceSelected?.(workspace)) !== false;
}

export function getWriteWorkspaceSwitchState(): WriteDocumentViewState & {
  files: WriteFileEntry[];
} {
  return {
    files: [],
    ...getWriteClearedDocumentState(),
  };
}

export function getWriteOpenDocumentState(
  path: string,
  content: string,
): WriteDocumentViewState {
  return {
    activePath: path,
    content,
    savedContent: content,
    completion: "",
    selection: { selectionStart: 0, selectionEnd: 0 },
  };
}

export function getWriteClearedDocumentState(): WriteDocumentViewState {
  return {
    activePath: null,
    content: "",
    savedContent: "",
    completion: "",
    selection: { selectionStart: 0, selectionEnd: 0 },
  };
}

export type WriteListState = "loading" | "no-workspace" | "empty" | "empty-search" | "ready";

export function getWriteListState(input: {
  files: WriteFileEntry[];
  listLoading: boolean;
  search: string;
  workspaceRoot: string;
}): WriteListState {
  if (input.listLoading) return "loading";
  if (!input.workspaceRoot) return "no-workspace";
  if (input.files.length > 0) return "ready";
  return input.search.trim() ? "empty-search" : "empty";
}

export function formatWriteFileMeta(file: WriteFileEntry): string {
  return `${formatBytes(file.size)} | ${formatDate(file.modifiedAt)}`;
}

export interface WriteDocumentStateUpdate {
  content: string;
  completion: string;
}

export function getWriteDocumentEditState(nextContent: string): WriteDocumentStateUpdate {
  return {
    content: nextContent,
    completion: "",
  };
}

export function getWriteCompletionAcceptState(
  content: string,
  completion: string,
  selection: WriteEditorSelectionState = {
    selectionStart: content.length,
    selectionEnd: content.length,
  },
): WriteDocumentStateUpdate {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  return {
    content: `${content.slice(0, normalized.selectionStart)}${completion}${content.slice(
      normalized.selectionEnd,
    )}`,
    completion: "",
  };
}

export function getWriteCompletionRequestContext({
  content,
  selection,
  maxPrefixChars = WRITE_COMPLETION_PREFIX_MAX_CHARS,
  maxSuffixChars = WRITE_COMPLETION_SUFFIX_MAX_CHARS,
}: {
  content: string;
  selection: WriteEditorSelectionState;
  maxPrefixChars?: number;
  maxSuffixChars?: number;
}): { prefix: string; suffix: string } {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  const prefixStart = Math.max(0, normalized.selectionStart - Math.max(0, maxPrefixChars));
  const suffixEnd = Math.min(content.length, normalized.selectionEnd + Math.max(0, maxSuffixChars));
  return {
    prefix: content.slice(prefixStart, normalized.selectionStart),
    suffix: content.slice(normalized.selectionEnd, suffixEnd),
  };
}

export function shouldRequestWriteCompletion({
  activePath,
  workspaceRoot,
  prefix,
  minTrailingChars = COMPLETION_MIN_TRAILING_CHARS,
}: {
  activePath: string | null;
  workspaceRoot: string;
  prefix: string;
  minTrailingChars?: number;
}): boolean {
  return Boolean(activePath && workspaceRoot && prefix.trimEnd().length >= minTrailingChars);
}

export interface WriteAssistantPromptInput {
  prompt: string;
  activePath: string | null;
  content: string;
  savedContent: string;
  selection?: WriteEditorSelectionState;
  attachmentIds?: string[];
  mode?: "agent" | "plan";
  goalMode?: boolean;
}

export function buildWriteAssistantPrompt(
  input: WriteAssistantPromptInput,
): WriteAssistantPromptPayload | null {
  const prompt = input.prompt.trim();
  if (!prompt) return null;

  const currentFile = input.activePath ?? "none";
  const saveState = input.content === input.savedContent ? "saved" : "unsaved changes";
  const localContext = getWriteAssistantLocalContext({
    content: input.content,
    selection: input.selection ?? {
      selectionStart: input.content.length,
      selectionEnd: input.content.length,
    },
  });
  const contextLines = [
    `- Current Markdown file: ${currentFile}`,
    `- Current file save state: ${saveState}`,
  ];
  if (localContext) {
    contextLines.push(
      `- ${localContext.label}:`,
      localContext.text,
    );
  }
  return {
    text: [
      "Write workbench request:",
      prompt,
      "",
      "Context:",
      ...contextLines,
      "",
      "Respond with writing guidance or draft text. Do not claim that you changed files directly.",
    ].join("\n"),
    displayText: prompt,
    threadTitle: prompt,
    attachmentIds: input.attachmentIds ?? [],
    mode: input.mode ?? "agent",
    goalMode: input.goalMode ?? false,
  };
}

export function getWriteAssistantPromptText(
  text: string,
  attachmentCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (attachmentCount <= 0) return "";
  return t(
    attachmentCount === 1
      ? "composer.attachmentOnlyMessageSingle"
      : "composer.attachmentOnlyMessageMultiple",
  );
}

export function normalizeWriteDocumentPathInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .join("/");
}

export function isWriteMarkdownDocumentPath(path: string): boolean {
  return getWriteDocumentPathValidationError(path) === null;
}

export function getWriteDocumentPathValidationError(
  value: string,
): WriteDocumentPathValidationError | null {
  const normalized = normalizeWriteDocumentPathInput(value);
  if (!normalized) return "empty";
  if (normalized.endsWith("/")) return "directory";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment)) return "empty-segment";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "dot-segment";
  }
  if (/^[A-Za-z]:$/.test(segments[0] ?? "")) return "drive-root";
  const filename = segments.at(-1) ?? "";
  const extension = WRITE_MARKDOWN_EXTENSIONS.find((candidate) =>
    filename.toLowerCase().endsWith(candidate),
  );
  if (!extension) return "extension";
  if (!filename.slice(0, -extension.length).trim()) return "filename";
  return null;
}

export function getNextWriteDocumentPath(
  files: readonly Pick<WriteFileEntry, "path">[],
): string {
  const existing = new Set(files.map((file) => file.path.toLowerCase()));
  if (!existing.has("untitled.md")) return "untitled.md";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `untitled-${index}.md`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `untitled-${Date.now()}.md`;
}

export function getWriteAssistantVisibleItems(
  items: readonly Item[],
  limit = 80,
): Item[] {
  // Write and Code timelines share chronological turn grouping. Sorting before
  // windowing prevents replayed or late-updated items from splitting a turn at
  // the visible history boundary.
  const sortedItems = sortTimelineItems(items);
  if (sortedItems.length <= limit) return sortedItems;
  const limitedStartIndex = Math.max(0, sortedItems.length - limit);
  const firstLimitedTurnId = getTimelineItemTurnId(sortedItems[limitedStartIndex]);
  let startIndex = limitedStartIndex;
  while (
    startIndex > 0 &&
    getTimelineItemTurnId(sortedItems[startIndex - 1]) === firstLimitedTurnId
  ) {
    startIndex -= 1;
  }
  return sortedItems.slice(startIndex);
}

export interface WriteAssistantLocalContext {
  label: "Selected text" | "Nearby text";
  text: string;
}

export function getWriteAssistantLocalContext({
  content,
  selection,
  maxChars = WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  nearbyRadius = WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
}: {
  content: string;
  selection: WriteEditorSelectionState;
  maxChars?: number;
  nearbyRadius?: number;
}): WriteAssistantLocalContext | null {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  const selected = content
    .slice(normalized.selectionStart, normalized.selectionEnd)
    .trim();
  if (selected) {
    return {
      label: "Selected text",
      text: truncateWriteAssistantContext(selected, maxChars),
    };
  }

  const nearby = getWriteNearbyContext({
    content,
    caret: normalized.selectionStart,
    radius: nearbyRadius,
    maxChars,
  }).trim();
  return nearby
    ? {
        label: "Nearby text",
        text: nearby,
      }
    : null;
}

export function getWriteNearbyContext({
  content,
  caret,
  radius = WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
  maxChars = WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
}: {
  content: string;
  caret: number;
  radius?: number;
  maxChars?: number;
}): string {
  if (!content.trim()) return "";
  const normalizedCaret = Math.min(Math.max(0, caret), content.length);
  const start = Math.max(0, normalizedCaret - Math.max(0, radius));
  const end = Math.min(content.length, normalizedCaret + Math.max(0, radius));
  if (start === 0 && end === content.length) return "";
  const prefix = start > 0 ? "[...]\n" : "";
  const suffix = end < content.length ? "\n[...]" : "";
  return truncateWriteAssistantContext(`${prefix}${content.slice(start, end)}${suffix}`, maxChars);
}

export function truncateWriteAssistantContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 12) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 8)}\n[...]`;
}

export function normalizeWriteEditorSelection(
  selection: WriteEditorSelectionState,
  contentLength: number,
): WriteEditorSelectionState {
  const start = Math.min(Math.max(0, selection.selectionStart), contentLength);
  const end = Math.min(Math.max(0, selection.selectionEnd), contentLength);
  return {
    selectionStart: Math.min(start, end),
    selectionEnd: Math.max(start, end),
  };
}

export function isWriteEditorSelectionEqual(
  left: WriteEditorSelectionState,
  right: WriteEditorSelectionState,
): boolean {
  return left.selectionStart === right.selectionStart && left.selectionEnd === right.selectionEnd;
}

export function getWriteContextMenuPosition({
  clientX,
  clientY,
  viewportWidth,
  viewportHeight,
  menuWidth = WRITE_CONTEXT_MENU_WIDTH_PX,
  menuHeight = WRITE_CONTEXT_MENU_HEIGHT_PX,
  margin = WRITE_CONTEXT_MENU_VIEWPORT_MARGIN_PX,
}: {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
  margin?: number;
}): { x: number; y: number } {
  const safeMargin = Math.max(0, margin);
  const maxX = Math.max(safeMargin, viewportWidth - menuWidth - safeMargin);
  const maxY = Math.max(safeMargin, viewportHeight - menuHeight - safeMargin);
  return {
    x: Math.min(maxX, Math.max(safeMargin, clientX)),
    y: Math.min(maxY, Math.max(safeMargin, clientY)),
  };
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}
