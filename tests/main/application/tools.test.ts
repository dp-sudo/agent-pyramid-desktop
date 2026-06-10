import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPackageManagerInvocation,
  createCommandTools,
  createShellInvocation,
  toWslPath,
} from "../../../src/main/application/tools/command-tools";
import { createCodingTools } from "../../../src/main/application/tools/coding-tools";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { FileHistoryStore } from "../../../src/main/application/tools/file-history-state";
import { FileReadStateStore } from "../../../src/main/application/tools/file-read-state";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { createWorkspaceTools } from "../../../src/main/application/tools/workspace-tools";
import type { AgentTool } from "../../../src/main/domain/agent/types";
import {
  RUNTIME_READ_ONLY_TOOL_NAMES,
  type ThreadGoalStatus,
} from "../../../src/shared/agent-contracts";
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

function toolSchemaProperties(tool: AgentTool | undefined): Record<string, unknown> {
  const properties = tool?.definition.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(`Expected ${tool?.definition.name ?? "missing"} tool schema properties.`);
  }
  return properties as Record<string, unknown>;
}

function nodeCommand(script: string): string {
  if (process.platform === "win32") {
    const encoded = Buffer.from(script, "utf8").toString("base64");
    return `node -e eval^(Buffer.from^('${encoded}','base64'^).toString^(^)^)`;
  }
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function tscCommand(project = "tsconfig.json"): string {
  return `node ${JSON.stringify(requireFromTest.resolve("typescript/bin/tsc"))} --noEmit -p ${JSON.stringify(project)}`;
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
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

  it("keeps shared read-only tool names aligned with built-in metadata", () => {
    const tools = [
      ...createWorkspaceTools(),
      ...createCommandTools(),
      createPlanTool,
      ...createGoalTools({ updateGoal: async () => undefined }),
      ...createCodingTools(),
    ];
    const metadataReadOnlyNames = tools
      .filter((tool) => tool.metadata?.isReadOnly)
      .map((tool) => tool.definition.name)
      .sort();

    expect(metadataReadOnlyNames).toEqual([...RUNTIME_READ_ONLY_TOOL_NAMES].sort());
    expect(RUNTIME_READ_ONLY_TOOL_NAMES.every((toolName) =>
      tools.some((tool) => tool.definition.name === toolName),
    )).toBe(true);
  });

  it("keeps diagnose_file schema aligned with the language service implementation", () => {
    const diagnoseFile = createCommandTools()
      .find((tool) => tool.definition.name === "diagnose_file");

    expect(diagnoseFile?.definition.inputSchema).toMatchObject({
      type: "object",
      properties: {
        path: {
          type: "string",
        },
      },
      required: ["path"],
    });
    expect(Object.keys(diagnoseFile?.definition.inputSchema.properties ?? {}))
      .toEqual(["path"]);
  });

  it("registers dedicated development command tools", () => {
    const names = createCommandTools().map((tool) => tool.definition.name);

    expect(names).toEqual(expect.arrayContaining([
      "run_command",
      "shell_command",
      "git_bash_command",
      "powershell_command",
      "wsl_command",
      "rg_search",
      "git_status",
      "git_diff",
      "git_log",
      "git_branch",
      "git_commit",
      "package_scripts",
      "package_install",
      "package_test",
      "package_build",
      "run_lint",
      "run_format",
      "run_tests",
      "run_build",
      "start_command_session",
      "read_command_session",
      "write_command_session",
      "stop_command_session",
      "detect_shell_environment",
    ]));
  });

  it("keeps workspace tool limit schema aligned with runtime bounds", () => {
    const tools = createWorkspaceTools();
    const listFiles = tools.find((tool) => tool.definition.name === "list_files");
    const readFile = tools.find((tool) => tool.definition.name === "read_file");
    const searchFiles = tools.find((tool) => tool.definition.name === "search_files");

    expect(toolSchemaProperties(listFiles).max_entries).toMatchObject({
      type: "number",
      description: "Maximum entries to return. Defaults to 120, maximum 500.",
    });
    expect(toolSchemaProperties(readFile).max_bytes).toMatchObject({
      type: "number",
      description: "Maximum bytes to read. Defaults to 80000, maximum 240000.",
    });
    expect(toolSchemaProperties(readFile).offset_bytes).toMatchObject({
      type: "number",
      description: "Byte offset to start reading from. Defaults to 0.",
    });
    expect(toolSchemaProperties(searchFiles).max_results).toMatchObject({
      type: "number",
      description: "Maximum matching lines to return. Defaults to 80, maximum 300.",
    });
  });

  it("keeps command timeout schema aligned with runtime bounds", () => {
    const tools = createCommandTools();
    const runCommand = tools.find((tool) => tool.definition.name === "run_command");
    const diagnoseWorkspace = tools.find((tool) => tool.definition.name === "diagnose_workspace");
    const timeoutDescription =
      "Maximum runtime in milliseconds. Defaults to the runtime command preference (30000). Overrides must be between 100 and the current runtime command preference, which cannot exceed 120000.";

    expect(toolSchemaProperties(runCommand).timeout_ms).toMatchObject({
      type: "number",
      description: timeoutDescription,
    });
    expect(toolSchemaProperties(diagnoseWorkspace).timeout_ms).toMatchObject({
      type: "number",
      description: timeoutDescription,
    });
  });

  it("normalizes create_plan input into visible plan payloads", async () => {
    const content = await createPlanTool.execute(
      {
        title: " Review ",
        steps: [
          { title: " Read code ", status: "in_progress" },
          { title: "Patch tests" },
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
    await expect(
      createPlanTool.execute(
        { steps: [{ title: "Patch tests", status: "unknown" }] },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow("create_plan step status must be pending, in_progress, or completed.");

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

    await expect(
      goalTool.execute(
        { status: "complete", summary: 123 },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow("summary must be a string.");
    await expect(
      goalTool.execute(
        { status: "complete", summary: " " },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow("summary must be a non-empty string.");
    await expect(
      goalTool.execute(
        { goal: "Ship tests", summary: " " },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow("summary must be a non-empty string.");
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

      await expect(
        registry.execute(
          { id: "call-relative-workspace", name: "list_files", arguments: { path: "." } },
          { threadId: "thread-1", turnId: "turn-1", workspace: "relative-workspace" },
        ),
      ).rejects.toThrow("Workspace path must be absolute.");

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

      await fs.writeFile(path.join(workspace, "src", "unicode.txt"), "你a", "utf8");
      await expect(
        registry.execute(
          {
            id: "call-read-unicode-too-small",
            name: "read_file",
            arguments: { path: "src/unicode.txt", max_bytes: 2 },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ),
      ).rejects.toThrow("read_file max_bytes ended before a complete UTF-8 character: src/unicode.txt");
      const unicodeRead = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-read-unicode",
              name: "read_file",
              arguments: { path: "src/unicode.txt", max_bytes: 3 },
            },
            { threadId: "thread-1", turnId: "turn-1", workspace },
          )
        ).content,
      ) as { content: string; bytesRead: number; truncated: boolean };
      expect(unicodeRead).toMatchObject({
        content: "你",
        bytesRead: 3,
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

      await fs.writeFile(path.join(workspace, "src", "invalid-utf8.txt"), Buffer.from([0xff, 0xfe]));
      await expect(
        registry.execute(
          {
            id: "call-invalid-utf8",
            name: "read_file",
            arguments: { path: "src/invalid-utf8.txt" },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ),
      ).rejects.toThrow("read_file path is not valid UTF-8: src/invalid-utf8.txt");
      await expect(
        registry.execute(
          {
            id: "call-search-invalid-utf8",
            name: "search_files",
            arguments: { query: "marker", path: "src/invalid-utf8.txt" },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ),
      ).rejects.toThrow("search_files path is not valid UTF-8: src/invalid-utf8.txt");
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

      await fs.writeFile(path.join(workspace, "invalid.txt"), Buffer.from([0xff, 0xfe]));
      await expect(
        registry.execute(
          { id: "call-read-invalid", name: "read_file", arguments: { path: "invalid.txt" } },
          context,
        ),
      ).rejects.toThrow("read_file path is not valid UTF-8: invalid.txt");
      await expect(
        registry.execute(
          {
            id: "call-overwrite-invalid",
            name: "write_file",
            arguments: { path: "invalid.txt", content: "next\n", overwrite: true },
          },
          context,
        ),
      ).rejects.toThrow("File is not valid UTF-8: invalid.txt");
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

  it("keeps UTF-8 BOM bytes consistent between reads and edits", async () => {
    const workspace = await makeTempDir("coding-tools-bom-");
    try {
      const bomContent = "\uFEFFconst value = 1;\n";
      await fs.writeFile(path.join(workspace, "file.ts"), bomContent, "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

      const read = JSON.parse(
        (
          await registry.execute(
            { id: "call-read-bom", name: "read_file", arguments: { path: "file.ts" } },
            context,
          )
        ).content,
      ) as { content: string; fullSha256: string };
      expect(read.content).toBe(bomContent);
      expect(read.fullSha256).toBe(createHash("sha256").update(bomContent).digest("hex"));

      await registry.execute(
        {
          id: "call-edit-bom",
          name: "edit_file",
          arguments: {
            path: "file.ts",
            old_string: "const value = 1;",
            new_string: "const value = 2;",
          },
        },
        context,
      );
      expect(await fs.readFile(path.join(workspace, "file.ts"), "utf8"))
        .toBe("\uFEFFconst value = 2;\n");
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

  it("preserves apply_patch no-newline-at-end markers", async () => {
    const workspace = await makeTempDir("apply-patch-no-newline-");
    try {
      await fs.writeFile(path.join(workspace, "existing.txt"), "old", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "existing.txt" } },
        context,
      );

      await registry.execute(
        {
          id: "call-patch-no-newline",
          name: "apply_patch",
          arguments: {
            patch: [
              "--- a/existing.txt",
              "+++ b/existing.txt",
              "@@ -1 +1 @@",
              "-old",
              "\\ No newline at end of file",
              "+new",
              "\\ No newline at end of file",
              "--- /dev/null",
              "+++ b/created.txt",
              "@@ -0,0 +1 @@",
              "+created",
              "\\ No newline at end of file",
            ].join("\n"),
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "existing.txt"), "utf8"))
        .toBe("new");
      expect(await fs.readFile(path.join(workspace, "created.txt"), "utf8"))
        .toBe("created");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects apply_patch hunks that omit required no-newline markers", async () => {
    const workspace = await makeTempDir("apply-patch-missing-no-newline-");
    try {
      await fs.writeFile(path.join(workspace, "existing.txt"), "old", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "existing.txt" } },
        context,
      );

      await expect(
        registry.execute(
          {
            id: "call-patch-missing-marker",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- a/existing.txt",
                "+++ b/existing.txt",
                "@@ -1 +1 @@",
                "-old",
                "+new",
              ].join("\n"),
            },
          },
          context,
        ),
      ).rejects.toThrow("apply_patch hunk does not match existing.txt.");
      expect(await fs.readFile(path.join(workspace, "existing.txt"), "utf8"))
        .toBe("old");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("does not treat removed hunk lines beginning with dashes as file headers", async () => {
    const workspace = await makeTempDir("apply-patch-dash-lines-");
    try {
      await fs.writeFile(path.join(workspace, "flags.txt"), "-- old\nkeep\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "flags.txt" } },
        context,
      );

      await registry.execute(
        {
          id: "call-patch-dash-line",
          name: "apply_patch",
          arguments: {
            patch: [
              "--- a/flags.txt",
              "+++ b/flags.txt",
              "@@ -1,2 +1,2 @@",
              "--- old",
              "+-- new",
              " keep",
            ].join("\n"),
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "flags.txt"), "utf8"))
        .toBe("-- new\nkeep\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("preserves CRLF line endings when applying patches", async () => {
    const workspace = await makeTempDir("apply-patch-crlf-");
    try {
      await fs.writeFile(path.join(workspace, "windows.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "windows.txt" } },
        context,
      );

      await registry.execute(
        {
          id: "call-patch-crlf",
          name: "apply_patch",
          arguments: {
            patch: [
              "--- a/windows.txt",
              "+++ b/windows.txt",
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

      expect(await fs.readFile(path.join(workspace, "windows.txt"), "utf8"))
        .toBe("alpha\r\nBETA\r\ngamma\r\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects writes when files change between prepare and commit", async () => {
    const workspace = await makeTempDir("coding-tools-write-race-");
    try {
      const targetPath = path.join(workspace, "file.ts");
      await fs.writeFile(targetPath, "one\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "file.ts" } },
        context,
      );

      const originalMkdir = fs.mkdir.bind(fs);
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation((async (
        ...args: Parameters<typeof fs.mkdir>
      ) => {
        const result = await originalMkdir(...args);
        await fs.writeFile(targetPath, "external\n", "utf8");
        return result;
      }) as typeof fs.mkdir);
      try {
        await expect(
          registry.execute(
            {
              id: "call-edit-race",
              name: "edit_file",
              arguments: {
                path: "file.ts",
                old_string: "one",
                new_string: "two",
              },
            },
            context,
          ),
        ).rejects.toThrow("File changed before write: file.ts. Read it again before writing.");
      } finally {
        mkdirSpy.mockRestore();
      }

      expect(await fs.readFile(targetPath, "utf8")).toBe("external\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects creates when parent directories become symlinks before commit", async () => {
    const workspace = await makeTempDir("coding-tools-symlink-race-");
    const outside = await makeTempDir("coding-tools-symlink-race-outside-");
    try {
      const parentPath = path.join(workspace, "created");
      const outsideTargetPath = path.join(outside, "file.ts");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };

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
          registry.execute(
            {
              id: "call-write-symlink-race",
              name: "write_file",
              arguments: {
                path: "created/file.ts",
                content: "created\n",
              },
            },
            context,
          ),
        ).rejects.toThrow("Path escapes workspace: created/file.ts");
      } finally {
        mkdirSpy.mockRestore();
      }

      await expect(fs.access(outsideTargetPath)).rejects.toThrow();
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
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
            id: "call-duplicate-target",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- a/src/index.ts",
                "+++ b/src/index.ts",
                "@@ -1 +1 @@",
                "-const value = 1;",
                "+const value = 2;",
                "--- a/src/index.ts",
                "+++ b/src/index.ts",
                "@@ -1 +1 @@",
                "-const value = 1;",
                "+const value = 3;",
              ].join("\n"),
            },
          },
          context,
        ),
      ).rejects.toThrow("apply_patch contains duplicate file sections for src/index.ts.");
      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");

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

  it("rolls back committed files when apply_patch fails during execution", async () => {
    const workspace = await makeTempDir("apply-patch-exec-failure-");
    const failingPath = path.join(workspace, "locked", "new.ts");
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
        { id: "call-read-index", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );
      const originalWriteFile = fs.writeFile.bind(fs);
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation((async (
        ...args: Parameters<typeof fs.writeFile>
      ) => {
        const targetPath = args[0];
        if (typeof targetPath === "string" && path.resolve(targetPath) === failingPath) {
          throw new Error("simulated write failure");
        }
        return originalWriteFile(...args);
      }) as typeof fs.writeFile);

      try {
        await expect(
          registry.execute(
            {
              id: "call-partial-patch",
              name: "apply_patch",
              arguments: {
                patch: [
                  "--- a/src/index.ts",
                  "+++ b/src/index.ts",
                  "@@ -1 +1 @@",
                  "-const value = 1;",
                  "+const value = 2;",
                  "--- /dev/null",
                  "+++ b/locked/new.ts",
                  "@@ -0,0 +1 @@",
                  "+created",
                ].join("\n"),
              },
            },
            context,
          ),
        ).rejects.toThrow("simulated write failure");
      } finally {
        writeFileSpy.mockRestore();
      }

      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");
      await expect(fs.access(failingPath)).rejects.toThrow();
      expect(fileHistory.latest(path.join(workspace, "src", "index.ts"))).toBeUndefined();
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

  it("selects explicit Windows and POSIX shell invocations for workspace commands", () => {
    withPlatform("win32", () => {
      const originalComSpec = process.env.ComSpec;
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
      try {
        expect(createShellInvocation("npm run typecheck")).toEqual({
          file: "C:\\Windows\\System32\\cmd.exe",
          args: ["/d", "/s", "/c", "npm run typecheck"],
        });
      } finally {
        if (originalComSpec === undefined) {
          delete process.env.ComSpec;
        } else {
          process.env.ComSpec = originalComSpec;
        }
      }
    });

    withPlatform("linux", () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = "/bin/bash";
      try {
        expect(createShellInvocation("npm run typecheck")).toEqual({
          file: "/bin/bash",
          args: ["-c", "npm run typecheck"],
        });
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL;
        } else {
          process.env.SHELL = originalShell;
        }
      }
    });
  });

  it("runs configurable shell commands with an explicit shell path and arguments", async () => {
    const workspace = await makeTempDir("shell-command-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-shell-command",
          name: "shell_command",
          arguments: {
            command: "process.stdout.write(process.cwd());",
            shell_path: process.execPath,
            shell_args: ["-e", "{command}"],
            cwd: "src",
          },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        cwd: string;
        stdout: string;
        shellFile: string;
      };

      expect(parsed.cwd).toBe("src");
      expect(path.resolve(parsed.stdout)).toBe(path.join(workspace, "src"));
      expect(parsed.shellFile).toBe(process.execPath);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("converts Windows paths for WSL commands", () => {
    expect(toWslPath("C:\\Users\\Ada\\project")).toBe("/mnt/c/Users/Ada/project");
    expect(toWslPath("/mnt/d/workspace")).toBe("/mnt/d/workspace");
  });

  it("routes package manager shims through cmd on Windows", () => {
    withPlatform("win32", () => {
      const invocation = createPackageManagerInvocation("npm", ["run", "build"]);

      expect(invocation).toEqual({
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", "npm run build"],
      });
    });

    withPlatform("linux", () => {
      expect(createPackageManagerInvocation("npm", ["run", "build"])).toEqual({
        file: "npm",
        args: ["run", "build"],
      });
    });
  });

  it("detects shell environment facts without requiring approval-only command execution", async () => {
    const workspace = await makeTempDir("shell-detect-tools-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-detect-shell",
          name: "detect_shell_environment",
          arguments: {},
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        platform: string;
        pathEntries: string[];
        executables: Record<string, { found: boolean; path?: string }>;
        workspacePath: string;
        wslWorkspacePath: string;
      };

      expect(parsed.platform).toBe(process.platform);
      expect(Array.isArray(parsed.pathEntries)).toBe(true);
      expect(parsed.executables).toHaveProperty("git");
      expect(parsed.workspacePath).toBe(workspace);
      expect(parsed.wslWorkspacePath).toBe(toWslPath(workspace));
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("runs regex workspace searches separately from literal search_files", async () => {
    const workspace = await makeTempDir("rg-search-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "src", "index.ts"),
        "const alpha1 = true;\nconst beta = false;\n",
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-rg-search",
          name: "rg_search",
          arguments: {
            pattern: "alpha\\d",
            path: "src",
          },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        results: Array<{ path: string; line: number; column: number; match: string }>;
      };

      expect(parsed.results).toEqual([
        {
          path: "src/index.ts",
          line: 1,
          column: 7,
          match: "alpha1",
          text: "const alpha1 = true;",
        },
      ]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("skips hidden files during regex workspace search", async () => {
    const workspace = await makeTempDir("rg-search-hidden-tools-");
    try {
      await fs.writeFile(path.join(workspace, ".env"), "SECRET_TOKEN=hidden\n", "utf8");
      await fs.writeFile(path.join(workspace, "visible.txt"), "SECRET_TOKEN=visible\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-rg-hidden-search",
          name: "rg_search",
          arguments: {
            pattern: "SECRET_TOKEN",
            path: ".",
          },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        results: Array<{ path: string; text: string }>;
      };

      expect(parsed.results).toEqual([
        expect.objectContaining({
          path: "visible.txt",
          text: "SECRET_TOKEN=visible",
        }),
      ]);
      expect(parsed.results.some((entry) => entry.path === ".env")).toBe(false);
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

  it("uses runtime command defaults for timeout and output truncation", async () => {
    const workspace = await makeTempDir("command-tools-runtime-defaults-");
    try {
      await fs.writeFile(
        path.join(workspace, "emit-output.js"),
        "process.stderr.write('e'.repeat(3000)); process.exit(2);\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            typecheck: "node emit-output.js",
          },
        }),
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        commandDefaults: {
          timeoutMs: 100,
          maxOutputBytes: 2048,
        },
      };

      const timedOut = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-default-timeout",
              name: "run_command",
              arguments: {
                command: nodeCommand("setTimeout(() => undefined, 1000);"),
              },
            },
            context,
          )
        ).content,
      ) as { timedOut: boolean; exitCode: number | null };
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.exitCode === null || timedOut.exitCode > 0).toBe(true);

      const truncated = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-default-output",
              name: "run_command",
              arguments: {
                command: nodeCommand("process.stdout.write('x'.repeat(3000));"),
              },
            },
            context,
          )
        ).content,
      ) as {
        stdout: string;
        stdoutBytes: number;
        stdoutTruncated: boolean;
      };
      expect(truncated.stdout.length).toBe(2048);
      expect(truncated.stdoutBytes).toBe(3000);
      expect(truncated.stdoutTruncated).toBe(true);

      const diagnostics = JSON.parse(
        (
          await registry.execute(
            {
              id: "call-diagnose-default-output",
              name: "diagnose_workspace",
              arguments: {},
            },
            {
              ...context,
              commandDefaults: {
                timeoutMs: 30_000,
                maxOutputBytes: 2048,
              },
            },
          )
        ).content,
      ) as { stdoutTruncated: boolean; stderrTruncated: boolean };
      expect(diagnostics.stdoutTruncated || diagnostics.stderrTruncated).toBe(true);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("keeps command output truncation on a UTF-8 character boundary", async () => {
    const workspace = await makeTempDir("command-tools-utf8-truncate-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-utf8-truncate",
          name: "run_command",
          arguments: {
            command: nodeCommand("process.stdout.write('x'.repeat(1023) + '你' + 'tail');"),
          },
        },
        {
          threadId: "thread-1",
          turnId: "turn-1",
          workspace,
          commandDefaults: {
            timeoutMs: 30_000,
            maxOutputBytes: 1024,
          },
        },
      );
      const parsed = JSON.parse(result.content) as {
        stdout: string;
        stdoutBytes: number;
        stdoutTruncated: boolean;
      };

      expect(parsed.stdout).toBe("x".repeat(1023));
      expect(parsed.stdout).not.toContain("\uFFFD");
      expect(parsed.stdoutBytes).toBe(Buffer.byteLength("x".repeat(1023) + "你" + "tail", "utf8"));
      expect(parsed.stdoutTruncated).toBe(true);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects command timeout overrides above the runtime command preference", async () => {
    const workspace = await makeTempDir("command-tools-timeout-policy-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        commandDefaults: {
          timeoutMs: 100,
          maxOutputBytes: 2048,
        },
      };

      await expect(
        registry.execute(
          {
            id: "call-run-command-timeout",
            name: "run_command",
            arguments: {
              command: nodeCommand("process.stdout.write('ok');"),
              timeout_ms: 101,
            },
          },
          context,
        ),
      ).rejects.toThrow("timeout_ms must be an integer between 100 and 100.");

      await expect(
        registry.execute(
          {
            id: "call-diagnose-timeout",
            name: "diagnose_workspace",
            arguments: {
              timeout_ms: 101,
            },
          },
          context,
        ),
      ).rejects.toThrow("timeout_ms must be an integer between 100 and 100.");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("returns structured git status, diff, log, branch, and commit results", async () => {
    const workspace = await makeTempDir("git-tools-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };

      await registry.execute(
        { id: "git-init", name: "run_command", arguments: { command: "git init" } },
        context,
      );
      await registry.execute(
        {
          id: "git-email",
          name: "run_command",
          arguments: { command: "git config user.email test@example.test" },
        },
        context,
      );
      await registry.execute(
        {
          id: "git-name",
          name: "run_command",
          arguments: { command: "git config user.name Tester" },
        },
        context,
      );
      await fs.writeFile(path.join(workspace, "file.txt"), "one\n", "utf8");

      const status = JSON.parse(
        (
          await registry.execute(
            { id: "git-status", name: "git_status", arguments: {} },
            context,
          )
        ).content,
      ) as { entries: Array<{ xy: string; path: string }> };
      expect(status.entries).toEqual([
        expect.objectContaining({ xy: "??", path: "file.txt" }),
      ]);

      const commit = JSON.parse(
        (
          await registry.execute(
            {
              id: "git-commit",
              name: "git_commit",
              arguments: { message: "initial commit", all: true },
            },
            context,
          )
        ).content,
      ) as { staged: boolean; commit: { exitCode: number | null } };
      expect(commit.staged).toBe(true);
      expect(commit.commit.exitCode).toBe(0);

      await fs.writeFile(path.join(workspace, "file.txt"), "two\n", "utf8");
      const diff = JSON.parse(
        (
          await registry.execute(
            { id: "git-diff", name: "git_diff", arguments: { pathspecs: ["file.txt"] } },
            context,
          )
        ).content,
      ) as { stdout: string };
      expect(diff.stdout).toContain("-one");
      expect(diff.stdout).toContain("+two");

      const log = JSON.parse(
        (
          await registry.execute(
            { id: "git-log", name: "git_log", arguments: { max_count: 1 } },
            context,
          )
        ).content,
      ) as { commits: Array<{ subject: string }> };
      expect(log.commits).toEqual([expect.objectContaining({ subject: "initial commit" })]);

      const branch = JSON.parse(
        (
          await registry.execute(
            { id: "git-branch", name: "git_branch", arguments: {} },
            context,
          )
        ).content,
      ) as { current: string | null; branches: Array<{ current: boolean }> };
      expect(branch.current).toBeTruthy();
      expect(branch.branches.some((entry) => entry.current)).toBe(true);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("disables configured external diff commands for read-only git_diff", async () => {
    const workspace = await makeTempDir("git-diff-safe-tools-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };
      const markerPath = path.join(workspace, "external-ran.txt");
      const externalScriptPath = path.join(workspace, "external-diff.cjs");
      await fs.writeFile(
        externalScriptPath,
        "require('fs').writeFileSync('external-ran.txt', '1');\n",
        "utf8",
      );
      await registry.execute(
        { id: "git-init", name: "run_command", arguments: { command: "git init" } },
        context,
      );
      await registry.execute(
        {
          id: "git-email",
          name: "run_command",
          arguments: { command: "git config user.email test@example.test" },
        },
        context,
      );
      await registry.execute(
        {
          id: "git-name",
          name: "run_command",
          arguments: { command: "git config user.name Tester" },
        },
        context,
      );
      await registry.execute(
        {
          id: "git-external",
          name: "run_command",
          arguments: {
            command: `git config diff.external ${JSON.stringify(`${process.execPath} ${externalScriptPath}`)}`,
          },
        },
        context,
      );
      await fs.writeFile(path.join(workspace, "file.txt"), "one\n", "utf8");
      await registry.execute(
        { id: "git-add", name: "run_command", arguments: { command: "git add file.txt" } },
        context,
      );
      await registry.execute(
        { id: "git-commit", name: "run_command", arguments: { command: "git commit -m initial" } },
        context,
      );
      await fs.writeFile(path.join(workspace, "file.txt"), "two\n", "utf8");

      const diff = JSON.parse(
        (
          await registry.execute(
            { id: "git-diff", name: "git_diff", arguments: { pathspecs: ["file.txt"] } },
            context,
          )
        ).content,
      ) as { commandArgs: string[]; stdout: string };

      expect(diff.commandArgs).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
      expect(diff.stdout).toContain("+two");
      expect(await fileExists(markerPath)).toBe(false);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("stops git_commit when staging requested paths fails", async () => {
    const workspace = await makeTempDir("git-commit-add-failure-tools-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };
      await registry.execute(
        { id: "git-init", name: "run_command", arguments: { command: "git init" } },
        context,
      );
      await registry.execute(
        {
          id: "git-email",
          name: "run_command",
          arguments: { command: "git config user.email test@example.test" },
        },
        context,
      );
      await registry.execute(
        {
          id: "git-name",
          name: "run_command",
          arguments: { command: "git config user.name Tester" },
        },
        context,
      );
      await fs.writeFile(path.join(workspace, ".gitignore"), "*.log\n", "utf8");
      await fs.writeFile(path.join(workspace, "base.txt"), "base\n", "utf8");
      await registry.execute(
        { id: "git-add-base", name: "run_command", arguments: { command: "git add ." } },
        context,
      );
      await registry.execute(
        { id: "git-commit-base", name: "run_command", arguments: { command: "git commit -m initial" } },
        context,
      );
      await fs.writeFile(path.join(workspace, "staged.txt"), "staged\n", "utf8");
      await registry.execute(
        { id: "git-add-staged", name: "run_command", arguments: { command: "git add staged.txt" } },
        context,
      );
      await fs.writeFile(path.join(workspace, "ignored.log"), "ignored\n", "utf8");

      await expect(
        registry.execute(
          {
            id: "git-commit-fail",
            name: "git_commit",
            arguments: { message: "should not commit staged file", pathspecs: ["ignored.log"] },
          },
          context,
        ),
      ).rejects.toThrow("git_commit staging failed");

      const log = JSON.parse(
        (
          await registry.execute(
            { id: "git-log", name: "git_log", arguments: { max_count: 5 } },
            context,
          )
        ).content,
      ) as { commits: Array<{ subject: string }> };
      expect(log.commits.map((commit) => commit.subject)).toEqual(["initial"]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("detects package scripts and runs package/build/lint/test wrappers", async () => {
    const workspace = await makeTempDir("package-tools-");
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            build: "node -e \"process.stdout.write('built')\"",
            lint: "node -e \"process.stdout.write('linted')\"",
            test: "node -e \"process.stdout.write('tested')\"",
          },
        }),
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };

      const scripts = JSON.parse(
        (
          await registry.execute(
            { id: "package-scripts", name: "package_scripts", arguments: {} },
            context,
          )
        ).content,
      ) as { manager: string; scripts: Record<string, string> };
      expect(scripts.manager).toBe("npm");
      expect(Object.keys(scripts.scripts).sort()).toEqual(["build", "lint", "test"]);

      const build = JSON.parse(
        (
          await registry.execute(
            { id: "package-build", name: "package_build", arguments: {} },
            context,
          )
        ).content,
      ) as { manager: string; script: string; stdout: string };
      expect(build).toMatchObject({ manager: "npm", script: "build" });
      expect(build.stdout).toContain("built");

      const lint = JSON.parse(
        (
          await registry.execute(
            { id: "run-lint", name: "run_lint", arguments: {} },
            context,
          )
        ).content,
      ) as { script: string; stdout: string };
      expect(lint).toMatchObject({ script: "lint" });
      expect(lint.stdout).toContain("linted");

      const tests = JSON.parse(
        (
          await registry.execute(
            { id: "run-tests", name: "run_tests", arguments: {} },
            context,
          )
        ).content,
      ) as { script: string; stdout: string };
      expect(tests).toMatchObject({ script: "test" });
      expect(tests.stdout).toContain("tested");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("starts, reads, writes, and stops long-running command sessions", async () => {
    const workspace = await makeTempDir("command-session-tools-");
    let sessionId: string | undefined;
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace };
      const start = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-start",
              name: "start_command_session",
              arguments: {
                command: nodeCommand(
                  "process.stdout.write('ready\\n'); process.stdin.on('data', (chunk) => process.stdout.write('echo:' + chunk.toString())); setInterval(() => undefined, 1000);",
                ),
              },
            },
            context,
          )
        ).content,
      ) as { sessionId: string; status: string };
      sessionId = start.sessionId;
      expect(start.status).toBe("running");

      await registry.execute(
        {
          id: "session-write",
          name: "write_command_session",
          arguments: { session_id: sessionId, input: "ping" },
        },
        context,
      );

      await waitUntil(async () => {
        const read = JSON.parse(
          (
            await registry.execute(
              {
                id: "session-read",
                name: "read_command_session",
                arguments: { session_id: sessionId },
              },
              context,
            )
          ).content,
        ) as { stdout: { text: string } };
        return read.stdout.text.includes("ready") && read.stdout.text.includes("echo:ping");
      });

      const stopped = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-stop",
              name: "stop_command_session",
              arguments: { session_id: sessionId },
            },
            context,
          )
        ).content,
      ) as { status: string };
      expect(["running", "stopping", "exited"]).toContain(stopped.status);
    } finally {
      if (sessionId) {
        const registry = new InMemoryToolRegistry(createCommandTools());
        await registry.execute(
          {
            id: "session-cleanup",
            name: "stop_command_session",
            arguments: { session_id: sessionId },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace },
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("Command session not found")) return;
          throw error;
        });
      }
      await removeTempDir(workspace);
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

  it("falls back to local npx tsc diagnostics when package typecheck is unavailable", async () => {
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

      expect(parsed.command).toBe("npx --no-install tsc --noEmit");
      expect(parsed.diagnosticCount).toBeGreaterThan(0);
      expect(parsed.diagnostics[0]).toMatchObject({
        path: "src/index.ts",
        code: "TS2322",
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("resolves diagnose_workspace diagnostics relative to the command cwd", async () => {
    const workspace = await makeTempDir("diagnose-tools-cwd-");
    try {
      const packageRoot = path.join(workspace, "packages", "app");
      await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
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
        path.join(packageRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      await fs.writeFile(path.join(packageRoot, "src", "index.ts"), "const value: string = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-diagnose-cwd",
          name: "diagnose_workspace",
          arguments: { cwd: "packages/app" },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace },
      );
      const parsed = JSON.parse(result.content) as {
        cwd: string;
        diagnostics: Array<{ path: string; code: string }>;
      };

      expect(parsed.cwd).toBe("packages/app");
      expect(parsed.diagnostics[0]).toMatchObject({
        path: "packages/app/src/index.ts",
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

      await fs.writeFile(path.join(workspace, "src", "invalid.ts"), Buffer.from([0xff, 0xfe]));
      await expect(
        registry.execute(
          {
            id: "call-invalid-utf8",
            name: "diagnose_file",
            arguments: { path: "src/invalid.ts" },
          },
          context,
        ),
      ).rejects.toThrow("diagnose_file path is not valid UTF-8: src/invalid.ts");
    } finally {
      await removeTempDir(workspace);
    }
  });
});
