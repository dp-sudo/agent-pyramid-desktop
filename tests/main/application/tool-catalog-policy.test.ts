import { describe, expect, it } from "vitest";
import {
  ToolCatalogService,
  createToolAccessPolicy,
} from "../../../src/main/application/tool-catalog";
import { ToolPolicyService } from "../../../src/main/application/tool-policy";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import type { AgentTool, AgentToolCall } from "../../../src/main/domain/agent/types";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  type RuntimePreferences,
  type ThreadRecord,
  type TurnRecord,
} from "../../../src/shared/agent-contracts";

function createTool(
  name: string,
  metadata: AgentTool["metadata"] = {},
): AgentTool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      inputSchema: { type: "object" },
    },
    metadata,
    async execute() {
      return "ok";
    },
  };
}

function createThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: "Thread",
    workspace: "/workspace",
    mode: "code",
    status: "active",
    relation: "primary",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    ...overrides,
  };
}

function createTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "in-flight",
    startedAt: "2026-01-01T00:00:00.000Z",
    model: "test-model",
    mode: "agent",
    ...overrides,
  };
}

function createCall(name: string, args: Record<string, unknown> = {}): AgentToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

function toolNames(service: ToolCatalogService, turn: TurnRecord, thread: ThreadRecord): string[] {
  return service
    .listDefinitionsForTurn(turn, thread, DEFAULT_RUNTIME_PREFERENCES)
    .map((definition) => definition.name)
    .sort();
}

describe("ToolCatalogService", () => {
  it("filters tools by mode, plan, goal, MCP namespace, and runtime availability", () => {
    const registry = new InMemoryToolRegistry([
      createTool("read_file", { isReadOnly: true }),
      createTool("write_file", { isDestructive: true }),
      createTool("create_plan", { isReadOnly: true }),
      createTool("update_goal", { isReadOnly: true }),
      createTool("mcp__local__echo", { isDestructive: true }),
    ]);
    const service = new ToolCatalogService({ registry });

    expect(toolNames(service, createTurn(), createThread({ mode: "code" }))).toEqual([
      "mcp__local__echo",
      "read_file",
      "write_file",
    ]);
    expect(toolNames(service, createTurn(), createThread({ mode: "write" }))).toEqual([
      "read_file",
    ]);
    expect(toolNames(service, createTurn({ mode: "plan" }), createThread({ mode: "code" }))).toContain(
      "create_plan",
    );
    expect(toolNames(
      service,
      createTurn(),
      createThread({
        mode: "code",
        goal: {
          text: "Finish",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    )).toContain("update_goal");
  });

  it("applies injected access policy before persisted runtime availability", () => {
    const registry = new InMemoryToolRegistry([
      createTool("run_command", { isDestructive: true }),
      createTool("read_file", { isReadOnly: true }),
    ]);
    const service = new ToolCatalogService({
      registry,
      toolAccessPolicy: createToolAccessPolicy({
        allowByMode: { code: ["run_command"] },
        denyByMode: { code: ["read_file"] },
      }),
    });
    const preferences: RuntimePreferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      toolAvailability: {
        ...DEFAULT_RUNTIME_PREFERENCES.toolAvailability,
        code: {
          ...DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code,
          run_command: false,
        },
      },
    };

    expect(service.listDefinitionsForTurn(
      createTurn(),
      createThread({ mode: "code" }),
      preferences,
    ).map((definition) => definition.name)).toEqual(["run_command"]);
  });
});

describe("ToolPolicyService", () => {
  it("resolves read-only, hard-deny, permission-rule, auto, and default approval decisions", () => {
    const registry = new InMemoryToolRegistry([
      createTool("read_file", { isReadOnly: true }),
      createTool("create_plan", { isDestructive: true }),
      createTool("run_command", { isDestructive: true }),
      createTool("preview", { isDestructive: false }),
      createTool("write_file", { isDestructive: true }),
    ]);
    const service = new ToolPolicyService(registry);
    const turn = createTurn();
    const thread = createThread();

    expect(service.resolve({
      call: createCall("read_file"),
      turn,
      thread,
      runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
      isToolAvailable: true,
    })).toBe("allow");
    expect(service.resolve({
      call: createCall("create_plan"),
      turn,
      thread,
      runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
      isToolAvailable: true,
    })).toBe("allow");
    expect(service.resolve({
      call: createCall("write_file", { path: "src/index.ts" }),
      turn,
      thread: createThread({ sandboxMode: "read-only" }),
      runtimePreferences: {
        ...DEFAULT_RUNTIME_PREFERENCES,
        permissionRules: [
          { id: "allow-write", tool: "write", pattern: "src/*", effect: "allow" },
        ],
      },
      isToolAvailable: true,
    })).toBe("deny");
    expect(service.resolve({
      call: createCall("run_command", { command: "npm test" }),
      turn,
      thread,
      runtimePreferences: {
        ...DEFAULT_RUNTIME_PREFERENCES,
        permissionRules: [
          { id: "allow-tests", tool: "command", pattern: "npm:*", effect: "allow" },
        ],
      },
      isToolAvailable: true,
    })).toBe("allow");
    expect(service.resolve({
      call: createCall("preview"),
      turn,
      thread: createThread({ approvalPolicy: "auto" }),
      runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
      isToolAvailable: true,
    })).toBe("allow");
    expect(service.resolve({
      call: createCall("write_file", { path: "src/index.ts" }),
      turn,
      thread,
      runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
      isToolAvailable: true,
    })).toBe("ask");
  });
});
