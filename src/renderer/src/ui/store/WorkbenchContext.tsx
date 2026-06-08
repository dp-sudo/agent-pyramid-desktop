import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactElement,
  type ReactNode,
} from "react";
import { DEFAULT_MODEL_CONFIG } from "../../../../shared/agent-contracts";
import {
  DEFAULT_BASIC_PREFERENCES,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_INSPECTOR_DEFAULT_WIDTH,
  loadBasicPreferences,
  loadLastWorkspaceRoot,
  saveBasicPreferences,
  saveLastWorkspaceRoot,
  type WorkbenchBasicPreferences,
} from "../preferences";
import type {
  AttachmentRecord,
  Item,
  ModelConfig,
  ModelConfigProfilesState,
  ModelReasoningEffort,
  TerminalTurnStatus,
  ThreadRecord,
  ThreadSummary,
  TurnRecord,
  WriteFileEntry,
  WriteInlineEditAction,
  WriteMediaReference,
  WriteMemoryEvidence,
  WriteTreeNode,
  WriteWatchResponse,
} from "../../../../shared/agent-contracts";

export type WorkbenchRoute = "code" | "write" | "settings";
export type RightPanelMode = "changes" | "todo" | "plan" | "file" | null;
export type WriteSaveStatus = "idle" | "loading" | "saving" | "saved" | "error";
export type WritePreviewMode = "source" | "split" | "preview";
export type WriteCompletionStatus = "idle" | "pending" | "ready" | "error";

export interface WriteSelectionState {
  start: number;
  end: number;
  direction: "none" | "forward" | "backward";
}

export interface WriteRecentEdit {
  id: string;
  filePath: string;
  editedAt: string;
  start: number;
  end: number;
  beforeLength: number;
  afterLength: number;
  summary: string;
}

export interface WriteCompletionState {
  requestId: number;
  status: WriteCompletionStatus;
  text: string;
  score: number;
  truncated: boolean;
  error: string | null;
}

export interface WritePendingInlineEdit {
  id: string;
  action: WriteInlineEditAction;
  before: string;
  after: string;
}

export interface WriteMemoryState {
  query: string;
  loading: boolean;
  error: string | null;
  evidence: WriteMemoryEvidence[];
  expanded: boolean;
}

export interface WriteLifecycleState {
  tree: WriteTreeNode[];
  media: WriteMediaReference[];
  watch: WriteWatchResponse | null;
  readonly: boolean;
  readonlyReason: string | null;
  exportMarkdown: string | null;
  exportName: string | null;
}

export interface WriteWorkspaceState {
  workspace: string;
  files: WriteFileEntry[];
  activeFile: string | null;
  content: string;
  savedContent: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  status: WriteSaveStatus;
  selection: WriteSelectionState;
  previewMode: WritePreviewMode;
  assistantOpen: boolean;
  assistantDraft: string;
  recentEdits: WriteRecentEdit[];
  completionState: WriteCompletionState;
  pendingInlineEdit: WritePendingInlineEdit | null;
  memoryState: WriteMemoryState;
  lifecycleState: WriteLifecycleState;
  listLoading: boolean;
  search: string;
}

export interface ComposerAttachment extends AttachmentRecord {
  previewUrl?: string;
  thumbnailUrl?: string;
}

export interface ComposerState {
  text: string;
  model: string;
  modelProfileId?: string;
  reasoningEffort?: ModelReasoningEffort;
  mode: "agent" | "plan";
  goalMode: boolean;
  attachmentIds: string[];
  attachments: ComposerAttachment[];
}

export interface WorkbenchState {
  route: WorkbenchRoute;
  modelConfig: ModelConfig;
  modelProfiles: ModelConfigProfilesState | null;
  workspaceRoot: string;
  showArchivedThreads: boolean;
  threads: ThreadSummary[];
  activeThread: ThreadRecord | null;
  activeThreadId: string | null;
  activeTurnId: string | null;
  items: Item[];
  inFlightTurnsByThreadId: Record<string, TurnRecord>;
  rightPanelMode: RightPanelMode;
  composer: ComposerState;
  writeWorkspace: WriteWorkspaceState;
  errorMessage: string | null;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  basicPreferences: WorkbenchBasicPreferences;
}

