import { createElement, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeWorkbenchStage } from "../../src/renderer/src/ui/components/workbench/CodeWorkbenchStage";
import { WriteWorkbenchStage } from "../../src/renderer/src/ui/components/workbench/WriteWorkbenchStage";
import { WriteAssistantPanel } from "../../src/renderer/src/ui/components/write/WriteAssistantPanel";
import { WriteEditorPanel } from "../../src/renderer/src/ui/components/write/WriteEditorPanel";
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
          onWorkspaceSelected: () => true,
          onSendAssistantPrompt: async () => true,
          onInterruptAssistant: () => undefined,
          assistantBusy: false,
          toastMessage: "Write failed",
          toastEnabled: true,
          onDismissToast: () => undefined,
        }),
      ),
    );

    expect(html).toContain("class=\"ds-write-workspace\"");
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
        status: "idle",
        errorMessage: null,
        activePath: "notes.md",
        saveDisabled: false,
        onContentChange: () => undefined,
        onEditorKeyDown: () => undefined,
        onSave: () => undefined,
      }),
    );

    expect(html).toContain("class=\"ds-write-editor\"");
    expect(html).toContain("aria-label=\"write.editorPlaceholder\"");
    expect(html).toContain("draft body");
    expect(html).toContain("class=\"ds-write-ghost\"");
    expect(html).toContain(" completion");
    expect(html).toContain("class=\"ds-pill is-accent ds-write-save-button\"");
    expect(html).toContain("write.save");
  });

  it("keeps the assistant panel on the Write composer variant", () => {
    const assistantMessagesRef: RefObject<HTMLDivElement | null> = { current: null };
    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        null,
        createElement(WriteAssistantPanel, {
          activePath: null,
          activeTurnId: null,
          assistantBusy: true,
          assistantItems: [],
          assistantMessagesRef,
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
    expect(html).not.toContain("ds-composer-model-button");
  });
});
