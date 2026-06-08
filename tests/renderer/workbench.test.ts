import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/shared/agent-contracts";
import {
  buildComposerSendPayload,
  clampSidebarWidth,
  formatInitialLoadErrors,
  getNextSidebarWidth,
} from "../../src/renderer/src/ui/Workbench";

describe("Workbench", () => {
  it("formats initial load IPC errors instead of silently ignoring them", () => {
    expect(
      formatInitialLoadErrors([
        ok([]),
        err("CONFIG_FAILED", "Could not load model config."),
        err("PROFILES_FAILED", "Could not load model profiles."),
      ]),
    ).toBe("Could not load model config.\nCould not load model profiles.");
  });

  it("does not report an initial load error when all IPC requests succeed", () => {
    expect(formatInitialLoadErrors([ok([]), ok({}), ok({})])).toBeNull();
  });

  it("keeps sidebar width inside the supported drag range", () => {
    expect(clampSidebarWidth(120)).toBe(180);
    expect(clampSidebarWidth(260)).toBe(260);
    expect(clampSidebarWidth(520)).toBe(420);
  });

  it("maps separator keyboard controls to sidebar widths", () => {
    expect(getNextSidebarWidth(260, "ArrowLeft")).toBe(244);
    expect(getNextSidebarWidth(260, "ArrowRight")).toBe(276);
    expect(getNextSidebarWidth(260, "Home")).toBe(180);
    expect(getNextSidebarWidth(260, "End")).toBe(420);
    expect(getNextSidebarWidth(260, "Enter")).toBe(260);
  });

  it("builds no send payload for an empty composer with no attachments", () => {
    expect(buildComposerSendPayload("   ", 0, testT)).toBeNull();
  });

  it("builds a trimmed text payload when the composer has text", () => {
    expect(buildComposerSendPayload("  Explain this  ", 1, testT)).toEqual({
      text: "Explain this",
      threadTitle: "Explain this",
    });
  });

  it("builds an attachment-only payload with visible text", () => {
    expect(buildComposerSendPayload("   ", 2, testT)).toEqual({
      text: "Analyze attached images",
      displayText: "Analyze attached images",
      threadTitle: "Analyze attached images",
    });
  });
});

function testT(key: string): string {
  if (key === "composer.attachmentOnlyMessageSingle") {
    return "Analyze attached image";
  }
  if (key === "composer.attachmentOnlyMessageMultiple") {
    return "Analyze attached images";
  }
  return key;
}
