import type { IpcResult, ThreadRecord } from "../../../shared/agent-contracts";
import { runWorkbenchIpc } from "./workbench-ipc";
import {
  getThreadInFlightTurn,
  type WorkbenchActions,
  type WorkbenchState,
} from "./store/WorkbenchContext";
import {
  isThreadMutationBusyError,
  threadMutationBusyMessageKey,
} from "./workbench-thread-model";

const DEFAULT_THREAD_TITLE = "New chat";

/**
 * Shared "create thread → subscribe → select" skeleton used by both code and
 * write composer send paths when no active thread exists yet. Returns the new
 * threadId, or null if any step failed (error already surfaced via actions).
 */
export async function ensureThreadForSend(
  state: WorkbenchState,
  actions: WorkbenchActions,
  workspace: string,
  mode: ThreadRecord["mode"],
  title: string,
  hooks: {
    setActiveThreadId: (id: string | null) => void;
    subscribeThreadEvents: (threadId: string) => Promise<boolean>;
    refreshThreads: () => void;
  },
): Promise<string | null> {
  const threadResult = await runWorkbenchIpc(() =>
    window.agentApi.threads.create({ title, workspace, mode }),
  );
  if (!threadResult.ok) {
    actions.setError(threadResult.message);
    return null;
  }
  const threadId = threadResult.value.id;
  hooks.setActiveThreadId(threadId);
  actions.selectThread(threadResult.value, []);
  if (!(await hooks.subscribeThreadEvents(threadId))) return null;
  void hooks.refreshThreads();
  return threadId;
}

/**
 * Shared "create empty thread → subscribe → select" skeleton for onNewChat /
 * onNewWriteThread. Returns the created thread or null on failure.
 */
export async function createNewThread(
  actions: WorkbenchActions,
  workspace: string,
  mode: ThreadRecord["mode"],
  hooks: {
    setActiveThreadId: (id: string | null) => void;
    subscribeThreadEvents: (threadId: string) => Promise<boolean>;
    refreshThreads: () => void;
  },
): Promise<ThreadRecord | null> {
  const result = await runWorkbenchIpc(() =>
    window.agentApi.threads.create({
      title: DEFAULT_THREAD_TITLE,
      workspace,
      mode,
    }),
  );
  if (!result.ok) {
    actions.setError(result.message);
    return null;
  }
  hooks.setActiveThreadId(result.value.id);
  if (!(await hooks.subscribeThreadEvents(result.value.id))) return null;
  actions.selectThread(result.value, []);
  actions.setError(null);
  void hooks.refreshThreads();
  return result.value;
}

/**
 * Shared skeleton for delete / archive thread mutations. Handles busy-guard,
 * IPC call, busy-error fallback, unsubscribe, and refresh. The `mutation`
 * callback receives the threadId and performs the actual IPC operation.
 */
export async function runThreadMutation(
  state: WorkbenchState,
  actions: WorkbenchActions,
  id: string,
  operation: "delete" | "archive",
  t: (key: string) => string,
  mutation: (id: string) => Promise<IpcResult<unknown>>,
  hooks: {
    setActiveThreadId: (id: string | null) => void;
    unsubscribeThreadEvents: (threadId: string) => Promise<boolean>;
    refreshThreads: () => void;
  },
): Promise<boolean> {
  const busyMessage = t(threadMutationBusyMessageKey(operation));
  if (getThreadInFlightTurn(state, id)) {
    actions.setError(busyMessage);
    return false;
  }

  const result = await mutation(id);
  if (!result.ok) {
    actions.setError(
      isThreadMutationBusyError(operation, result.code)
        ? busyMessage
        : result.message,
    );
    return false;
  }

  const wasActiveThread = state.activeThreadId === id;
  if (wasActiveThread) {
    hooks.setActiveThreadId(null);
    if (operation === "archive") {
      actions.deselectThread();
    }
  }
  const unsubscribed = await hooks.unsubscribeThreadEvents(id);
  if (operation === "delete") {
    actions.removeThread(id);
  }
  if (unsubscribed) actions.setError(null);
  void hooks.refreshThreads();
  return true;
}
