import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { IpcResult } from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { RendererToMainChannel } from "../../shared/ipc.js";
import type { IpcErrorCode } from "../../shared/ipc-errors.js";

type IpcResultHandler<TArgs extends readonly unknown[], TValue> = (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => Promise<TValue> | TValue;

/**
 * Main-process IPC handlers must preserve the shared IpcResult envelope so
 * renderer callers can surface traceable failures without catching thrown
 * Electron invoke errors at each call site.
 */
export function registerIpcResultHandler<TArgs extends readonly unknown[], TValue>(
  channel: RendererToMainChannel,
  failureCode: IpcErrorCode,
  handler: IpcResultHandler<TArgs, TValue>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<TValue>> => {
    try {
      return ok(await handler(event, ...(args as unknown as TArgs)));
    } catch (error) {
      return err(failureCode, messageOfIpcError(error));
    }
  });
}

export function messageOfIpcError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate that an IPC request payload is a plain object before field access.
 * Shared by handler-level request parsers so the error wording stays uniform.
 */
export function requestObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Shared busy-guard for operations that must not run while a thread has an
 * in-flight turn (archive / delete / rewind). Returns an IpcResult error when
 * the thread is busy, or null when the operation may proceed.
 */
export function rejectIfThreadBusy(
  runtime: { isThreadInFlight(id: string): boolean } | undefined,
  threadId: string,
  code: IpcErrorCode,
  message: string,
): IpcResult<never> | null {
  if (runtime?.isThreadInFlight(threadId)) {
    return err(code, message);
  }
  return null;
}
