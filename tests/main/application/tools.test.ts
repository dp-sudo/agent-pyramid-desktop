import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPackageManagerInvocation,
  createCommandTools,
  createShellInvocation,
  resolveDefaultPowerShellShell,
  shutdownCommandSessions,
  toWslPath,
} from "../../../src/main/application/tools/command-tools";
import { createCodingTools } from "../../../src/main/application/tools/coding-tools";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { FileHistoryStore } from "../../../src/main/application/tools/file-history-state";
import { FileReadStateStore } from "../../../src/main/application/tools/file-read-state";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { createSkillTools } from "../../../src/main/application/tools/skill-tools";
import { openTextFileNoFollow } from "../../../src/main/application/tools/text-file";
import { createWorkspaceTools } from "../../../src/main/application/tools/workspace-tools";
import { SkillService } from "../../../src/main/skills/skill-service";
import type {
  AgentCheckpointCapability,
  AgentTool,
  AgentToolContext,
} from "../../../src/main/domain/agent/types";
import {
  RUNTIME_READ_ONLY_TOOL_NAMES,
  RUNTIME_TOOL_NAMES,
  type ThreadGoalStatus,
  type ToolProgressStream,
} from "../../../src/shared/agent-contracts";
import { CheckpointStore } from "../../../src/main/persistence/checkpoint-store";
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

function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

