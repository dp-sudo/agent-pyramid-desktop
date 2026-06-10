import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  completeMarkdownInline,
  createMarkdownFileContent,
  deleteMarkdownFile,
  listMarkdownFiles,
  parseWriteCompleteRequest,
  parseWriteCreateRequest,
  parseWriteDeleteRequest,
  parseWriteGetRequest,
  parseWriteListRequest,
  parseWritePutRequest,
  parseWriteRenameRequest,
  readMarkdownFileContent,
  renameMarkdownFile,
  resolveWritePathForAccess,
  resolveWritePath,
  writeMarkdownFileContent,
} from "../../../src/main/ipc/write-handlers";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("write handlers helpers", () => {
  it("parses write IPC requests before file service access", () => {
    expect(parseWriteListRequest({ workspace: "/workspace", search: "guide" }))
      .toEqual({ workspace: "/workspace", search: "guide" });
    expect(parseWriteGetRequest({ workspace: "/workspace", path: "notes.md" }))
      .toEqual({ workspace: "/workspace", path: "notes.md" });
    expect(parseWritePutRequest({
      workspace: "/workspace",
      path: "notes.md",
      content: "# Notes\n",
    })).toEqual({
      workspace: "/workspace",
      path: "notes.md",
      content: "# Notes\n",
    });
    expect(parseWriteCreateRequest({
      workspace: "/workspace",
      path: "drafts/new.md",
      content: "# New\n",
    })).toEqual({
      workspace: "/workspace",
      path: "drafts/new.md",
      content: "# New\n",
    });
    expect(parseWriteRenameRequest({
      workspace: "/workspace",
      path: "drafts/old.md",
      newPath: "drafts/new.md",
    })).toEqual({
      workspace: "/workspace",
      path: "drafts/old.md",
      newPath: "drafts/new.md",
    });
    expect(parseWriteDeleteRequest({ workspace: "/workspace", path: "notes.md" }))
      .toEqual({ workspace: "/workspace", path: "notes.md" });
    expect(parseWriteCompleteRequest({
      workspace: "/workspace",
      path: "notes.md",
      prefix: "- first task",
      suffix: "",
    })).toEqual({
      workspace: "/workspace",
      path: "notes.md",
      prefix: "- first task",
      suffix: "",
    });
  });

  it("rejects malformed write IPC requests with traceable messages", () => {
    expect(() => parseWriteListRequest(null)).toThrow(
      "Write list request must be an object.",
    );
    expect(() => parseWriteListRequest({ workspace: "/workspace", search: 1 }))
      .toThrow("Write list search must be a string.");
    expect(() => parseWriteGetRequest({ workspace: "/workspace", path: 1 }))
      .toThrow("Write get path must be a string.");
    expect(() => parseWritePutRequest({
      workspace: "/workspace",
      path: "notes.md",
      content: Buffer.from("draft"),
    })).toThrow("Write put content must be a string.");
    expect(() => parseWriteCreateRequest({
      workspace: "/workspace",
      path: "notes.md",
      content: 1,
    })).toThrow("Write create content must be a string.");
    expect(() => parseWriteRenameRequest({
      workspace: "/workspace",
      path: "notes.md",
      newPath: 1,
    })).toThrow("Write rename newPath must be a string.");
    expect(() => parseWriteDeleteRequest({
      workspace: "/workspace",
      path: false,
    })).toThrow("Write delete path must be a string.");
    expect(() => parseWriteCompleteRequest({
      workspace: "/workspace",
      path: "notes.md",
      prefix: "- first task",
      suffix: false,
    })).toThrow("Write complete suffix must be a string.");
  });

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
      expect(() => resolveWritePath("relative-workspace", "docs/guide.md")).toThrow(
        "Workspace path must be absolute.",
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
      expect(() => resolveWritePath(workspace, ".vscode/settings.md")).toThrow(
        "Path is skipped by write service policy: .vscode/settings.md",
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

  it("rejects invalid UTF-8 markdown reads", async () => {
    const workspace = await makeTempDir("write-invalid-utf8-");
    try {
      await fs.writeFile(path.join(workspace, "bad.md"), Buffer.from([0xff, 0xfe]));

      await expect(readMarkdownFileContent(workspace, "bad.md"))
        .rejects.toThrow("write.get path is not valid UTF-8: bad.md");
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

  it("rejects writes when created parent directories become symlinks before commit", async () => {
    const workspace = await makeTempDir("write-parent-symlink-race-");
    const outside = await makeTempDir("write-parent-symlink-race-outside-");
    try {
      const parentPath = path.join(workspace, "drafts");
      const outsideTargetPath = path.join(outside, "note.md");
      const originalMkdir = fs.mkdir.bind(fs);
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation((async (
        ...args: Parameters<typeof fs.mkdir>
      ) => {
        const result = await originalMkdir(...args);
        const target = args[0];
        if (typeof target === "string" && path.resolve(target) === parentPath) {
          await fs.rm(parentPath, { recursive: true, force: true });
          await fs.symlink(outside, parentPath);
        }
        return result;
      }) as typeof fs.mkdir);
      try {
        await expect(
          writeMarkdownFileContent(workspace, "drafts/note.md", "# Draft\n"),
        ).rejects.toThrow("Path escapes workspace: drafts/note.md");
      } finally {
        mkdirSpy.mockRestore();
      }

      await expect(fs.access(outsideTargetPath)).rejects.toThrow();
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("creates markdown documents without overwriting existing files", async () => {
    const workspace = await makeTempDir("write-create-");
    try {
      await expect(createMarkdownFileContent(workspace, "drafts/new.md", "# New\n"))
        .resolves.toBe(Buffer.byteLength("# New\n", "utf8"));
      await expect(readMarkdownFileContent(workspace, "drafts/new.md"))
        .resolves.toBe("# New\n");
      await expect(createMarkdownFileContent(workspace, "drafts/new.md", "# Other\n"))
        .rejects.toThrow();
      await expect(createMarkdownFileContent(workspace, "drafts/new.txt", "text"))
        .rejects.toThrow("Write service only supports Markdown files: drafts/new.txt");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("renames markdown documents without overwriting target files", async () => {
    const workspace = await makeTempDir("write-rename-");
    try {
      await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
      await fs.writeFile(path.join(workspace, "docs", "source.md"), "# Source\n", "utf8");
      await fs.writeFile(path.join(workspace, "docs", "target.md"), "# Target\n", "utf8");

      await expect(renameMarkdownFile(workspace, "docs/source.md", "docs/source.md"))
        .rejects.toThrow("Write rename source and target must be different.");
      await expect(renameMarkdownFile(workspace, "docs/source.md", "docs/target.md"))
        .rejects.toThrow();
      await expect(readMarkdownFileContent(workspace, "docs/source.md"))
        .resolves.toBe("# Source\n");
      await expect(readMarkdownFileContent(workspace, "docs/target.md"))
        .resolves.toBe("# Target\n");

      await renameMarkdownFile(workspace, "docs/source.md", "docs/renamed.md");

      await expect(readMarkdownFileContent(workspace, "docs/renamed.md"))
        .resolves.toBe("# Source\n");
      await expect(readMarkdownFileContent(workspace, "docs/source.md"))
        .rejects.toThrow();
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("deletes markdown documents through the same workspace policy", async () => {
    const workspace = await makeTempDir("write-delete-");
    try {
      await fs.writeFile(path.join(workspace, "notes.md"), "# Notes\n", "utf8");

      await deleteMarkdownFile(workspace, "notes.md");

      await expect(fs.stat(path.join(workspace, "notes.md"))).rejects.toThrow();
      await expect(deleteMarkdownFile(workspace, "../outside.md"))
        .rejects.toThrow("Path escapes workspace: ../outside.md");
      await fs.writeFile(path.join(workspace, "notes.txt"), "text", "utf8");
      await expect(deleteMarkdownFile(workspace, "notes.txt"))
        .rejects.toThrow("Write service only supports Markdown files: notes.txt");
    } finally {
      await removeTempDir(workspace);
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
