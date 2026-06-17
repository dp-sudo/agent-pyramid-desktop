import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RIGHT_INSPECTOR_REGION_ID } from "../../src/renderer/src/ui/components/inspector/RightInspector";
import {
  getInspectorToggleLabel,
  isInspectorExpanded,
  WorkbenchTopBar,
} from "../../src/renderer/src/ui/components/topbar/WorkbenchTopBar";
import { WorkbenchProvider } from "../../src/renderer/src/ui/store/WorkbenchContext";
import { INITIAL_STATE } from "../../src/renderer/src/ui/store/WorkbenchContext";
import type { ThreadRecord } from "../../src/shared/agent-contracts";

describe("WorkbenchTopBar helpers", () => {
  it("shows an open label before the inspector is visible", () => {
    expect(getInspectorToggleLabel(null, testT)).toBe("Open");
  });

  it("shows a close label while any inspector mode is visible", () => {
    expect(getInspectorToggleLabel("changes", testT)).toBe("Close");
    expect(getInspectorToggleLabel("todo", testT)).toBe("Close");
    expect(getInspectorToggleLabel("plan", testT)).toBe("Close");
  });

  it("derives the Inspector toggle expansion state from the panel mode", () => {
    expect(isInspectorExpanded(null)).toBe(false);
    expect(isInspectorExpanded("changes")).toBe(true);
    expect(isInspectorExpanded("todo")).toBe(true);
    expect(isInspectorExpanded("plan")).toBe(true);
  });

  it("wires topbar Inspector controls to the controlled panel region", () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchProvider, null, createElement(WorkbenchTopBar)),
    );

    expect(html).toContain(`aria-controls="${RIGHT_INSPECTOR_REGION_ID}"`);
    expect(html).toContain("aria-expanded=\"false\"");
  });

  it("shows current thread approval and sandbox controls when a session is active", () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkbenchProvider,
        {
          initialState: {
            ...INITIAL_STATE,
            activeThreadId: "thread-1",
            activeThread: thread(),
          },
          children: createElement(WorkbenchTopBar, {
            onUpdateThreadSafety: async () => undefined,
          }),
        },
      ),
    );

    expect(html).toContain("class=\"ds-topbar-safety\"");
    expect(html).toContain("aria-label=\"chat.approvalPolicy\"");
    expect(html).toContain("aria-label=\"chat.sandboxMode\"");
    expect(html).toContain("value=\"on-request\"");
    expect(html).toContain("value=\"workspace-write\"");
    expect(html).toContain("settings.approvalPolicies.untrusted");
    expect(html).toContain("settings.sandboxModes.danger-full-access");
  });
});

function testT(key: string): string {
  if (key === "inspector.open") return "Open";
  if (key === "inspector.close") return "Close";
  return key;
}

function thread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: "Thread",
    workspace: "/workspace",
    mode: "code",
    status: "active",
    relation: "primary",
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    ...overrides,
  };
}
