import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodingTools } from "../../../src/main/application/tools/coding-tools";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
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

function asStringToolResult(result: string | { content: string }): string {
  return typeof result === "string" ? result : result.content;
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
      ) as { path: string; content: string; sha256: string; mtimeMs: number };
      expect(read).toMatchObject({
        path: "src/index.ts",
        content: "export const marker = 1;\n",
        sha256: createHash("sha256").update("export const marker = 1;\n").digest("hex"),
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
      ) as { content: string; bytes: number; truncated: boolean };
      expect(truncated).toMatchObject({
        content: "abc",
        bytes: 6,
        truncated: true,
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
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

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
});
