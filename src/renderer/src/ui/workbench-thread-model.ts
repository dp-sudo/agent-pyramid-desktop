import type { ThreadRecord, ThreadSummary } from "../../../shared/agent-contracts";
import { IPC_ERROR_CODES, type IpcErrorCode } from "../../../shared/ipc-errors";
import type { WorkbenchRoute } from "./store/WorkbenchContext";

export type WorkbenchThreadMutationAction = "delete" | "archive";

const WORKBENCH_THREAD_BUSY_MESSAGE_KEYS = {
  delete: "threads.deleteBlockedRunning",
  archive: "threads.archiveBlockedRunning",
} as const satisfies Record<WorkbenchThreadMutationAction, string>;

const WORKBENCH_THREAD_BUSY_ERROR_CODES = {
  delete: IPC_ERROR_CODES.THREAD_DELETE_BUSY,
  archive: IPC_ERROR_CODES.THREAD_ARCHIVE_BUSY,
} as const satisfies Record<WorkbenchThreadMutationAction, IpcErrorCode>;

export function shouldUnsubscribeRemovedThread(
  subscribedThreadIds: ReadonlySet<string>,
  threadId: string,
): boolean {
  return subscribedThreadIds.has(threadId);
}

export function workbenchThreadModeForRoute(route: WorkbenchRoute): ThreadRecord["mode"] {
  return route === "write" ? "write" : "code";
}

export function findLatestThreadForWorkspace(
  threads: readonly ThreadSummary[],
  workspace: string,
  mode: ThreadRecord["mode"],
): ThreadSummary | null {
  let latest: ThreadSummary | null = null;
  for (const thread of threads) {
    if (
      thread.mode !== mode ||
      thread.workspace !== workspace ||
      thread.status === "archived"
    ) {
      continue;
    }
    if (!latest || Date.parse(thread.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = thread;
    }
  }
  return latest;
}

export function filterThreadsForWorkbench(
  threads: readonly ThreadSummary[],
  mode: ThreadRecord["mode"],
): ThreadSummary[] {
  return threads.filter((thread) => thread.mode === mode);
}

export function threadMutationBusyMessageKey(
  action: WorkbenchThreadMutationAction,
): string {
  return WORKBENCH_THREAD_BUSY_MESSAGE_KEYS[action];
}

export function isThreadMutationBusyError(
  action: WorkbenchThreadMutationAction,
  code: IpcErrorCode,
): boolean {
  return code === WORKBENCH_THREAD_BUSY_ERROR_CODES[action];
}
