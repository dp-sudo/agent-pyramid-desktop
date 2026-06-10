import { describe, expect, it } from "vitest";
import type { Item, PlanItem, ToolItem } from "../../src/shared/agent-contracts";
import {
  clampRightInspectorWidth,
  deriveInspectorTodos,
  getNextRightInspectorWidth,
  getResetRightInspectorWidth,
  getRightInspectorResizerClassName,
  RIGHT_INSPECTOR_CLOSE_BUTTON_TEXT,
  RIGHT_INSPECTOR_REGION_ID,
  RIGHT_INSPECTOR_TITLE_ID,
  summarizeInspectorChanges,
  summarizePlanProgress,
} from "../../src/renderer/src/ui/components/inspector/RightInspector";

describe("RightInspector helpers", () => {
  it("keeps inspector width inside the design range", () => {
    expect(clampRightInspectorWidth(240)).toBe(280);
    expect(clampRightInspectorWidth(360)).toBe(360);
    expect(clampRightInspectorWidth(900)).toBe(760);
  });

  it("maps keyboard controls for a right-side resizer", () => {
    expect(getNextRightInspectorWidth(360, "ArrowLeft")).toBe(384);
    expect(getNextRightInspectorWidth(360, "ArrowRight")).toBe(336);
    expect(getNextRightInspectorWidth(360, "Home")).toBe(280);
    expect(getNextRightInspectorWidth(360, "End")).toBe(760);
    expect(getNextRightInspectorWidth(360, "Enter")).toBe(360);
  });

  it("resets the right-side resizer to the default width on double click", () => {
    expect(getResetRightInspectorWidth()).toBe(360);
  });

  it("marks the right-side resizer while pointer resizing is active", () => {
    expect(getRightInspectorResizerClassName(false)).toBe("ds-right-inspector-resizer");
    expect(getRightInspectorResizerClassName(true)).toBe(
      "ds-right-inspector-resizer is-dragging",
    );
  });

  it("uses stable ASCII visible text for the close button", () => {
    expect(RIGHT_INSPECTOR_CLOSE_BUTTON_TEXT).toBe("x");
  });

  it("uses stable ids for the controlled Inspector region and label", () => {
    expect(RIGHT_INSPECTOR_REGION_ID).toBe("workbench-right-inspector");
    expect(RIGHT_INSPECTOR_TITLE_ID).toBe("workbench-right-inspector-title");
  });

  it("summarizes tool items for the changes panel", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "read_file",
      args: { path: "src/main/index.ts" },
      result: { content: "main" },
      status: "completed",
      createdAt,
    };

    expect(summarizeInspectorChanges([item], testT)).toEqual([
      {
        id: "tool-1",
        title: "read_file:src/main/index.ts",
        detail: "{\n  \"path\": \"src/main/index.ts\"\n}\n\nmain",
        statusText: "Completed",
        tone: "success",
      },
    ]);
  });

  it("derives actionable todos from approvals, failed tools, errors, and open plan steps", () => {
    const plan: PlanItem = {
      kind: "plan",
      id: "plan-1",
      threadId: "thread-1",
      turnId: "turn-1",
      steps: [
        { id: "step-1", title: "Done", status: "completed" },
        { id: "step-2", title: "Patch UI", status: "in_progress" },
        { id: "step-3", title: "Verify", status: "pending" },
      ],
      createdAt,
    };
    const items: Item[] = [
      {
        kind: "approval",
        id: "approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "write_file",
        args: {},
        createdAt,
      },
      {
        kind: "tool",
        id: "tool-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        name: "search_files",
        args: { query: "TODO" },
        status: "failed",
        createdAt,
      },
      {
        kind: "system",
        id: "system-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Worker crashed",
        level: "error",
        createdAt,
      },
      plan,
    ];

    expect(deriveInspectorTodos(items, testT)).toEqual([
      {
        id: "approval-1",
        title: "write_file",
        label: "Approval needed",
        tone: "running",
      },
      {
        id: "tool-1",
        title: "search_files:TODO",
        label: "Tool failed",
        tone: "danger",
      },
      {
        id: "system-1",
        title: "Worker crashed",
        label: "Runtime error",
        tone: "danger",
      },
      {
        id: "plan-1:step-2",
        title: "Patch UI",
        label: "In progress",
        tone: "running",
      },
      {
        id: "plan-1:step-3",
        title: "Verify",
        label: "Pending",
        tone: "neutral",
      },
    ]);
  });

  it("summarizes plan progress", () => {
    expect(
      summarizePlanProgress([
        { id: "step-1", title: "One", status: "completed" },
        { id: "step-2", title: "Two", status: "in_progress" },
        { id: "step-3", title: "Three", status: "pending" },
      ]),
    ).toEqual({ completed: 1, total: 3, percent: 33 });
  });
});

const createdAt = "2026-01-01T00:00:00.000Z";

function testT(key: string, options?: Record<string, unknown>): string {
  if (key === "chat.tools.readFilePath") return `read_file:${String(options?.path)}`;
  if (key === "chat.tools.searchFilesQuery") return `search_files:${String(options?.query)}`;
  if (key === "chat.toolStatus.completed") return "Completed";
  if (key === "chat.toolStatus.failed") return "Failed";
  if (key === "inspector.todoApproval") return "Approval needed";
  if (key === "inspector.todoFailedTool") return "Tool failed";
  if (key === "inspector.todoRuntimeError") return "Runtime error";
  if (key === "inspector.planStatusInProgress") return "In progress";
  if (key === "inspector.planStatusPending") return "Pending";
  if (key === "inspector.planStatusCompleted") return "Completed";
  return key;
}
