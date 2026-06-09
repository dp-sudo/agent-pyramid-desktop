import { describe, expect, it } from "vitest";
import {
  buildWriteAssistantPrompt,
  canSubmitWriteAssistantPrompt,
  formatWriteFileMeta,
  getWriteAssistantVisibleItems,
  getWriteCompletionAcceptState,
  getWriteDocumentEditState,
  getWriteWorkspaceSwitchState,
  getWriteListState,
  shouldApplyWriteOpenResult,
  shouldDisableWriteSave,
  shouldSaveWriteFileBeforeSwitch,
  shouldWarnBeforeLeavingWriteDocument,
  shouldUseSelectedWriteWorkspace,
  WRITE_SEARCH_CLEAR_BUTTON_TEXT,
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
    expect(WRITE_SEARCH_CLEAR_BUTTON_TEXT).toBe("x");
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

  it("builds explicit assistant prompts without mirroring the full document", () => {
    const payload = buildWriteAssistantPrompt({
      prompt: "  帮我润色这一段  ",
      activePath: "drafts/intro.md",
      content: "full private draft body",
      savedContent: "older draft body",
    });

    expect(payload).toEqual({
      text: [
        "Write workbench request:",
        "帮我润色这一段",
        "",
        "Context:",
        "- Current Markdown file: drafts/intro.md",
        "- Current file save state: unsaved changes",
        "",
        "Respond with writing guidance or draft text. Do not claim that you changed files directly.",
      ].join("\n"),
      displayText: "帮我润色这一段",
      threadTitle: "帮我润色这一段",
    });
    expect(payload?.text).not.toContain("full private draft body");
    expect(buildWriteAssistantPrompt({
      prompt: "   ",
      activePath: "drafts/intro.md",
      content: "",
      savedContent: "",
    })).toBeNull();
  });

  it("allows assistant submit only for explicit prompts in an open workspace", () => {
    expect(canSubmitWriteAssistantPrompt({
      prompt: "润色标题",
      workspaceRoot: "/workspace",
      sending: false,
    })).toBe(true);
    expect(canSubmitWriteAssistantPrompt({
      prompt: "",
      workspaceRoot: "/workspace",
      sending: false,
    })).toBe(false);
    expect(canSubmitWriteAssistantPrompt({
      prompt: "润色标题",
      workspaceRoot: "",
      sending: false,
    })).toBe(false);
    expect(canSubmitWriteAssistantPrompt({
      prompt: "润色标题",
      workspaceRoot: "/workspace",
      sending: true,
    })).toBe(false);
  });

  it("keeps the write assistant panel focused on conversational items", () => {
    const items = [
      makeItem("system", "system-1"),
      makeItem("user", "user-1"),
      makeItem("tool", "tool-1"),
      makeItem("assistant", "assistant-1"),
    ];

    expect(getWriteAssistantVisibleItems(items).map((item) => item.id))
      .toEqual(["system-1", "user-1", "assistant-1"]);
  });
});

function makeItem(kind: "system" | "user" | "assistant" | "tool", id: string) {
  const base = {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: "2026-06-08T00:00:00.000Z",
  };
  if (kind === "system") {
    return { ...base, kind, level: "info" as const, text: "system" };
  }
  if (kind === "user") {
    return { ...base, kind, text: "user" };
  }
  if (kind === "assistant") {
    return { ...base, kind, text: "assistant" };
  }
  return {
    ...base,
    kind,
    toolCallId: "call-1",
    name: "read_file",
    args: {},
    status: "completed" as const,
  };
}