async function withPlatformAsync<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  try {
    return await fn();
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

  it("validates tool arguments against the published input schema before execution", async () => {
    const execute = vi.fn(async () => "accepted");
    const schemaTool: AgentTool = {
      definition: {
        name: "schema_tool",
        description: "Exercises registry-level schema validation.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["read", "write"],
            },
            flags: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            options: {
              type: "object",
              properties: {
                dry_run: { type: "boolean" },
              },
              required: ["dry_run"],
            },
          },
          required: ["mode", "flags", "options"],
        },
      },
      execute,
    };
    const registry = new InMemoryToolRegistry([schemaTool]);

    await expect(
      registry.execute(
        {
          id: "call-missing",
          name: "schema_tool",
          arguments: { mode: "read", options: { dry_run: true } },
        },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow(
      'Tool "schema_tool" arguments do not match inputSchema: arguments.flags is required.',
    );
    await expect(
      registry.execute(
        {
          id: "call-enum",
          name: "schema_tool",
          arguments: { mode: "fast", flags: ["safe"], options: { dry_run: true } },
        },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow(
      'Tool "schema_tool" arguments do not match inputSchema: arguments.mode must be one of "read", "write".',
    );
    await expect(
      registry.execute(
        {
          id: "call-array-item",
          name: "schema_tool",
          arguments: { mode: "read", flags: [1], options: { dry_run: true } },
        },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow(
      'Tool "schema_tool" arguments do not match inputSchema: arguments.flags[0] must be string.',
    );
    expect(execute).not.toHaveBeenCalled();

    await expect(
      registry.execute(
        {
          id: "call-valid",
          name: "schema_tool",
          arguments: { mode: "read", flags: ["safe"], options: { dry_run: true } },
        },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).resolves.toMatchObject({
      toolCallId: "call-valid",
      name: "schema_tool",
      content: "accepted",
    });
    expect(execute).toHaveBeenCalledTimes(1);
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
      ...createSkillTools({ skillService: new SkillService() }),
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

  it("keeps shared runtime tool names aligned with built-in tool registration", () => {
    const tools = [
      ...createWorkspaceTools(),
      ...createCommandTools(),
      createPlanTool,
      ...createGoalTools({ updateGoal: async () => undefined }),
      ...createSkillTools({ skillService: new SkillService() }),
      ...createCodingTools(),
    ];
    const registeredNames = tools.map((tool) => tool.definition.name).sort();

    expect(registeredNames).toEqual([...RUNTIME_TOOL_NAMES].sort());
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

  it("keeps list_symbols schema aligned with the language service implementation", () => {
    const listSymbols = createCommandTools()
      .find((tool) => tool.definition.name === "list_symbols");

    expect(listSymbols?.definition.inputSchema).toMatchObject({
      type: "object",
      properties: {
        path: {
          type: "string",
        },
        max_results: {
          type: "number",
        },
      },
      required: ["path"],
    });
    expect(Object.keys(listSymbols?.definition.inputSchema.properties ?? {}))
      .toEqual(["path", "max_results"]);
  });

  it("keeps search_symbols schema aligned with project symbol search", () => {
    const searchSymbols = createCommandTools()
      .find((tool) => tool.definition.name === "search_symbols");

    expect(searchSymbols?.definition.inputSchema).toMatchObject({
      type: "object",
      properties: {
        query: {
          type: "string",
        },
        path: {
          type: "string",
        },
        case_sensitive: {
          type: "boolean",
        },
        max_results: {
          type: "number",
        },
      },
    });
    expect(Object.keys(searchSymbols?.definition.inputSchema.properties ?? {}))
      .toEqual(["query", "path", "case_sensitive", "max_results"]);
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
      "list_command_sessions",
      "read_command_session",
      "write_command_session",
      "stop_command_session",
      "detect_shell_environment",
      "list_symbols",
      "search_symbols",
    ]));
  });

  it("registers dedicated coding tools", () => {
    const names = createCodingTools().map((tool) => tool.definition.name);

    expect(names).toEqual([
      "create_edit_plan",
      "edit_file",
      "multi_edit",
      "write_file",
      "delete_file",
      "apply_patch",
      "rollback_file",
    ]);
  });

  it("normalizes create_edit_plan into a visible multi-file plan payload", async () => {
    const workspace = await makeTempDir("create-edit-plan-tool-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      const registry = new InMemoryToolRegistry(createCodingTools());

      const result = await registry.execute(
        {
          id: "call-edit-plan",
          name: "create_edit_plan",
          arguments: {
            title: "Refactor runtime boundary",
            summary: "Coordinate runtime and tests before writing.",
            files: [
              {
                path: "src/runtime.ts",
                action: "update",
                reason: "implementation entry",
              },
              {
                path: "src/runtime.test.ts",
                action: "update",
                reason: "coverage",
              },
            ],
            verification: ["npm test -- runtime"],
          },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as {
        title: string;
        summary: string;
        files: Array<{ path: string; action: string; reason: string }>;
        steps: Array<{ title: string; status: string }>;
        verification: string[];
      };

      expect(parsed).toMatchObject({
        title: "Refactor runtime boundary",
        summary: "Coordinate runtime and tests before writing.",
        files: [
          { path: "src/runtime.ts", action: "update", reason: "implementation entry" },
          { path: "src/runtime.test.ts", action: "update", reason: "coverage" },
        ],
        verification: ["npm test -- runtime"],
      });
      expect(parsed.steps).toEqual([
        { title: "Update src/runtime.ts: implementation entry", status: "pending" },
        { title: "Update src/runtime.test.ts: coverage", status: "pending" },
        { title: "Verify: npm test -- runtime", status: "pending" },
      ]);
      expect(result.displayResult).toEqual(parsed);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("validates create_edit_plan paths and distinct multi-file scope", async () => {
    const workspace = await makeTempDir("create-edit-plan-tool-guard-");
    try {
      const registry = new InMemoryToolRegistry(createCodingTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          {
            id: "call-edit-plan-single-file",
            name: "create_edit_plan",
            arguments: {
              files: [{ path: "src/runtime.ts", action: "update" }],
            },
          },
          context,
        ),
      ).rejects.toThrow("Tool \"create_edit_plan\" arguments do not match inputSchema");

      await expect(
        registry.execute(
          {
            id: "call-edit-plan-escape",
            name: "create_edit_plan",
            arguments: {
              files: [
                { path: "../outside.ts", action: "update" },
                { path: "src/runtime.test.ts", action: "update" },
              ],
            },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside.ts");

      await expect(
        registry.execute(
          {
            id: "call-edit-plan-duplicate",
            name: "create_edit_plan",
            arguments: {
              files: [
                { path: "src/runtime.ts", action: "update" },
                { path: "src/runtime.ts", action: "delete" },
              ],
            },
          },
          context,
        ),
      ).rejects.toThrow("create_edit_plan file path is duplicated: src/runtime.ts");

      await expect(
        withPlatformAsync("win32", () =>
          registry.execute(
            {
              id: "call-edit-plan-windows-case-duplicate",
              name: "create_edit_plan",
              arguments: {
                files: [
                  { path: "src/Runtime.ts", action: "update" },
                  { path: "src/runtime.ts", action: "update" },
                ],
              },
            },
            context,
          )
        ),
      ).rejects.toThrow("create_edit_plan file path is duplicated: src/runtime.ts");

      await expect(
        registry.execute(
          {
            id: "call-edit-plan-nul",
            name: "create_edit_plan",
            arguments: {
              title: "runtime\0plan",
              files: [
                { path: "src/runtime.ts", action: "update" },
                { path: "src/runtime.test.ts", action: "update" },
              ],
            },
          },
          context,
        ),
      ).rejects.toThrow("create_edit_plan strings cannot contain NUL bytes.");
    } finally {
      await removeTempDir(workspace);
    }
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

  it("keeps Git pathspec schema aligned with plain path validation", () => {
    const tools = createCommandTools();
    const gitStatus = tools.find((tool) => tool.definition.name === "git_status");
    const gitDiff = tools.find((tool) => tool.definition.name === "git_diff");
    const gitLog = tools.find((tool) => tool.definition.name === "git_log");
    const gitCommit = tools.find((tool) => tool.definition.name === "git_commit");

    expect(toolSchemaProperties(gitStatus).pathspecs).toMatchObject({
      type: "array",
      description: "Optional plain workspace-relative paths to limit status.",
    });
    expect(toolSchemaProperties(gitDiff).pathspecs).toMatchObject({
      type: "array",
      description: "Optional plain workspace-relative paths.",
    });
    expect(toolSchemaProperties(gitLog).pathspecs).toMatchObject({
      type: "array",
      description: "Optional plain workspace-relative paths.",
    });
    expect(toolSchemaProperties(gitCommit).pathspecs).toMatchObject({
      type: "array",
      description: "Plain workspace-relative paths to stage before commit.",
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
      await fs.mkdir(path.join(workspace, "src", "external-references"), { recursive: true });
      await fs.mkdir(path.join(workspace, "DeepSeek"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "export const marker = 1;\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "src", "external-references", "reference.ts"),
        "external marker\n",
        "utf8",
      );
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
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside.ts");
      await expect(
        registry.execute(
          { id: "call-hidden", name: "read_file", arguments: { path: ".hidden.ts" } },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("Path is skipped by workspace tool policy: .hidden.ts");
      await expect(
        registry.execute(
          { id: "call-deepseek", name: "read_file", arguments: { path: "DeepSeek/reference.ts" } },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("Path is skipped by workspace tool policy: DeepSeek/reference.ts");
      await expect(
        registry.execute(
          {
            id: "call-external-reference",
            name: "read_file",
            arguments: { path: "src/external-references/reference.ts" },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow(
        "Path is skipped by workspace tool policy: src/external-references/reference.ts",
      );

      await fs.writeFile(path.join(workspace, "src", "invalid-utf8.txt"), Buffer.from([0xff, 0xfe]));
      await expect(
        registry.execute(
          {
            id: "call-invalid-utf8",
            name: "read_file",
            arguments: { path: "src/invalid-utf8.txt" },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("read_file path is not valid UTF-8: src/invalid-utf8.txt");
      await expect(
        registry.execute(
          {
            id: "call-search-invalid-utf8",
            name: "search_files",
            arguments: { query: "marker", path: "src/invalid-utf8.txt" },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("search_files path is not valid UTF-8: src/invalid-utf8.txt");
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("rejects invalid workspace tool numeric limits instead of clamping them", async () => {
    const workspace = await makeTempDir("workspace-tool-limits-");
    try {
      await fs.writeFile(path.join(workspace, "file.txt"), "marker\n", "utf8");
      const registry = new InMemoryToolRegistry(createWorkspaceTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          { id: "call-list-invalid-limit", name: "list_files", arguments: { max_entries: "10" } },
          context,
        ),
      ).rejects.toThrow(
        'Tool "list_files" arguments do not match inputSchema: arguments.max_entries must be number.',
      );

      await expect(
        registry.execute(
          { id: "call-read-over-limit", name: "read_file", arguments: { path: "file.txt", max_bytes: 240_001 } },
          context,
        ),
      ).rejects.toThrow("max_bytes must be an integer between 1 and 240000.");

      await expect(
        registry.execute(
          { id: "call-read-negative-offset", name: "read_file", arguments: { path: "file.txt", offset_bytes: -1 } },
          context,
        ),
      ).rejects.toThrow("offset_bytes must be an integer between 0 and 9007199254740991.");

      await expect(
        registry.execute(
          { id: "call-search-fractional-limit", name: "search_files", arguments: { query: "marker", max_results: 1.5 } },
          context,
        ),
      ).rejects.toThrow("max_results must be an integer between 1 and 300.");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects invalid workspace optional path parameters instead of using the root path", async () => {
    const workspace = await makeTempDir("workspace-tool-paths-");
    try {
      await fs.writeFile(path.join(workspace, "file.txt"), "marker\n", "utf8");
      const registry = new InMemoryToolRegistry(createWorkspaceTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          { id: "call-list-invalid-path", name: "list_files", arguments: { path: 1 } },
          context,
        ),
      ).rejects.toThrow(
        'Tool "list_files" arguments do not match inputSchema: arguments.path must be string.',
      );

      await expect(
        registry.execute(
          { id: "call-search-invalid-path", name: "search_files", arguments: { query: "marker", path: false } },
          context,
        ),
      ).rejects.toThrow(
        'Tool "search_files" arguments do not match inputSchema: arguments.path must be string.',
      );
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects NUL bytes in workspace string parameters", async () => {
    const workspace = await makeTempDir("workspace-tool-nul-strings-");
    try {
      await fs.writeFile(path.join(workspace, "file.txt"), "marker\n", "utf8");
      const registry = new InMemoryToolRegistry(createWorkspaceTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          { id: "call-list-nul-path", name: "list_files", arguments: { path: "src\0index.ts" } },
          context,
        ),
      ).rejects.toThrow("path cannot contain NUL bytes.");

      await expect(
        registry.execute(
          { id: "call-read-nul-path", name: "read_file", arguments: { path: "file.txt\0" } },
          context,
        ),
      ).rejects.toThrow("path cannot contain NUL bytes.");

      await expect(
        registry.execute(
          { id: "call-search-nul-query", name: "search_files", arguments: { query: "marker\0" } },
          context,
        ),
      ).rejects.toThrow("query cannot contain NUL bytes.");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("closes text read handles when the post-open symlink guard fails", async () => {
    const noFollowDescriptor = Object.getOwnPropertyDescriptor(fsConstants, "O_NOFOLLOW");
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const fakeHandle = { close } as unknown as Awaited<ReturnType<typeof fs.open>>;
    const openSpy = vi.spyOn(fs, "open").mockResolvedValue(fakeHandle);
    const lstatSpy = vi.spyOn(fs, "lstat").mockResolvedValue({
      isSymbolicLink: () => true,
    } as Awaited<ReturnType<typeof fs.lstat>>);

    try {
      Object.defineProperty(fsConstants, "O_NOFOLLOW", {
        configurable: true,
        value: undefined,
      });

      await expect(
        openTextFileNoFollow(path.join("workspace", "link.txt"), {
          label: "Helper read",
          relativePath: "link.txt",
        }),
      ).rejects.toThrow("Helper read target is a symbolic link: link.txt");
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(lstatSpy).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
      lstatSpy.mockRestore();
      if (noFollowDescriptor) {
        Object.defineProperty(fsConstants, "O_NOFOLLOW", noFollowDescriptor);
      } else {
        Reflect.deleteProperty(fsConstants, "O_NOFOLLOW");
      }
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

  it("applies multi_edit steps atomically through the coding write path", async () => {
    const workspace = await makeTempDir("coding-tools-multi-edit-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "multi.ts"), "alpha one\nalpha two\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };

      await registry.execute(
        { id: "call-read-multi", name: "read_file", arguments: { path: "src/multi.ts" } },
        context,
      );
      const edited = await registry.execute(
        {
          id: "call-multi-edit",
          name: "multi_edit",
          arguments: {
            path: "src/multi.ts",
            edits: [
              { old_string: "one", new_string: "1" },
              { old_string: "alpha", new_string: "const", replace_all: true },
            ],
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "src", "multi.ts"), "utf8"))
        .toBe("const 1\nconst two\n");
      expect(edited.displayResult).toMatchObject({
        path: "src/multi.ts",
        operation: "update",
        diff: {
          kind: "file_diff",
          added: 2,
          removed: 2,
        },
      });
      expect(fileHistory.latest(path.join(workspace, "src", "multi.ts"))).toMatchObject({
        toolName: "multi_edit",
        operation: "update",
        beforeContent: "alpha one\nalpha two\n",
        afterContent: "const 1\nconst two\n",
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("leaves files untouched when any multi_edit step fails", async () => {
    const workspace = await makeTempDir("coding-tools-multi-edit-fail-");
    try {
      const targetPath = path.join(workspace, "file.ts");
      await fs.writeFile(targetPath, "alpha\nbeta\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };

      await registry.execute(
        { id: "call-read-multi-fail", name: "read_file", arguments: { path: "file.ts" } },
        context,
      );
      await expect(
        registry.execute(
          {
            id: "call-multi-edit-fail",
            name: "multi_edit",
            arguments: {
              path: "file.ts",
              edits: [
                { old_string: "alpha", new_string: "ALPHA" },
                { old_string: "missing", new_string: "MISSING" },
              ],
            },
          },
          context,
        ),
      ).rejects.toThrow("multi_edit edit 2 old_string was not found in file.ts.");

      expect(await fs.readFile(targetPath, "utf8")).toBe("alpha\nbeta\n");
      expect(fileHistory.latest(targetPath)).toBeUndefined();
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("records checkpoint snapshots before coding tools write files", async () => {
    const workspace = await makeTempDir("coding-tools-checkpoint-");
    type CheckpointRecorder =
      NonNullable<AgentCheckpointCapability["checkpoint"]>["recordFileSnapshot"];
    type CheckpointEntry = Parameters<CheckpointRecorder>[0];
    const captured: Array<{ entry: CheckpointEntry; contentAtCapture: string | null }> = [];
    const recordFileSnapshot = vi.fn<CheckpointRecorder>(async (entry) => {
      let contentAtCapture: string | null = null;
      try {
        contentAtCapture = await fs.readFile(path.join(workspace, entry.relativePath), "utf8");
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") throw error;
      }
      captured.push({ entry, contentAtCapture });
    });
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      await fs.writeFile(path.join(workspace, "delete.ts"), "remove me\n", "utf8");
      await fs.writeFile(path.join(workspace, "patch.ts"), "old\n", "utf8");
      await fs.writeFile(path.join(workspace, "multi.ts"), "alpha\nbeta\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context: AgentToolContext = {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        readState,
        checkpoint: { recordFileSnapshot },
      };

      await registry.execute(
        { id: "call-read-edit", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );
      await registry.execute(
        {
          id: "call-edit-checkpoint",
          name: "edit_file",
          arguments: {
            path: "src/index.ts",
            old_string: "const value = 1;",
            new_string: "const value = 2;",
          },
        },
        context,
      );
      await registry.execute(
        {
          id: "call-write-checkpoint",
          name: "write_file",
          arguments: { path: "src/new.ts", content: "created\n" },
        },
        context,
      );
      await registry.execute(
        { id: "call-read-multi", name: "read_file", arguments: { path: "multi.ts" } },
        context,
      );
      await registry.execute(
        {
          id: "call-multi-edit-checkpoint",
          name: "multi_edit",
          arguments: {
            path: "multi.ts",
            edits: [
              { old_string: "alpha", new_string: "ALPHA" },
              { old_string: "beta", new_string: "BETA" },
            ],
          },
        },
        context,
      );
      await registry.execute(
        { id: "call-read-delete", name: "read_file", arguments: { path: "delete.ts" } },
        context,
      );
      await registry.execute(
        {
          id: "call-delete-checkpoint",
          name: "delete_file",
          arguments: { path: "delete.ts" },
        },
        context,
      );
      await registry.execute(
        { id: "call-read-patch", name: "read_file", arguments: { path: "patch.ts" } },
        context,
      );
      await registry.execute(
        {
          id: "call-patch-checkpoint",
          name: "apply_patch",
          arguments: {
            patch: [
              "--- a/patch.ts",
              "+++ b/patch.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
          },
        },
        context,
      );

      expect(captured.map(({ entry, contentAtCapture }) => ({
        path: entry.relativePath,
        operation: entry.operation,
        beforeContent: entry.beforeContent,
        afterContent: entry.afterContent,
        contentAtCapture,
      }))).toEqual([
        {
          path: "src/index.ts",
          operation: "update",
          beforeContent: "const value = 1;\n",
          afterContent: "const value = 2;\n",
          contentAtCapture: "const value = 1;\n",
        },
        {
          path: "src/new.ts",
          operation: "create",
          beforeContent: null,
          afterContent: "created\n",
          contentAtCapture: null,
        },
        {
          path: "multi.ts",
          operation: "update",
          beforeContent: "alpha\nbeta\n",
          afterContent: "ALPHA\nBETA\n",
          contentAtCapture: "alpha\nbeta\n",
        },
        {
          path: "delete.ts",
          operation: "delete",
          beforeContent: "remove me\n",
          afterContent: null,
          contentAtCapture: "remove me\n",
        },
        {
          path: "patch.ts",
          operation: "update",
          beforeContent: "old\n",
          afterContent: "new\n",
          contentAtCapture: "old\n",
        },
      ]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("deletes files only after a fresh read and allows rollback restore", async () => {
    const workspace = await makeTempDir("coding-tools-delete-");
    try {
      await fs.writeFile(path.join(workspace, "remove.ts"), "export const remove = true;\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };

      await registry.execute(
        { id: "call-read-delete", name: "read_file", arguments: { path: "remove.ts" } },
        context,
      );
      const deleted = await registry.execute(
        {
          id: "call-delete",
          name: "delete_file",
          arguments: { path: "remove.ts" },
        },
        context,
      );

      await expect(fs.readFile(path.join(workspace, "remove.ts"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(deleted.displayResult).toMatchObject({
        path: "remove.ts",
        operation: "delete",
        diff: {
          kind: "file_diff",
          added: 0,
          removed: 1,
        },
      });
      expect(fileHistory.latest(path.join(workspace, "remove.ts"))).toMatchObject({
        operation: "delete",
        beforeContent: "export const remove = true;\n",
        afterContent: null,
      });

      const rollback = await registry.execute(
        {
          id: "call-rollback-delete",
          name: "rollback_file",
          arguments: { path: "remove.ts" },
        },
        context,
      );
      expect(await fs.readFile(path.join(workspace, "remove.ts"), "utf8"))
        .toBe("export const remove = true;\n");
      expect(rollback.displayResult).toMatchObject({
        path: "remove.ts",
        operation: "create",
      });

      await registry.execute(
        { id: "call-read-stale-delete", name: "read_file", arguments: { path: "remove.ts" } },
        context,
      );
      await fs.writeFile(path.join(workspace, "remove.ts"), "external\n", "utf8");
      await expect(
        registry.execute(
          {
            id: "call-delete-stale",
            name: "delete_file",
            arguments: { path: "remove.ts" },
          },
          context,
        ),
      ).rejects.toThrow("File has been modified since it was read.");
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

  it("applies patches whose file headers contain spaces and C-style escapes", async () => {
    const workspace = await makeTempDir("apply-patch-escaped-paths-");
    try {
      const utf8Name = Buffer.from([0xe6, 0xb5, 0x8b, 0xe8, 0xaf, 0x95]).toString("utf8");
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "My File.ts"), "old space\n", "utf8");
      await fs.writeFile(path.join(workspace, "src", `${utf8Name}.ts`), "old utf8\n", "utf8");
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read-space", name: "read_file", arguments: { path: "src/My File.ts" } },
        context,
      );
      await registry.execute(
        { id: "call-read-utf8", name: "read_file", arguments: { path: `src/${utf8Name}.ts` } },
        context,
      );

      await registry.execute(
        {
          id: "call-patch-escaped-paths",
          name: "apply_patch",
          arguments: {
            patch: [
              "diff --git a/src/My File.ts b/src/My File.ts",
              "--- a/src/My File.ts",
              "+++ b/src/My File.ts",
              "@@ -1 +1 @@",
              "-old space",
              "+new space",
              "diff --git \"a/src/\\346\\265\\213\\350\\257\\225.ts\" \"b/src/\\346\\265\\213\\350\\257\\225.ts\"",
              "--- \"a/src/\\346\\265\\213\\350\\257\\225.ts\"\t2026-01-01 00:00:00",
              "+++ \"b/src/\\346\\265\\213\\350\\257\\225.ts\"\t2026-01-01 00:00:00",
              "@@ -1 +1 @@",
              "-old utf8",
              "+new utf8",
            ].join("\n"),
          },
        },
        context,
      );

      expect(await fs.readFile(path.join(workspace, "src", "My File.ts"), "utf8"))
        .toBe("new space\n");
      expect(await fs.readFile(path.join(workspace, "src", `${utf8Name}.ts`), "utf8"))
        .toBe("new utf8\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects apply_patch file headers with invalid target paths before filesystem access", async () => {
    const workspace = await makeTempDir("apply-patch-invalid-path-");
    try {
      const registry = new InMemoryToolRegistry(createCodingTools());
      await expect(
        registry.execute(
          {
            id: "call-patch-invalid-path",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- /dev/null",
                `+++ b/src/created.ts${"\0"}`,
                "@@ -0,0 +1 @@",
                "+created",
              ].join("\n"),
            },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("apply_patch file path is invalid.");
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

  it("rejects writes when the target becomes a symlink before commit", async () => {
    const workspace = await makeTempDir("coding-tools-target-symlink-race-");
    const outside = await makeTempDir("coding-tools-target-symlink-race-outside-");
    try {
      const targetPath = path.join(workspace, "file.ts");
      const outsideTargetPath = path.join(outside, "file.ts");
      await fs.writeFile(targetPath, "one\n", "utf8");
      await fs.writeFile(outsideTargetPath, "outside\n", "utf8");
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

      const realOpen = fs.open.bind(fs);
      let replaced = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        const target = args[0];
        const flags = args[1];
        const isWriteOpen = typeof flags === "number" &&
          (flags & fsConstants.O_WRONLY) === fsConstants.O_WRONLY;
        if (
          !replaced &&
          isWriteOpen &&
          typeof target === "string" &&
          path.resolve(target) === targetPath
        ) {
          replaced = true;
          await fs.rm(targetPath, { force: true });
          await fs.symlink(outsideTargetPath, targetPath);
        }
        return realOpen(...args);
      }) as typeof fs.open);
      try {
        await expect(
          registry.execute(
            {
              id: "call-edit-target-symlink-race",
              name: "edit_file",
              arguments: {
                path: "file.ts",
                old_string: "one",
                new_string: "two",
              },
            },
            context,
          ),
        ).rejects.toThrow("Coding tool write target is a symbolic link: file.ts");
      } finally {
        openSpy.mockRestore();
      }

      expect(await fs.readFile(outsideTargetPath, "utf8")).toBe("outside\n");
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("rejects editable reads when the target becomes a symlink before open", async () => {
    const workspace = await makeTempDir("coding-tools-read-symlink-race-");
    const outside = await makeTempDir("coding-tools-read-symlink-race-outside-");
    try {
      const targetPath = path.join(workspace, "file.ts");
      const outsideTargetPath = path.join(outside, "file.ts");
      await fs.writeFile(targetPath, "one\n", "utf8");
      await fs.writeFile(outsideTargetPath, "outside\n", "utf8");
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

      const realOpen = fs.open.bind(fs);
      let replaced = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        const target = args[0];
        if (!replaced && typeof target === "string" && path.resolve(target) === targetPath) {
          replaced = true;
          await fs.rm(targetPath, { force: true });
          await fs.symlink(outsideTargetPath, targetPath);
        }
        return realOpen(...args);
      }) as typeof fs.open);
      try {
        await expect(
          registry.execute(
            {
              id: "call-edit-read-symlink-race",
              name: "edit_file",
              arguments: {
                path: "file.ts",
                old_string: "one",
                new_string: "two",
              },
            },
            context,
          ),
        ).rejects.toThrow("Coding tool read target is a symbolic link: file.ts");
      } finally {
        openSpy.mockRestore();
      }

      expect(await fs.readFile(outsideTargetPath, "utf8")).toBe("outside\n");
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("rejects destructive coding tool paths that include symbolic links", async () => {
    const workspace = await makeTempDir("coding-tools-symlink-path-");
    try {
      await fs.mkdir(path.join(workspace, "real"), { recursive: true });
      await fs.writeFile(path.join(workspace, "real", "file.ts"), "one\n", "utf8");
      try {
        await fs.symlink(path.join(workspace, "real"), path.join(workspace, "link"), "dir");
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
        if (code === "EPERM" || code === "EACCES") {
          return;
        }
        throw error;
      }
      const readState = new FileReadStateStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState };
      await registry.execute(
        { id: "call-read-symlink", name: "read_file", arguments: { path: "link/file.ts" } },
        context,
      );

      await expect(
        registry.execute(
          {
            id: "call-edit-symlink",
            name: "edit_file",
            arguments: { path: "link/file.ts", old_string: "one", new_string: "two" },
          },
          context,
        ),
      ).rejects.toThrow("Coding tools do not modify files through symbolic links: link/file.ts");
      await expect(
        registry.execute(
          {
            id: "call-delete-symlink",
            name: "delete_file",
            arguments: { path: "link/file.ts" },
          },
          context,
        ),
      ).rejects.toThrow("Coding tools do not modify files through symbolic links: link/file.ts");
      await expect(
        registry.execute(
          {
            id: "call-patch-symlink",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- a/link/file.ts",
                "+++ b/link/file.ts",
                "@@ -1 +1 @@",
                "-one",
                "+two",
              ].join("\n"),
            },
          },
          context,
        ),
      ).rejects.toThrow("Coding tools do not modify files through symbolic links: link/file.ts");
      await expect(
        registry.execute(
          {
            id: "call-write-symlink-create",
            name: "write_file",
            arguments: { path: "link/new.ts", content: "created\n" },
          },
          context,
        ),
      ).rejects.toThrow("Coding tools do not modify files through symbolic links: link/new.ts");

      expect(await fs.readFile(path.join(workspace, "real", "file.ts"), "utf8"))
        .toBe("one\n");
      await expect(fs.access(path.join(workspace, "real", "new.ts")))
        .rejects.toThrow();
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
        withPlatformAsync("win32", () =>
          registry.execute(
            {
              id: "call-duplicate-target-windows-case",
              name: "apply_patch",
              arguments: {
                patch: [
                  "--- a/src/index.ts",
                  "+++ b/src/index.ts",
                  "@@ -1 +1 @@",
                  "-const value = 1;",
                  "+const value = 2;",
                  "--- a/SRC/INDEX.ts",
                  "+++ b/SRC/INDEX.ts",
                  "@@ -1 +1 @@",
                  "-const value = 1;",
                  "+const value = 3;",
                ].join("\n"),
              },
            },
            context,
          )
        ),
      ).rejects.toThrow("apply_patch contains duplicate file sections for SRC/INDEX.ts.");
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
      const realOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        const targetPath = args[0];
        if (typeof targetPath === "string" && path.resolve(targetPath) === failingPath) {
          throw new Error("simulated write failure");
        }
        return realOpen(...args);
      }) as typeof fs.open);

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
        openSpy.mockRestore();
      }

      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");
      await expect(fs.access(failingPath)).rejects.toThrow();
      expect(fileHistory.latest(path.join(workspace, "src", "index.ts"))).toBeUndefined();
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rolls back apply_patch writes when post-write metadata collection fails", async () => {
    const workspace = await makeTempDir("apply-patch-stat-failure-");
    const createdPath = path.join(workspace, "generated", "new.ts");
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

      let failCreatedStat = false;
      const realOpen = fs.open.bind(fs);
      const originalStat = fs.stat.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        const targetPath = args[0];
        if (typeof targetPath === "string" && path.resolve(targetPath) === createdPath) {
          failCreatedStat = true;
        }
        return realOpen(...args);
      }) as typeof fs.open);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation((async (
        ...args: Parameters<typeof fs.stat>
      ) => {
        const targetPath = args[0];
        if (
          failCreatedStat &&
          typeof targetPath === "string" &&
          path.resolve(targetPath) === createdPath
        ) {
          throw new Error("simulated post-write stat failure");
        }
        return originalStat(...args);
      }) as typeof fs.stat);

      try {
        await expect(
          registry.execute(
            {
              id: "call-post-write-stat-failure",
              name: "apply_patch",
              arguments: {
                patch: [
                  "--- a/src/index.ts",
                  "+++ b/src/index.ts",
                  "@@ -1 +1 @@",
                  "-const value = 1;",
                  "+const value = 2;",
                  "--- /dev/null",
                  "+++ b/generated/new.ts",
                  "@@ -0,0 +1 @@",
                  "+created",
                ].join("\n"),
              },
            },
            context,
          ),
        ).rejects.toThrow("simulated post-write stat failure");
      } finally {
        statSpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");
      await expect(fs.access(createdPath)).rejects.toThrow();
      expect(fileHistory.latest(path.join(workspace, "src", "index.ts"))).toBeUndefined();
      expect(fileHistory.latest(createdPath)).toBeUndefined();
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rolls back single-file edits when post-write metadata collection fails", async () => {
    const workspace = await makeTempDir("edit-file-stat-failure-");
    const targetPath = path.join(workspace, "src", "index.ts");
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, "const value = 1;\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };
      await registry.execute(
        { id: "call-read-edit-stat-failure", name: "read_file", arguments: { path: "src/index.ts" } },
        context,
      );

      let failTargetStat = false;
      const realOpen = fs.open.bind(fs);
      const originalStat = fs.stat.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        const target = args[0];
        if (typeof target === "string" && path.resolve(target) === targetPath) {
          failTargetStat = true;
        }
        return realOpen(...args);
      }) as typeof fs.open);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation((async (
        ...args: Parameters<typeof fs.stat>
      ) => {
        const target = args[0];
        if (
          failTargetStat &&
          typeof target === "string" &&
          path.resolve(target) === targetPath
        ) {
          throw new Error("simulated single-file post-write stat failure");
        }
        return originalStat(...args);
      }) as typeof fs.stat);

      try {
        await expect(
          registry.execute(
            {
              id: "call-edit-post-write-stat-failure",
              name: "edit_file",
              arguments: {
                path: "src/index.ts",
                old_string: "const value = 1;",
                new_string: "const value = 2;",
              },
            },
            context,
          ),
        ).rejects.toThrow("simulated single-file post-write stat failure");
      } finally {
        statSpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(await fs.readFile(targetPath, "utf8")).toBe("const value = 1;\n");
      expect(fileHistory.latest(targetPath)).toBeUndefined();
      expect(readState.get(targetPath)?.content).toBe("const value = 1;\n");
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

  it("rolls back from checkpoint snapshots when in-memory file history is absent", async () => {
    const userDataDir = await makeTempDir("rollback-checkpoint-userdata-");
    const workspace = await makeTempDir("rollback-checkpoint-workspace-");
    try {
      const targetPath = path.join(workspace, "file.ts");
      await fs.writeFile(targetPath, "two\n", "utf8");
      const checkpoint = new CheckpointStore(userDataDir);
      await checkpoint.init();
      await checkpoint.beginTurn({
        threadId: "thread-1",
        turnId: "turn-edit",
        workspace,
        prompt: "edit file",
        createdAt: "2026-06-12T01:00:00.000Z",
      });
      await checkpoint.recordFileSnapshot({
        threadId: "thread-1",
        turnId: "turn-edit",
        workspace,
        toolName: "edit_file",
        relativePath: "file.ts",
        operation: "update",
        beforeContent: "one\n",
        afterContent: "two\n",
        beforeSha256: sha256Text("one\n"),
        afterSha256: sha256Text("two\n"),
      });

      const resumedCheckpoint = new CheckpointStore(userDataDir);
      const registry = new InMemoryToolRegistry(createCodingTools());
      const rollback = await registry.execute(
        {
          id: "call-checkpoint-rollback",
          name: "rollback_file",
          arguments: { path: "file.ts" },
        },
        {
          threadId: "thread-1",
          turnId: "turn-rollback",
          workspace,
          checkpoint: resumedCheckpoint,
        },
      );

      expect(await fs.readFile(targetPath, "utf8")).toBe("one\n");
      expect(rollback.displayResult).toMatchObject({
        path: "file.ts",
        operation: "update",
        diff: {
          removed: 1,
          added: 1,
        },
      });
    } finally {
      await removeTempDir(userDataDir);
      await removeTempDir(workspace);
    }
  });

  it("refuses checkpoint rollback when current content no longer matches the snapshot", async () => {
    const userDataDir = await makeTempDir("rollback-checkpoint-stale-userdata-");
    const workspace = await makeTempDir("rollback-checkpoint-stale-workspace-");
    try {
      const targetPath = path.join(workspace, "file.ts");
      await fs.writeFile(targetPath, "external\n", "utf8");
      const checkpoint = new CheckpointStore(userDataDir);
      await checkpoint.init();
      await checkpoint.beginTurn({
        threadId: "thread-1",
        turnId: "turn-edit",
        workspace,
        prompt: "edit file",
        createdAt: "2026-06-12T01:00:00.000Z",
      });
      await checkpoint.recordFileSnapshot({
        threadId: "thread-1",
        turnId: "turn-edit",
        workspace,
        toolName: "edit_file",
        relativePath: "file.ts",
        operation: "update",
        beforeContent: "one\n",
        afterContent: "two\n",
        beforeSha256: sha256Text("one\n"),
        afterSha256: sha256Text("two\n"),
      });

      const registry = new InMemoryToolRegistry(createCodingTools());
      await expect(
        registry.execute(
          {
            id: "call-stale-checkpoint-rollback",
            name: "rollback_file",
            arguments: { path: "file.ts" },
          },
          {
            threadId: "thread-1",
            turnId: "turn-rollback",
            workspace,
            checkpoint: new CheckpointStore(userDataDir),
          },
        ),
      ).rejects.toThrow(
        "rollback_file current content no longer matches the latest checkpoint entry: file.ts",
      );
      expect(await fs.readFile(targetPath, "utf8")).toBe("external\n");
    } finally {
      await removeTempDir(userDataDir);
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

  it("refuses rollback of file history written by another thread", async () => {
    const workspace = await makeTempDir("rollback-tools-thread-guard-");
    try {
      await fs.writeFile(path.join(workspace, "file.ts"), "one\n", "utf8");
      const readState = new FileReadStateStore();
      const fileHistory = new FileHistoryStore();
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      const threadOne = { threadId: "thread-1", turnId: "turn-1", workspace, readState, fileHistory };
      const threadTwo = { threadId: "thread-2", turnId: "turn-2", workspace, readState, fileHistory };

      await registry.execute(
        { id: "call-read", name: "read_file", arguments: { path: "file.ts" } },
        threadOne,
      );
      await registry.execute(
        {
          id: "call-edit",
          name: "edit_file",
          arguments: { path: "file.ts", old_string: "one", new_string: "two" },
        },
        threadOne,
      );

      await expect(
        registry.execute(
          {
            id: "call-cross-thread-rollback",
            name: "rollback_file",
            arguments: { path: "file.ts" },
          },
          threadTwo,
        ),
      ).rejects.toThrow("rollback_file history does not belong to this thread: file.ts");
      expect(await fs.readFile(path.join(workspace, "file.ts"), "utf8")).toBe("two\n");
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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

  it("redacts sensitive environment variables from foreground commands", async () => {
    const workspace = await makeTempDir("command-tools-env-");
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalToken = process.env.AGENT_PYRAMID_TEST_TOKEN;
    const originalPath = process.env.PATH;
    try {
      process.env.OPENAI_API_KEY = "secret-openai-key";
      process.env.AGENT_PYRAMID_TEST_TOKEN = "secret-agent-token";
      process.env.PATH = originalPath ?? path.dirname(process.execPath);
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-command-env",
          name: "run_command",
          arguments: {
            command: nodeCommand(
              [
                "process.stdout.write(JSON.stringify({",
                "openai: process.env.OPENAI_API_KEY ?? null,",
                "token: process.env.AGENT_PYRAMID_TEST_TOKEN ?? null,",
                "hasPath: Boolean(process.env.PATH || process.env.Path)",
                "}));",
              ].join(""),
            ),
          },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as { stdout: string };
      const envSnapshot = JSON.parse(parsed.stdout) as {
        openai: string | null;
        token: string | null;
        hasPath: boolean;
      };

      expect(envSnapshot).toEqual({
        openai: null,
        token: null,
        hasPath: true,
      });
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      if (originalToken === undefined) {
        delete process.env.AGENT_PYRAMID_TEST_TOKEN;
      } else {
        process.env.AGENT_PYRAMID_TEST_TOKEN = originalToken;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await removeTempDir(workspace);
    }
  });

  it("reports foreground command stdout and stderr progress without changing the final result", async () => {
    const workspace = await makeTempDir("command-tools-progress-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const progress: Array<{ chunk: string; stream: "stdout" | "stderr" }> = [];

      const result = await registry.execute(
        {
          id: "call-command-progress",
          name: "run_command",
          arguments: {
            command: nodeCommand(
              "process.stdout.write('out-1\\n'); process.stderr.write('err-1\\n');",
            ),
          },
        },
        {
          threadId: "thread-1",
          turnId: "turn-1",
          workspace,
          sandboxMode: "danger-full-access" as const,
          reportProgress: (chunk, stream) => {
            progress.push({ chunk, stream });
          },
        },
      );
      const parsed = JSON.parse(result.content) as {
        stdout: string;
        stderr: string;
      };

      expect(parsed.stdout).toBe("out-1\n");
      expect(parsed.stderr).toBe("err-1\n");
      expect(progress.some((entry) => entry.stream === "stdout" && entry.chunk.includes("out-1")))
        .toBe(true);
      expect(progress.some((entry) => entry.stream === "stderr" && entry.chunk.includes("err-1")))
        .toBe(true);
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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

  it("reports foreground command spawn failures before treating the command as executed", async () => {
    const workspace = await makeTempDir("shell-command-spawn-failure-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());

      await expect(
        registry.execute(
          {
            id: "call-shell-spawn-failure",
            name: "shell_command",
            arguments: {
              command: "echo unreachable",
              shell_path: path.join(workspace, "missing-shell"),
              shell_args: ["-c", "{command}"],
            },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("Command failed to start:");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("resolves the default PowerShell command shell through the Windows fallback order", async () => {
    const fakeBin = await makeTempDir("powershell-command-fallback-bin-");
    const originalPath = process.env.PATH;
    const originalPathCapitalized = process.env.Path;
    try {
      process.env.PATH = fakeBin;
      process.env.Path = fakeBin;

      await fs.writeFile(path.join(fakeBin, "powershell.exe"), "", "utf8");
      await expect(
        withPlatformAsync("win32", () => resolveDefaultPowerShellShell()),
      ).resolves.toBe("powershell");

      await fs.writeFile(path.join(fakeBin, "pwsh.exe"), "", "utf8");
      await expect(
        withPlatformAsync("win32", () => resolveDefaultPowerShellShell()),
      ).resolves.toBe("pwsh");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathCapitalized === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathCapitalized;
      }
      await removeTempDir(fakeBin);
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
        sandbox: {
          mode: string;
          cwdBoundary: string;
          environment: string;
          stdio: string;
          shell: string;
          processCleanup: string;
          osJail: { enabled: boolean; reason: string };
        };
      };

      expect(parsed.platform).toBe(process.platform);
      expect(Array.isArray(parsed.pathEntries)).toBe(true);
      expect(parsed.executables).toHaveProperty("git");
      expect(parsed.workspacePath).toBe(workspace);
      expect(parsed.wslWorkspacePath).toBe(toWslPath(workspace));
      expect(parsed.sandbox).toMatchObject({
        mode: "workspace-write",
        cwdBoundary: "workspace-realpath",
        environment: "credential-filtered",
        stdio: "not-inherited",
        shell: "explicit",
        osJail: { enabled: false },
      });
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

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

  it("rejects NUL bytes in command optional string parameters", async () => {
    const workspace = await makeTempDir("command-tools-nul-strings-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          {
            id: "command-nul-cwd",
            name: "run_command",
            arguments: {
              command: nodeCommand("process.stdout.write('x')"),
              cwd: `src${"\0"}index`,
            },
          },
          context,
        ),
      ).rejects.toThrow("optional string value cannot contain NUL bytes.");
      await expect(
        registry.execute(
          {
            id: "command-nul-shell-path",
            name: "shell_command",
            arguments: {
              command: "process.stdout.write('x')",
              shell_path: `${process.execPath}${"\0"}`,
              shell_args: ["-e", "{command}"],
            },
          },
          context,
        ),
      ).rejects.toThrow("optional string value cannot contain NUL bytes.");
      await expect(
        registry.execute(
          {
            id: "command-nul-distro",
            name: "wsl_command",
            arguments: {
              command: "printf x",
              distro: `Ubuntu${"\0"}next`,
            },
          },
          context,
        ),
      ).rejects.toThrow("optional string value cannot contain NUL bytes.");
      await expect(
        registry.execute(
          {
            id: "command-nul-detect-workspace-path",
            name: "detect_shell_environment",
            arguments: {
              workspace_path: `${workspace}${"\0"}outside`,
            },
          },
          context,
        ),
      ).rejects.toThrow("optional string value cannot contain NUL bytes.");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("falls back to direct child kill when Windows taskkill exits nonzero", async () => {
    const workspace = await makeTempDir("command-tools-taskkill-fallback-");
    const fakeBin = await makeTempDir("command-tools-fake-taskkill-");
    const originalPath = process.env.PATH;
    const originalPathCapitalized = process.env.Path;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      if (process.platform === "win32") {
        await fs.copyFile(process.execPath, path.join(fakeBin, "taskkill.exe"));
      } else {
        const fakeTaskkill = path.join(fakeBin, "taskkill");
        await fs.writeFile(fakeTaskkill, "#!/bin/sh\nexit 1\n", "utf8");
        await fs.chmod(fakeTaskkill, 0o755);
      }
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
      process.env.Path = `${fakeBin}${path.delimiter}${originalPathCapitalized ?? originalPath ?? ""}`;

      const registry = new InMemoryToolRegistry(createCommandTools());
      const result = await withPlatformAsync("win32", () =>
        registry.execute(
          {
            id: "call-taskkill-fallback",
            name: "shell_command",
            arguments: {
              command: "setTimeout(() => process.exit(23), 800);",
              shell_path: process.execPath,
              shell_args: ["-e", "{command}"],
              timeout_ms: 100,
            },
          },
          {
            threadId: "thread-1",
            turnId: "turn-1",
            workspace,
            sandboxMode: "danger-full-access" as const,
            commandDefaults: {
              timeoutMs: 100,
              maxOutputBytes: 2048,
            },
          },
        ),
      );
      const parsed = JSON.parse(result.content) as { timedOut: boolean; exitCode: number | null };

      expect(parsed.timedOut).toBe(true);
      expect(parsed.exitCode).not.toBe(23);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("taskkill exited with code"),
      );
    } finally {
      warnSpy.mockRestore();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathCapitalized === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathCapitalized;
      }
      await removeTempDir(workspace);
      await removeTempDir(fakeBin);
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
        sandboxMode: "danger-full-access" as const,
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
          sandboxMode: "danger-full-access" as const,
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
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

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

      const headLog = JSON.parse(
        (
          await registry.execute(
            { id: "git-log-head", name: "git_log", arguments: { ref: "HEAD", max_count: 1 } },
            context,
          )
        ).content,
      ) as { command: string[]; commits: Array<{ subject: string }> };
      expect(headLog.command).toContain("HEAD");
      expect(headLog.commits).toEqual([expect.objectContaining({ subject: "initial commit" })]);

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
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
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
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
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

  it("supports deleted file pathspecs for git_diff and git_commit", async () => {
    const workspace = await makeTempDir("git-deleted-pathspec-tools-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
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
      await fs.writeFile(path.join(workspace, "delete-me.txt"), "remove me\n", "utf8");
      await registry.execute(
        { id: "git-add-base", name: "run_command", arguments: { command: "git add delete-me.txt" } },
        context,
      );
      await registry.execute(
        { id: "git-commit-base", name: "run_command", arguments: { command: "git commit -m initial" } },
        context,
      );
      await fs.unlink(path.join(workspace, "delete-me.txt"));

      const diff = JSON.parse(
        (
          await registry.execute(
            { id: "git-diff-delete", name: "git_diff", arguments: { pathspecs: ["delete-me.txt"] } },
            context,
          )
        ).content,
      ) as { stdout: string };
      expect(diff.stdout).toContain("-remove me");

      const commit = JSON.parse(
        (
          await registry.execute(
            {
              id: "git-commit-delete",
              name: "git_commit",
              arguments: { message: "delete tracked file", pathspecs: ["delete-me.txt"] },
            },
            context,
          )
        ).content,
      ) as { commit: { exitCode: number | null } };
      expect(commit.commit.exitCode).toBe(0);

      await expect(
        registry.execute(
          {
            id: "git-hidden-pathspec",
            name: "git_diff",
            arguments: { pathspecs: [".env"] },
          },
          context,
        ),
      ).rejects.toThrow("Path is skipped by workspace tool policy: .env");
      await expect(
        registry.execute(
          {
            id: "git-magic-pathspec",
            name: "git_diff",
            arguments: { pathspecs: [":(glob).env"] },
          },
          context,
        ),
      ).rejects.toThrow("git_diff pathspec must be a plain workspace-relative path");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects git_log refs that are options or pathspec magic", async () => {
    const workspace = await makeTempDir("git-log-ref-tools-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      for (const ref of ["--all", "-n1", ":(glob)*", "HEAD name"]) {
        await expect(
          registry.execute(
            {
              id: `git-log-ref-${ref}`,
              name: "git_log",
              arguments: { ref },
            },
            context,
          ),
        ).rejects.toThrow("git_log ref");
      }
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
            "format:write": "node -e \"process.stdout.write('formatted')\"",
            lint: "node -e \"process.stdout.write('linted')\"",
            test: "node -e \"process.stdout.write('tested')\"",
          },
        }),
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      const scripts = JSON.parse(
        (
          await registry.execute(
            { id: "package-scripts", name: "package_scripts", arguments: {} },
            context,
          )
        ).content,
      ) as { manager: string; scripts: Record<string, string> };
      expect(scripts.manager).toBe("npm");
      expect(Object.keys(scripts.scripts).sort()).toEqual(["build", "format:write", "lint", "test"]);

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

      const formatted = JSON.parse(
        (
          await registry.execute(
            {
              id: "package-test-format-write",
              name: "package_test",
              arguments: { script: "format:write" },
            },
            context,
          )
        ).content,
      ) as { script: string; stdout: string };
      expect(formatted).toMatchObject({ script: "format:write" });
      expect(formatted.stdout).toContain("formatted");

      for (const script of ["--help", "-w", "test -- --watch", "test\nnext", "bad<script>"]) {
        await expect(
          registry.execute(
            {
              id: `package-test-script-${Buffer.from(script).toString("hex")}`,
              name: "package_test",
              arguments: { script },
            },
            context,
          ),
        ).rejects.toThrow("script");
      }
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("uses npm ci only when frozen package_install has an npm lockfile", async () => {
    const workspace = await makeTempDir("package-install-frozen-tools-");
    const fakeBin = await makeTempDir("package-install-fake-bin-");
    const originalPath = process.env.PATH;
    const originalPathCapitalized = process.env.Path;
    try {
      await fs.writeFile(path.join(workspace, "package.json"), "{}", "utf8");
      const fakeNpm = process.platform === "win32"
        ? path.join(fakeBin, "npm.cmd")
        : path.join(fakeBin, "npm");
      const fakeNpmBody = process.platform === "win32"
        ? "@echo off\r\nnode -e \"process.stdout.write(process.argv.slice(1).join(' '))\" %*\r\n"
        : "#!/bin/sh\nnode -e \"process.stdout.write(process.argv.slice(1).join(' '))\" \"$@\"\n";
      await fs.writeFile(fakeNpm, fakeNpmBody, "utf8");
      if (process.platform !== "win32") {
        await fs.chmod(fakeNpm, 0o755);
      }
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
      process.env.Path = `${fakeBin}${path.delimiter}${originalPathCapitalized ?? originalPath ?? ""}`;
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          {
            id: "package-install-frozen-missing-lock",
            name: "package_install",
            arguments: { manager: "npm", frozen_lockfile: true },
          },
          context,
        ),
      ).rejects.toThrow("package_install frozen_lockfile requires package-lock.json or npm-shrinkwrap.json for npm.");

      await fs.writeFile(path.join(workspace, "package-lock.json"), "{}", "utf8");
      const packageLockInstall = JSON.parse(
        (
          await registry.execute(
            {
              id: "package-install-frozen-package-lock",
              name: "package_install",
              arguments: { manager: "npm", frozen_lockfile: true },
            },
            context,
          )
        ).content,
      ) as { commandArgs: string[]; stdout: string };
      expect(packageLockInstall.commandArgs).toEqual(["npm", "ci"]);
      expect(packageLockInstall.stdout.trim()).toBe("ci");

      await fs.unlink(path.join(workspace, "package-lock.json"));
      await fs.writeFile(path.join(workspace, "npm-shrinkwrap.json"), "{}", "utf8");
      const shrinkwrapInstall = JSON.parse(
        (
          await registry.execute(
            {
              id: "package-install-frozen-shrinkwrap",
              name: "package_install",
              arguments: { manager: "npm", frozen_lockfile: true },
            },
            context,
          )
        ).content,
      ) as { commandArgs: string[]; stdout: string };
      expect(shrinkwrapInstall.commandArgs).toEqual(["npm", "ci"]);
      expect(shrinkwrapInstall.stdout.trim()).toBe("ci");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathCapitalized === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathCapitalized;
      }
      await removeTempDir(workspace);
      await removeTempDir(fakeBin);
    }
  });

  it("starts, reads, writes, and stops long-running command sessions", async () => {
    const workspace = await makeTempDir("command-session-tools-");
    let sessionId: string | undefined;
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const progressEvents: Array<{ chunk: string; stream: ToolProgressStream }> = [];
      const context = {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        sandboxMode: "danger-full-access" as const,
        reportProgress(chunk: string, stream: ToolProgressStream): void {
          progressEvents.push({ chunk, stream });
        },
      };
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

      const crossThreadList = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-cross-thread-list",
              name: "list_command_sessions",
              arguments: {},
            },
            { threadId: "thread-2", turnId: "turn-2", workspace },
          )
        ).content,
      ) as { sessionCount: number; sessions: unknown[] };
      expect(crossThreadList).toEqual({ sessionCount: 0, sessions: [] });

      const listed = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-list",
              name: "list_command_sessions",
              arguments: {},
            },
            context,
          )
        ).content,
      ) as {
        sessionCount: number;
        sessions: Array<{ sessionId: string; command: string; status: string; stdout?: unknown }>;
      };
      expect(listed.sessionCount).toBe(1);
      expect(listed.sessions[0]).toMatchObject({
        sessionId,
        status: "running",
      });
      expect(listed.sessions[0].command).toContain("node");
      expect(listed.sessions[0].stdout).toBeUndefined();

      await expect(
        registry.execute(
          {
            id: "session-cross-thread-read",
            name: "read_command_session",
            arguments: { session_id: sessionId },
          },
          { threadId: "thread-2", turnId: "turn-2", workspace },
        ),
      ).rejects.toThrow("read_command_session session does not belong to this thread workspace");

      const write = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-write",
              name: "write_command_session",
              arguments: { session_id: sessionId, input: " ping " },
            },
            context,
          )
        ).content,
      ) as { sessionId: string; bytesWritten: number };
      expect(write).toEqual({
        sessionId,
        bytesWritten: Buffer.byteLength(" ping \n", "utf8"),
      });

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
        return read.stdout.text.includes("ready") && read.stdout.text.includes("echo: ping ");
      });

      const listedWithOutput = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-list-output",
              name: "list_command_sessions",
              arguments: { include_output: true, tail_bytes: 1024 },
            },
            context,
          )
        ).content,
      ) as { sessions: Array<{ sessionId: string; stdout: { text: string } }> };
      expect(listedWithOutput.sessions).toHaveLength(1);
      expect(listedWithOutput.sessions[0].sessionId).toBe(sessionId);
      expect(listedWithOutput.sessions[0].stdout.text).toContain("ready");
      expect(listedWithOutput.sessions[0].stdout.text).toContain("echo: ping ");
      await waitUntil(() =>
        progressEvents.some((event) =>
          event.stream === "stdout" && event.chunk.includes("ready"),
        ) &&
        progressEvents.some((event) =>
          event.stream === "stdout" && event.chunk.includes("echo: ping "),
        ),
      );

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
      expect(["exited", "failed"]).toContain(stopped.status);
      await expect(
        registry.execute(
          {
            id: "session-write-stopped",
            name: "write_command_session",
            arguments: { session_id: sessionId, input: "late" },
          },
          context,
        ),
      ).rejects.toThrow("write_command_session session is not running");
    } finally {
      if (sessionId) {
        const registry = new InMemoryToolRegistry(createCommandTools());
        await registry.execute(
          {
            id: "session-cleanup",
            name: "stop_command_session",
            arguments: { session_id: sessionId },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("Command session not found")) return;
          throw error;
        });
      }
      await removeTempDir(workspace);
    }
  });

  it("does not start a command session when the tool context is already aborted", async () => {
    const workspace = await makeTempDir("command-session-pre-aborted-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const controller = new AbortController();
      controller.abort();
      const context = {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        signal: controller.signal,
      };

      await expect(
        registry.execute(
          {
            id: "session-start-aborted",
            name: "start_command_session",
            arguments: {
              command: nodeCommand("process.stdout.write('should-not-run');"),
            },
          },
          context,
        ),
      ).rejects.toThrow("Command was interrupted.");

      const list = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-list-after-abort",
              name: "list_command_sessions",
              arguments: {},
            },
            { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
          )
        ).content,
      ) as { sessionCount: number };
      expect(list.sessionCount).toBe(0);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("cleans up command sessions during application shutdown", async () => {
    const workspace = await makeTempDir("command-session-shutdown-");
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
      const start = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-shutdown-start",
              name: "start_command_session",
              arguments: {
                command: nodeCommand(
                  "process.stdout.write('shutdown-ready\\n'); setInterval(() => undefined, 1000);",
                ),
              },
            },
            context,
          )
        ).content,
      ) as { sessionId: string };

      await waitUntil(async () => {
        const read = JSON.parse(
          (
            await registry.execute(
              {
                id: "session-shutdown-read",
                name: "read_command_session",
                arguments: { session_id: start.sessionId },
              },
              context,
            )
          ).content,
        ) as { stdout: { text: string } };
        return read.stdout.text.includes("shutdown-ready");
      });

      const shutdown = await shutdownCommandSessions();
      expect(shutdown.sessionCount).toBe(1);
      expect(shutdown.stoppedSessionCount).toBe(1);
      expect(shutdown.sessions).toHaveLength(1);
      expect(shutdown.sessions[0].sessionId).toBe(start.sessionId);
      expect(["exited", "failed"]).toContain(shutdown.sessions[0].status);
      expect(shutdown.sessions[0].error).toBe(
        "Command session stopped during application shutdown.",
      );

      const listed = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-shutdown-list",
              name: "list_command_sessions",
              arguments: {},
            },
            context,
          )
        ).content,
      ) as { sessionCount: number; sessions: unknown[] };
      expect(listed).toEqual({ sessionCount: 0, sessions: [] });
      await expect(shutdownCommandSessions()).resolves.toEqual({
        sessionCount: 0,
        stoppedSessionCount: 0,
        sessions: [],
      });
    } finally {
      await shutdownCommandSessions().catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("Command session shutdown failed")) return;
        throw error;
      });
      await removeTempDir(workspace);
    }
  });

  it("redacts sensitive environment variables from long-running command sessions", async () => {
    const workspace = await makeTempDir("command-session-env-");
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalToken = process.env.AGENT_PYRAMID_TEST_TOKEN;
    const originalPath = process.env.PATH;
    let sessionId: string | undefined;
    try {
      process.env.OPENAI_API_KEY = "secret-openai-key";
      process.env.AGENT_PYRAMID_TEST_TOKEN = "secret-agent-token";
      process.env.PATH = originalPath ?? path.dirname(process.execPath);
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
      const start = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-env-start",
              name: "start_command_session",
              arguments: {
                command: nodeCommand(
                  [
                    "process.stdout.write(JSON.stringify({",
                    "openai: process.env.OPENAI_API_KEY ?? null,",
                    "token: process.env.AGENT_PYRAMID_TEST_TOKEN ?? null,",
                    "hasPath: Boolean(process.env.PATH || process.env.Path)",
                    "}) + '\\n');",
                    "setInterval(() => undefined, 1000);",
                  ].join(""),
                ),
              },
            },
            context,
          )
        ).content,
      ) as { sessionId: string };
      sessionId = start.sessionId;

      await waitUntil(async () => {
        const read = JSON.parse(
          (
            await registry.execute(
              {
                id: "session-env-read-wait",
                name: "read_command_session",
                arguments: { session_id: sessionId },
              },
              context,
            )
          ).content,
        ) as { stdout: { text: string } };
        return read.stdout.text.includes("}");
      });
      const read = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-env-read",
              name: "read_command_session",
              arguments: { session_id: sessionId },
            },
            context,
          )
        ).content,
      ) as { stdout: { text: string } };
      const envSnapshot = JSON.parse(read.stdout.text.trim()) as {
        openai: string | null;
        token: string | null;
        hasPath: boolean;
      };

      expect(envSnapshot).toEqual({
        openai: null,
        token: null,
        hasPath: true,
      });
    } finally {
      if (sessionId) {
        const registry = new InMemoryToolRegistry(createCommandTools());
        await registry.execute(
          {
            id: "session-env-cleanup",
            name: "stop_command_session",
            arguments: { session_id: sessionId },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("Command session not found")) return;
          throw error;
        });
      }
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      if (originalToken === undefined) {
        delete process.env.AGENT_PYRAMID_TEST_TOKEN;
      } else {
        process.env.AGENT_PYRAMID_TEST_TOKEN = originalToken;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await removeTempDir(workspace);
    }
  });

  it("keeps command session tail output on a UTF-8 character boundary", async () => {
    const workspace = await makeTempDir("command-session-utf8-tail-");
    let sessionId: string | undefined;
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
      const start = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-start-utf8-tail",
              name: "start_command_session",
              arguments: {
                command: nodeCommand(
                  "process.stdout.write('x' + '你' + 'tail'); setInterval(() => undefined, 1000);",
                ),
              },
            },
            context,
          )
        ).content,
      ) as { sessionId: string };
      sessionId = start.sessionId;

      await waitUntil(async () => {
        const read = JSON.parse(
          (
            await registry.execute(
              {
                id: "session-read-utf8-tail-wait",
                name: "read_command_session",
                arguments: { session_id: sessionId },
              },
              context,
            )
          ).content,
        ) as { stdout: { text: string } };
        return read.stdout.text.includes("tail");
      });

      const tail = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-read-utf8-tail",
              name: "read_command_session",
              arguments: { session_id: sessionId, tail_bytes: 6 },
            },
            context,
          )
        ).content,
      ) as { stdout: { text: string; truncated: boolean; bytes: number } };

      expect(tail.stdout.text).toBe("tail");
      expect(tail.stdout.text).not.toContain("\uFFFD");
      expect(tail.stdout.truncated).toBe(true);
      expect(tail.stdout.bytes).toBe(Buffer.byteLength("x你tail", "utf8"));
    } finally {
      if (sessionId) {
        const registry = new InMemoryToolRegistry(createCommandTools());
        await registry.execute(
          {
            id: "session-cleanup-utf8-tail",
            name: "stop_command_session",
            arguments: { session_id: sessionId },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("Command session not found")) return;
          throw error;
        });
      }
      await removeTempDir(workspace);
    }
  });

  it("keeps the latest command session output when the session buffer fills", async () => {
    const workspace = await makeTempDir("command-session-latest-buffer-");
    let sessionId: string | undefined;
    try {
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
      const script = [
        "process.stdout.write('old' + '你' + 'x'.repeat(1016) + 'latest');",
        "setInterval(() => undefined, 1000);",
      ].join(" ");
      const start = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-start-latest-buffer",
              name: "start_command_session",
              arguments: {
                command: nodeCommand(script),
                max_buffer_bytes: 1024,
              },
            },
            context,
          )
        ).content,
      ) as { sessionId: string };
      sessionId = start.sessionId;

      await waitUntil(async () => {
        const read = JSON.parse(
          (
            await registry.execute(
              {
                id: "session-read-latest-buffer-wait",
                name: "read_command_session",
                arguments: { session_id: sessionId },
              },
              context,
            )
          ).content,
        ) as { stdout: { text: string } };
        return read.stdout.text.includes("latest");
      });

      const read = JSON.parse(
        (
          await registry.execute(
            {
              id: "session-read-latest-buffer",
              name: "read_command_session",
              arguments: { session_id: sessionId },
            },
            context,
          )
        ).content,
      ) as { stdout: { text: string; truncated: boolean; bytes: number } };

      expect(read.stdout.text).toContain("latest");
      expect(read.stdout.text).not.toContain("old");
      expect(read.stdout.text).not.toContain("\uFFFD");
      expect(read.stdout.truncated).toBe(true);
      expect(read.stdout.bytes).toBe(Buffer.byteLength(`old你${"x".repeat(1016)}latest`, "utf8"));
    } finally {
      if (sessionId) {
        const registry = new InMemoryToolRegistry(createCommandTools());
        await registry.execute(
          {
            id: "session-cleanup-latest-buffer",
            name: "stop_command_session",
            arguments: { session_id: sessionId },
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("Command session not found")) return;
          throw error;
        });
      }
      await removeTempDir(workspace);
    }
  });

  it("fails command session start when the shell cannot spawn", async () => {
    const workspace = await makeTempDir("command-session-spawn-failure-");
    const envKey = process.platform === "win32" ? "ComSpec" : "SHELL";
    const originalShell = process.env[envKey];
    try {
      process.env[envKey] = path.join(workspace, "missing-shell");
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };
      await expect(
        registry.execute(
          {
            id: "session-start-missing-shell",
            name: "start_command_session",
            arguments: { command: "echo unreachable" },
          },
          context,
        ),
      ).rejects.toThrow("start_command_session failed to start command:");
    } finally {
      if (originalShell === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalShell;
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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

  it("reports invalid package.json while resolving workspace diagnostics", async () => {
    const workspace = await makeTempDir("diagnose-tools-invalid-package-");
    try {
      await fs.writeFile(path.join(workspace, "package.json"), "{ invalid", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      await expect(
        registry.execute(
          {
            id: "call-diagnose-invalid-package",
            name: "diagnose_workspace",
            arguments: {},
          },
          { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
        ),
      ).rejects.toThrow("diagnose_workspace package.json is invalid");
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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

  it("filters diagnose_workspace diagnostics outside the workspace", async () => {
    const workspace = await makeTempDir("diagnose-tools-outside-output-");
    const outside = await makeTempDir("diagnose-tools-outside-source-");
    try {
      const outsideFile = path.join(outside, "external.ts");
      await fs.writeFile(outsideFile, "const value: string = 1;\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "emit-diagnostics.js"),
        [
          `console.log(${JSON.stringify(`${outsideFile}(1,7): error TS2322: outside`)});`,
          "console.log('src/index.ts(1,7): error TS2322: inside');",
          "process.exit(1);",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            typecheck: "node emit-diagnostics.js",
          },
        }),
        "utf8",
      );
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value: string = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-diagnose-outside-output",
          name: "diagnose_workspace",
          arguments: {},
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as {
        diagnostics: Array<{ path: string; message: string }>;
      };

      expect(parsed.diagnostics).toEqual([
        expect.objectContaining({
          path: "src/index.ts",
          message: "inside",
        }),
      ]);
      expect(parsed.diagnostics.some((diagnostic) => diagnostic.path.includes(".."))).toBe(false);
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
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
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
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

  it("keeps diagnose_file diagnostic paths inside the workspace", async () => {
    const workspace = await makeTempDir("diagnose-file-tools-outside-");
    const outside = await makeTempDir("diagnose-file-tools-outside-source-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            allowJs: true,
            checkJs: true,
            moduleResolution: "node",
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      const outsideFile = path.join(outside, "external.js");
      await fs.writeFile(outsideFile, "/** @type {string} */\nexports.value = 1;\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "src", "index.ts"),
        `import { value } from ${JSON.stringify(outsideFile.replaceAll("\\", "/"))};\nconst local: string = 1;\nconsole.log(value);\n`,
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-diagnose-file-outside",
          name: "diagnose_file",
          arguments: { path: "src/index.ts" },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as {
        diagnostics: Array<{ path: string; code: string }>;
      };

      expect(parsed.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "src/index.ts",
          code: "TS2322",
        }),
      ]));
      expect(parsed.diagnostics.some((diagnostic) => diagnostic.path.includes(".."))).toBe(false);
    } finally {
      await removeTempDir(workspace);
      await removeTempDir(outside);
    }
  });

  it("guards diagnose_file paths", async () => {
    const workspace = await makeTempDir("diagnose-file-tools-guard-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "file.ts"), "const value = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

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

  it("returns a structured symbol outline for one workspace file", async () => {
    const workspace = await makeTempDir("list-symbols-tools-");
    try {
      await fs.writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            strict: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "src", "index.ts"),
        [
          "export class Runner {",
          "  start(): void {}",
          "}",
          "export function createRunner(): Runner {",
          "  return new Runner();",
          "}",
        ].join("\n"),
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-list-symbols",
          name: "list_symbols",
          arguments: { path: "src/index.ts", max_results: 10 },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as {
        path: string;
        symbolCount: number;
        truncated: boolean;
        symbols: Array<{
          path: string;
          name: string;
          kind: string;
          line: number;
          column: number;
          level: number;
        }>;
      };

      expect(parsed.path).toBe("src/index.ts");
      expect(parsed.truncated).toBe(false);
      expect(parsed.symbolCount).toBeGreaterThanOrEqual(3);
      expect(parsed.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "src/index.ts",
          name: "Runner",
          kind: "class",
          line: 1,
          column: 1,
          level: 0,
        }),
        expect.objectContaining({
          path: "src/index.ts",
          name: "start",
          kind: "method",
          line: 2,
          level: 1,
        }),
        expect.objectContaining({
          path: "src/index.ts",
          name: "createRunner",
          kind: "function",
          line: 4,
          level: 0,
        }),
      ]));
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("searches TypeScript symbols across workspace project files", async () => {
    const workspace = await makeTempDir("search-symbols-tools-");
    try {
      await fs.writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            strict: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        }),
        "utf8",
      );
      await fs.mkdir(path.join(workspace, "src", "nested"), { recursive: true });
      await fs.mkdir(path.join(workspace, "docs", "external-references"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "src", "alpha.ts"),
        [
          "export class AlphaRunner {",
          "  runAlpha(): void {}",
          "}",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "src", "nested", "beta.ts"),
        [
          "export function betaRunner(): void {}",
          "export const betaValue = 1;",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "docs", "external-references", "ignored.ts"),
        "export function betaReference(): void {}\n",
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-search-symbols",
          name: "search_symbols",
          arguments: { query: "runner", max_results: 10 },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as {
        query: string;
        path: string;
        fileCount: number;
        symbolCount: number;
        truncated: boolean;
        symbols: Array<{
          path: string;
          name: string;
          kind: string;
          level: number;
        }>;
      };

      expect(parsed.query).toBe("runner");
      expect(parsed.path).toBe(".");
      expect(parsed.fileCount).toBe(2);
      expect(parsed.truncated).toBe(false);
      expect(parsed.symbolCount).toBe(2);
      expect(parsed.symbols).toEqual([
        expect.objectContaining({
          path: "src/alpha.ts",
          name: "AlphaRunner",
          kind: "class",
          level: 0,
        }),
        expect.objectContaining({
          path: "src/nested/beta.ts",
          name: "betaRunner",
          kind: "function",
          level: 0,
        }),
      ]);
      expect(parsed.symbols.some((symbol) => symbol.path.includes("external-references"))).toBe(false);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("bounds project symbol search by directory and result limit", async () => {
    const workspace = await makeTempDir("search-symbols-tools-bounds-");
    try {
      await fs.mkdir(path.join(workspace, "src", "a"), { recursive: true });
      await fs.mkdir(path.join(workspace, "src", "b"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "src", "a", "one.ts"),
        "export function oneSymbol(): void {}\nexport function twoSymbol(): void {}\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "src", "b", "three.ts"),
        "export function threeSymbol(): void {}\n",
        "utf8",
      );
      const registry = new InMemoryToolRegistry(createCommandTools());

      const result = await registry.execute(
        {
          id: "call-search-symbols-bounds",
          name: "search_symbols",
          arguments: { path: "src/a", max_results: 1 },
        },
        { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const },
      );
      const parsed = JSON.parse(result.content) as {
        fileCount: number;
        symbolCount: number;
        truncated: boolean;
        symbols: Array<{ path: string; name: string }>;
      };

      expect(parsed.fileCount).toBe(1);
      expect(parsed.symbolCount).toBe(1);
      expect(parsed.truncated).toBe(true);
      expect(parsed.symbols).toEqual([
        expect.objectContaining({ path: "src/a/one.ts", name: "oneSymbol" }),
      ]);
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("guards search_symbols paths and UTF-8 decoding", async () => {
    const workspace = await makeTempDir("search-symbols-tools-guard-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "file.ts"), "export const value = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          {
            id: "call-search-symbols-escape",
            name: "search_symbols",
            arguments: { path: "../outside" },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside");

      await expect(
        registry.execute(
          {
            id: "call-search-symbols-invalid-limit",
            name: "search_symbols",
            arguments: { max_results: 1.5 },
          },
          context,
        ),
      ).rejects.toThrow("max_results must be an integer between 1 and 1000.");

      await fs.writeFile(path.join(workspace, "src", "invalid.ts"), Buffer.from([0xff, 0xfe]));
      await expect(
        registry.execute(
          {
            id: "call-search-symbols-invalid-utf8",
            name: "search_symbols",
            arguments: { path: "src" },
          },
          context,
        ),
      ).rejects.toThrow("search_symbols path is not valid UTF-8: src/invalid.ts");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("guards list_symbols paths and UTF-8 decoding", async () => {
    const workspace = await makeTempDir("list-symbols-tools-guard-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "file.ts"), "export const value = 1;\n", "utf8");
      const registry = new InMemoryToolRegistry(createCommandTools());
      const context = { threadId: "thread-1", turnId: "turn-1", workspace, sandboxMode: "danger-full-access" as const };

      await expect(
        registry.execute(
          {
            id: "call-list-symbols-escape",
            name: "list_symbols",
            arguments: { path: "../outside.ts" },
          },
          context,
        ),
      ).rejects.toThrow("Path escapes workspace: ../outside.ts");

      await expect(
        registry.execute(
          {
            id: "call-list-symbols-directory",
            name: "list_symbols",
            arguments: { path: "src" },
          },
          context,
        ),
      ).rejects.toThrow("list_symbols path is not a file: src");

      await fs.writeFile(path.join(workspace, "src", "invalid.ts"), Buffer.from([0xff, 0xfe]));
      await expect(
        registry.execute(
          {
            id: "call-list-symbols-invalid-utf8",
            name: "list_symbols",
            arguments: { path: "src/invalid.ts" },
          },
          context,
        ),
      ).rejects.toThrow("list_symbols path is not valid UTF-8: src/invalid.ts");
    } finally {
      await removeTempDir(workspace);
    }
  });
});

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
