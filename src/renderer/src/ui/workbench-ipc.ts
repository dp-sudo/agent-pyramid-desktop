import { err, type IpcResult } from "../../../shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../../shared/ipc-errors";

export function formatInitialLoadErrors(results: Array<IpcResult<unknown>>): string | null {
  const messages = results
    .filter((result) => !result.ok)
    .map((result) => result.message);
  return messages.length > 0 ? messages.join("\n") : null;
}

export async function runWorkbenchIpc<T>(
  invoke: () => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  try {
    return await invoke();
  } catch (error) {
    // Normalize rejected preload calls back into the renderer's IpcResult envelope
    // so Workbench state can surface a traceable error instead of throwing.
    return err(IPC_ERROR_CODES.RENDERER_IPC_REJECTED, messageOfWorkbenchError(error));
  }
}

export function messageOfWorkbenchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
