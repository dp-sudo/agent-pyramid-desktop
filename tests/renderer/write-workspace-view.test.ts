import { describe, expect, it } from "vitest";
import {
  formatWriteFileMeta,
  getWriteListState,
  shouldDisableWriteSave,
  shouldSaveWriteFileBeforeSwitch,
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
});
