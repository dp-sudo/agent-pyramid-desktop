import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCommandTools } from "../../../src/main/application/tools/command-tools";
import { createCodingTools } from "../../../src/main/application/tools/coding-tools";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { FileHistoryStore } from "../../../src/main/application/tools/file-history-state";
import { FileReadStateStore } from "../../../src/main/application/tools/file-read-state";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { createWorkspaceTools } from "../../../src/main/application/tools/workspace-tools";
import type { AgentTool } from "../../../src/main/domain/agent/types";
import type { ThreadGoalStatus } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const sampleTool: AgentTool = {
  definition: {
    name: "sample",
    description: "Test-only tool for exercising registry plumbing.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  async execute(input) {
    if (typeof input.text !== "string") {
      throw new Error("sample tool requires a string field named text.");
    }
    return input.text;
  },
};

const requireFromTest = createRequire(import.meta.url);

function asStringToolResult(result: string | { content: string }): string {
  return typeof result === "string" ? result : result.content;
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function tscCommand(project = "tsconfig.json"): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(requireFromTest.resolve("typescript/bin/tsc"))} --noEmit -p ${project}`;
}

describe("application tools", () => {
  it("registers and executes tools by name", async () => {
    const registry = new InMemoryToolRegistry([sampleTool]);

    expect(registry.listDefinitions()).toEqual([sampleTool.definition]);
    await expect(
      registry.execute(
        { id: "call-1", name: "sample", arguments: { text: "hello" } },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).resolves.toEqual({
      toolCallId: "call-1",
      name: "sample",
      content: "hello",
    });
  });

  it("rejects duplicate tool names during construction and registration", () => {
    expect(() => new InMemoryToolRegistry([sampleTool, sampleTool]))
      .toThrow('Tool "sample" is already registered.');

    const registry = new InMemoryToolRegistry([]);
    registry.register(sampleTool);

    expect(() => registry.register(sampleTool))
      .toThrow('Tool "sample" is already registered.');
  });

  it("keeps missing and invalid tool failures observable", async () => {
    const registry = new InMemoryToolRegistry([sampleTool]);

    await expect(
      registry.execute(
        { id: "call-1", name: "missing", arguments: {} },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow('Tool "missing" is not registered.');

    await expect(sampleTool.execute({}, { threadId: "thread-1", turnId: "turn-1" }))
      .rejects.toThrow("sample tool requires a string field named text.");
  });

  it("normalizes create_plan input into visible plan payloads", async () => {
    const content = await createPlanTool.execute(
      {
        title: " Review ",
        steps: [
          { title: " Read code ", status: "in_progress" },
          { title: "Patch tests", status: "unknown" },
        ],
      },
      { threadId: "thread-1", turnId: "turn-1" },
    );

    expect(JSON.parse(asStringToolResult(content)) as unknown).toEqual({
      title: "Review",
      steps: [
        { title: "Read code", status: "in_progress" },
        { title: "Patch tests", status: "pending" },
      ],
    });
  });

  it("validates create_plan and update_goal inputs", async () => {
    await expect(
      createPlanTool.execute({ steps: [] }, { threadId: "thread-1", turnId: "turn-1" }),
    ).rejects.toThrow("create_plan requires a non-empty steps array.");

    const updateGoal = vi.fn<
      (threadId: string, update: {
        goal?: string | null;
        status?: ThreadGoalStatus;
        summary?: string;
      }) => void
    >();
    const [goalTool] = createGoalTools({
      updateGoal: async (threadId, update) => {
        updateGoal(threadId, update);
      },
    });

    const result = await goalTool.execute(
      { goal: " Ship tests ", status: "complete", summary: " Done " },
      { threadId: "thread-1", turnId: "turn-1" },
    );
    expect(JSON.parse(asStringToolResult(result)) as unknown).toEqual({ updated: true });
    expect(updateGoal).toHaveBeenCalledWith("thread-1", {
      goal: "Ship tests",
      status: "complete",
      summary: "Done",
    });

    await goalTool.execute(
      { clear: true },
      { threadId: "thread-1", turnId: "turn-1" },
    );
    expect(updateGoal).toHaveBeenLastCalledWith("thread-1", {
      goal: null,
    });

    await expect(
      goalTool.execute({ goal: "" }, { threadId: "thread-1", turnId: "turn-1" }),
    ).rejects.toThrow("goal must be a non-empty string. Use clear: true to clear the goal.");

    await expect(
      goalTool.execute(
        { clear: true, status: "complete" },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow("clear cannot be combined with goal, status, or summary.");

    await expect(
      goalTool.execute({ status: "done" }, { threadId: "thread-1", turnId: "turn-1" }),
    ).rejects.toThrow("goal status must be active, complete, or blocked.");
  });

  it("reads, lists, and searches workspace files without escaping the workspace", async () => {
    const workspace = await makeTempDir("workspace-tools-");
    const outside = await makeTempDir("workspace-tools-outside-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.mkdir(path.join(workspace, "DeepSeek"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "export const marker = 1;\n", "utf8");
      await fs.writeFile(path.join(workspace, ".hidden.ts"), "secret\n", "utf8");
      await fs.writeFile(path.join(workspace, "DeepSeek", "reference.ts"), "reference\n", "utf8");
      await fs.writeFile(path.join(workspace, "src", "large.txt"), "abcdef", "utf8");
      await fs.writeFile(path.join(workspace, "src", "huge.txt"), `${"x".repeat(1_000_001)}marker\n`, "utf8");
      await fs.writeFile(path.join(outside, "outside.ts"), "external marker\n", "utf8");
      await fs.symlink(outside, path.join(workspace, "linked-outside"));
      const registry = new InMemoryToolRegistry(createWorkspaceTools());
      const readState = new FileReadStateStore();

      const listed = JSON.parse(
        (
          await registry.execute(
            { id: "call-list", name: "list_files", arguments: { path: "." } },
            { threadId: "thread-1", turnId: "turn-1", workspace },
          )
        ).content,
      ) as { entries: Array<{ path: string; type: string }> };
      expect(listed.entries).toEqual([
        expect.objectContaining({ path: "src", type: "directory" }),
      ]);
      expect(listed.entries.some((entry) => entry.path === "linked-outside")).toBe(false);

      const read = JSON.parse(
        (
          await registry.execute(
            { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
            { threadId: "thread-1", turnId: "turn-1", workspace, readState },
          )
        ).content,
      ) as {
        path: string;
        content: string;
        sha256: string;
        fullSha256: string;
        offsetBytes: number;
        bytesRead: number;
        mtimeMs: number;
      };
      expect(read).toMatchObject({
        path: "src/index.ts",
        content: "export const marker = 1;\n",
        sha256: createHash("sha256").update("export const marker = 1;\n").digest("hex"),
        fullSha256: createHash("sha256").update("export const marker = 1;\n").digest("hex"),
        offsetBytes: 0,
        bytesRead: Buffer.byteLength("export const marker = 1;\n", "utf8"),
      });
      expect(read.mtimeMs).toBeGreaterThan(0);
      expect(readState.get(path.join(workspace, "src", "index.ts"))?.content)
        .toBe("export const marker = 1;\n");

      const truncated = JSON.parse(
        (
          await registry.execute(
            { id: "call-read-small", name: "read_file", arguments: { path: "src/large.txt", max_bytes: 3 } },
            { threadId: "thread-1", turnId: "turn-1", workspace },
          )
        ).content,
      ) as {
        content: string;
        bytes: number;
        fullSha256: string;
        offsetBytes: number;
        bytesRead: number;
        truncated: boolean;
      };
      expect(truncated).toMatchObject({
        content: "abc",
        bytes: 6,
        fullSha256: createHash("sha256").update("abcdef").digest("hex"),
        offsetBytes: 0,
        bytesRead: 3,
        truncated: true,
      });

      const ranged = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-read-range",
              name: "read_file",
              arguments: { path: "src/large.txt", offset_bytes: 3, max_bytes: 3 },
            },
            { threadId: "thread-1", turnId: "turn-1", workspace },
          )
        ).content,
      ) as {
        content: string;
        offsetBytes: number;
        bytesRead: number;
        truncated: boolean;
      };
      expect(ranged).toMatchObject({
        content: "def",
        offsetBytes: 3,
        bytesRead: 3,
        truncated: false,
      });

      const searched = JSON.parse(
        (
          await registry.execute(
            { id: "call-search", name: "search_files", arguments: { query: "marker" } },
            { threadId: "thread-1", turnId: "turn-1", workspace },
          )
        ).content,
      ) as {
        results: Array<{ path: string; line: number; text: string }>;
        skippedLargeFiles: number;
      };
      expect(searched.results).toEqual([
        { path: "src/index.ts", line: 1, text: "export const marker = 1;" },
      ]);
      expect(
        searched.results.some((result) => result.path.includes("linked-outside")),
      ).toBe(false);
      expect(searched.skippedLargeFiles).toBe(1);

      const searchedFile = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-search-file",
              name: "search_files",
              arguments: { query: "marker", path: "src/index.ts" },
            },
            { threadId: "thread-1", turnId: "turn-1", workspace },
          )
        ).content,
      ) as {
        path: string;
        results: Array<{ path: string; line: number; text: string }>;
        skippedLargeFiles: number;
        truncated: boolean;
      };
      expect(searchedFile).toEqual({
        query: "marker",
        path: "src/index.ts",
        results: [
          { path: "src/index.ts", line: 1, text: "export const marker = 1;" },
        ],
        skippedLargeFiles: 0,
        truncated: false,
      });

      await expect(
        registry.execute(
          { id: "call-escape", name: "read_file", arguments: { path: "../outside.ts" } },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside.ts");
      await expect(
        registry.execute(
          { id: "call-hidden", name: "read_file", arguments: { path: ".hidden.ts" } },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ),
      ).rejects.toThrow("Path is skipped by workspace tool policy: .hidden.ts");
      await expect(
        registry.execute(
          { id: "call-deepseek", name: "read_file", arguments: { path: "DeepSeek/reference.ts" } },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ),
      ).rejects.toThrow("Path is skipped by workspace tool policy: DeepSeek/reference.ts");
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("edits and writes files only after a fresh read and returns structured diffs", async () => {
    const workspace = await makeTempDir("coding-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };

      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );
      const edit = await registry.execute(
        {
          id: "call-edit",
          name: "edit_file",
          arguments: {
            path: "src/index.ts",
            old_string: "const value = 1;",
            new_string: "const value = 2;",
          },
        },
        context,
      );
      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 2;\n");
      expect(edit.displayResult).toMatchObject({
        path: "src/index.ts",
        operation: "update",
        diff: {
          kind: "file_diff",
          added: 1,
          removed: 1,
          lines: [
            { type: "removed", text: "const value = 1;" },
            { type: "added", text: "const value = 2;" },
          ],
        },
      });

      const write = await registry.execute(
        {
          id: "call-write",
          name: "write_file",
          arguments: { path: "src/new.ts", content: "export const created = true;\n" },
        },
        context,
      );
      expect(await fs.readFile(path.join(workspace, "src", "new.ts"), "utf8"))
        .toBe("export const created = true;\n");
      expect(write.displayResult).toMatchObject({
        path: "src/new.ts",
        operation: "create",
        diff: {
          kind: "file_diff",
          added: 1,
          removed: 0,
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects ambiguous edits, stale reads, and unsafe write overwrites", async () => {
    const workspace = await makeTempDir("coding-tools-guard-");
    try {
      await fs.writeFile(path.join(workspace, "file.ts"), "x\nx\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

      await expect(
        registry.execute(
          {
            id: "call-edit-no-read",
            name: "edit_file",
            arguments: { path: "file.ts", old_string: "x", new_string: "y" },
          },
          context,
        ),
      ).rejects.toThrow("Read the file with read_file before attempting to edit or overwrite it.");

      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "file.ts" } },
        context,
      );
      await expect(
        registry.execute(
          {
            id: "call-edit-ambiguous",
            name: "edit_file",
            arguments: { path: "file.ts", old_string: "x", new_string: "y" },
          },
          context,
        ),
      ).rejects.toThrow("edit_file found 2 matches");

      await fs.writeFile(path.join(workspace, "file.ts"), "external\n", "utf8");
      await expect(
        registry.execute(
          {
            id: "call-write-stale",
            name: "write_file",
            arguments: { path: "file.ts", content: "next\n", overwrite: true },
          },
          context,
        ),
      ).rejects.toThrow("File has been modified since it was read.");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("allows exact edits after ranged reads using the full file hash", async () => {
    const workspace = await makeTempDir("coding-tools-ranged-read-");
    try {
      await fs.writeFile(path.join(workspace, "file.ts"), "alpha\nbeta\ngamma\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

      const partialRead = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-read-range",
              name: "read_file",
              arguments: { path: "file.ts", max_bytes: 5 },
            },
            context,
          )
        ).content,
      ) as { truncated: boolean; fullSha256: string };
      expect(partialRead).toMatchObject({
        truncated: true,
        fullSha256: createHash("sha256").update("alpha\nbeta\ngamma\n").digest("hex"),
      });

      await registry.execute(
        {
          id: "call-edit-after-range",
          name: "edit_file",
          arguments: {
            path: "file.ts",
            old_string: "beta",
            new_string: "BETA",
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "file.ts"), "utf8"))
        .toBe("alpha\nBETA\ngamma\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects edits after ranged reads when the full file hash is stale", async () => {
    const workspace = await makeTempDir("coding-tools-ranged-read-stale-");
    try {
      await fs.writeFile(path.join(workspace, "file.ts"), "alpha\nbeta\ngamma\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

      await registry.execute(
        {
          id: "call-read-range",
          name: "read_file",
          arguments: { path: "file.ts", max_bytes: 5 },
        },
        context,
      );
      await fs.writeFile(path.join(workspace, "file.ts"), "alpha\nexternal\ngamma\n", "utf8");

      await expect(
        registry.execute(
          {
            id: "call-edit-stale-range",
            name: "edit_file",
            arguments: {
              path: "file.ts",
              old_string: "external",
              new_string: "next",
            },
          },
          context,
        ),
      ).rejects.toThrow("File has been modified since it was read.");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("applies unified diff patches after dry-run validation", async () => {
    const workspace = await makeTempDir("apply-patch-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };
      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );

      const result = await registry.execute(
        {
          id: "call-patch",
          name: "apply_patch",
          arguments: {
            patch: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const value = 1;",
              "+const value = 2;",
              "--- /dev/null",
              "+++ b/src/created.ts",
              "@@ -0,0 +1,2 @@",
              "+export const created = true;",
              "+export const answer = 42;",
            ].join("\n"),
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 2;\n");
      expect(await fs.readFile(path.join(workspace, "src", "created.ts"), "utf8"))
        .toBe("export const created = true;\nexport const answer = 42;\n");
      expect(result.displayResult).toMatchObject({
        added: 3,
        removed: 1,
        diff: {
          kind: "multi_file_diff",
          added: 3,
          removed: 1,
          files: [
            { path: "src/index.ts", operation: "update", added: 1, removed: 1 },
            { path: "src/created.ts", operation: "create", added: 2, removed: 0 },
          ],
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("applies patches after ranged reads when the full file hash is fresh", async () => {
    const workspace = await makeTempDir("apply-patch-ranged-read-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "alpha\nbeta\ngamma\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        {
          id: "call-read-range",
          name: "read_file",
          arguments: { path: "src/index.ts", max_bytes: 5 },
        },
        context,
      );

      await registry.execute(
        {
          id: "call-patch-range",
          name: "apply_patch",
          arguments: {
            patch: [
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1,3 +1,3 @@",
              " alpha",
              "-beta",
              "+BETA",
              " gamma",
            ].join("\n"),
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("alpha\nBETA\ngamma\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects invalid apply_patch input without partial writes", async () => {
    const workspace = await makeTempDir("apply-patch-tools-guard-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      await fs.writeFile(path.join(workspace, "src", "other.ts"), "unchanged\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

      await expect(
        registry.execute(
          {
            id: "call-no-read",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- a/src/index.ts",
                "+++ b/src/index.ts",
                "@@ -1 +1 @@",
                "-const value = 1;",
                "+const value = 2;",
              ].join("\n"),
            },
          },
          context,
        ),
      ).rejects.toThrow("Read the file with read_file before attempting to edit or overwrite it.");

      await registry.execute(
        { id: "call-read-index", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );
      await registry.execute(
        { id: "call-read-other", name: "read_file", arguments: { path: "src/other.ts" } },
        context,
      );
      await expect(
        registry.execute(
          {
            id: "call-bad-patch",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- a/src/index.ts",
                "+++ b/src/index.ts",
                "@@ -1 +1 @@",
                "-const value = 1;",
                "+const value = 2;",
                "--- a/src/other.ts",
                "+++ b/src/other.ts",
                "@@ -1 +1 @@",
                "-missing",
                "+changed",
              ].join("\n"),
            },
          },
          context,
        ),
      ).rejects.toThrow("apply_patch hunk does not match src/other.ts.");
      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");
      expect(await fs.readFile(path.join(workspace, "src", "other.ts"), "utf8"))
        .toBe("unchanged\n");

      await expect(
        registry.execute(
          {
            id: "call-escape",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- /dev/null",
                "+++ b/../outside.ts",
                "@@ -0,0 +1 @@",
                "+escape",
              ].join("\n"),
            },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside.ts");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("records file history and rolls back updates and created files", async () => {
    const workspace = await makeTempDir("rollback-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };

      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );
      await registry.execute(
        {
          id: "call-edit",
          name: "edit_file",
          arguments: {
            path: "src/index.ts",
            old_string: "const value = 1;",
            new_string: "const value = 2;",
          },
        },
        context,
      );
      const rollbackUpdate = await registry.execute(
        {
          id: "call-rollback-update",
          name: "rollback_file",
          arguments: { path: "src/index.ts" },
        },
        context,
      );
      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");
      expect(rollbackUpdate.displayResult).toMatchObject({
        path: "src/index.ts",
        operation: "update",
        diff: {
          removed: 1,
          added: 1,
        },
      });

      await registry.execute(
        {
          id: "call-write",
          name: "write_file",
          arguments: { path: "src/created.ts", content: "created\n" },
        },
        context,
      );
      const rollbackCreate = await registry.execute(
        {
          id: "call-rollback-create",
          name: "rollback_file",
          arguments: { path: "src/created.ts" },
        },
        context,
      );
      await expect(fs.access(path.join(workspace, "src", "created.ts")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(rollbackCreate.displayResult).toMatchObject({
        path: "src/created.ts",
        operation: "delete",
        diff: {
          removed: 1,
          added: 0,
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("refuses rollback when history is missing or current content is stale", async () => {
    const workspace = await makeTempDir("rollback-tools-guard-");
    try {
      await fs.writeFile(path.join(workspace, "file.ts"), "one\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };

      await expect(
        registry.execute(
          {
            id: "call-no-history",
            name: "rollback_file",
            arguments: { path: "file.ts" },
          },
          context,
        ),
      ).rejects.toThrow("rollback_file has no history for file.ts.");

      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "file.ts" } },
        context,
      );
      await registry.execute(
        {
          id: "call-edit",
          name: "edit_file",
          arguments: { path: "file.ts", old_string: "one", new_string: "two" },
        },
        context,
      );
      await fs.writeFile(path.join(workspace, "file.ts"), "external\n", "utf8");
      await expect(
        registry.execute(
          {
            id: "call-stale",
            name: "rollback_file",
            arguments: { path: "file.ts" },
          },
          context,
        ),
      ).rejects.toThrow("rollback_file current content no longer matches the latest history entry: file.ts");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("runs foreground workspace commands with cwd, exit status, and captured output", async () => {
    const workspace = await makeTempDir("command-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "input.txt"), "ok\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-command",
          name: "run_command",
          arguments: {
            command: nodeCommand(
              "const fs = require('fs'); process.stdout.write(fs.readFileSync('input.txt', 'utf8')); process.stderr.write('warn'); process.exit(7);",
            ),
            cwd: "src",
          },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        cwd: string;
        exitCode: number;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };

      expect(parsed).toMatchObject({
        cwd: "src",
        exitCode: 7,
        timedOut: false,
        stdout: "ok\n",
        stderr: "warn",
      });
      expect(result.displayResult).toMatchObject(parsed);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("guards run_command cwd, timeouts, and output truncation", async () => {
    const workspace = await makeTempDir("command-tools-guard-");
    const outside = await makeTempDir("command-tools-outside-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "file.txt"), "not a directory", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };

      await expect(
        registry.execute(
          {
            id: "call-escape",
            name: "run_command",
            arguments: { command: nodeCommand("process.stdout.write('x')"), cwd: "../outside" },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside");

      await fs.symlink(outside, path.join(workspace, "linked-outside"));
      await expect(
        registry.execute(
          {
            id: "call-symlink",
            name: "run_command",
            arguments: { command: nodeCommand("process.stdout.write('x')"), cwd: "linked-outside" },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: linked-outside");

      await expect(
        registry.execute(
          {
            id: "call-file-cwd",
            name: "run_command",
            arguments: { command: nodeCommand("process.stdout.write('x')"), cwd: "src/file.txt" },
          },
          context,
        ),
      ).rejects.toThrow("run_command cwd is not a directory: src/file.txt");

      const timedOut = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-timeout",
              name: "run_command",
              arguments: {
                command: nodeCommand("setTimeout(() => undefined, 1000);"),
                timeout_ms: 100,
              },
            },
            context,
          )
        ).content,
      ) as { timedOut: boolean; signal: string | null; exitCode: number | null };
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.exitCode === null || timedOut.exitCode > 0).toBe(true);

      const truncated = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-truncate",
              name: "run_command",
              arguments: {
                command: nodeCommand(
                  "process.stdout.write('x'.repeat(40000)); process.stderr.write('e'.repeat(40000));",
                ),
              },
            },
            context,
          )
        ).content,
      ) as {
        stdout: string;
        stderr: string;
        stdoutBytes: number;
        stderrBytes: number;
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
      };
      expect(truncated.stdout.length).toBe(32 * 1024);
      expect(truncated.stderr.length).toBe(32 * 1024);
      expect(truncated.stdoutBytes).toBe(40000);
      expect(truncated.stderrBytes).toBe(40000);
      expect(truncated.stdoutTruncated).toBe(true);
      expect(truncated.stderrTruncated).toBe(true);
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("runs TypeScript workspace diagnostics and parses structured errors", async () => {
    const workspace = await makeTempDir("diagnose-tools-");
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            typecheck: tscCommand(),
          },
          devDependencies: {
            typescript: "local",
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value: string = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-diagnose",
          name: "diagnose_workspace",
          arguments: {},
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        command: string;
        diagnosticCount: number;
        diagnostics: Array<{ path: string; line: number; column: number; code: string; message: string }>;
      };

      expect(parsed.command).toBe("npm run typecheck");
      expect(parsed.diagnosticCount).toBeGreaterThan(0);
      expect(parsed.diagnostics).toEqual([
        expect.objectContaining({
          path: "src/index.ts",
          line: 1,
          code: "TS2322",
        }),
      ]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("falls back to npx tsc diagnostics when package typecheck is unavailable", async () => {
    const workspace = await makeTempDir("diagnose-tools-fallback-");
    try {
      await fs.writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value: string = 1;\n", "utf8");
      await fs.mkdir(path.join(workspace, "node_modules", ".bin"), { recursive: true });
      await fs.symlink(requireFromTest.resolve("typescript/bin/tsc"), path.join(workspace, "node_modules", ".bin", "tsc"));
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-diagnose-fallback",
          name: "diagnose_workspace",
          arguments: {},
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        command: string;
        diagnosticCount: number;
        diagnostics: Array<{ path: string; code: string }>;
      };

      expect(parsed.command).toBe("npx tsc --noEmit");
      expect(parsed.diagnosticCount).toBeGreaterThan(0);
      expect(parsed.diagnostics[0]).toMatchObject({
        path: "src/index.ts",
        code: "TS2322",
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("filters TypeScript diagnostics to a single workspace file", async () => {
    const workspace = await makeTempDir("diagnose-file-tools-");
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            typecheck: tscCommand(),
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "a.ts"), "const a: string = 1;\n", "utf8");
      await fs.writeFile(path.join(workspace, "src", "b.ts"), "const b: number = 'x';\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-diagnose-file",
          name: "diagnose_file",
          arguments: { path: "src/a.ts" },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        path: string;
        diagnosticCount: number;
        diagnostics: Array<{ path: string; code: string }>;
      };

      expect(parsed.path).toBe("src/a.ts");
      expect(parsed.diagnosticCount).toBe(1);
      expect(parsed.diagnostics).toEqual([
        expect.objectContaining({
          path: "src/a.ts",
          code: "TS2322",
        }),
      ]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("guards diagnose_file paths", async () => {
    const workspace = await makeTempDir("diagnose-file-tools-guard-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "file.ts"), "const value = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };

      await expect(
        registry.execute(
          {
            id: "call-escape",
            name: "diagnose_file",
            arguments: { path: "../outside.ts" },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside.ts");

      await expect(
        registry.execute(
          {
            id: "call-directory",
            name: "diagnose_file",
            arguments: { path: "src" },
          },
          context,
        ),
      ).rejects.toThrow("diagnose_file path is not a file: src");
    } finally {
      await removeTempDir(workspace);
    }
  });
});
