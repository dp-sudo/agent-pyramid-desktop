import {
  DEFAULT_BASIC_PREFERENCES,
  loadLastWorkspaceRoot,
  saveBasicPreferences,
  saveLastWorkspaceRoot,
  type WorkbenchBasicPreferences,
} from "../preferences";

export type BasicPreferenceAction = {
  [K in keyof WorkbenchBasicPreferences]: {
    type: "updateBasicPreference";
    key: K;
    value: WorkbenchBasicPreferences[K];
  };
}[keyof WorkbenchBasicPreferences];

export interface BasicPreferenceStateInput {
  basicPreferences: WorkbenchBasicPreferences;
  workspaceRoot: string;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
}

export interface BasicPreferenceStatePatch {
  basicPreferences: WorkbenchBasicPreferences;
  showArchivedThreads?: boolean;
  leftSidebarWidth?: number;
  rightSidebarWidth?: number;
  rightPanelMode?: WorkbenchBasicPreferences["defaultInspectorMode"];
  workspaceRoot?: string;
}

export function persistWorkspaceRootWhenRestored(
  preferences: WorkbenchBasicPreferences,
  workspaceRoot: string,
): void {
  if (preferences.restoreLastWorkspaceOnStartup) {
    saveLastWorkspaceRoot(workspaceRoot);
  }
}

export function setShowArchivedThreadsPreference(
  preferences: WorkbenchBasicPreferences,
  show: boolean,
): {
  showArchivedThreads: boolean;
  basicPreferences: WorkbenchBasicPreferences;
} {
  return {
    showArchivedThreads: show,
    basicPreferences: saveBasicPreferences({
      ...preferences,
      showArchivedThreadsByDefault: show,
    }),
  };
}

export function setLeftSidebarWidthPreference(
  preferences: WorkbenchBasicPreferences,
  width: number,
): {
  leftSidebarWidth: number;
  basicPreferences: WorkbenchBasicPreferences;
} {
  return {
    leftSidebarWidth: width,
    basicPreferences: preferences.rememberLeftSidebarWidth
      ? saveBasicPreferences({ ...preferences, leftSidebarWidth: width })
      : preferences,
  };
}

export function setRightSidebarWidthPreference(
  preferences: WorkbenchBasicPreferences,
  width: number,
): {
  rightSidebarWidth: number;
  basicPreferences: WorkbenchBasicPreferences;
} {
  return {
    rightSidebarWidth: width,
    basicPreferences: preferences.rememberRightSidebarWidth
      ? saveBasicPreferences({ ...preferences, rightSidebarWidth: width })
      : preferences,
  };
}

export function applyBasicPreferenceUpdate(
  input: BasicPreferenceStateInput,
  action: BasicPreferenceAction,
): BasicPreferenceStatePatch {
  const draftPreferences = {
    ...input.basicPreferences,
    [action.key]: action.value,
  };
  if (action.key === "rememberLeftSidebarWidth") {
    draftPreferences.leftSidebarWidth = action.value
      ? input.leftSidebarWidth
      : DEFAULT_BASIC_PREFERENCES.leftSidebarWidth;
  }
  if (action.key === "rememberRightSidebarWidth") {
    draftPreferences.rightSidebarWidth = action.value
      ? input.rightSidebarWidth
      : DEFAULT_BASIC_PREFERENCES.rightSidebarWidth;
  }
  if (
    action.key === "restoreLastWorkspaceOnStartup" &&
    action.value &&
    input.workspaceRoot
  ) {
    saveLastWorkspaceRoot(input.workspaceRoot);
  }
  const nextPreferences = saveBasicPreferences(draftPreferences);
  return {
    basicPreferences: nextPreferences,
    ...(action.key === "showArchivedThreadsByDefault"
      ? { showArchivedThreads: nextPreferences.showArchivedThreadsByDefault }
      : {}),
    ...(action.key === "rememberLeftSidebarWidth" &&
    !nextPreferences.rememberLeftSidebarWidth
      ? { leftSidebarWidth: DEFAULT_BASIC_PREFERENCES.leftSidebarWidth }
      : {}),
    ...(action.key === "rememberRightSidebarWidth" &&
    !nextPreferences.rememberRightSidebarWidth
      ? { rightSidebarWidth: DEFAULT_BASIC_PREFERENCES.rightSidebarWidth }
      : {}),
    ...(action.key === "defaultInspectorMode"
      ? { rightPanelMode: nextPreferences.defaultInspectorMode }
      : {}),
    ...(action.key === "restoreLastWorkspaceOnStartup" &&
    nextPreferences.restoreLastWorkspaceOnStartup
      ? { workspaceRoot: input.workspaceRoot || loadLastWorkspaceRoot() }
      : {}),
  };
}