const initialBasicPreferences = loadBasicPreferences();
const initialWorkspaceRoot = initialBasicPreferences.restoreLastWorkspaceOnStartup
  ? loadLastWorkspaceRoot()
  : "";

export const INITIAL_WRITE_SELECTION: WriteSelectionState = {
  start: 0,
  end: 0,
  direction: "none",
};

export function createInitialWriteMemoryState(): WriteMemoryState {
  return {
    query: "",
    loading: false,
    error: null,
    evidence: [],
    expanded: false,
  };
}

export function createInitialWriteLifecycleState(): WriteLifecycleState {
  return {
    tree: [],
    media: [],
    watch: null,
    readonly: false,
    readonlyReason: null,
    exportMarkdown: null,
    exportName: null,
  };
}

export function createInitialWriteWorkspaceState(
  workspace = "",
): WriteWorkspaceState {
  return withWriteDerivedState({
    workspace,
    files: [],
    activeFile: null,
    content: "",
    savedContent: "",
    dirty: false,
    saving: false,
    error: null,
    status: "idle",
    selection: INITIAL_WRITE_SELECTION,
    previewMode: "source",
    assistantOpen: true,
    assistantDraft: "",
    recentEdits: [],
    completionState: {
      requestId: 0,
      status: "idle",
      text: "",
      score: 0,
      truncated: false,
      error: null,
    },
    pendingInlineEdit: null,
    memoryState: createInitialWriteMemoryState(),
    lifecycleState: createInitialWriteLifecycleState(),
    listLoading: false,
    search: "",
  });
}

export const INITIAL_STATE: WorkbenchState = {
  route: initialBasicPreferences.defaultStartupView,
  modelConfig: DEFAULT_MODEL_CONFIG,
  modelProfiles: null,
  workspaceRoot: initialWorkspaceRoot,
  showArchivedThreads: initialBasicPreferences.showArchivedThreadsByDefault,
  threads: [],
  activeThread: null,
  activeThreadId: null,
  activeTurnId: null,
  items: [],
  inFlightTurnsByThreadId: {},
  rightPanelMode: initialBasicPreferences.defaultInspectorMode,
  composer: {
    text: "",
    model: DEFAULT_MODEL_CONFIG.model,
    reasoningEffort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    mode: "agent",
    goalMode: false,
    attachmentIds: [],
    attachments: [],
  },
  writeWorkspace: createInitialWriteWorkspaceState(initialWorkspaceRoot),
  errorMessage: null,
  leftSidebarWidth: initialBasicPreferences.rememberLeftSidebarWidth
    ? initialBasicPreferences.leftSidebarWidth
    : LEFT_SIDEBAR_DEFAULT_WIDTH,
  rightSidebarWidth: initialBasicPreferences.rememberRightSidebarWidth
    ? initialBasicPreferences.rightSidebarWidth
    : RIGHT_INSPECTOR_DEFAULT_WIDTH,
  basicPreferences: initialBasicPreferences,
};

