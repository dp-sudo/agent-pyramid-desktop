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
  ThreadRecord,
  ThreadRelation,
  ThreadUpdatePatch,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";
import type { JsonlThreadStore } from "../persistence/index.js";

const THREAD_RELATIONS: ReadonlySet<ThreadRelation> = new Set(["primary", "fork", "side"]);
const THREAD_MODES: ReadonlySet<ThreadRecord["mode"]> = new Set(["code", "write"]);
const THREAD_STATUSES: ReadonlySet<ThreadRecord["status"]> = new Set(["active", "archived"]);
const APPROVAL_POLICIES: ReadonlySet<ThreadRecord["approvalPolicy"]> = new Set([
  "auto",
  "on-request",
  "untrusted",
  "never",
]);
const SANDBOX_MODES: ReadonlySet<ThreadRecord["sandboxMode"]> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export function registerThreadHandlers(store: JsonlThreadStore, runtime?: AgentRuntime): void {
  ipcMain.handle(THREAD_LIST_CHANNEL, async (_event, filter?: unknown) => {
    try {
      return ok(await store.listThreads(parseThreadListFilter(filter)));
    } catch (error) {
      return err("THREAD_LIST_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(THREAD_CREATE_CHANNEL, async (_event, input: unknown) => {
    try {
      return ok(await store.createThread(parseThreadCreateInput(input)));
    } catch (error) {
      return err("THREAD_CREATE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(THREAD_GET_CHANNEL, async (_event, request: unknown) => {
    try {
      const id = parseThreadId(request, "Thread get");
      const thread = await store.getThread(id);
      return thread ? ok(thread) : err("THREAD_NOT_FOUND", `No thread with id ${id}`);
    } catch (error) {
      return err("THREAD_GET_FAILED", messageOf(error));
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
          return err("THREAD_NOT_FOUND", `No thread with id ${id}`);
        }
        if (patch.status === "archived" && runtime?.isThreadInFlight(id)) {
          return err("THREAD_ARCHIVE_BUSY", "Cannot archive a thread while a turn is running.");
        }
        return ok(await store.updateThread(id, patch));
      } catch (error) {
        const message = messageOf(error);
        return err(
          message === "Thread status must be active or archived."
            ? "THREAD_STATUS_INVALID"
            : "THREAD_UPDATE_FAILED",
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
        return err("THREAD_NOT_FOUND", `No thread with id ${id}`);
      }
      if (runtime?.isThreadInFlight(id)) {
        return err("THREAD_DELETE_BUSY", "Cannot delete a thread while a turn is running.");
      }
      await store.deleteThread(id);
      return ok({ id });
    } catch (error) {
      return err("THREAD_DELETE_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(THREAD_FORK_CHANNEL, async (_event, request: unknown) => {
    try {
      const parentId = parseThreadId(request, "Thread fork");
      return ok(await store.forkThread(parentId));
    } catch (error) {
      return err("THREAD_FORK_FAILED", messageOf(error));
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
  };
  if (parsed.relation === "fork" && !parsed.parentThreadId) {
    throw new Error("Thread create fork requires parentThreadId.");
  }
  return parsed;
}

export function parseThreadUpdatePatch(patch: unknown): ThreadUpdatePatch {
  const value = requestObject(patch, "Thread update patch");
  return {
    ...optionalStringField(value, "title", "Thread update title must be a string."),
    ...optionalEnumField(
      value,
      "approvalPolicy",
      APPROVAL_POLICIES,
      "Thread update approvalPolicy is invalid.",
    ),
    ...optionalEnumField(
      value,
      "sandboxMode",
      SANDBOX_MODES,
      "Thread update sandboxMode is invalid.",
    ),
    ...optionalEnumField(value, "status", THREAD_STATUSES, "Thread status must be active or archived."),
    ...(value.goal !== undefined ? { goal: value.goal as ThreadUpdatePatch["goal"] } : {}),
  };
}

export function parseThreadId(request: unknown, label: string): string {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error(`${label} requires a thread id string.`);
  }
  return request.trim();
}

function requestObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
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
  options: ReadonlySet<T>,
  message: string,
): T {
  if (typeof value !== "string" || !options.has(value as T)) {
    throw new Error(message);
  }
  return value as T;
}

function optionalEnumField<T extends string>(
  value: Record<string, unknown>,
  field: string,
  options: ReadonlySet<T>,
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

function isThreadRelation(value: unknown): value is ThreadRelation {
  return typeof value === "string" && THREAD_RELATIONS.has(value as ThreadRelation);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
