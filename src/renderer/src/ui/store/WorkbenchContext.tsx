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
  reasoningEffort?: ModelReasoningEffort;
}

export interface WorkbenchState {
  route: WorkbenchRoute;
  modelConfig: ModelConfig;
  threads: ThreadSummary[];
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

const INITIAL_STATE: WorkbenchState = {
  route: "code",
  modelConfig: DEFAULT_MODEL_CONFIG,
  threads: [],
  activeThreadId: null,
  activeTurnId: null,
  items: [],
  inFlightTurn: null,
  rightPanelMode: null,
  composer: { text: "", model: DEFAULT_MODEL_CONFIG.model },
  errorMessage: null,
  leftSidebarWidth: 268,
  rightSidebarWidth: 360,
};

type Action =
  | { type: "setRoute"; route: WorkbenchRoute }
  | { type: "setModelConfig"; config: ModelConfig }
  | { type: "setThreads"; threads: ThreadSummary[] }
  | { type: "selectThread"; thread: ThreadRecord; items: Item[] }
  | { type: "deselectThread" }
  | { type: "appendItem"; item: Item }
  | { type: "resetItems"; items: Item[] }
  | { type: "turnStarted"; turn: TurnRecord }
  | { type: "turnEnded"; status: "completed" | "failed" | "interrupted" }
  | { type: "setComposerText"; text: string }
  | { type: "setComposerModel"; model: string }
  | { type: "openRightPanel"; mode: Exclude<RightPanelMode, null> }
  | { type: "closeRightPanel" }
  | { type: "setError"; message: string | null }
  | { type: "setLeftSidebarWidth"; width: number }
  | { type: "setRightSidebarWidth"; width: number };

function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case "setRoute":
      return { ...state, route: action.route };
    case "setModelConfig":
      return {
        ...state,
        modelConfig: action.config,
        composer: { ...state.composer, model: action.config.model },
      };
    case "setThreads":
      return { ...state, threads: action.threads };
    case "selectThread":
      return {
        ...state,
        activeThreadId: action.thread.id,
        items: action.items,
        inFlightTurn: null,
        activeTurnId: null,
      };
    case "deselectThread":
      return { ...state, activeThreadId: null, items: [], activeTurnId: null };
    case "appendItem":
      return { ...state, items: [...state.items, action.item] };
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
      return { ...state, composer: { ...state.composer, model: action.model } };
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
  setThreads(threads: ThreadSummary[]): void;
  selectThread(thread: ThreadRecord, items: Item[]): void;
  deselectThread(): void;
  appendItem(item: Item): void;
  turnStarted(turn: TurnRecord): void;
  turnEnded(status: "completed" | "failed" | "interrupted"): void;
  setComposerText(text: string): void;
  setComposerModel(model: string): void;
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
      setThreads: (threads) => dispatch({ type: "setThreads", threads }),
      selectThread: (thread, items) => dispatch({ type: "selectThread", thread, items }),
      deselectThread: () => dispatch({ type: "deselectThread" }),
      appendItem: (item) => dispatch({ type: "appendItem", item }),
      turnStarted: (turn) => dispatch({ type: "turnStarted", turn }),
      turnEnded: (status) => dispatch({ type: "turnEnded", status }),
      setComposerText: (text) => dispatch({ type: "setComposerText", text }),
      setComposerModel: (model) => dispatch({ type: "setComposerModel", model }),
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