function upsertItem(items: Item[], item: Item): Item[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function updateThreadActivity(
  thread: ThreadRecord,
  timestamp: string,
): ThreadRecord {
  if (Date.parse(timestamp) <= Date.parse(thread.updatedAt)) return thread;
  return { ...thread, updatedAt: timestamp };
}

function updateThreadSummaryActivity(
  threads: ThreadSummary[],
  threadId: string,
  timestamp: string,
): ThreadSummary[] {
  let changed = false;
  const next = threads.map((thread) => {
    if (thread.id !== threadId || Date.parse(timestamp) <= Date.parse(thread.updatedAt)) {
      return thread;
    }
    changed = true;
    return { ...thread, updatedAt: timestamp };
  });
  if (!changed) return threads;
  return next.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function withWriteDerivedState(state: WriteWorkspaceState): WriteWorkspaceState {
  return {
    ...state,
    dirty: state.content !== state.savedContent,
    saving: state.status === "saving",
  };
}

function normalizeWriteSelection(selection: WriteSelectionState): WriteSelectionState {
  const start = normalizeSelectionOffset(selection.start);
  const end = normalizeSelectionOffset(selection.end);
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    direction: selection.direction,
  };
}

function normalizeSelectionOffset(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function createWriteRecentEdit(input: {
  previousContent: string;
  nextContent: string;
  filePath: string | null;
  editedAt: string;
}): WriteRecentEdit | null {
  if (!input.filePath || input.previousContent === input.nextContent) return null;

  const start = getCommonPrefixLength(input.previousContent, input.nextContent);
  const suffix = getCommonSuffixLength(
    input.previousContent,
    input.nextContent,
    start,
  );
  const previousEnd = input.previousContent.length - suffix;
  const nextEnd = input.nextContent.length - suffix;
  const beforeLength = Math.max(0, previousEnd - start);
  const afterLength = Math.max(0, nextEnd - start);

  return {
    id: `${input.filePath}:${input.editedAt}:${start}:${beforeLength}:${afterLength}`,
    filePath: input.filePath,
    editedAt: input.editedAt,
    start,
    end: nextEnd,
    beforeLength,
    afterLength,
    summary: `Edited ${beforeLength} chars into ${afterLength} chars near ${start}.`,
  };
}

function getCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function getCommonSuffixLength(left: string, right: string, prefixLength: number): number {
  const maxSuffix = Math.min(left.length, right.length) - prefixLength;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return suffix;
}

export type Action =
  | { type: "setRoute"; route: WorkbenchRoute }
  | { type: "setModelConfig"; config: ModelConfig }
  | { type: "setModelProfiles"; profiles: ModelConfigProfilesState }
  | { type: "setWorkspaceRoot"; workspaceRoot: string }
  | { type: "setShowArchivedThreads"; show: boolean }
  | { type: "setThreads"; threads: ThreadSummary[] }
  | { type: "removeThread"; id: string }
  | { type: "selectThread"; thread: ThreadRecord; items: Item[] }
  | { type: "updateActiveThread"; thread: ThreadRecord }
  | { type: "deselectThread" }
  | { type: "appendItem"; item: Item }
  | { type: "updateItem"; item: Item }
  | { type: "turnStarted"; turn: TurnRecord }
  | {
      type: "turnEnded";
      threadId: string;
      status: TerminalTurnStatus;
    }
  | { type: "setComposerText"; text: string }
  | { type: "setComposerModel"; model: string; modelProfileId?: string }
  | { type: "setComposerReasoningEffort"; reasoningEffort: ModelReasoningEffort }
  | { type: "setComposerMode"; mode: "agent" | "plan" }
  | { type: "setComposerGoalMode"; enabled: boolean }
  | { type: "addComposerAttachment"; attachment: ComposerAttachment }
  | { type: "removeComposerAttachment"; attachmentId: string }
  | { type: "clearComposerAttachments" }
  | { type: "setWriteWorkspace"; workspace: string }
  | { type: "setWriteFiles"; files: WriteFileEntry[] }
  | { type: "setWriteListLoading"; listLoading: boolean }
  | { type: "setWriteSearch"; search: string }
  | { type: "clearWriteFileStateForWorkspace"; workspace: string }
  | {
      type: "openWriteFile";
      path: string;
      content: string;
      readonly?: boolean;
      readonlyReason?: string | null;
    }
  | { type: "editWriteDocument"; content: string; editedAt: string }
  | { type: "markWriteSaved"; content: string }
  | { type: "setWriteStatus"; status: WriteSaveStatus }
  | { type: "setWriteError"; message: string | null }
  | { type: "setWriteSelection"; selection: WriteSelectionState }
  | { type: "setWritePreviewMode"; previewMode: WritePreviewMode }
  | { type: "setWriteAssistantOpen"; open: boolean }
  | { type: "setWriteAssistantDraft"; text: string }
  | { type: "setWriteCompletionState"; completionState: WriteCompletionState }
  | { type: "setWritePendingInlineEdit"; pendingInlineEdit: WritePendingInlineEdit | null }
  | { type: "setWriteMemoryState"; memoryState: WriteMemoryState }
  | { type: "setWriteLifecycleState"; lifecycleState: WriteLifecycleState }
  | { type: "openRightPanel"; mode: Exclude<RightPanelMode, null> }
  | { type: "closeRightPanel" }
  | { type: "setError"; message: string | null }
  | { type: "setLeftSidebarWidth"; width: number }
  | { type: "setRightSidebarWidth"; width: number }
  | BasicPreferenceAction;

type BasicPreferenceAction = {
  [K in keyof WorkbenchBasicPreferences]: {
    type: "updateBasicPreference";
    key: K;
    value: WorkbenchBasicPreferences[K];
  };
}[keyof WorkbenchBasicPreferences];

export function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case "setRoute":
      return { ...state, route: action.route };
    case "setModelConfig":
      return {
        ...state,
        modelConfig: action.config,
        composer: {
          ...state.composer,
          model: action.config.model,
          reasoningEffort: action.config.model_reasoning_effort,
        },
      };
    case "setModelProfiles": {
      const activeProfileChanged =
        state.modelProfiles?.activeProfileId !== undefined &&
        state.modelProfiles.activeProfileId !== action.profiles.activeProfileId;
      const currentProfile = state.composer.modelProfileId
        ? action.profiles.profiles.find(
            (profile) => profile.id === state.composer.modelProfileId,
          )
        : undefined;
      const activeProfile =
        action.profiles.profiles.find(
          (profile) => profile.id === action.profiles.activeProfileId,
        ) ?? action.profiles.profiles[0];
      const selectedProfile = activeProfileChanged
        ? activeProfile
        : currentProfile ?? activeProfile;
      return {
        ...state,
        modelProfiles: action.profiles,
        ...(selectedProfile
          ? {
              composer: {
                ...state.composer,
                model: selectedProfile.config.model,
                modelProfileId: selectedProfile.id,
                reasoningEffort: selectedProfile.config.model_reasoning_effort,
              },
            }
          : {}),
      };
    }
    case "setWorkspaceRoot":
      if (state.basicPreferences.restoreLastWorkspaceOnStartup) {
        saveLastWorkspaceRoot(action.workspaceRoot);
      }
      return { ...state, workspaceRoot: action.workspaceRoot };
    case "setShowArchivedThreads": {
      const nextPreferences = saveBasicPreferences({
        ...state.basicPreferences,
        showArchivedThreadsByDefault: action.show,
      });
      return {
        ...state,
        showArchivedThreads: action.show,
        basicPreferences: nextPreferences,
      };
    }
    case "setThreads":
      return { ...state, threads: action.threads };
    case "removeThread": {
      const removingActive = state.activeThreadId === action.id;
      return {
        ...state,
        threads: state.threads.filter((thread) => thread.id !== action.id),
        ...(removingActive
          ? {
              activeThread: null,
              activeThreadId: null,
              activeTurnId: null,
              items: [],
              inFlightTurnsByThreadId: omitRecordKey(state.inFlightTurnsByThreadId, action.id),
              rightPanelMode: null,
            }
          : {}),
      };
    }
    case "selectThread":
      if (state.basicPreferences.restoreLastWorkspaceOnStartup) {
        saveLastWorkspaceRoot(action.thread.workspace || state.workspaceRoot);
      }
      return {
        ...state,
        activeThread: action.thread,
        activeThreadId: action.thread.id,
        workspaceRoot: action.thread.workspace || state.workspaceRoot,
        writeWorkspace: action.thread.mode === "write"
          ? withWriteDerivedState({
              ...state.writeWorkspace,
              workspace: action.thread.workspace || state.writeWorkspace.workspace,
            })
          : state.writeWorkspace,
        items: action.items,
        activeTurnId: state.inFlightTurnsByThreadId[action.thread.id]?.id ?? null,
      };
    case "deselectThread":
      return {
        ...state,
        activeThread: null,
        activeThreadId: null,
        items: [],
        activeTurnId: null,
      };
    case "updateActiveThread":
      return {
        ...state,
        activeThread: action.thread,
        activeThreadId: action.thread.id,
      };
    case "appendItem":
      return { ...state, items: upsertItem(state.items, action.item) };
    case "updateItem":
      return { ...state, items: upsertItem(state.items, action.item) };
    case "turnStarted":
      return {
        ...state,
        activeTurnId: state.activeThreadId === action.turn.threadId ? action.turn.id : state.activeTurnId,
        activeThread: state.activeThread?.id === action.turn.threadId
          ? updateThreadActivity(state.activeThread, action.turn.startedAt)
          : state.activeThread,
        threads: updateThreadSummaryActivity(
          state.threads,
          action.turn.threadId,
          action.turn.startedAt,
        ),
        inFlightTurnsByThreadId: {
          ...state.inFlightTurnsByThreadId,
          [action.turn.threadId]: {
            ...state.inFlightTurnsByThreadId[action.turn.threadId],
            ...action.turn,
          },
        },
      };
    case "turnEnded":
      return {
        ...state,
        activeTurnId: state.activeThreadId === action.threadId ? null : state.activeTurnId,
        inFlightTurnsByThreadId: omitRecordKey(state.inFlightTurnsByThreadId, action.threadId),
      };
    case "setComposerText":
      return { ...state, composer: { ...state.composer, text: action.text } };
    case "setComposerModel":
      return {
        ...state,
        composer: {
          ...state.composer,
          model: action.model,
          modelProfileId: action.modelProfileId,
        },
      };
    case "setComposerReasoningEffort":
      return {
        ...state,
        composer: { ...state.composer, reasoningEffort: action.reasoningEffort },
      };
    case "setComposerMode":
      return { ...state, composer: { ...state.composer, mode: action.mode } };
    case "setComposerGoalMode":
      return { ...state, composer: { ...state.composer, goalMode: action.enabled } };
    case "addComposerAttachment": {
      const hasAttachmentId = state.composer.attachmentIds.includes(action.attachment.id);
      const hasAttachmentRecord = state.composer.attachments.some(
        (attachment) => attachment.id === action.attachment.id,
      );
      return {
        ...state,
        composer: {
          ...state.composer,
          attachmentIds: hasAttachmentId
            ? state.composer.attachmentIds
            : [...state.composer.attachmentIds, action.attachment.id],
          attachments: hasAttachmentRecord
            ? state.composer.attachments
            : [...state.composer.attachments, action.attachment],
        },
      };
    }
    case "removeComposerAttachment":
      return {
        ...state,
        composer: {
          ...state.composer,
          attachmentIds: state.composer.attachmentIds.filter(
            (id) => id !== action.attachmentId,
          ),
          attachments: state.composer.attachments.filter(
            (attachment) => attachment.id !== action.attachmentId,
          ),
        },
      };
    case "clearComposerAttachments":
      return {
        ...state,
        composer: { ...state.composer, attachmentIds: [], attachments: [] },
      };
    case "setWriteWorkspace":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          workspace: action.workspace,
        }),
      };
    case "setWriteFiles":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          files: action.files,
        }),
      };
    case "setWriteListLoading":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          listLoading: action.listLoading,
        }),
      };
    case "setWriteSearch":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          search: action.search,
        }),
      };
    case "clearWriteFileStateForWorkspace":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          workspace: action.workspace,
          files: [],
          activeFile: null,
          content: "",
          savedContent: "",
          error: null,
          status: "loading",
          selection: INITIAL_WRITE_SELECTION,
          recentEdits: [],
          pendingInlineEdit: null,
          memoryState: createInitialWriteMemoryState(),
          lifecycleState: createInitialWriteLifecycleState(),
          completionState: {
            ...state.writeWorkspace.completionState,
            requestId: state.writeWorkspace.completionState.requestId + 1,
            status: "idle",
            text: "",
            score: 0,
            truncated: false,
            error: null,
          },
        }),
      };
    case "openWriteFile":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          activeFile: action.path,
          content: action.content,
          savedContent: action.content,
          error: null,
          status: "idle",
          selection: INITIAL_WRITE_SELECTION,
          recentEdits: [],
          pendingInlineEdit: null,
          memoryState: createInitialWriteMemoryState(),
          lifecycleState: {
            ...createInitialWriteLifecycleState(),
            readonly: Boolean(action.readonly),
            readonlyReason: action.readonlyReason ?? null,
          },
          completionState: {
            ...state.writeWorkspace.completionState,
            requestId: state.writeWorkspace.completionState.requestId + 1,
            status: "idle",
            text: "",
            score: 0,
            truncated: false,
            error: null,
          },
        }),
      };
    case "editWriteDocument": {
      const recentEdit = createWriteRecentEdit({
        previousContent: state.writeWorkspace.content,
        nextContent: action.content,
        filePath: state.writeWorkspace.activeFile,
        editedAt: action.editedAt,
      });
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          content: action.content,
          recentEdits: recentEdit
            ? [recentEdit, ...state.writeWorkspace.recentEdits].slice(0, 12)
            : state.writeWorkspace.recentEdits,
          pendingInlineEdit: null,
          completionState: {
            ...state.writeWorkspace.completionState,
            requestId: state.writeWorkspace.completionState.requestId + 1,
            status: "idle",
            text: "",
            score: 0,
            truncated: false,
            error: null,
          },
        }),
      };
    }
    case "markWriteSaved":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          savedContent: action.content,
          error: null,
          status: state.writeWorkspace.content === action.content ? "saved" : "saving",
        }),
      };
    case "setWriteStatus":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          status: action.status,
        }),
      };
    case "setWriteError":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          error: action.message,
          ...(action.message ? { status: "error" as const } : {}),
        }),
      };
    case "setWriteSelection":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          selection: normalizeWriteSelection(action.selection),
        }),
      };
    case "setWritePreviewMode":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          previewMode: action.previewMode,
        }),
      };
    case "setWriteAssistantOpen":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          assistantOpen: action.open,
        }),
      };
    case "setWriteAssistantDraft":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          assistantDraft: action.text,
        }),
      };
    case "setWriteCompletionState":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          completionState: action.completionState,
        }),
      };
    case "setWritePendingInlineEdit":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          pendingInlineEdit: action.pendingInlineEdit,
        }),
      };
    case "setWriteMemoryState":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          memoryState: action.memoryState,
        }),
      };
    case "setWriteLifecycleState":
      return {
        ...state,
        writeWorkspace: withWriteDerivedState({
          ...state.writeWorkspace,
          lifecycleState: action.lifecycleState,
        }),
      };
    case "openRightPanel":
      return { ...state, rightPanelMode: action.mode };
    case "closeRightPanel":
      return { ...state, rightPanelMode: null };
    case "setError":
      return { ...state, errorMessage: action.message };
    case "setLeftSidebarWidth":
      return {
        ...state,
        leftSidebarWidth: action.width,
        basicPreferences: state.basicPreferences.rememberLeftSidebarWidth
          ? saveBasicPreferences({
              ...state.basicPreferences,
              leftSidebarWidth: action.width,
            })
          : state.basicPreferences,
      };
    case "setRightSidebarWidth":
      return {
        ...state,
        rightSidebarWidth: action.width,
        basicPreferences: state.basicPreferences.rememberRightSidebarWidth
          ? saveBasicPreferences({
              ...state.basicPreferences,
              rightSidebarWidth: action.width,
            })
          : state.basicPreferences,
      };
    case "updateBasicPreference": {
      const draftPreferences = {
        ...state.basicPreferences,
        [action.key]: action.value,
      };
      if (action.key === "rememberLeftSidebarWidth") {
        draftPreferences.leftSidebarWidth = action.value
          ? state.leftSidebarWidth
          : DEFAULT_BASIC_PREFERENCES.leftSidebarWidth;
      }
      if (action.key === "rememberRightSidebarWidth") {
        draftPreferences.rightSidebarWidth = action.value
          ? state.rightSidebarWidth
          : DEFAULT_BASIC_PREFERENCES.rightSidebarWidth;
      }
      if (
        action.key === "restoreLastWorkspaceOnStartup" &&
        action.value &&
        state.workspaceRoot
      ) {
        saveLastWorkspaceRoot(state.workspaceRoot);
      }
      const nextPreferences = saveBasicPreferences(draftPreferences);
      return {
        ...state,
        basicPreferences: nextPreferences,
        ...(action.key === "showArchivedThreadsByDefault"
          ? { showArchivedThreads: nextPreferences.showArchivedThreadsByDefault }
          : {}),
        ...(action.key === "rememberLeftSidebarWidth" &&
        !nextPreferences.rememberLeftSidebarWidth
          ? { leftSidebarWidth: DEFAULT_BASIC_PREFERENCES.leftSidebarWidth }
          : {}),
        ...(action.key === "rememberRightSidebarWidth" &&
        !nextPreferences.rememberRightSidebarWidth
          ? { rightSidebarWidth: DEFAULT_BASIC_PREFERENCES.rightSidebarWidth }
          : {}),
        ...(action.key === "defaultInspectorMode"
          ? { rightPanelMode: nextPreferences.defaultInspectorMode }
          : {}),
        ...(action.key === "restoreLastWorkspaceOnStartup" &&
        nextPreferences.restoreLastWorkspaceOnStartup
          ? { workspaceRoot: state.workspaceRoot || loadLastWorkspaceRoot() }
          : {}),
      };
    }
    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}

function omitRecordKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  void _removed;
  return rest;
}

export function getThreadInFlightTurn(
  state: WorkbenchState,
  threadId: string | null,
): TurnRecord | null {
  if (!threadId) return null;
  return state.inFlightTurnsByThreadId[threadId] ?? null;
}

export function getActiveThreadInFlightTurn(state: WorkbenchState): TurnRecord | null {
  return getThreadInFlightTurn(state, state.activeThreadId);
}

export interface WorkbenchActions {
  setRoute(route: WorkbenchRoute): void;
  setModelConfig(config: ModelConfig): void;
  setModelProfiles(profiles: ModelConfigProfilesState): void;
  setWorkspaceRoot(workspaceRoot: string): void;
  setShowArchivedThreads(show: boolean): void;
  setThreads(threads: ThreadSummary[]): void;
  removeThread(id: string): void;
  selectThread(thread: ThreadRecord, items: Item[]): void;
  updateActiveThread(thread: ThreadRecord): void;
  deselectThread(): void;
  appendItem(item: Item): void;
  updateItem(item: Item): void;
  turnStarted(turn: TurnRecord): void;
  turnEnded(
    threadId: string,
    status: TerminalTurnStatus,
  ): void;
  setComposerText(text: string): void;
  setComposerModel(model: string, modelProfileId?: string): void;
  setComposerReasoningEffort(reasoningEffort: ModelReasoningEffort): void;
  setComposerMode(mode: "agent" | "plan"): void;
  setComposerGoalMode(enabled: boolean): void;
  addComposerAttachment(attachment: ComposerAttachment): void;
  removeComposerAttachment(attachmentId: string): void;
  clearComposerAttachments(): void;
  setWriteWorkspace(workspace: string): void;
  setWriteFiles(files: WriteFileEntry[]): void;
  setWriteListLoading(listLoading: boolean): void;
  setWriteSearch(search: string): void;
  clearWriteFileStateForWorkspace(workspace: string): void;
  openWriteFile(
    path: string,
    content: string,
    options?: { readonly?: boolean; readonlyReason?: string | null },
  ): void;
  editWriteDocument(content: string, editedAt?: string): void;
  markWriteSaved(content: string): void;
  setWriteStatus(status: WriteSaveStatus): void;
  setWriteError(message: string | null): void;
  setWriteSelection(selection: WriteSelectionState): void;
  setWritePreviewMode(previewMode: WritePreviewMode): void;
  setWriteAssistantOpen(open: boolean): void;
  setWriteAssistantDraft(text: string): void;
  setWriteCompletionState(completionState: WriteCompletionState): void;
  setWritePendingInlineEdit(pendingInlineEdit: WritePendingInlineEdit | null): void;
  setWriteMemoryState(memoryState: WriteMemoryState): void;
  setWriteLifecycleState(lifecycleState: WriteLifecycleState): void;
  openRightPanel(mode: Exclude<RightPanelMode, null>): void;
  closeRightPanel(): void;
  setError(message: string | null): void;
  setLeftSidebarWidth(width: number): void;
  setRightSidebarWidth(width: number): void;
  updateBasicPreference<K extends keyof WorkbenchBasicPreferences>(
    key: K,
    value: WorkbenchBasicPreferences[K],
  ): void;
}

