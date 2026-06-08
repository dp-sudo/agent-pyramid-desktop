import { describe, expect, it } from "vitest";
import { getInspectorToggleLabel } from "../../src/renderer/src/ui/components/topbar/WorkbenchTopBar";

describe("WorkbenchTopBar helpers", () => {
  it("shows an open label before the inspector is visible", () => {
    expect(getInspectorToggleLabel(null, testT)).toBe("Open");
  });

  it("shows a close label while any inspector mode is visible", () => {
    expect(getInspectorToggleLabel("changes", testT)).toBe("Close");
    expect(getInspectorToggleLabel("todo", testT)).toBe("Close");
    expect(getInspectorToggleLabel("plan", testT)).toBe("Close");
  });
});

function testT(key: string): string {
  if (key === "inspector.open") return "Open";
  if (key === "inspector.close") return "Close";
  return key;
}
