import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactElement,
  type ReactNode,
} from "react";
import { DEFAULT_MODEL_CONFIG } from "../../../../shared/agent-contracts";
import type {
  Item,
  ModelConfig,
  ModelConfigProfilesState,
  ModelReasoningEffort,
  ThreadRecord,
  ThreadSummary,
  TurnRecord,
} from "../../../../shared/agent-contracts";

export type WorkbenchRoute = "code" | "write" | "settings";
export type RightPanelMode = "changes" | "todo" | "plan" | "file" | null;

export interface ComposerState {
  text: string;
  model: string;
  modelProfileId?: string;
  reasoningEffort?: ModelReasoningEffort;
  mode: "agent" | "plan";
  goalMode: boolean;
  attachmentIds: string[];
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
  inFlightTurn: TurnRecord | null;
  rightPanelMode: RightPanelMode;
  composer: ComposerState;
  errorMessage: string | null;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
}

export const INITIAL_STATE: WorkbenchState = {
  route: "code",
  modelConfig: DEFAULT_MODEL_CONFIG,
  modelProfiles: null,
  workspaceRoot: "",
  showArchivedThreads: false,
  threads: [],
  activeThread: null,
  activeThreadId: null,
  activeTurnId: null,
  items: [],
  inFlightTurn: null,
  rightPanelMode: null,
  composer: {
    text: "",
    model: DEFAULT_MODEL_CONFIG.model,
    reasoningEffort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    mode: "agent",
    goalMode: false,
    attachmentIds: [],
  },
  errorMessage: null,
  leftSidebarWidth: 268,
  rightSidebarWidth: 360,
};

function upsertItem(items: Item[], item: Item): Item[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
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
  | { type: "resetItems"; items: Item[] }
  | { type: "turnStarted"; turn: TurnRecord }
  | { type: "turnEnded"; status: Exclude<TurnRecord["status"], "in-flight"> }
  | { type: "setComposerText"; text: string }
  | { type: "setComposerModel"; model: string; modelProfileId?: string }
  | { type: "setComposerReasoningEffort"; reasoningEffort: ModelReasoningEffort }
  | { type: "setComposerMode"; mode: "agent" | "plan" }
  | { type: "setComposerGoalMode"; enabled: boolean }
  | { type: "addComposerAttachment"; attachmentId: string }
  | { type: "removeComposerAttachment"; attachmentId: string }
  | { type: "clearComposerAttachments" }
  | { type: "openRightPanel"; mode: Exclude<RightPanelMode, null> }
  | { type: "closeRightPanel" }
  | { type: "setError"; message: string | null }
  | { type: "setLeftSidebarWidth"; width: number }
  | { type: "setRightSidebarWidth"; width: number };

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
      return { ...state, workspaceRoot: action.workspaceRoot };
    case "setShowArchivedThreads":
      return { ...state, showArchivedThreads: action.show };
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
              inFlightTurn: null,
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
        inFlightTurn: null,
        activeTurnId: null,
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
    case "resetItems":
      return { ...state, items: action.items };
    case "turnStarted":
      return {
        ...state,
        activeTurnId: action.turn.id,
        inFlightTurn: action.turn,
      };
    case "turnEnded":
      return {
        ...state,
        inFlightTurn: null,
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
    case "addComposerAttachment":
      return {
        ...state,
        composer: {
          ...state.composer,
          attachmentIds: state.composer.attachmentIds.includes(action.attachmentId)
            ? state.composer.attachmentIds
            : [...state.composer.attachmentIds, action.attachmentId],
        },
      };
    case "removeComposerAttachment":
      return {
        ...state,
        composer: {
          ...state.composer,
          attachmentIds: state.composer.attachmentIds.filter(
            (id) => id !== action.attachmentId,
          ),
        },
      };
    case "clearComposerAttachments":
      return { ...state, composer: { ...state.composer, attachmentIds: [] } };
    case "openRightPanel":
      return { ...state, rightPanelMode: action.mode };
    case "closeRightPanel":
      return { ...state, rightPanelMode: null };
    case "setError":
      return { ...state, errorMessage: action.message };
    case "setLeftSidebarWidth":
      return { ...state, leftSidebarWidth: action.width };
    case "setRightSidebarWidth":
      return { ...state, rightSidebarWidth: action.width };
    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
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
  turnEnded(status: Exclude<TurnRecord["status"], "in-flight">): void;
  setComposerText(text: string): void;
  setComposerModel(model: string, modelProfileId?: string): void;
  setComposerReasoningEffort(reasoningEffort: ModelReasoningEffort): void;
  setComposerMode(mode: "agent" | "plan"): void;
  setComposerGoalMode(enabled: boolean): void;
  addComposerAttachment(attachmentId: string): void;
  removeComposerAttachment(attachmentId: string): void;
  clearComposerAttachments(): void;
  openRightPanel(mode: Exclude<RightPanelMode, null>): void;
  closeRightPanel(): void;
  setError(message: string | null): void;
  setLeftSidebarWidth(width: number): void;
  setRightSidebarWidth(width: number): void;
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
      turnEnded: (status) => dispatch({ type: "turnEnded", status }),
      setComposerText: (text) => dispatch({ type: "setComposerText", text }),
      setComposerModel: (model, modelProfileId) =>
        dispatch({ type: "setComposerModel", model, modelProfileId }),
      setComposerReasoningEffort: (reasoningEffort) =>
        dispatch({ type: "setComposerReasoningEffort", reasoningEffort }),
      setComposerMode: (mode) => dispatch({ type: "setComposerMode", mode }),
      setComposerGoalMode: (enabled) =>
        dispatch({ type: "setComposerGoalMode", enabled }),
      addComposerAttachment: (attachmentId) =>
        dispatch({ type: "addComposerAttachment", attachmentId }),
      removeComposerAttachment: (attachmentId) =>
        dispatch({ type: "removeComposerAttachment", attachmentId }),
      clearComposerAttachments: () => dispatch({ type: "clearComposerAttachments" }),
      openRightPanel: (mode) => dispatch({ type: "openRightPanel", mode }),
      closeRightPanel: () => dispatch({ type: "closeRightPanel" }),
      setError: (message) => dispatch({ type: "setError", message }),
      setLeftSidebarWidth: (width) => dispatch({ type: "setLeftSidebarWidth", width }),
      setRightSidebarWidth: (width) => dispatch({ type: "setRightSidebarWidth", width }),
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
