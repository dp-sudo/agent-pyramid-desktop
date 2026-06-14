import { fileURLToPath } from "node:url";
import { BrowserWindow, shell } from "electron";
import { isSamePath } from "../application/path-utils.js";

export function configureExternalNavigation(
  window: BrowserWindow,
  rendererIndexFile: string,
): void {
  // Renderer markdown can request new windows, but main owns the security
  // boundary: external http(s) URLs leave Electron, everything else is denied.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      openExternalUrl(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, rendererIndexFile)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) {
      openExternalUrl(url);
    }
  });
}

function openExternalUrl(url: string): void {
  void shell.openExternal(url).catch((error) => {
    console.error("[main] open external URL failed:", error);
  });
}

function isExternalHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    if (!isInvalidUrlError(error)) throw error;
    return false;
  }
}

function isAllowedAppNavigation(
  rawUrl: string,
  rendererIndexFile: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (process.env.ELECTRON_RENDERER_URL) {
      const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
      return url.origin === rendererUrl.origin;
    }

    return url.protocol === "file:" && isSamePath(fileURLToPath(url), rendererIndexFile);
  } catch (error) {
    if (!isInvalidUrlError(error)) throw error;
    return false;
  }
}

function isInvalidUrlError(error: unknown): boolean {
  // Navigation URLs are attacker-controlled input; parse failures are expected,
  // while non-TypeError failures should stay visible to the main process.
  return error instanceof TypeError;
}
