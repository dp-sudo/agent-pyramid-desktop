export const WINDOWS_APP_USER_MODEL_ID = "com.agentpyramid.desktop";

interface AppIdentityApi {
  setAppUserModelId(id: string): void;
}

export function configureWindowsAppIdentity(
  app: AppIdentityApi,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;

  // Windows taskbar grouping and future installer shortcuts must share one
  // stable identity, and it needs to be set before any BrowserWindow exists.
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}
