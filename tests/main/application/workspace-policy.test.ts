import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspacePathLexically,
  resolveWorkspaceRoot,
} from "../../../src/main/application/tools/workspace-policy";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("workspace path policy", () => {
  it("uses the same trimmed workspace root for validation and resolution", async () => {
    const workspace = await makeTempDir("workspace-policy-root-");
    try {
      const paddedWorkspace = `  ${workspace}  `;

      expect(resolveWorkspaceRoot(paddedWorkspace)).toBe(path.resolve(workspace));
      expect(resolveWorkspacePathLexically(paddedWorkspace, "docs/guide.md"))
        .toBe(path.join(workspace, "docs", "guide.md"));
      expect(() => resolveWorkspaceRoot(" relative-workspace "))
        .toThrow("Workspace path must be absolute.");
    } finally {
      await removeTempDir(workspace);
    }
  });
});
