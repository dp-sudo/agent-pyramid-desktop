import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildWriteTree,
  checkMarkdownFileChange,
  completeMarkdownInline,
  createMarkdownFile,
  deleteMarkdownFile,
  exportMarkdownFile,
  getMarkdownFileForEdit,
  listMarkdownFiles,
  parseWriteAction,
  readMarkdownFileContent,
  renameMarkdownFile,
  resolveWritePathForAccess,
  resolveWritePath,
  resolveMarkdownMediaReferences,
  retrieveWriteMemory,
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
      await fs.mkdir(path.join(workspace, "__test_logs__", "pytest"), { recursive: true });
      await fs.mkdir(path.join(workspace, "out"), { recursive: true });
      await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(workspace, "README.md"), "# Root\n", "utf8");
      await fs.writeFile(path.join(workspace, "docs", "guide.mdx"), "# Guide\n", "utf8");
      await fs.writeFile(path.join(workspace, "DeepSeek", "reference.md"), "# Reference\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "__test_logs__", "pytest", "failure.md"),
        "# Failure\n",
        "utf8",
      );
      await fs.writeFile(path.join(workspace, "out", "build.md"), "# Build\n", "utf8");
      await fs.writeFile(path.join(workspace, "node_modules", "pkg", "readme.md"), "# Package\n", "utf8");

      const files = await listMarkdownFiles(workspace, "");

      expect(files.map((file) => file.path).sort()).toEqual(["README.md", "docs/guide.mdx"]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("skips unreadable child directories during workspace scans", async () => {
    const workspace = await makeTempDir("write-scan-eperm-");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const originalReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdir");
    try {
      await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
      await fs.mkdir(path.join(workspace, "locked"), { recursive: true });
      await fs.writeFile(path.join(workspace, "docs", "guide.md"), "# Guide\n", "utf8");

      readdirSpy.mockImplementation(async (target, options) => {
        if (target === path.join(workspace, "locked")) {
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          });
        }
        return originalReaddir(target, options);
      });

      await expect(listMarkdownFiles(workspace, "")).resolves.toEqual([
        expect.objectContaining({ path: "docs/guide.md" }),
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[write] skipped workspace scan path:"),
      );
    } finally {
      readdirSpy.mockRestore();
      warnSpy.mockRestore();
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

  it("parses write-specific inline edit actions without using code tools", () => {
    expect(
      parseWriteAction({
        workspace: "/workspace",
        path: "notes.md",
        rawAction: JSON.stringify({
          kind: "write:inline-edit",
          path: "notes.md",
          scope: {
            path: "notes.md",
            start: 0,
            end: 5,
            originalText: "Hello",
          },
          replacement: "Hi",
          summary: "Shorten greeting.",
        }),
      }),
    ).toEqual({
      kind: "write:inline-edit",
      path: "notes.md",
      scope: {
        path: "notes.md",
        start: 0,
        end: 5,
        originalText: "Hello",
      },
      replacement: "Hi",
      summary: "Shorten greeting.",
    });
  });

  it("rejects write actions that target a different path or invalid scope", () => {
    expect(() => parseWriteAction({
      workspace: "/workspace",
      path: "notes.md",
      rawAction: JSON.stringify({
        kind: "write:inline-edit",
        path: "other.md",
        scope: {
          path: "other.md",
          start: 0,
          end: 5,
          originalText: "Hello",
        },
        replacement: "Hi",
        summary: "Shorten greeting.",
      }),
    })).toThrow("Write action path does not match request path: other.md");

    expect(() => parseWriteAction({
      workspace: "/workspace",
      path: "notes.md",
      rawAction: JSON.stringify({
        kind: "write:inline-edit",
        path: "notes.md",
        scope: {
          path: "notes.md",
          start: 10,
          end: 5,
          originalText: "Hello",
        },
        replacement: "Hi",
        summary: "Shorten greeting.",
      }),
    })).toThrow("Write inline edit scope must use a valid non-negative range.");
  });

  it("retrieves observable local writing memory evidence from markdown files", async () => {
    const workspace = await makeTempDir("write-memory-");
    try {
      await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "docs", "voice.md"),
        "The product voice should feel calm, exact, and practical.\n\nOther paragraph.",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "notes.md"),
        "A launch note about pricing and support.",
        "utf8",
      );

      const result = await retrieveWriteMemory({
        workspace,
        query: "calm practical product voice",
        activePath: "docs/voice.md",
        limit: 3,
      });

      expect(result.query).toBe("calm practical product voice");
      expect(result.evidence[0]).toMatchObject({
        path: "docs/voice.md",
        snippet: "The product voice should feel calm, exact, and practical.",
      });
      expect(result.evidence[0].score).toBeGreaterThan(0);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("supports markdown file lifecycle operations and tree output", async () => {
    const workspace = await makeTempDir("write-lifecycle-");
    try {
      await createMarkdownFile({
        workspace,
        path: "drafts/one.md",
        content: "# One\n![cover](../images/cover.png)\n",
      });
      await fs.mkdir(path.join(workspace, "images"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "images", "cover.png"),
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a,
        ]),
      );

      expect(await buildWriteTree(workspace, "")).toEqual([
        {
          kind: "directory",
          name: "drafts",
          path: "drafts",
          children: [
            expect.objectContaining({
              kind: "file",
              name: "one.md",
              path: "drafts/one.md",
            }),
          ],
        },
      ]);

      const media = await resolveMarkdownMediaReferences({
        workspace,
        path: "drafts/one.md",
        content: "# One\n![cover](../images/cover.png)\n![site](https://example.com/a.png)\n",
      });
      expect(media.references).toEqual([
        expect.objectContaining({
          alt: "cover",
          rawTarget: "../images/cover.png",
          path: "images/cover.png",
          exists: true,
          external: false,
          mimeType: "image/png",
          dataUrl: expect.stringContaining("data:image/png;base64,"),
        }),
        {
          alt: "site",
          rawTarget: "https://example.com/a.png",
          path: null,
          exists: false,
          external: true,
        },
      ]);

      const renamed = await renameMarkdownFile({
        workspace,
        fromPath: "drafts/one.md",
        toPath: "drafts/two.md",
      });
      expect(renamed.path).toBe("drafts/two.md");

      const exported = await exportMarkdownFile({ workspace, path: "drafts/two.md" });
      expect(exported.suggestedName).toBe("two.md");
      expect(exported.markdown).toContain("# One");

      const watch = await checkMarkdownFileChange({
        workspace,
        path: "drafts/two.md",
        knownModifiedAt: "2000-01-01T00:00:00.000Z",
      });
      expect(watch.changed).toBe(true);

      await deleteMarkdownFile({ workspace, path: "drafts/two.md" });
      await expect(readMarkdownFileContent(workspace, "drafts/two.md")).rejects.toThrow();
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("marks large markdown files read-only for editing", async () => {
    const workspace = await makeTempDir("write-large-");
    try {
      await fs.writeFile(path.join(workspace, "large.md"), "x".repeat(1_000_001), "utf8");

      const file = await getMarkdownFileForEdit(workspace, "large.md");

      expect(file.readonly).toBe(true);
      expect(file.content).toBe("");
      expect(file.reason).toContain("larger");
    } finally {
      await removeTempDir(workspace);
    }
  });
});
