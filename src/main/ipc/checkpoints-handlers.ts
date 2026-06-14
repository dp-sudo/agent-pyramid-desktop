import { ipcMain } from "electron";
import {
  CHECKPOINT_LIST_CHANNEL,
  CHECKPOINT_REWIND_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  CheckpointListRequest,
  CheckpointRewindRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";
import type { CheckpointStore } from "../persistence/checkpoint-store.js";
import type { JsonlThreadStore } from "../persistence/index.js";
import { messageOfIpcError as messageOf, rejectIfThreadBusy, requestObject } from "./ipc-result-handler.js";

export function registerCheckpointHandlers(
  checkpointStore: CheckpointStore,
  threadStore: JsonlThreadStore,
  runtime?: AgentRuntime,
): void {
  ipcMain.handle(CHECKPOINT_LIST_CHANNEL, async (_event, input: unknown) => {
    try {
      const request = parseCheckpointListRequest(input);
      const thread = await threadStore.getThread(request.threadId);
      if (!thread) {
        return err(IPC_ERROR_CODES.THREAD_NOT_FOUND, `No thread with id ${request.threadId}`);
      }
      const sessionTurnIds = await collectSessionTurnIds(threadStore, request.threadId);
      const checkpoints = await checkpointStore.list(request.threadId);
      return ok({
        threadId: request.threadId,
        checkpoints: checkpoints.map((checkpoint) => ({
          ...checkpoint,
          canRewindSession: sessionTurnIds.has(checkpoint.turnId),
        })),
      });
    } catch (error) {
      return err(IPC_ERROR_CODES.CHECKPOINT_LIST_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(CHECKPOINT_REWIND_CHANNEL, async (_event, input: unknown) => {
    try {
      const request = parseCheckpointRewindRequest(input);
      const rewindBusy = rejectIfThreadBusy(runtime, request.threadId, IPC_ERROR_CODES.CHECKPOINT_REWIND_BUSY, "Cannot rewind a thread while a turn is running.");
      if (rewindBusy) return rewindBusy;
      const thread = await threadStore.getThread(request.threadId);
      if (!thread) {
        return err(IPC_ERROR_CODES.THREAD_NOT_FOUND, `No thread with id ${request.threadId}`);
      }
      if (request.rewindSession === true) {
        await assertSessionTurnExists(threadStore, request.threadId, request.turnId);
      }

      const restored = await checkpointStore.restoreCode(thread, request.turnId);
      let itemsRemoved = 0;
      let eventsRemoved = 0;
      let checkpointsRemoved = 0;
      if (request.rewindSession === true) {
        const truncated = await threadStore.truncateThreadFromTurn(
          request.threadId,
          request.turnId,
        );
        itemsRemoved = truncated.itemsRemoved;
        eventsRemoved = truncated.eventsRemoved;
        checkpointsRemoved = await checkpointStore.pruneFromTurn(
          request.threadId,
          request.turnId,
        );
      }

      return ok({
        threadId: request.threadId,
        turnId: request.turnId,
        rewindSession: request.rewindSession === true,
        restoredPaths: restored.restoredPaths,
        deletedPaths: restored.deletedPaths,
        itemsRemoved,
        eventsRemoved,
        checkpointsRemoved,
      });
    } catch (error) {
      return err(IPC_ERROR_CODES.CHECKPOINT_REWIND_FAILED, messageOf(error));
    }
  });
}

// Session rewind trims messages/events and therefore depends on a live transcript
// turn boundary. Code-only rewind can still use checkpoint snapshots after the
// transcript boundary is gone, but session rewind must fail before restoring code.
async function collectSessionTurnIds(
  threadStore: JsonlThreadStore,
  threadId: string,
): Promise<Set<string>> {
  const turnIds = new Set<string>();
  for await (const item of threadStore.replayItems(threadId)) {
    const turnId = "turnId" in item ? item.turnId : undefined;
    if (typeof turnId === "string") {
      turnIds.add(turnId);
    }
  }
  return turnIds;
}

async function assertSessionTurnExists(
  threadStore: JsonlThreadStore,
  threadId: string,
  turnId: string,
): Promise<void> {
  const turnIds = await collectSessionTurnIds(threadStore, threadId);
  if (!turnIds.has(turnId)) {
    throw new Error(`Turn ${turnId} was not found in thread ${threadId}.`);
  }
}

// Checkpoint IPC accepts renderer-controlled identifiers. Keep validation at
// the boundary so store paths and rewind decisions cannot be steered by malformed
// payloads.
export function parseCheckpointListRequest(input: unknown): CheckpointListRequest {
  const value = requestObject(input, "Checkpoint list request");
  return {
    threadId: requiredString(value.threadId, "Checkpoint list threadId is required."),
  };
}

export function parseCheckpointRewindRequest(input: unknown): CheckpointRewindRequest {
  const value = requestObject(input, "Checkpoint rewind request");
  return {
    threadId: requiredString(value.threadId, "Checkpoint rewind threadId is required."),
    turnId: requiredString(value.turnId, "Checkpoint rewind turnId is required."),
    ...(value.rewindSession !== undefined
      ? { rewindSession: requiredBoolean(value.rewindSession, "Checkpoint rewindSession must be a boolean.") }
      : {}),
  };
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

function requiredBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
  return value;
}
