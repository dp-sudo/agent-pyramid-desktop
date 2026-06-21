import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RENDERER_MODEL_CONFIG,
  DEFAULT_RUNTIME_PREFERENCES,
} from "../../../../shared/agent-contracts";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_INSPECTOR_DEFAULT_WIDTH,
  loadBasicPreferences,
  loadLastWorkspaceRoot,
  type WorkbenchBasicPreferences,
} from "../preferences";
import type {
  AttachmentRecord,
  Item,
  ModelReasoningEffort,
  RendererModelConfig,
  RendererModelConfigProfilesState,
  RuntimePreferences,
  TerminalTurnStatus,
  ThreadRecord,
  ThreadSummary,
  TurnRecord,
} from "../../../../shared/agent-contracts";
import {
  appendToolProgressToItems,
  type ToolProgressUpdate,
} from "./tool-progress-model";
import {
  applyModelConfigToComposer,
  applyModelProfilesToComposer,
  selectComposerModel,
} from "./composer-model-model";
import {
  applyLeftSidebarWidthPreference,
  applyBasicPreferenceUpdate,
  applyRightSidebarWidthPreference,
  applyShowArchivedThreadsPreference,
  persistBasicPreferences,
  persistWorkspaceRootWhenRestored,
  type BasicPreferenceAction,
} from "./basic-preferences-state";

export type { ToolProgressUpdate } from "./tool-progress-model";

export type WorkbenchRoute = "code" | "write" | "settings";
export type RightPanelMode = "changes" | "checkpoints" | "todo" | "plan" | null;

export interface ComposerAttachment extends AttachmentRecord {
  previewUrl?: string;
  thumbnailUrl?: string;
}

export interface ComposerState {
  text: string;
  model: string;
  modelProfileId?: string;
  modelProfileSelection: "auto" | "explicit";
  reasoningEffort?: ModelReasoningEffort;
  mode: "agent" | "plan";
  goalMode: boolean;
  attachmentIds: string[];
  attachments: ComposerAttachment[];
}

export interface WorkbenchState {
  route: WorkbenchRoute;
  lastWorkbenchRoute: Extract<WorkbenchRoute, "code" | "write">;
  modelConfig: RendererModelConfig;
  modelProfiles: RendererModelConfigProfilesState | null;
  runtimePreferences: RuntimePreferences;
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
  errorMessage: string | null;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  basicPreferences: WorkbenchBasicPreferences;
}

const initialBasicPreferences = loadBasicPreferences();

export const INITIAL_STATE: WorkbenchState = {
  route: initialBasicPreferences.defaultStartupView,
  lastWorkbenchRoute: initialBasicPreferences.defaultStartupView,
  modelConfig: DEFAULT_RENDERER_MODEL_CONFIG,
  modelProfiles: null,
  runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
  workspaceRoot: initialBasicPreferences.restoreLastWorkspaceOnStartup
    ? loadLastWorkspaceRoot()
    : "",
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
    modelProfileSelection: "auto",
    reasoningEffort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    mode: "agent",
    goalMode: false,
    attachmentIds: [],
    attachments: [],
  },
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

export function shouldDeselectActiveThreadForRoute(
  route: WorkbenchRoute,
  thread: ThreadRecord | null,
): boolean {
  return isWorkbenchRoute(route) && thread !== null && thread.mode !== route;
}

export type Action =
  | { type: "setRoute"; route: WorkbenchRoute }
  | { type: "setModelConfig"; config: RendererModelConfig }
  | { type: "setModelProfiles"; profiles: RendererModelConfigProfilesState }
  | { type: "setRuntimePreferences"; preferences: RuntimePreferences }
  | { type: "setWorkspaceRoot"; workspaceRoot: string }
  | { type: "setShowArchivedThreads"; show: boolean }
  | { type: "setThreads"; threads: ThreadSummary[] }
  | { type: "removeThread"; id: string }
  | { type: "selectThread"; thread: ThreadRecord; items: Item[] }
  | { type: "updateActiveThread"; thread: ThreadRecord }
  | { type: "deselectThread" }
  | { type: "appendItem"; item: Item }
  | { type: "updateItem"; item: Item }
  | { type: "appendToolProgress"; progress: ToolProgressUpdate }
  | { type: "turnStarted"; turn: TurnRecord }
  | {
      type: "turnEnded";
      threadId: string;
      status: TerminalTurnStatus;
    }
  | { type: "setComposerText"; text: string }
  | {
      type: "setComposerModel";
      model: string;
      modelProfileId?: string;
      modelProfileSelection?: ComposerState["modelProfileSelection"];
    }
  | { type: "setComposerReasoningEffort"; reasoningEffort: ModelReasoningEffort }
  | { type: "setComposerMode"; mode: "agent" | "plan" }
  | { type: "setComposerGoalMode"; enabled: boolean }
  | { type: "addComposerAttachment"; attachment: ComposerAttachment }
  | { type: "removeComposerAttachment"; attachmentId: string }
  | { type: "clearComposerAttachments" }
  | { type: "openRightPanel"; mode: Exclude<RightPanelMode, null> }
  | { type: "closeRightPanel" }
  | { type: "setError"; message: string | null }
  | { type: "setLeftSidebarWidth"; width: number }
  | { type: "setRightSidebarWidth"; width: number }
  | BasicPreferenceAction;

