import { ipcMain } from "electron";
import {
  THREAD_LIST_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_UPDATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_FORK_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  ThreadCreateInput,
  ThreadListFilter,
  ThreadUpdatePatch,
} from "../../shared/agent-contracts.js";
import {
  THREAD_APPROVAL_POLICIES,
  THREAD_MODES,
  THREAD_RELATIONS,
  THREAD_SANDBOX_MODES,
  THREAD_STATUSES,
  err,
  isThreadGoal,
  isThreadRelation,
  ok,
} from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";
import type { JsonlThreadStore } from "../persistence/index.js";
import type { RuntimePreferencesStore } from "../persistence/runtime-preferences-store.js";
import { messageOfIpcError as messageOf, rejectIfThreadBusy, requestObject } from "./ipc-result-handler.js";

export function registerThreadHandlers(
  store: JsonlThreadStore,
  runtime?: AgentRuntime,
  runtimePreferencesStore?: RuntimePreferencesStore,
): void {
  ipcMain.handle(THREAD_LIST_CHANNEL, async (_event, filter?: unknown) => {
    try {
      return ok(await store.listThreads(parseThreadListFilter(filter)));
    } catch (error) {
      return err(IPC_ERROR_CODES.THREAD_LIST_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(THREAD_CREATE_CHANNEL, async (_event, input: unknown) => {
    try {
      const parsed = parseThreadCreateInput(input);
      return ok(await store.createThread(
        await applyThreadCreateDefaults(parsed, runtimePreferencesStore),
      ));
    } catch (error) {
      return err(IPC_ERROR_CODES.THREAD_CREATE_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(THREAD_GET_CHANNEL, async (_event, request: unknown) => {
    try {
      const id = parseThreadId(request, "Thread get");
      const thread = await store.getThread(id);
      return thread ? ok(thread) : err(IPC_ERROR_CODES.THREAD_NOT_FOUND, `No thread with id ${id}`);
    } catch (error) {
      return err(IPC_ERROR_CODES.THREAD_GET_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(
    THREAD_UPDATE_CHANNEL,
    async (_event, idInput: unknown, patchInput: unknown) => {
      try {
        const id = parseThreadId(idInput, "Thread update");
        const patch = parseThreadUpdatePatch(patchInput);
        const thread = await store.getThread(id);
        if (!thread) {
          return err(IPC_ERROR_CODES.THREAD_NOT_FOUND, `No thread with id ${id}`);
        }
        const archiveBusy = rejectIfThreadBusy(runtime, id, IPC_ERROR_CODES.THREAD_ARCHIVE_BUSY, "Cannot archive a thread while a turn is running.");
        if (patch.status === "archived" && archiveBusy) return archiveBusy;
        return ok(await store.updateThread(id, patch));
      } catch (error) {
        const message = messageOf(error);
        return err(
          message === "Thread status must be active or archived."
            ? IPC_ERROR_CODES.THREAD_STATUS_INVALID
            : IPC_ERROR_CODES.THREAD_UPDATE_FAILED,
          message,
        );
      }
    },
  );

  ipcMain.handle(THREAD_DELETE_CHANNEL, async (_event, request: unknown) => {
    try {
      const id = parseThreadId(request, "Thread delete");
      const thread = await store.getThread(id);
      if (!thread) {
        return err(IPC_ERROR_CODES.THREAD_NOT_FOUND, `No thread with id ${id}`);
      }
      const deleteBusy = rejectIfThreadBusy(runtime, id, IPC_ERROR_CODES.THREAD_DELETE_BUSY, "Cannot delete a thread while a turn is running.");
      if (deleteBusy) return deleteBusy;
      await store.deleteThread(id);
      return ok({ id });
    } catch (error) {
      return err(IPC_ERROR_CODES.THREAD_DELETE_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(THREAD_FORK_CHANNEL, async (_event, request: unknown) => {
    try {
      const parentId = parseThreadId(request, "Thread fork");
      return ok(await store.forkThread(parentId));
    } catch (error) {
      return err(IPC_ERROR_CODES.THREAD_FORK_FAILED, messageOf(error));
    }
  });
}

// Thread records are the root of runtime/workspace state. Validate renderer IPC
// payloads before they can initialize stores, hit thread paths, or influence the
// in-flight archive/delete gates.
export function parseThreadListFilter(filter: unknown): ThreadListFilter {
  if (filter === undefined) return {};
  const value = requestObject(filter, "Thread list filter");
  const include = value.include;
  if (include !== undefined && (!Array.isArray(include) || !include.every(isThreadRelation))) {
    throw new Error("Thread list include must contain valid thread relations.");
  }
  return {
    ...(include !== undefined ? { include } : {}),
    ...optionalStringField(value, "search", "Thread list search must be a string."),
    ...optionalEnumField(value, "mode", THREAD_MODES, "Thread list mode is invalid."),
    ...optionalBooleanField(
      value,
      "includeArchived",
      "Thread list includeArchived must be a boolean.",
    ),
    ...optionalBooleanField(
      value,
      "archivedOnly",
      "Thread list archivedOnly must be a boolean.",
    ),
  };
}

export function parseThreadCreateInput(input: unknown): ThreadCreateInput {
  const value = requestObject(input, "Thread create input");
  const parsed: ThreadCreateInput = {
    ...optionalStringField(value, "title", "Thread create title must be a string."),
    workspace: requiredString(value.workspace, "Thread create workspace is required."),
    mode: requiredEnum(value.mode, THREAD_MODES, "Thread create mode is invalid."),
    ...optionalEnumField(
      value,
      "relation",
      THREAD_RELATIONS,
      "Thread create relation is invalid.",
    ),
    ...optionalStringField(
      value,
      "parentThreadId",
      "Thread create parentThreadId must be a string.",
    ),
    ...optionalEnumField(
      value,
      "approvalPolicy",
      THREAD_APPROVAL_POLICIES,
      "Thread create approvalPolicy is invalid.",
    ),
    ...optionalEnumField(
      value,
      "sandboxMode",
      THREAD_SANDBOX_MODES,
      "Thread create sandboxMode is invalid.",
    ),
  };
  if (parsed.relation === "fork" && !parsed.parentThreadId) {
    throw new Error("Thread create fork requires parentThreadId.");
  }
  if (parsed.parentThreadId && parsed.relation !== "fork") {
    throw new Error("Thread create parentThreadId requires relation fork.");
  }
  return parsed;
}

async function applyThreadCreateDefaults(
  input: ThreadCreateInput,
  runtimePreferencesStore?: RuntimePreferencesStore,
): Promise<ThreadCreateInput> {
  if (!runtimePreferencesStore) return input;
  const preferences = await runtimePreferencesStore.get();
  return {
    ...input,
    approvalPolicy: input.approvalPolicy ?? preferences.defaultApprovalPolicy,
    sandboxMode: input.sandboxMode ?? preferences.defaultSandboxMode,
  };
}

export function parseThreadUpdatePatch(patch: unknown): ThreadUpdatePatch {
  const value = requestObject(patch, "Thread update patch");
  const goal = parseOptionalThreadGoalPatch(value.goal);
  const parsed: ThreadUpdatePatch = {
    ...optionalStringField(value, "title", "Thread update title must be a string."),
    ...optionalEnumField(
      value,
      "approvalPolicy",
      THREAD_APPROVAL_POLICIES,
      "Thread update approvalPolicy is invalid.",
    ),
    ...optionalEnumField(
      value,
      "sandboxMode",
      THREAD_SANDBOX_MODES,
      "Thread update sandboxMode is invalid.",
    ),
    ...optionalEnumField(value, "status", THREAD_STATUSES, "Thread status must be active or archived."),
    ...(goal !== undefined ? { goal } : {}),
  };
  if (Object.keys(parsed).length === 0) {
    throw new Error("Thread update patch must include at least one field.");
  }
  return parsed;
}

function parseOptionalThreadGoalPatch(value: unknown): ThreadUpdatePatch["goal"] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isThreadGoal(value)) {
    throw new Error("Thread update goal is invalid.");
  }
  return value;
}

export function parseThreadId(request: unknown, label: string): string {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error(`${label} requires a thread id string.`);
  }
  return request.trim();
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

function optionalStringField(
  value: Record<string, unknown>,
  field: string,
  message: string,
): Record<string, string> {
  const raw = value[field];
  if (raw === undefined) return {};
  if (typeof raw !== "string") {
    throw new Error(message);
  }
  return { [field]: raw };
}

function requiredEnum<T extends string>(
  value: unknown,
  options: readonly T[],
  message: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Error(message);
  }
  return value as T;
}

function optionalEnumField<T extends string>(
  value: Record<string, unknown>,
  field: string,
  options: readonly T[],
  message: string,
): Record<string, T> {
  const raw = value[field];
  if (raw === undefined) return {};
  return { [field]: requiredEnum(raw, options, message) };
}

function optionalBooleanField(
  value: Record<string, unknown>,
  field: string,
  message: string,
): Record<string, boolean> {
  const raw = value[field];
  if (raw === undefined) return {};
  if (typeof raw !== "boolean") {
    throw new Error(message);
  }
  return { [field]: raw };
}
