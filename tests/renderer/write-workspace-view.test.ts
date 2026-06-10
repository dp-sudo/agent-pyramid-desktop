import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildWriteAssistantPrompt,
  clampWriteSidebarWidth,
  formatWriteFileMeta,
  getNextWriteSidebarWidth,
  getWriteAssistantLocalContext,
  getWriteAssistantVisibleItems,
  getWriteCompletionAcceptState,
  getWriteCompletionRequestContext,
  getWriteDocumentEditState,
  getWriteListState,
  getWriteSidebarDividerClassName,
  getWriteWorkspaceSwitchState,
  shouldApplyWriteOpenResult,
  shouldDisableWriteSave,
  shouldRequestWriteCompletion,
  shouldSaveWriteFileBeforeSwitch,
  shouldUseSelectedWriteWorkspace,
  shouldWarnBeforeLeavingWriteDocument,
  WRITE_SEARCH_CLEAR_BUTTON_TEXT,
  WriteWorkspaceView,
} from "../../src/renderer/src/ui/components/write/WriteWorkspaceView";
import { WorkbenchProvider } from "../../src/renderer/src/ui/store/WorkbenchContext";

describe("WriteWorkspaceView helpers", () => {
  it("labels the main markdown editor independently from placeholder text", () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchProvider, null, createElement(WriteWorkspaceView)),
    );

    expect(html).toContain("aria-label=\"write.editorPlaceholder\"");
    expect(html).toContain("placeholder=\"write.editorPlaceholder\"");
    expect(html).toContain("aria-label=\"write.previewLabel\"");
  });

  it("uses the shared write composer instead of the old assistant form", () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchProvider, null, createElement(WriteWorkspaceView)),
    );

    expect(html).toContain("class=\"ds-write-sidebar-actions\"");
    expect(html).toContain("class=\"ds-pill is-accent ds-write-save-button\"");
    expect(html).toContain("class=\"ds-write-assistant-composer\"");
    expect(html).toContain("class=\"ds-composer-shell is-write\"");
    expect(html).toContain("placeholder=\"composer.writePlaceholder\"");
    expect(html).not.toContain("ds-write-assistant-form");
    expect(html).not.toContain("ds-composer-tool-button");
    expect(html).not.toContain("ds-composer-model-button");
    expect(html).not.toContain("float:right");
    expect(html).not.toContain("background:var(--ds-bg-sidebar)");
  });

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
    expect(meta).toContain(" | ");
    expect(meta).not.toContain("·");
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

  it("accepts local completion at the current editor selection", () => {
    expect(
      getWriteCompletionAcceptState("before after", " middle", {
        selectionStart: 6,
        selectionEnd: 6,
      }),
    ).toEqual({
      content: "before middle after",
      completion: "",
    });
    expect(
      getWriteCompletionAcceptState("before old after", "new", {
        selectionStart: 7,
        selectionEnd: 10,
      }),
    ).toEqual({
      content: "before new after",
      completion: "",
    });
  });

  it("sends completion prefix and suffix around the cursor", () => {
    expect(
      getWriteCompletionRequestContext({
        content: "alpha beta gamma",
        selection: { selectionStart: 6, selectionEnd: 10 },
      }),
    ).toEqual({
      prefix: "alpha ",
      suffix: " gamma",
    });
  });

  it("requests completion only when the current prefix has enough context", () => {
    expect(
      shouldRequestWriteCompletion({
        activePath: "notes.md",
        workspaceRoot: "/workspace",
        prefix: "short",
      }),
    ).toBe(false);
    expect(
      shouldRequestWriteCompletion({
        activePath: "notes.md",
        workspaceRoot: "/workspace",
        prefix: "0123456789",
      }),
    ).toBe(true);
    expect(
      shouldRequestWriteCompletion({
        activePath: "notes.md",
        workspaceRoot: "/workspace",
        prefix: "0123456789   ",
      }),
    ).toBe(true);
    expect(
      shouldRequestWriteCompletion({
        activePath: null,
        workspaceRoot: "/workspace",
        prefix: "0123456789",
      }),
    ).toBe(false);
    expect(
      shouldRequestWriteCompletion({
        activePath: "notes.md",
        workspaceRoot: "",
        prefix: "0123456789",
      }),
    ).toBe(false);
  });

  it("builds explicit assistant prompts without mirroring the full document", () => {
    const payload = buildWriteAssistantPrompt({
      prompt: "  refine this intro  ",
      activePath: "drafts/intro.md",
      content: "full private draft body",
      savedContent: "older draft body",
    });

    expect(payload).toEqual({
      text: [
        "Write workbench request:",
        "refine this intro",
        "",
        "Context:",
        "- Current Markdown file: drafts/intro.md",
        "- Current file save state: unsaved changes",
        "",
        "Respond with writing guidance or draft text. Do not claim that you changed files directly.",
      ].join("\n"),
      displayText: "refine this intro",
      threadTitle: "refine this intro",
      attachmentIds: [],
      mode: "agent",
      goalMode: false,
    });
    expect(payload?.text).not.toContain("full private draft body");
    expect(buildWriteAssistantPrompt({
      prompt: "   ",
      activePath: "drafts/intro.md",
      content: "",
      savedContent: "",
    })).toBeNull();
  });

  it("adds selected text as explicit assistant context without mirroring the whole document", () => {
    const payload = buildWriteAssistantPrompt({
      prompt: "polish this",
      activePath: "drafts/intro.md",
      content: "private before\nselected paragraph\nprivate after",
      savedContent: "private before\nselected paragraph\nprivate after",
      selection: {
        selectionStart: "private before\n".length,
        selectionEnd: "private before\nselected paragraph".length,
      },
    });

    expect(payload?.text).toContain("- Selected text:");
    expect(payload?.text).toContain("selected paragraph");
    expect(payload?.text).not.toContain("private before\nselected paragraph\nprivate after");
  });

  it("uses bounded nearby context only when it does not equal the whole document", () => {
    expect(
      getWriteAssistantLocalContext({
        content: "short private draft",
        selection: { selectionStart: 5, selectionEnd: 5 },
      }),
    ).toBeNull();

    const longContent = `${"a".repeat(1300)}CURSOR${"b".repeat(1300)}`;
    const context = getWriteAssistantLocalContext({
      content: longContent,
      selection: { selectionStart: 1300, selectionEnd: 1300 },
      maxChars: 240,
      nearbyRadius: 80,
    });

    expect(context?.label).toBe("Nearby text");
    expect(context?.text).toContain("[...]");
    expect(context?.text.length).toBeLessThanOrEqual(240);
    expect(context?.text).not.toBe(longContent);
  });

  it("keeps all recent write assistant process items visible", () => {
    const items = [
      makeItem("system", "system-1"),
      makeItem("user", "user-1"),
      makeItem("tool", "tool-1"),
      makeItem("assistant", "assistant-1"),
    ];

    expect(getWriteAssistantVisibleItems(items).map((item) => item.id))
      .toEqual(["system-1", "user-1", "tool-1", "assistant-1"]);
  });

  it("keeps the leading recent turn complete when limiting assistant items", () => {
    const firstTurn = Array.from({ length: 10 }, (_, index) =>
      makeItem("tool", `turn-a-${index}`, "turn-a"),
    );
    const secondTurn = Array.from({ length: 75 }, (_, index) =>
      makeItem("tool", `turn-b-${index}`, "turn-b"),
    );

    const visible = getWriteAssistantVisibleItems([...firstTurn, ...secondTurn], 80);

    expect(visible).toHaveLength(85);
    expect(visible[0]?.id).toBe("turn-a-0");
    expect(visible[visible.length - 1]?.id).toBe("turn-b-74");
  });

  it("maps write sidebar resize controls to the shared width range", () => {
    expect(clampWriteSidebarWidth(120)).toBe(180);
    expect(clampWriteSidebarWidth(260)).toBe(260);
    expect(clampWriteSidebarWidth(520)).toBe(420);
    expect(getNextWriteSidebarWidth(260, "ArrowLeft")).toBe(244);
    expect(getNextWriteSidebarWidth(260, "ArrowRight")).toBe(276);
    expect(getNextWriteSidebarWidth(260, "Home")).toBe(180);
    expect(getNextWriteSidebarWidth(260, "End")).toBe(420);
    expect(getNextWriteSidebarWidth(260, "Enter")).toBe(260);
    expect(getWriteSidebarDividerClassName(false)).toBe(
      "ds-workbench-divider ds-write-sidebar-divider",
    );
    expect(getWriteSidebarDividerClassName(true)).toBe(
      "ds-workbench-divider ds-write-sidebar-divider is-dragging",
    );
  });
});

function makeItem(
  kind: "system" | "user" | "assistant" | "tool",
  id: string,
  turnId = "turn-1",
) {
  const base = {
    id,
    threadId: "thread-1",
    turnId,
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