export function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case "setRoute":
      /*
       * Code and Write threads share renderer state but must not share the
       * active timeline. Switching between workbench modes clears only the
       * in-memory selection when the selected thread belongs to the other
       * mode; persisted thread data remains owned by the main-process store.
       */
      return {
        ...state,
        route: action.route,
        lastWorkbenchRoute: isWorkbenchRoute(action.route)
          ? action.route
          : state.lastWorkbenchRoute,
        ...(shouldDeselectActiveThreadForRoute(action.route, state.activeThread)
          ? {
              activeThread: null,
              activeThreadId: null,
              activeTurnId: null,
              items: [],
              rightPanelMode: null,
            }
          : {}),
      };
    case "setModelConfig":
      return {
        ...state,
        modelConfig: action.config,
        composer: applyModelConfigToComposer(state.composer, action.config),
      };
    case "setModelProfiles":
      return {
        ...state,
        modelProfiles: action.profiles,
        composer: applyModelProfilesToComposer(state.composer, action.profiles),
      };
    case "setRuntimePreferences":
      return {
        ...state,
        runtimePreferences: action.preferences,
      };
    case "setWorkspaceRoot":
      return { ...state, workspaceRoot: action.workspaceRoot };
    case "setShowArchivedThreads": {
      return {
        ...state,
        ...applyShowArchivedThreadsPreference(state.basicPreferences, action.show),
      };
    }
    case "setThreads":
      return { ...state, threads: action.threads };
    case "removeThread": {
      const removingActive = state.activeThreadId === action.id;
      const inFlightTurnsByThreadId = omitRecordKey(
        state.inFlightTurnsByThreadId,
        action.id,
      );
      return {
        ...state,
        threads: state.threads.filter((thread) => thread.id !== action.id),
        inFlightTurnsByThreadId,
        ...(removingActive
          ? {
              activeThread: null,
              activeThreadId: null,
              activeTurnId: null,
              items: [],
              rightPanelMode: null,
            }
          : {}),
      };
    }
    case "selectThread":
      return {
        ...state,
        activeThread: action.thread,
        activeThreadId: action.thread.id,
        workspaceRoot: action.thread.workspace || state.workspaceRoot,
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
        rightPanelMode: null,
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
    case "appendToolProgress": {
      if (state.activeThreadId !== action.progress.threadId) return state;
      const items = appendToolProgressToItems(state.items, action.progress);
      return items === state.items ? state : { ...state, items };
    }
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
        composer: selectComposerModel(
          state.composer,
          action.model,
          action.modelProfileId,
          action.modelProfileSelection,
        ),
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
    case "openRightPanel":
      return { ...state, rightPanelMode: action.mode };
    case "closeRightPanel":
      return { ...state, rightPanelMode: null };
    case "setError":
      return { ...state, errorMessage: action.message };
    case "setLeftSidebarWidth":
      return {
        ...state,
        ...applyLeftSidebarWidthPreference(state.basicPreferences, action.width),
      };
    case "setRightSidebarWidth":
      return {
        ...state,
        ...applyRightSidebarWidthPreference(state.basicPreferences, action.width),
      };
    case "updateBasicPreference":
      return {
        ...state,
        ...applyBasicPreferenceUpdate(state, action),
      };
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
  const next: Record<string, T> = { ...record };
  delete next[key];
  return next;
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
  setModelConfig(config: RendererModelConfig): void;
  setModelProfiles(profiles: RendererModelConfigProfilesState): void;
  setRuntimePreferences(preferences: RuntimePreferences): void;
  setWorkspaceRoot(workspaceRoot: string): void;
  setShowArchivedThreads(show: boolean): void;
  setThreads(threads: ThreadSummary[]): void;
  removeThread(id: string): void;
  selectThread(thread: ThreadRecord, items: Item[]): void;
  updateActiveThread(thread: ThreadRecord): void;
  deselectThread(): void;
  appendItem(item: Item): void;
  updateItem(item: Item): void;
  appendToolProgress(progress: ToolProgressUpdate): void;
  turnStarted(turn: TurnRecord): void;
  turnEnded(
    threadId: string,
    status: TerminalTurnStatus,
  ): void;
  setComposerText(text: string): void;
  setComposerModel(
    model: string,
    modelProfileId?: string,
    modelProfileSelection?: ComposerState["modelProfileSelection"],
  ): void;
  setComposerReasoningEffort(reasoningEffort: ModelReasoningEffort): void;
  setComposerMode(mode: "agent" | "plan"): void;
  setComposerGoalMode(enabled: boolean): void;
  addComposerAttachment(attachment: ComposerAttachment): void;
  removeComposerAttachment(attachmentId: string): void;
  clearComposerAttachments(): void;
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

export function createWorkbenchActions(
  getState: () => WorkbenchState,
  dispatch: (action: Action) => void,
): WorkbenchActions {
  return {
    setRoute: (route) => dispatch({ type: "setRoute", route }),
    setModelConfig: (config) => dispatch({ type: "setModelConfig", config }),
    setModelProfiles: (profiles) => dispatch({ type: "setModelProfiles", profiles }),
    setRuntimePreferences: (preferences) =>
      dispatch({ type: "setRuntimePreferences", preferences }),
    setWorkspaceRoot: (workspaceRoot) => {
      const state = getState();
      persistWorkspaceRootWhenRestored(state.basicPreferences, workspaceRoot);
      dispatch({ type: "setWorkspaceRoot", workspaceRoot });
    },
    setShowArchivedThreads: (show) => {
      const state = getState();
      persistBasicPreferences({
        ...state.basicPreferences,
        showArchivedThreadsByDefault: show,
      });
      dispatch({ type: "setShowArchivedThreads", show });
    },
    setThreads: (threads) => dispatch({ type: "setThreads", threads }),
    removeThread: (id) => dispatch({ type: "removeThread", id }),
    selectThread: (thread, items) => {
      const state = getState();
      persistWorkspaceRootWhenRestored(
        state.basicPreferences,
        thread.workspace || state.workspaceRoot,
      );
      dispatch({ type: "selectThread", thread, items });
    },
    updateActiveThread: (thread) => dispatch({ type: "updateActiveThread", thread }),
    deselectThread: () => dispatch({ type: "deselectThread" }),
    appendItem: (item) => dispatch({ type: "appendItem", item }),
    updateItem: (item) => dispatch({ type: "updateItem", item }),
    appendToolProgress: (progress) =>
      dispatch({ type: "appendToolProgress", progress }),
    turnStarted: (turn) => dispatch({ type: "turnStarted", turn }),
    turnEnded: (threadId, status) => dispatch({ type: "turnEnded", threadId, status }),
    setComposerText: (text) => dispatch({ type: "setComposerText", text }),
    setComposerModel: (model, modelProfileId, modelProfileSelection) =>
      dispatch({ type: "setComposerModel", model, modelProfileId, modelProfileSelection }),
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
    openRightPanel: (mode) => dispatch({ type: "openRightPanel", mode }),
    closeRightPanel: () => dispatch({ type: "closeRightPanel" }),
    setError: (message) => dispatch({ type: "setError", message }),
    setLeftSidebarWidth: (width) => {
      const state = getState();
      if (state.basicPreferences.rememberLeftSidebarWidth) {
        persistBasicPreferences({
          ...state.basicPreferences,
          leftSidebarWidth: width,
        });
      }
      dispatch({ type: "setLeftSidebarWidth", width });
    },
    setRightSidebarWidth: (width) => {
      const state = getState();
      if (state.basicPreferences.rememberRightSidebarWidth) {
        persistBasicPreferences({
          ...state.basicPreferences,
          rightSidebarWidth: width,
        });
      }
      dispatch({ type: "setRightSidebarWidth", width });
    },
    updateBasicPreference: (key, value) => {
      const state = getState();
      const restoredWorkspaceRoot =
        key === "restoreLastWorkspaceOnStartup" && value && !state.workspaceRoot
          ? loadLastWorkspaceRoot()
          : undefined;
      if (key === "restoreLastWorkspaceOnStartup" && value && state.workspaceRoot) {
        persistWorkspaceRootWhenRestored(
          {
            ...state.basicPreferences,
            restoreLastWorkspaceOnStartup: true,
          },
          state.workspaceRoot,
        );
      }
      const action = {
        type: "updateBasicPreference",
        key,
        value,
        restoredWorkspaceRoot,
      } as BasicPreferenceAction;
      const patch = applyBasicPreferenceUpdate(state, action);
      persistBasicPreferences(patch.basicPreferences);
      dispatch(action);
    },
  };
}

export function WorkbenchProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  // Optional override used by tests to seed a specific route/preferences
  // without dispatching effects; production callers leave this undefined.
  initialState?: WorkbenchState;
}): ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState ?? INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo<WorkbenchActions>(
    () => createWorkbenchActions(() => stateRef.current, dispatch),
    [dispatch],
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

function isWorkbenchRoute(
  route: WorkbenchRoute,
): route is Extract<WorkbenchRoute, "code" | "write"> {
  return route === "code" || route === "write";
}
