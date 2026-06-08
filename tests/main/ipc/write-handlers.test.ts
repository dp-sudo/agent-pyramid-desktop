import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  completeMarkdownInline,
  listMarkdownFiles,
  resolveWritePathForAccess,
  resolveWritePath,
} from "../../../src/main/ipc/write-handlers";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("write handlers helpers", () => {
  it("lists markdown files while excluding skipped project and build directories", async () => {
    const workspace = await makeTempDir("write-handlers-");
    try {
      await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
      await fs.mkdir(path.join(workspace, "DeepSeek"), { recursive: true });
      await fs.mkdir(path.join(workspace, "out"), { recursive: true });
      await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(workspace, "README.md"), "# Root\n", "utf8");
      await fs.writeFile(path.join(workspace, "docs", "guide.mdx"), "# Guide\n", "utf8");
      await fs.writeFile(path.join(workspace, "DeepSeek", "reference.md"), "# Reference\n", "utf8");
      await fs.writeFile(path.join(workspace, "out", "build.md"), "# Build\n", "utf8");
      await fs.writeFile(path.join(workspace, "node_modules", "pkg", "readme.md"), "# Package\n", "utf8");

      const files = await listMarkdownFiles(workspace, "");

      expect(files.map((file) => file.path).sort()).toEqual(["README.md", "docs/guide.mdx"]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("keeps write get/put paths inside the workspace and outside skipped directories", async () => {
    const workspace = await makeTempDir("write-path-policy-");
    try {
      expect(resolveWritePath(workspace, "docs/guide.md")).toBe(
        path.join(workspace, "docs", "guide.md"),
      );
      expect(() => resolveWritePath(workspace, "../outside.md")).toThrow(
        "Path escapes workspace: ../outside.md",
      );
      expect(() => resolveWritePath(workspace, "DeepSeek/reference.md")).toThrow(
        "Path is skipped by write service policy: DeepSeek/reference.md",
      );
      expect(() => resolveWritePath(workspace, "out/build.md")).toThrow(
        "Path is skipped by write service policy: out/build.md",
      );
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("limits write get/put paths to markdown files", async () => {
    const workspace = await makeTempDir("write-markdown-policy-");
    try {
      expect(resolveWritePath(workspace, "docs/guide.md")).toBe(
        path.join(workspace, "docs", "guide.md"),
      );
      expect(resolveWritePath(workspace, "docs/guide.mdx")).toBe(
        path.join(workspace, "docs", "guide.mdx"),
      );
      expect(resolveWritePath(workspace, "docs/guide.markdown")).toBe(
        path.join(workspace, "docs", "guide.markdown"),
      );
      expect(() => resolveWritePath(workspace, "src/index.ts")).toThrow(
        "Write service only supports Markdown files: src/index.ts",
      );
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("surfaces unreadable workspace scans as errors instead of returning an empty list", async () => {
    await expect(listMarkdownFiles("/path/that/does/not/exist", "")).rejects.toThrow();
  });

  it("rejects read and write paths that resolve through symlinks outside the workspace", async () => {
    const workspace = await makeTempDir("write-symlink-workspace-");
    const outside = await makeTempDir("write-symlink-outside-");
    try {
      const outsideFile = path.join(outside, "outside.md");
      await fs.writeFile(outsideFile, "# Outside\n", "utf8");
      await fs.symlink(outsideFile, path.join(workspace, "linked.md"));

      await expect(resolveWritePathForAccess(workspace, "linked.md", "read"))
        .rejects.toThrow("Path escapes workspace: linked.md");
      await expect(resolveWritePathForAccess(workspace, "linked.md", "write"))
        .rejects.toThrow("Path escapes workspace: linked.md");

      await expect(resolveWritePathForAccess(workspace, "docs/new.md", "write"))
        .resolves.toBe(path.join(workspace, "docs", "new.md"));
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("rejects dangling symlink write targets before they can create outside files", async () => {
    const workspace = await makeTempDir("write-dangling-symlink-workspace-");
    const outside = await makeTempDir("write-dangling-symlink-outside-");
    try {
      const outsideFile = path.join(outside, "created-later.md");
      await fs.symlink(outsideFile, path.join(workspace, "dangling.md"));

      await expect(resolveWritePathForAccess(workspace, "dangling.md", "write"))
        .rejects.toThrow("Path escapes workspace: dangling.md");
      await expect(fs.stat(outsideFile)).rejects.toThrow();
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("suggests local markdown continuations for inline completion", () => {
    expect(
      completeMarkdownInline({
        workspace: "/workspace",
        path: "notes.md",
        prefix: "- first task",
        suffix: "",
      }),
    ).toEqual({ completion: "\n- ", score: 0.56, truncated: false });

    expect(
      completeMarkdownInline({
        workspace: "/workspace",
        path: "notes.md",
        prefix: "1. first item",
        suffix: "",
      }),
    ).toEqual({ completion: "\n2. ", score: 0.56, truncated: false });
  });
});
