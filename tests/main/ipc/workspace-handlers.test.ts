import { describe, expect, it, vi } from "vitest";
import { normalizeWorkspacePickResult } from "../../../src/main/ipc/workspace-handlers";

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("workspace handlers", () => {
  it("normalizes canceled and selected directory picker results", () => {
    expect(normalizeWorkspacePickResult({ canceled: true, filePaths: [] }))
      .toEqual({ canceled: true, path: null });
    expect(normalizeWorkspacePickResult({ canceled: false, filePaths: ["/workspace"] }))
      .toEqual({ canceled: false, path: "/workspace" });
  });

  it("rejects non-canceled picker results without a selected directory", () => {
    expect(() => normalizeWorkspacePickResult({ canceled: false, filePaths: [] }))
      .toThrow("Workspace picker returned no selected directory.");
  });
});
