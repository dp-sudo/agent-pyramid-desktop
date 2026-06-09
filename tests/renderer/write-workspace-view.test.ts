import { describe, expect, it } from "vitest";
import {
  formatWriteFileMeta,
  getWriteCompletionAcceptState,
  getWriteDocumentEditState,
  getWriteWorkspaceSwitchState,
  getWriteListState,
  shouldApplyWriteOpenResult,
  shouldDisableWriteSave,
  shouldSaveWriteFileBeforeRouteChange,
  shouldSaveWriteFileBeforeSwitch,
  shouldWarnBeforeLeavingWriteDocument,
  shouldUseSelectedWriteWorkspace,
} from "../../src/renderer/src/ui/components/write/WriteWorkspaceView";

describe("WriteWorkspaceView helpers", () => {
  it("disables save when there is no file, no workspace, a busy state, or no changes", () => {
    expect(
      shouldDisableWriteSave({
        activePath: null,
        workspaceRoot: "/workspace",
        content: "draft",
        savedContent: "",
        status: "idle",
      }),
    ).toBe(true);
    expect(
      shouldDisableWriteSave({
        activePath: "notes.md",
        workspaceRoot: "",
        content: "draft",
        savedContent: "",
        status: "idle",
      }),
    ).toBe(true);
    expect(
      shouldDisableWriteSave({
        activePath: "notes.md",
        workspaceRoot: "/workspace",
        content: "draft",
        savedContent: "draft",
        status: "idle",
      }),
    ).toBe(true);
    expect(
      shouldDisableWriteSave({
        activePath: "notes.md",
        workspaceRoot: "/workspace",
        content: "draft",
        savedContent: "",
        status: "saving",
      }),
    ).toBe(true);
  });

  it("enables save for a changed open file in an idle workspace", () => {
    expect(
      shouldDisableWriteSave({
        activePath: "notes.md",
        workspaceRoot: "/workspace",
        content: "draft",
        savedContent: "",
        status: "idle",
      }),
    ).toBe(false);
  });

  it("requires a save before switching away from a changed open file", () => {
    expect(shouldSaveWriteFileBeforeSwitch({
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "",
    })).toBe(true);
    expect(shouldSaveWriteFileBeforeSwitch({
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "draft",
    })).toBe(false);
    expect(shouldSaveWriteFileBeforeSwitch({
      activePath: null,
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "",
    })).toBe(false);
    expect(shouldSaveWriteFileBeforeSwitch({
      activePath: "notes.md",
      workspaceRoot: "",
      content: "draft",
      savedContent: "",
    })).toBe(false);
  });

  it("requires a save before leaving the write route with a changed open file", () => {
    expect(shouldSaveWriteFileBeforeRouteChange({
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "",
    })).toBe(true);
    expect(shouldSaveWriteFileBeforeRouteChange({
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "draft",
    })).toBe(false);
  });

  it("warns before leaving when the active write document is still dirty", () => {
    expect(shouldWarnBeforeLeavingWriteDocument({
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "",
    })).toBe(true);
    expect(shouldWarnBeforeLeavingWriteDocument({
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "draft",
      savedContent: "draft",
    })).toBe(false);
  });

  it("applies only the latest open-file response for the same workspace and path", () => {
    expect(shouldApplyWriteOpenResult({
      requestId: 2,
      latestRequestId: 2,
      requestedWorkspace: "/workspace",
      currentWorkspace: "/workspace",
      requestedPath: "notes.md",
      returnedPath: "notes.md",
    })).toBe(true);

    expect(shouldApplyWriteOpenResult({
      requestId: 1,
      latestRequestId: 2,
      requestedWorkspace: "/workspace",
      currentWorkspace: "/workspace",
      requestedPath: "first.md",
      returnedPath: "first.md",
    })).toBe(false);

    expect(shouldApplyWriteOpenResult({
      requestId: 2,
      latestRequestId: 2,
      requestedWorkspace: "/workspace-a",
      currentWorkspace: "/workspace-b",
      requestedPath: "notes.md",
      returnedPath: "notes.md",
    })).toBe(false);

    expect(shouldApplyWriteOpenResult({
      requestId: 2,
      latestRequestId: 2,
      requestedWorkspace: "/workspace",
      currentWorkspace: "/workspace",
      requestedPath: "notes.md",
      returnedPath: "other.md",
    })).toBe(false);
  });

  it("uses selected workspaces only when the thread selection gate allows it", async () => {
    await expect(shouldUseSelectedWriteWorkspace("/workspace")).resolves.toBe(true);
    await expect(
      shouldUseSelectedWriteWorkspace("/workspace", () => undefined),
    ).resolves.toBe(true);
    await expect(
      shouldUseSelectedWriteWorkspace("/workspace", async () => true),
    ).resolves.toBe(true);
    await expect(
      shouldUseSelectedWriteWorkspace("/workspace", async () => false),
    ).resolves.toBe(false);
  });

  it("clears file-specific state when switching workspace", () => {
    expect(getWriteWorkspaceSwitchState()).toEqual({
      files: [],
      activePath: null,
      content: "",
      savedContent: "",
      completion: "",
    });
  });

  it("derives file list empty states from workspace, search, and loading status", () => {
    expect(getWriteListState({ files: [], listLoading: false, search: "", workspaceRoot: "" }))
      .toBe("no-workspace");
    expect(getWriteListState({
      files: [],
      listLoading: true,
      search: "",
      workspaceRoot: "/workspace",
    }))
      .toBe("loading");
    expect(getWriteListState({
      files: [],
      listLoading: false,
      search: "",
      workspaceRoot: "/workspace",
    }))
      .toBe("empty");
    expect(getWriteListState({
      files: [],
      listLoading: false,
      search: "guide",
      workspaceRoot: "/workspace",
    }))
      .toBe("empty-search");
    expect(getWriteListState({
      files: [{ path: "README.md", size: 10, modifiedAt: "2026-06-08T00:00:00.000Z" }],
      listLoading: false,
      search: "",
      workspaceRoot: "/workspace",
    })).toBe("ready");
  });

  it("formats file metadata for list rows", () => {
    const meta = formatWriteFileMeta({
      path: "README.md",
      size: 1536,
      modifiedAt: "2026-06-08T00:00:00.000Z",
    });

    expect(meta).toContain("1.5 KB");
  });

  it("keeps document edits isolated from global composer state", () => {
    const editState = getWriteDocumentEditState("draft body");
    expect(editState).toEqual({
      content: "draft body",
      completion: "",
    });
    expect(editState).not.toHaveProperty("composerText");
  });

  it("accepts local completion without producing composer text", () => {
    const nextState = getWriteCompletionAcceptState("draft", " body");
    expect(nextState).toEqual({
      content: "draft body",
      completion: "",
    });
    expect(nextState).not.toHaveProperty("composerText");
  });
});
