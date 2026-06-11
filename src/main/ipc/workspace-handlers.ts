import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { WORKSPACE_PICK_DIRECTORY_CHANNEL } from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import {
  err,
  ok,
  type WorkspacePickDirectoryResponse,
} from "../../shared/agent-contracts.js";

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(WORKSPACE_PICK_DIRECTORY_CHANNEL, async (event) => {
    try {
      const options: OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
      };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return ok(normalizeWorkspacePickResult(result));
    } catch (error) {
      return err(IPC_ERROR_CODES.WORKSPACE_PICK_DIRECTORY_FAILED, messageOf(error));
    }
  });
}

export function normalizeWorkspacePickResult(result: {
  canceled: boolean;
  filePaths: string[];
}): WorkspacePickDirectoryResponse {
  if (result.canceled) {
    return { canceled: true, path: null };
  }
  const selectedPath = result.filePaths[0];
  if (!selectedPath) {
    throw new Error("Workspace picker returned no selected directory.");
  }
  return { canceled: false, path: selectedPath };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
