import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeWorkbenchStage } from "../../src/renderer/src/ui/components/workbench/CodeWorkbenchStage";
import { WriteWorkbenchStage } from "../../src/renderer/src/ui/components/workbench/WriteWorkbenchStage";
import { WriteAssistantPanel } from "../../src/renderer/src/ui/components/write/WriteAssistantPanel";
import {
  countWriteNewlinesBeforeCaret,
  getInitialWritePreviewSnapshot,
  getWriteSourceMode,
  getWriteSourceTextareaPerformanceAttributes,
  getWritePreviewMode,
  getWritePreviewStatus,
  hasWritePreviewContent,
  shouldSyncWriteSourceTextarea,
  WriteEditorPanel,
} from "../../src/renderer/src/ui/components/write/WriteEditorPanel";
import { WorkbenchProvider } from "../../src/renderer/src/ui/store/WorkbenchContext";

describe("Workbench stage components", () => {
  it("keeps the Code stage structural classes and composer toast boundary", () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(CodeWorkbenchStage, {
          onApprove: async () => undefined,
          pendingApprovalResponses: {},
          onComposerRequestSend: async () => true,
          onInterrupt: () => undefined,
          composerDisabled: false,
          toastMessage: "Runtime failed",
          toastEnabled: true,
          onDismissToast: () => undefined,
        }),
      ),
    );

    expect(html).toContain("class=\"ds-chat-stage\"");
    expect(html).toContain("class=\"ds-chat-topbar-frame\"");
    expect(html).toContain("class=\"ds-message-timeline-empty\"");
    expect(html).toContain("class=\"ds-chat-composer-frame\"");
    expect(html).toContain("class=\"ds-composer-shell is-code\"");
    expect(html).toContain("class=\"ds-error-toast\"");
    expect(html).toContain("Runtime failed");
  });

  it("keeps the Write stage workspace and floating toast boundary", () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(WriteWorkbenchStage, {
          onApprove: async () => undefined,
          pendingApprovalResponses: {},
          onWorkspaceSelected: () => true,
          onSendAssistantPrompt: async () => true,
          onInterruptAssistant: () => undefined,
          assistantBusy: false,
          writeThreads: [
            {
              id: "write-thread-1",
              title: "Draft session",
              workspace: "/workspace",
              status: "active",
              relation: "primary",
              mode: "write",
              updatedAt: "2026-06-10T09:00:00.000Z",
            },
          ],
          onSelectWriteThread: () => undefined,
          onNewWriteThread: () => undefined,
          onDeleteWriteThread: () => undefined,
          onArchiveWriteThread: () => undefined,
          onRestoreWriteThread: () => undefined,
          showArchivedThreads: false,
          onToggleArchivedThreads: () => undefined,
          toastMessage: "Write failed",
          toastEnabled: true,
          onDismissToast: () => undefined,
        }),
      ),
    );

    expect(html).toContain("class=\"ds-write-workspace\"");
    expect(html).toContain("class=\"ds-write-sidebar-section ds-write-sessions-section\"");
    expect(html).toContain("class=\"ds-write-session-list\"");
    expect(html).toContain("Draft session");
    expect(html).toContain("class=\"ds-write-main\"");
    expect(html).toContain("class=\"ds-write-editor\"");
    expect(html).toContain("class=\"ds-write-assistant\"");
    expect(html).toContain("class=\"ds-error-toast is-floating\"");
    expect(html).toContain("Write failed");
  });
});