export interface WorkbenchContextValue {
  state: WorkbenchState;
  actions: WorkbenchActions;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const actions = useMemo<WorkbenchActions>(
    () => ({
      setRoute: (route) => dispatch({ type: "setRoute", route }),
      setModelConfig: (config) => dispatch({ type: "setModelConfig", config }),
      setModelProfiles: (profiles) => dispatch({ type: "setModelProfiles", profiles }),
      setWorkspaceRoot: (workspaceRoot) =>
        dispatch({ type: "setWorkspaceRoot", workspaceRoot }),
      setShowArchivedThreads: (show) =>
        dispatch({ type: "setShowArchivedThreads", show }),
      setThreads: (threads) => dispatch({ type: "setThreads", threads }),
      removeThread: (id) => dispatch({ type: "removeThread", id }),
      selectThread: (thread, items) => dispatch({ type: "selectThread", thread, items }),
      updateActiveThread: (thread) => dispatch({ type: "updateActiveThread", thread }),
      deselectThread: () => dispatch({ type: "deselectThread" }),
      appendItem: (item) => dispatch({ type: "appendItem", item }),
      updateItem: (item) => dispatch({ type: "updateItem", item }),
      turnStarted: (turn) => dispatch({ type: "turnStarted", turn }),
      turnEnded: (threadId, status) => dispatch({ type: "turnEnded", threadId, status }),
      setComposerText: (text) => dispatch({ type: "setComposerText", text }),
      setComposerModel: (model, modelProfileId) =>
        dispatch({ type: "setComposerModel", model, modelProfileId }),
      setComposerReasoningEffort: (reasoningEffort) =>
        dispatch({ type: "setComposerReasoningEffort", reasoningEffort }),
      setComposerMode: (mode) => dispatch({ type: "setComposerMode", mode }),
      setComposerGoalMode: (enabled) =>
        dispatch({ type: "setComposerGoalMode", enabled }),
      addComposerAttachment: (attachment) =>
        dispatch({ type: "addComposerAttachment", attachment }),
      removeComposerAttachment: (attachmentId) =>
        dispatch({ type: "removeComposerAttachment", attachmentId }),
      clearComposerAttachments: () => dispatch({ type: "clearComposerAttachments" }),
      setWriteWorkspace: (workspace) => dispatch({ type: "setWriteWorkspace", workspace }),
      setWriteFiles: (files) => dispatch({ type: "setWriteFiles", files }),
      setWriteListLoading: (listLoading) =>
        dispatch({ type: "setWriteListLoading", listLoading }),
      setWriteSearch: (search) => dispatch({ type: "setWriteSearch", search }),
      clearWriteFileStateForWorkspace: (workspace) =>
        dispatch({ type: "clearWriteFileStateForWorkspace", workspace }),
      openWriteFile: (path, content, options) =>
        dispatch({
          type: "openWriteFile",
          path,
          content,
          readonly: options?.readonly,
          readonlyReason: options?.readonlyReason,
        }),
      editWriteDocument: (content, editedAt = new Date().toISOString()) =>
        dispatch({ type: "editWriteDocument", content, editedAt }),
      markWriteSaved: (content) => dispatch({ type: "markWriteSaved", content }),
      setWriteStatus: (status) => dispatch({ type: "setWriteStatus", status }),
      setWriteError: (message) => dispatch({ type: "setWriteError", message }),
      setWriteSelection: (selection) =>
        dispatch({ type: "setWriteSelection", selection }),
      setWritePreviewMode: (previewMode) =>
        dispatch({ type: "setWritePreviewMode", previewMode }),
      setWriteAssistantOpen: (open) =>
        dispatch({ type: "setWriteAssistantOpen", open }),
      setWriteAssistantDraft: (text) =>
        dispatch({ type: "setWriteAssistantDraft", text }),
      setWriteCompletionState: (completionState) =>
        dispatch({ type: "setWriteCompletionState", completionState }),
      setWritePendingInlineEdit: (pendingInlineEdit) =>
        dispatch({ type: "setWritePendingInlineEdit", pendingInlineEdit }),
      setWriteMemoryState: (memoryState) =>
        dispatch({ type: "setWriteMemoryState", memoryState }),
      setWriteLifecycleState: (lifecycleState) =>
        dispatch({ type: "setWriteLifecycleState", lifecycleState }),
      openRightPanel: (mode) => dispatch({ type: "openRightPanel", mode }),
      closeRightPanel: () => dispatch({ type: "closeRightPanel" }),
      setError: (message) => dispatch({ type: "setError", message }),
      setLeftSidebarWidth: (width) => dispatch({ type: "setLeftSidebarWidth", width }),
      setRightSidebarWidth: (width) => dispatch({ type: "setRightSidebarWidth", width }),
      updateBasicPreference: (key, value) =>
        dispatch({ type: "updateBasicPreference", key, value } as BasicPreferenceAction),
    }),
    [],
  );

  return (
    <WorkbenchContext.Provider value={{ state, actions }}>
      {children}
    </WorkbenchContext.Provider>
  );
}

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench must be used within WorkbenchProvider");
  return ctx;
}

export function useWorkbenchActions(): WorkbenchActions {
  return useWorkbench().actions;
}

// Convenience for component code that only needs the current active thread id.
export function useActiveThreadId(): string | null {
  return useWorkbench().state.activeThreadId;
}
