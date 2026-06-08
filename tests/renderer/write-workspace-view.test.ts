import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  applyWriteInlineEditAction,
  buildWriteInlineEditDiffPreview,
  clampWriteAssistantWidth,
  createWritePendingInlineEdit,
  createEditorSelection,
  formatWriteFileMeta,
  formatWriteWorkspacePath,
  getNextUntitledMarkdownPath,
  getLatestAssistantItem,
  getNextWriteAssistantWidth,
  getRenamedMarkdownPath,
  getWriteCompletionAcceptState,
  getWriteCompletionResetState,
  getWriteDocumentStatusLabel,
  getWriteDocumentEditState,
  getWriteMemoryQuery,
  getWriteSelectionFromEditorState,
  getWriteWorkspaceSwitchState,
  getWriteListState,
  shouldApplyWriteOpenResult,
  shouldDisableWriteSave,
  shouldSaveWriteFileBeforeSwitch,
  shouldUseSelectedWriteWorkspace,
  resolveWritePreviewImageSrc,
  summarizeMediaReferences,
  WRITE_ASSISTANT_COMPOSER_TOOLS,
} from "../../src/renderer/src/ui/components/write/WriteWorkspaceView";
import type { Item, WriteInlineEditAction } from "../../src/shared/agent-contracts";

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

  it("disables save for read-only large files", () => {
    expect(
      shouldDisableWriteSave({
        activePath: "large.md",
        workspaceRoot: "/workspace",
        content: "draft",
        savedContent: "",
        status: "idle",
        readonly: true,
      }),
    ).toBe(true);
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

  it("shortens long workspace paths for the sidebar label", () => {
    expect(formatWriteWorkspacePath("F:\\System\\apps\\backend")).toBe("apps/backend");
    expect(formatWriteWorkspacePath("/mnt/f/System")).toBe("f/System");
    expect(formatWriteWorkspacePath("F:\\System")).toBe("F:\\System");
  });

  it("derives document status labels without mixing editor actions into status", () => {
    const t = (key: string): string => key;

    expect(getWriteDocumentStatusLabel({
      activeFile: null,
      dirty: false,
      readonly: false,
      status: "idle",
      t,
    })).toBe("write.noActiveFile");
    expect(getWriteDocumentStatusLabel({
      activeFile: "draft.md",
      dirty: true,
      readonly: false,
      status: "idle",
      t,
    })).toBe("write.unsaved");
    expect(getWriteDocumentStatusLabel({
      activeFile: "draft.md",
      dirty: false,
      readonly: true,
      status: "idle",
      t,
    })).toBe("write.readonlyFile");
    expect(getWriteDocumentStatusLabel({
      activeFile: "draft.md",
      dirty: true,
      readonly: false,
      status: "saving",
      t,
    })).toBe("write.saving");
  });

  it("derives lifecycle file names without colliding with existing markdown files", () => {
    const files = [
      { path: "untitled-1.md", size: 1, modifiedAt: "2026-06-08T00:00:00.000Z" },
      { path: "notes-renamed.md", size: 1, modifiedAt: "2026-06-08T00:00:00.000Z" },
    ];

    expect(getNextUntitledMarkdownPath(files)).toBe("untitled-2.md");
    expect(getRenamedMarkdownPath("notes.md", files)).toBe("notes-renamed-2.md");
  });

  it("summarizes media references for visible writing evidence", () => {
    const references = [
      {
        alt: "cover",
        rawTarget: "cover.png",
        path: "cover.png",
        exists: true,
        external: false,
        dataUrl: "data:image/png;base64,abc",
      },
      {
        alt: "missing",
        rawTarget: "missing.png",
        path: "missing.png",
        exists: false,
        external: false,
      },
      {
        alt: "remote",
        rawTarget: "https://example.com/a.png",
        path: null,
        exists: false,
        external: true,
      },
    ];

    expect(summarizeMediaReferences(references)).toBe("3 total · 1 missing · 1 external · 1 previews");
    expect(resolveWritePreviewImageSrc("cover.png", references)).toBe("data:image/png;base64,abc");
    expect(resolveWritePreviewImageSrc("missing.png", references)).toBeNull();
  });

  it("keeps document edits isolated from global composer state", () => {
    const editState = getWriteDocumentEditState("draft body");
    expect(editState).toEqual({
      content: "draft body",
      completion: "",
      selection: {
        start: 0,
        end: 0,
        direction: "none",
      },
    });
    expect(editState).not.toHaveProperty("composerText");
  });

  it("accepts local completion without producing composer text", () => {
    const nextState = getWriteCompletionAcceptState("draft", " body", {
      start: 5,
      end: 5,
      direction: "none",
    });
    expect(nextState).toEqual({
      content: "draft body",
      completion: "",
      selection: {
        start: 10,
        end: 10,
        direction: "none",
      },
    });
    expect(nextState).not.toHaveProperty("composerText");
  });

  it("accepts local completion at the current cursor", () => {
    expect(
      getWriteCompletionAcceptState("hello world", " brave", {
        start: 5,
        end: 5,
        direction: "none",
      }),
    ).toEqual({
      content: "hello brave world",
      completion: "",
      selection: {
        start: 11,
        end: 11,
        direction: "none",
      },
    });
  });

  it("resets completion state with a traceable request id", () => {
    expect(getWriteCompletionResetState(42)).toEqual({
      requestId: 42,
      status: "idle",
      text: "",
      score: 0,
      truncated: false,
      error: null,
    });
  });

  it("maps CodeMirror selections into Write selection state", () => {
    const forward = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.single(1, 5),
    });
    const backward = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.single(8, 3),
    });

    expect(getWriteSelectionFromEditorState(forward)).toEqual({
      start: 1,
      end: 5,
      direction: "forward",
    });
    expect(getWriteSelectionFromEditorState(backward)).toEqual({
      start: 3,
      end: 8,
      direction: "backward",
    });
  });

  it("maps Write selection state into clamped CodeMirror selections", () => {
    const selection = createEditorSelection({
      start: 2,
      end: 99,
      direction: "backward",
    }, "abcdef");
    const range = selection.main;

    expect(range.anchor).toBe(6);
    expect(range.head).toBe(2);
  });

  it("creates a pending inline edit diff instead of applying immediately", () => {
    const action = makeInlineEditAction();
    const pending = createWritePendingInlineEdit(action, "Hello world");

    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.pendingInlineEdit.before).toBe("Hello");
    expect(pending.pendingInlineEdit.after).toBe("Hi");
    expect(buildWriteInlineEditDiffPreview(action)).toEqual({
      added: 1,
      removed: 1,
      lines: [
        { type: "removed", text: "Hello" },
        { type: "added", text: "Hi" },
      ],
    });
  });

  it("applies inline edits only when the original scope still matches", () => {
    const action = makeInlineEditAction();

    expect(applyWriteInlineEditAction("Hello world", action)).toEqual({
      ok: true,
      content: "Hi world",
      selection: {
        start: 2,
        end: 2,
        direction: "none",
      },
    });

    expect(applyWriteInlineEditAction("Hallo world", action)).toEqual({
      ok: false,
      message: "Write inline edit scope changed before apply. Review the latest document and retry.",
    });
  });

  it("uses the latest assistant item as the Write action source", () => {
    const items: Item[] = [
      makeAssistantItem("assistant-1", "older"),
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        turnId: "turn-2",
        text: "request",
        createdAt: "2026-06-09T00:00:01.000Z",
      },
      makeAssistantItem("assistant-2", "latest"),
    ];

    expect(getLatestAssistantItem(items)?.text).toBe("latest");
  });

  it("derives writing memory queries from prompt, selection, or cursor context", () => {
    const content = "Opening note.\nSelected concept.\nCursor context";
    expect(getWriteMemoryQuery("  product voice  ", {
      start: 0,
      end: 0,
      direction: "none",
    }, content)).toBe("product voice");
    expect(getWriteMemoryQuery("", {
      start: 14,
      end: 30,
      direction: "forward",
    }, content)).toBe("Selected concept");
    expect(getWriteMemoryQuery("", {
      start: content.length,
      end: content.length,
      direction: "none",
    }, content)).toContain("Cursor context");
  });

  it("keeps Write assistant composer tools separate from Code composer controls", () => {
    expect(WRITE_ASSISTANT_COMPOSER_TOOLS).toEqual(["model", "memory", "action"]);
    expect(WRITE_ASSISTANT_COMPOSER_TOOLS).not.toContain("attachment");
    expect(WRITE_ASSISTANT_COMPOSER_TOOLS).not.toContain("plan");
    expect(WRITE_ASSISTANT_COMPOSER_TOOLS).not.toContain("goal");
  });

  it("clamps and steps the resizable Write assistant boundary", () => {
    expect(clampWriteAssistantWidth(100)).toBe(280);
    expect(clampWriteAssistantWidth(900)).toBe(760);
    expect(getNextWriteAssistantWidth(360, "ArrowLeft")).toBe(384);
    expect(getNextWriteAssistantWidth(360, "ArrowRight")).toBe(336);
    expect(getNextWriteAssistantWidth(360, "Home")).toBe(280);
    expect(getNextWriteAssistantWidth(360, "End")).toBe(760);
    expect(getNextWriteAssistantWidth(360, "Enter")).toBe(360);
  });
});

function makeInlineEditAction(): WriteInlineEditAction {
  return {
    kind: "write:inline-edit",
    path: "notes.md",
    scope: {
      path: "notes.md",
      start: 0,
      end: 5,
      originalText: "Hello",
    },
    replacement: "Hi",
    summary: "Shorten greeting.",
  };
}

function makeAssistantItem(id: string, text: string): Item {
  return {
    kind: "assistant",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    text,
    createdAt: "2026-06-09T00:00:00.000Z",
  };
}
