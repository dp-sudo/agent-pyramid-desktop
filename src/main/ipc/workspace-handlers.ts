import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { WORKSPACE_PICK_DIRECTORY_CHANNEL } from "../../shared/ipc.js";
import { err, ok } from "../../shared/agent-contracts.js";

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
      return ok({
        canceled: result.canceled,
        path: result.canceled ? null : result.filePaths[0] ?? null,
      });
    } catch (error) {
      return err("WORKSPACE_PICK_DIRECTORY_FAILED", messageOf(error));
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
