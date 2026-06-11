import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildWriteAssistantPrompt,
  clampWriteSidebarWidth,
  formatWriteFileMeta,
  getNextWriteDocumentPath,
  getNextWriteSidebarWidth,
  getWriteAssistantPromptText,
  getWriteAssistantLocalContext,
  getWriteAssistantVisibleItems,
  getWriteCompletionAcceptState,
  getWriteCompletionRequestContext,
  getWriteContextMenuPosition,
  getWriteClearedDocumentState,
  getWriteDocumentEditState,
  getWriteDocumentPathValidationError,
  getWriteListState,
  getWriteOpenDocumentState,
  getWriteSidebarDividerClassName,
  getWriteWorkspaceSwitchState,
  isWriteEditorSelectionEqual,
  isWriteMarkdownDocumentPath,
  normalizeWriteDocumentPathInput,
  shouldApplyWriteCompletionResult,
  shouldApplyWriteOpenResult,
  shouldDisableWriteSave,
  shouldRequestWriteCompletion,
  shouldSaveWriteFileBeforeDocumentDelete,
  shouldSaveWriteFileBeforeSwitch,
  shouldUseSelectedWriteWorkspace,
  shouldWarnBeforeLeavingWriteDocument,
  WRITE_SEARCH_CLEAR_BUTTON_TEXT,
  WriteWorkspaceView,
} from "../../src/renderer/src/ui/components/write/WriteWorkspaceView";
import {
  WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  WRITE_COMPLETION_PREFIX_MAX_CHARS,
  WRITE_COMPLETION_SUFFIX_MAX_CHARS,
} from "../../src/renderer/src/ui/components/write/write-constants";
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
    expect(html).toContain("class=\"ds-write-sidebar-section ds-write-sessions-section\"");
    expect(html).toContain("class=\"ds-write-session-list\"");
    expect(html).toContain("class=\"ds-write-sidebar-section ds-write-documents-section\"");
    expect(html).toContain("class=\"ds-write-document-list\"");
    expect(html).toContain("class=\"ds-pill is-accent ds-write-save-button\"");
    expect(html).toContain("class=\"ds-write-assistant-composer\"");
    expect(html).toContain("class=\"ds-composer-shell is-write\"");
    expect(html).toContain("placeholder=\"composer.writePlaceholder\"");
    expect(html).toContain("ds-composer-tool-button");
    expect(html).toContain("ds-composer-model-button");
    expect(html).not.toContain("ds-write-assistant-form");
    expect(html).not.toContain("ds-composer-mode-chip");
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

  it("skips pre-delete save only when deleting the active document itself", () => {
    expect(shouldSaveWriteFileBeforeDocumentDelete({
      deletingPath: "notes.md",
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "dirty draft",
      savedContent: "saved draft",
    })).toBe(false);
    expect(shouldSaveWriteFileBeforeDocumentDelete({
      deletingPath: "other.md",
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "dirty draft",
      savedContent: "saved draft",
    })).toBe(true);
    expect(shouldSaveWriteFileBeforeDocumentDelete({
      deletingPath: "other.md",
      activePath: "notes.md",
      workspaceRoot: "/workspace",
      content: "saved draft",
      savedContent: "saved draft",
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

  it("applies only completion responses that still match the current document", () => {
    expect(shouldApplyWriteCompletionResult({
      requestId: 2,
      latestRequestId: 2,
      requestedWorkspace: "/workspace",
      currentWorkspace: "/workspace",
      requestedPath: "notes.md",
      currentPath: "notes.md",
    })).toBe(true);

    expect(shouldApplyWriteCompletionResult({
      requestId: 1,
      latestRequestId: 2,
      requestedWorkspace: "/workspace",
      currentWorkspace: "/workspace",
      requestedPath: "notes.md",
      currentPath: "notes.md",
    })).toBe(false);

    expect(shouldApplyWriteCompletionResult({
      requestId: 2,
      latestRequestId: 2,
      requestedWorkspace: "/workspace-a",
      currentWorkspace: "/workspace-b",
      requestedPath: "notes.md",
      currentPath: "notes.md",
    })).toBe(false);

    expect(shouldApplyWriteCompletionResult({
      requestId: 2,
      latestRequestId: 2,
      requestedWorkspace: "/workspace",
      currentWorkspace: "/workspace",
      requestedPath: "notes.md",
      currentPath: "other.md",
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
      selection: { selectionStart: 0, selectionEnd: 0 },
    });
  });

  it("centralizes open and cleared document view state", () => {
    expect(getWriteOpenDocumentState("notes.md", "draft")).toEqual({
      activePath: "notes.md",
      content: "draft",
      savedContent: "draft",
      completion: "",
      selection: { selectionStart: 0, selectionEnd: 0 },
    });

    expect(getWriteClearedDocumentState()).toEqual({
      activePath: null,
      content: "",
      savedContent: "",
      completion: "",
      selection: { selectionStart: 0, selectionEnd: 0 },
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

  it("normalizes and validates markdown document paths for document actions", () => {
    expect(normalizeWriteDocumentPathInput("  \\docs\\draft.md  "))
      .toBe("docs/draft.md");
    expect(normalizeWriteDocumentPathInput("/docs/draft.md"))
      .toBe("docs/draft.md");
    expect(normalizeWriteDocumentPathInput(" docs // nested / draft.md "))
      .toBe("docs/nested/draft.md");
    expect(isWriteMarkdownDocumentPath("docs/draft.md")).toBe(true);
    expect(isWriteMarkdownDocumentPath("docs/draft.mdx")).toBe(true);
    expect(isWriteMarkdownDocumentPath("docs/draft.markdown")).toBe(true);
    expect(isWriteMarkdownDocumentPath("docs/draft.txt")).toBe(false);
    expect(isWriteMarkdownDocumentPath("docs/.md")).toBe(false);
    expect(isWriteMarkdownDocumentPath("../draft.md")).toBe(false);
    expect(isWriteMarkdownDocumentPath("docs/")).toBe(false);
    expect(getWriteDocumentPathValidationError("")).toBe("empty");
    expect(getWriteDocumentPathValidationError("docs/")).toBe("directory");
    expect(getWriteDocumentPathValidationError("../draft.md")).toBe("dot-segment");
    expect(getWriteDocumentPathValidationError("C:/draft.md")).toBe("drive-root");
    expect(getWriteDocumentPathValidationError("docs/draft.txt")).toBe("extension");
    expect(getWriteDocumentPathValidationError("docs/.md")).toBe("filename");
    expect(getWriteDocumentPathValidationError("docs/draft.md")).toBeNull();
  });

  it("suggests the next available default markdown document path", () => {
    expect(getNextWriteDocumentPath([])).toBe("untitled.md");
    expect(getNextWriteDocumentPath([{ path: "untitled.md" }]))
      .toBe("untitled-2.md");
    expect(getNextWriteDocumentPath([
      { path: "UNTITLED.md" },
      { path: "untitled-2.md" },
    ])).toBe("untitled-3.md");
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

  it("detects unchanged editor selections before invalidating completion", () => {
    expect(isWriteEditorSelectionEqual(
      { selectionStart: 4, selectionEnd: 4 },
      { selectionStart: 4, selectionEnd: 4 },
    )).toBe(true);
    expect(isWriteEditorSelectionEqual(
      { selectionStart: 4, selectionEnd: 8 },
      { selectionStart: 4, selectionEnd: 9 },
    )).toBe(false);
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

    expect(
      getWriteCompletionRequestContext({
        content: "0123456789abcdef",
        selection: { selectionStart: 10, selectionEnd: 10 },
        maxPrefixChars: 4,
        maxSuffixChars: 3,
      }),
    ).toEqual({
      prefix: "6789",
      suffix: "abc",
    });
  });

  it("uses named write policy limits for default completion context", () => {
    const content = `${"p".repeat(WRITE_COMPLETION_PREFIX_MAX_CHARS + 3)}${"s".repeat(
      WRITE_COMPLETION_SUFFIX_MAX_CHARS + 3,
    )}`;
    const selectionStart = WRITE_COMPLETION_PREFIX_MAX_CHARS + 3;

    expect(
      getWriteCompletionRequestContext({
        content,
        selection: { selectionStart, selectionEnd: selectionStart },
      }),
    ).toEqual({
      prefix: "p".repeat(WRITE_COMPLETION_PREFIX_MAX_CHARS),
      suffix: "s".repeat(WRITE_COMPLETION_SUFFIX_MAX_CHARS),
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

  it("uses attachment-only copy and carries assistant attachment payload fields", () => {
    const t = (key: string): string => key;
    expect(getWriteAssistantPromptText("  draft  ", 1, t)).toBe("draft");
    expect(getWriteAssistantPromptText("  ", 1, t))
      .toBe("composer.attachmentOnlyMessageSingle");
    expect(getWriteAssistantPromptText("  ", 2, t))
      .toBe("composer.attachmentOnlyMessageMultiple");
    expect(getWriteAssistantPromptText("  ", 0, t)).toBe("");

    const payload = buildWriteAssistantPrompt({
      prompt: "analyze this image",
      activePath: null,
      content: "",
      savedContent: "",
      attachmentIds: ["attachment-1"],
      mode: "agent",
      goalMode: false,
    });

    expect(payload?.attachmentIds).toEqual(["attachment-1"]);
    expect(payload?.mode).toBe("agent");
    expect(payload?.goalMode).toBe(false);
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

  it("uses named write policy limits for assistant selected context", () => {
    const selected = "x".repeat(WRITE_ASSISTANT_CONTEXT_MAX_CHARS + 20);

    expect(
      getWriteAssistantLocalContext({
        content: selected,
        selection: { selectionStart: 0, selectionEnd: selected.length },
      }),
    ).toEqual({
      label: "Selected text",
      text: `${"x".repeat(WRITE_ASSISTANT_CONTEXT_MAX_CHARS - 8)}\n[...]`,
    });
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

  it("sorts write assistant items before preserving the leading visible turn", () => {
    const turn1User = makeItem(
      "user",
      "turn-1-user",
      "turn-1",
      "2026-06-08T00:00:01.000Z",
    );
    const turn2User = makeItem(
      "user",
      "turn-2-user",
      "turn-2",
      "2026-06-08T00:00:03.000Z",
    );
    const turn1Tool = makeItem(
      "tool",
      "turn-1-tool",
      "turn-1",
      "2026-06-08T00:00:02.000Z",
    );

    const visible = getWriteAssistantVisibleItems(
      [turn1User, turn2User, turn1Tool],
      2,
    );

    expect(visible.map((item) => item.id)).toEqual([
      "turn-1-user",
      "turn-1-tool",
      "turn-2-user",
    ]);
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

  it("keeps write document context menus inside the viewport", () => {
    expect(getWriteContextMenuPosition({
      clientX: 120,
      clientY: 80,
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 120, y: 80 });

    expect(getWriteContextMenuPosition({
      clientX: 780,
      clientY: 580,
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 616, y: 468 });

    expect(getWriteContextMenuPosition({
      clientX: -20,
      clientY: -10,
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 8, y: 8 });

    expect(getWriteContextMenuPosition({
      clientX: 100,
      clientY: 100,
      viewportWidth: 120,
      viewportHeight: 90,
    })).toEqual({ x: 8, y: 8 });
  });
});

function makeItem(
  kind: "system" | "user" | "assistant" | "tool",
  id: string,
  turnId = "turn-1",
  createdAt = "2026-06-08T00:00:00.000Z",
) {
  const base = {
    id,
    threadId: "thread-1",
    turnId,
    createdAt,
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