describe("Write workspace panel components", () => {
  it("keeps the editor panel controlled fields and inline completion ghost", () => {
    const html = renderToStaticMarkup(
      createElement(WriteEditorPanel, {
        content: "draft body",
        savedContent: "saved body",
        completion: " completion",
        selectionStart: 5,
        selectionEnd: 5,
        status: "idle",
        errorMessage: null,
        activePath: "notes.md",
        saveDisabled: false,
        onContentChange: () => undefined,
        onSelectionChange: () => undefined,
        onEditorKeyDown: () => undefined,
        onSave: () => undefined,
      }),
    );

    expect(html).toContain("class=\"ds-write-editor\"");
    expect(html).toContain("class=\"ds-write-editor-split\"");
    expect(html).toContain("class=\"ds-write-preview\"");
    expect(html).toContain("aria-label=\"write.editorPlaceholder\"");
    expect(html).toContain("draft body");
    expect(html).toContain("class=\"ds-write-ghost\"");
    expect(html).toContain(" completion");
    expect(html).toContain("class=\"ds-pill is-accent ds-write-save-button\"");
    expect(html).toContain("write.save");
  });

  it("keeps the assistant panel on the Write composer variant", () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(WriteAssistantPanel, {
          activePath: null,
          activeTurnId: null,
          assistantBusy: true,
          assistantItems: [],
          composerDisabled: true,
          onRequestSend: async () => true,
          onInterrupt: () => undefined,
        }),
      ),
    );

    expect(html).toContain("class=\"ds-write-assistant\"");
    expect(html).toContain("class=\"ds-shiny-text\"");
    expect(html).toContain("class=\"ds-write-assistant-empty\"");
    expect(html).toContain("class=\"ds-composer-shell is-write\"");
    expect(html).toContain("placeholder=\"composer.writePlaceholder\"");
    expect(html).toContain("ds-composer-tool-button");
    expect(html).toContain("ds-composer-model-button");
    expect(html).not.toContain("ds-composer-mode-chip");
  });

  it("pauses initial markdown preview rendering for very large documents", () => {
    const largeContent = `# Large\n${"paragraph\n".repeat(15000)}`;
    const html = renderToStaticMarkup(
      createElement(WriteEditorPanel, {
        content: largeContent,
        savedContent: largeContent,
        completion: "",
        selectionStart: 0,
        selectionEnd: 0,
        status: "idle",
        errorMessage: null,
        activePath: "large.md",
        saveDisabled: true,
        onContentChange: () => undefined,
        onSelectionChange: () => undefined,
        onEditorKeyDown: () => undefined,
        onSave: () => undefined,
      }),
    );

    expect(html).toContain("class=\"ds-write-preview-controls\"");
    expect(html).toContain("data-source-mode=\"large-document\"");
    expect(html).toContain("write.previewPaused");
    expect(html).toContain("write.refreshPreview");
    expect(html).not.toContain("class=\"ds-markdown");
  });

  it("derives write preview performance modes from document size", () => {
    expect(getWritePreviewMode(10, { liveMaxChars: 20, manualMinChars: 40 }))
      .toBe("live");
    expect(getWritePreviewMode(21, { liveMaxChars: 20, manualMinChars: 40 }))
      .toBe("debounced");
    expect(getWritePreviewMode(40, { liveMaxChars: 20, manualMinChars: 40 }))
      .toBe("manual");
    expect(getInitialWritePreviewSnapshot("a".repeat(50))).toBe("a".repeat(50));
    expect(getInitialWritePreviewSnapshot("a".repeat(130000))).toBe("");
    expect(getWritePreviewStatus({
      mode: "debounced",
      content: "new",
      previewText: "old",
    })).toBe("updating");
    expect(getWritePreviewStatus({
      mode: "manual",
      content: "new",
      previewText: "old",
    })).toBe("paused");
    expect(getWritePreviewStatus({
      mode: "manual",
      content: "same",
      previewText: "same",
    })).toBe("live");
    expect(hasWritePreviewContent("  \n\t")).toBe(false);
    expect(hasWritePreviewContent("  text ")).toBe(true);
  });

  it("counts caret lines without allocating split arrays", () => {
    expect(countWriteNewlinesBeforeCaret("a\nb\nc", 0)).toBe(0);
    expect(countWriteNewlinesBeforeCaret("a\nb\nc", 3)).toBe(1);
    expect(countWriteNewlinesBeforeCaret("a\nb\nc", 99)).toBe(2);
    expect(countWriteNewlinesBeforeCaret("a\nb\nc", -1)).toBe(0);
  });

  it("uses a lower-cost source textarea mode for large markdown files", () => {
    expect(getWriteSourceMode(10, 20)).toBe("standard");
    expect(getWriteSourceMode(20, 20)).toBe("large-document");
    expect(getWriteSourceTextareaPerformanceAttributes("standard")).toEqual({
      wrap: "soft",
      spellCheck: true,
    });
    expect(getWriteSourceTextareaPerformanceAttributes("large-document")).toEqual({
      wrap: "off",
      spellCheck: false,
      autoCapitalize: "off",
      autoComplete: "off",
    });
  });

  it("syncs the hybrid source textarea only for programmatic content changes", () => {
    expect(shouldSyncWriteSourceTextarea({
      activePath: "next.md",
      previousActivePath: "current.md",
      domValue: "old",
      lastKnownDomValue: "old",
      nextContent: "new",
    })).toBe(true);
    expect(shouldSyncWriteSourceTextarea({
      activePath: "current.md",
      previousActivePath: "current.md",
      domValue: "typed",
      lastKnownDomValue: "old",
      nextContent: "typed",
    })).toBe(false);
    expect(shouldSyncWriteSourceTextarea({
      activePath: "current.md",
      previousActivePath: "current.md",
      domValue: "old",
      lastKnownDomValue: "old",
      nextContent: "programmatic",
    })).toBe(true);
    expect(shouldSyncWriteSourceTextarea({
      activePath: "current.md",
      previousActivePath: "current.md",
      domValue: "user is still typing",
      lastKnownDomValue: "old",
      nextContent: "programmatic",
    })).toBe(false);
  });
});
