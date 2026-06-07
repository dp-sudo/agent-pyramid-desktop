import { ipcMain } from "electron";
import {
  THREAD_LIST_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_UPDATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_FORK_CHANNEL,
} from "../../shared/ipc.js";
import type {
  ThreadCreateInput,
  ThreadListFilter,
  ThreadUpdatePatch,
  IpcResult,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { JsonlThreadStore } from "../persistence/index.js";

export function registerThreadHandlers(store: JsonlThreadStore): void {
  ipcMain.handle(THREAD_LIST_CHANNEL, async (_event, filter?: ThreadListFilter) => {
    try {
      return ok(await store.listThreads(filter ?? {}));
    } catch (error) {
      return err("THREAD_LIST_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(THREAD_CREATE_CHANNEL, async (_event, input: ThreadCreateInput) => {
    try {
      return ok(await store.createThread(input));
    } catch (error) {
      return err("THREAD_CREATE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(THREAD_GET_CHANNEL, async (_event, id: string) => {
    try {
      const thread = await store.getThread(id);
      return thread ? ok(thread) : err("THREAD_NOT_FOUND", `No thread with id ${id}`);
    } catch (error) {
      return err("THREAD_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(
    THREAD_UPDATE_CHANNEL,
    async (_event, id: string, patch: ThreadUpdatePatch) => {
      try {
        return ok(await store.updateThread(id, patch));
      } catch (error) {
        return err("THREAD_UPDATE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(THREAD_DELETE_CHANNEL, async (_event, id: string) => {
    try {
      await store.deleteThread(id);
      return ok({ id });
    } catch (error) {
      return err("THREAD_DELETE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(THREAD_FORK_CHANNEL, async (_event, parentId: string) => {
    try {
      return ok(await store.forkThread(parentId));
    } catch (error) {
      return err("THREAD_FORK_FAILED", messageOf(error));
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ThreadListResult = IpcResult<Awaited<ReturnType<JsonlThreadStore["listThreads"]>>>;
