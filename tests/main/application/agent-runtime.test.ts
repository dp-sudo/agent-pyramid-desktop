import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRuntime,
  COMMAND_TOOL_NAMES,
  CODE_ONLY_TOOL_NAMES,
  createToolAccessPolicy,
  isCodeOnlyToolName,
  type ToolAccessPolicy,
} from "../../../src/main/application/agent-runtime";
import { createCommandTools } from "../../../src/main/application/tools/command-tools";
import { createCodingTools } from "../../../src/main/application/tools/coding-tools";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { createSkillTools } from "../../../src/main/application/tools/skill-tools";
import { createWorkspaceTools } from "../../../src/main/application/tools/workspace-tools";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import { SkillService } from "../../../src/main/skills/skill-service";
import type {
  AgentTool,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
} from "../../../src/main/domain/agent/types";
import { AttachmentStore } from "../../../src/main/persistence/attachment-store";
import { CheckpointStore } from "../../../src/main/persistence/checkpoint-store";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import { ModelConfigStore } from "../../../src/main/persistence/model-config-store";
import { RuntimePreferencesStore } from "../../../src/main/persistence/runtime-preferences-store";
import { LlmWorkerError, type LlmWorkerPool } from "../../../src/main/infrastructure/llm-worker/worker-pool";
import type {
  ApprovalRespondRequest,
  Item,
  RuntimeEvent,
} from "../../../src/shared/agent-contracts";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_PREFERENCES,
  RUNTIME_TOOL_NAMES,
} from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function nodeCommand(script: string): string {
  if (process.platform === "win32") {
    const encoded = Buffer.from(script, "utf8").toString("base64");
    return `node -e eval^(Buffer.from^('${encoded}','base64'^).toString^(^)^)`;
  }
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

class FakePool {
  readonly requests: LlmRequest[] = [];
  readonly canceledThreads: string[] = [];
  private readonly defaultResponse: LlmResponse = {
    text: "Assistant final",
    reasoning: "Reasoning final",
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    raw: {},
  };
  response: LlmResponse = this.defaultResponse;
  responses: LlmResponse[] = [];
  chunks: LlmStreamChunk[] = [];
  error: Error | null = null;
  delayMs = 0;
  rejectCanceledThreads = false;
  activeChats = 0;

  async chat(
    thread: { id: string },
    request: LlmRequest,
    onChunk: (chunk: LlmStreamChunk) => void,
  ): Promise<LlmResponse> {
    this.activeChats += 1;
    try {
      this.requests.push(request);
      for (const chunk of this.chunks) {
        onChunk(chunk);
      }
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.rejectCanceledThreads && this.canceledThreads.includes(thread.id)) {
        throw new Error("aborted by cancel");
      }
      if (this.error) {
        throw this.error;
      }
      return this.responses.shift() ?? this.response;
    } finally {
      this.activeChats -= 1;
    }
  }

  cancel(threadId: string): void {
    this.canceledThreads.push(threadId);
  }
}

function finalItems<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

async function waitFor(
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

function expectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

type ToolTimelineItem = Extract<Item, { kind: "tool" }>;

function isToolItemNamed(name: string): (item: Item) => item is ToolTimelineItem {
  return (item): item is ToolTimelineItem => item.kind === "tool" && item.name === name;
}

function expectProtocolValidToolHistory(messages: LlmRequest["messages"]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
      throw new Error(`Unexpected orphan tool result at message ${index}: ${message.toolCallId ?? ""}`);
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    const expectedIds = message.toolCalls.map((call) => call.id);
    const seenIds: string[] = [];
    for (const expectedId of expectedIds) {
      const next = messages[index + 1 + seenIds.length];
      expect(next).toMatchObject({
        role: "tool",
        toolCallId: expectedId,
      });
      if (next?.role !== "tool" || next.toolCallId !== expectedId) {
        throw new Error(`Missing matching tool result for ${expectedId}.`);
      }
      seenIds.push(expectedId);
    }
    index += seenIds.length;
  }
}

function createFakeRunCommandTool(): AgentTool {
  return {
    definition: {
      name: "run_command",
      description: "Fake command tool",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
    metadata: { isDestructive: true, category: "command" },
    async execute(input) {
      return {
        toolCallId: "fake-command",
        name: "run_command",
        content: `ran ${String(input.command)}`,
      };
    },
  };
}

describe("AgentRuntime", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;
  let attachmentStore: AttachmentStore;
  let checkpointStore: CheckpointStore;
  let modelConfigStore: ModelConfigStore;
  let runtimePreferencesStore: RuntimePreferencesStore;
  let bus: RuntimeEventBus;
  let fakePool: FakePool;
  let events: RuntimeEvent[];
  let previousMaxToolRounds: string | undefined;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-runtime-");
    store = new JsonlThreadStore(userDataDir);
    attachmentStore = new AttachmentStore(userDataDir);
    checkpointStore = new CheckpointStore(userDataDir);
    modelConfigStore = new ModelConfigStore(userDataDir);
    runtimePreferencesStore = new RuntimePreferencesStore(userDataDir);
    bus = new RuntimeEventBus();
    fakePool = new FakePool();
    events = [];
    previousMaxToolRounds = process.env.AGENT_MAX_TOOL_ROUNDS;
    delete process.env.AGENT_MAX_TOOL_ROUNDS;
    for (const kind of [
      "turn_started",
      "turn_completed",
      "turn_failed",
      "item_appended",
      "item_updated",
      "approval_requested",
      "tool_progress",
      "tool_budget_reached",
      "goal_updated",
      "runtime_error",
    ] as const) {
      bus.on(kind, (event) => events.push(event));
    }
  });

  afterEach(async () => {
    if (previousMaxToolRounds === undefined) {
      delete process.env.AGENT_MAX_TOOL_ROUNDS;
    } else {
      process.env.AGENT_MAX_TOOL_ROUNDS = previousMaxToolRounds;
    }
    await removeTempDir(userDataDir);
  });

  function createRuntime(
    registry = new InMemoryToolRegistry([]),
    toolAccessPolicy?: ToolAccessPolicy,
    skillService?: SkillService,
  ): AgentRuntime {
    return new AgentRuntime({
      store,
      attachmentStore,
      checkpointStore,
      modelConfigStore,
      runtimePreferencesStore,
      pool: fakePool as unknown as LlmWorkerPool,
      bus,
      registry,
      ...(skillService ? { skillService } : {}),
      ...(toolAccessPolicy ? { toolAccessPolicy } : {}),
    });
  }

  async function collectThreadItems(threadId: string): Promise<Item[]> {
    const items: Item[] = [];
    for await (const item of store.replayItems(threadId)) {
      items.push(item);
    }
    return items;
  }

  async function writeWorkspaceSkill(
    workspace: string,
    relativeDir: string,
    input: {
      frontmatter: string[];
      body: string;
    },
  ): Promise<void> {
    const root = path.join(workspace, relativeDir);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "SKILL.md"),
      ["---", ...input.frontmatter, "---", "", input.body].join("\n"),
      "utf8",
    );
  }

  it("starts a turn, streams live items, persists final items, and completes", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.chunks = [
      { kind: "reasoning_delta", text: "Think" },
      { kind: "text_delta", text: "Hello" },
      { kind: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    ];
    fakePool.response = {
      text: "",
      reasoning: "",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      raw: {},
    };

    const runtime = createRuntime();
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Run",
    });

    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(turn.model).toBe(DEFAULT_MODEL_CONFIG.model);
    expect(fakePool.requests[0]).toMatchObject({
      model: DEFAULT_MODEL_CONFIG.model,
      provider: DEFAULT_MODEL_CONFIG.model_provide,
      messages: expect.arrayContaining([{ role: "user", content: "Run" }]),
      tools: [],
    });
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "item_appended",
        "turn_started",
        "item_updated",
        "turn_completed",
      ]),
    );
    expect(events.find((event) => event.kind === "turn_started")).toMatchObject({
      kind: "turn_started",
      turn: {
        id: turn.id,
        threadId: thread.id,
        model: DEFAULT_MODEL_CONFIG.model,
        modelProfileId: "default",
        mode: "agent",
      },
    });

    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed.map((item) => item.kind)).toEqual(["user", "reasoning", "assistant"]);
    expect(replayed.at(-1)).toMatchObject({ kind: "assistant", text: "Hello" });
  });

  it("records the model-visible tool catalog snapshot on turn start", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "zeta",
          description: "Zeta tool",
          inputSchema: { type: "object" },
        },
        async execute() {
          return "zeta";
        },
      },
      {
        definition: {
          name: "alpha",
          description: "Alpha tool",
          inputSchema: { type: "object" },
        },
        async execute() {
          return "alpha";
        },
      },
    ]);

    const runtime = createRuntime(registry);
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Run",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(turn.toolCatalog).toEqual({
      fingerprint: expect.any(String),
      toolCount: 2,
      toolNames: ["alpha", "zeta"],
    });
    expect(events.find((event) => event.kind === "turn_started")).toMatchObject({
      kind: "turn_started",
      turn: {
        toolCatalog: turn.toolCatalog,
      },
    });
  });

  it("uses Code and Write default model profiles when no explicit profile is supplied", async () => {
    const codeThread = await store.createThread({
      title: "Code Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const writeThread = await store.createThread({
      title: "Write Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    const codeProfiles = await modelConfigStore.createProfile({
      name: "Code Model",
      config: {
        model_provide: "CodeProvider",
        model: "code-model",
      },
    });
    const codeProfile = codeProfiles.profiles.find((profile) => profile.name === "Code Model");
    if (!codeProfile) throw new Error("Expected Code Model profile.");
    const writeProfiles = await modelConfigStore.createProfile({
      name: "Write Model",
      config: {
        model_provide: "WriteProvider",
        model: "write-model",
      },
    });
    const writeProfile = writeProfiles.profiles.find((profile) => profile.name === "Write Model");
    if (!writeProfile) throw new Error("Expected Write Model profile.");
    await runtimePreferencesStore.update({
      codeDefaultModelProfileId: codeProfile.id,
      writeDefaultModelProfileId: writeProfile.id,
    });

    const runtime = createRuntime();
    const codeTurn = await runtime.startTurn({
      threadId: codeThread.id,
      text: "Code request",
    });
    const writeTurn = await runtime.startTurn({
      threadId: writeThread.id,
      text: "Write request",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(writeThread.id));

    expect(codeTurn).toMatchObject({
      model: "code-model",
      modelProfileId: codeProfile.id,
    });
    expect(writeTurn).toMatchObject({
      model: "write-model",
      modelProfileId: writeProfile.id,
    });
    expect(fakePool.requests.map((request) => request.model)).toEqual([
      "code-model",
      "write-model",
    ]);
  });

  it("forwards the selected model profile protocol to the LLM request", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const profiles = await modelConfigStore.createProfile({
      name: "Anthropic",
      activate: true,
      config: {
        model_provide: "AnthropicProvider",
        model: "claude-test",
        protocol: "anthropic-compatible",
      },
    });
    const profile = profiles.profiles.find((item) => item.name === "Anthropic");
    if (!profile) throw new Error("Expected Anthropic profile.");

    const runtime = createRuntime();
    await runtime.startTurn({
      threadId: thread.id,
      text: "Run",
      modelProfileId: profile.id,
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    expect(fakePool.requests[0]).toMatchObject({
      provider: "AnthropicProvider",
      model: "claude-test",
      protocol: "anthropic-compatible",
    });
  });

  it("uses the explicitly selected model profile and includes attachment content", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const profiles = await modelConfigStore.createProfile({
      name: "Agnes",
      activate: true,
      config: {
        model_provide: "Agnes",
        model: "agnes-2.0-flash",
        base_url: "https://provider.example.test/v1",
        OPENAI_API_KEY: "",
        model_context_window: 1000,
        model_auto_compact_token_limit: 900,
        max_tokens: 200,
        thinking: true,
        model_reasoning_effort: "high",
      },
    });
    const profile = profiles.profiles.find((item) => item.name === "Agnes");
    if (!profile) throw new Error("Expected Agnes profile.");
    const attachment = await attachmentStore.create({
      name: "image.png",
      mimeType: "image/png",
      dataBase64: IMAGE_BASE64,
    });

    const runtime = createRuntime();
    await runtime.startTurn({
      threadId: thread.id,
      text: "Describe image",
      modelProfileId: profile.id,
      attachmentIds: [attachment.id],
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    const request = fakePool.requests[0];
    expect(request).toMatchObject({
      provider: "Agnes",
      model: "agnes-2.0-flash",
      baseUrl: "https://provider.example.test/v1",
      maxTokens: 200,
      reasoningEffort: "high",
    });
    expect(request.messages.at(-1)?.content).toEqual([
      { type: "text", text: "Describe image" },
      { type: "image", mimeType: "image/png", dataBase64: IMAGE_BASE64 },
    ]);
  });

  it("rejects concurrent turns for the same thread before appending another user item", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 50;
    const runtime = createRuntime();

    await runtime.startTurn({
      threadId: thread.id,
      text: "First",
    });

    await expect(
      runtime.startTurn({
        threadId: thread.id,
        text: "Second",
      }),
    ).rejects.toThrow("RUNTIME_TURN_BUSY");

    await waitFor(() => !runtime.isThreadInFlight(thread.id));
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed.filter((item) => item.kind === "user").map((item) => item.text))
      .toEqual(["First"]);
  });

  it("reserves the thread while a turn is being prepared", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 50;
    const runtime = createRuntime();

    const firstStart = runtime.startTurn({
      threadId: thread.id,
      text: "First",
    });
    const secondStart = runtime.startTurn({
      threadId: thread.id,
      text: "Second",
    });

    await expect(secondStart).rejects.toThrow("RUNTIME_TURN_BUSY");
    const firstTurn = await firstStart;
    expect(firstTurn.threadId).toBe(thread.id);
    await waitFor(() => !runtime.isThreadInFlight(thread.id));

    const replayed = await collectThreadItems(thread.id);
    expect(replayed.filter((item) => item.kind === "user").map((item) => item.text))
      .toEqual(["First"]);
  });

  it("emits turn_failed when the worker chat fails before completion", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.error = new Error("worker connection lost");
    const runtime = createRuntime();

    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Run",
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.kind === "turn_completed" &&
          event.turnId === turn.id &&
          event.status === "failed",
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "internal",
          message: "worker connection lost",
        }),
        expect.objectContaining({
          kind: "turn_failed",
          turnId: turn.id,
          message: "worker connection lost",
        }),
        expect.objectContaining({
          kind: "turn_completed",
          turnId: turn.id,
          status: "failed",
        }),
      ]),
    );
    const persistedEvents: RuntimeEvent[] = [];
    for await (const event of store.replayEvents(thread.id)) {
      persistedEvents.push(event);
    }
    expect(persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn_failed",
          turnId: turn.id,
          message: "worker connection lost",
        }),
        expect.objectContaining({
          kind: "turn_completed",
          turnId: turn.id,
          status: "failed",
        }),
      ]),
    );
    expect(runtime.isThreadInFlight(thread.id)).toBe(false);
  });

  it("maps typed worker failures to specific runtime error codes", async () => {
    const runtime = createRuntime();
    const schemaThread = await store.createThread({
      title: "Schema Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.error = new LlmWorkerError("bad provider frame", "schema");

    await runtime.startTurn({
      threadId: schemaThread.id,
      text: "Run schema",
    });
    await waitFor(() => !runtime.isThreadInFlight(schemaThread.id));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          threadId: schemaThread.id,
          code: "schema_invalid",
          message: "bad provider frame",
        }),
      ]),
    );

    const httpThread = await store.createThread({
      title: "HTTP Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.error = new LlmWorkerError("LLM stream failed with HTTP 429", "http");

    await runtime.startTurn({
      threadId: httpThread.id,
      text: "Run HTTP",
    });
    await waitFor(() => !runtime.isThreadInFlight(httpThread.id));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          threadId: httpThread.id,
          code: "provider_http",
          message: "LLM stream failed with HTTP 429",
        }),
      ]),
    );

    const providerEventThread = await store.createThread({
      title: "Provider Event Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.error = new LlmWorkerError(
      "LLM stream error event: rate_limit_error: rate limited",
      "provider",
    );

    await runtime.startTurn({
      threadId: providerEventThread.id,
      text: "Run provider event",
    });
    await waitFor(() => !runtime.isThreadInFlight(providerEventThread.id));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          threadId: providerEventThread.id,
          code: "provider_error",
          message: "LLM stream error event: rate_limit_error: rate limited",
        }),
      ]),
    );
  });

  it("persists truncated streamed output when the worker fails after deltas", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.chunks = [{ kind: "text_delta", text: "Partial before failure" }];
    fakePool.error = new Error("worker connection lost");
    const runtime = createRuntime();

    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Run",
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.kind === "turn_completed" &&
          event.turnId === turn.id &&
          event.status === "failed",
      ),
    );

    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assistant",
          text: "Partial before failure",
          truncated: true,
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn_failed",
          turnId: turn.id,
          message: "worker connection lost",
        }),
        expect.objectContaining({
          kind: "turn_completed",
          turnId: turn.id,
          status: "failed",
        }),
      ]),
    );
  });

  it("clears in-flight state when appending the initial user item fails", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime();
    const appendItem = vi.spyOn(store, "appendItem");
    appendItem.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      runtime.startTurn({
        threadId: thread.id,
        text: "First",
      }),
    ).rejects.toThrow("disk full");

    expect(runtime.isThreadInFlight(thread.id)).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "persistence_error",
          message: "disk full",
        }),
        expect.objectContaining({
          kind: "turn_failed",
          message: "disk full",
        }),
      ]),
    );
    const persistedEvents: RuntimeEvent[] = [];
    for await (const event of store.replayEvents(thread.id)) {
      persistedEvents.push(event);
    }
    expect(persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn_failed",
          message: "disk full",
        }),
      ]),
    );

    await runtime.startTurn({
      threadId: thread.id,
      text: "Second",
    });
    await waitFor(() => !runtime.isThreadInFlight(thread.id));
    appendItem.mockRestore();
  });

  it("fails fast for missing model profiles before appending user items", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });

    await expect(
      createRuntime().startTurn({
        threadId: thread.id,
        text: "Run",
        modelProfileId: "missing",
      }),
    ).rejects.toThrow("Model config profile missing not found.");

    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed).toEqual([]);
  });

  it("guides model tool choice away from shell probing during workspace inspection", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });

    await createRuntime().startTurn({
      threadId: thread.id,
      text: "Inspect the repo.",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].systemPrompt).toContain(
      "prefer list_files, read_file, search_files, and rg_search before shell commands",
    );
    expect(fakePool.requests[0].systemPrompt).toContain(
      "On Windows, run_command uses cmd.exe syntax by default",
    );
    expect(fakePool.requests[0].systemPrompt).toContain("detect_shell_environment");
  });

  it("exposes create_plan only in plan mode and appends a plan item without approval", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-1",
            name: "create_plan",
            arguments: {
              title: "Test plan",
              steps: [{ title: "Write tests", status: "completed" }],
            },
          },
        ],
        raw: {},
      },
      {
        text: "Plan created.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(new InMemoryToolRegistry([createPlanTool])).startTurn({
      threadId: thread.id,
      text: "Plan",
      mode: "plan",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["create_plan"]);
    expect(fakePool.requests[0].systemPrompt).not.toContain("Plan mode is active.");
    expect(fakePool.requests[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Plan mode is active."),
    });
    const firstContextIndex = fakePool.requests[0].messages.findIndex(
      (message) => message.role === "system" && String(message.content).includes("Plan mode is active."),
    );
    const secondContextIndexes = fakePool.requests[1].messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === "system" && String(message.content).includes("Plan mode is active."))
      .map(({ index }) => index);
    expect(secondContextIndexes).toEqual([firstContextIndex]);
    expect(fakePool.requests[1].messages.at(firstContextIndex)).toMatchObject({
      role: "system",
      content: expect.stringContaining("Plan mode is active."),
    });
    expect(fakePool.requests[1].messages.slice(0, fakePool.requests[0].messages.length)).toEqual(
      fakePool.requests[0].messages,
    );
    expect(fakePool.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ name: "create_plan" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call-1" }),
      ]),
    );
    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);

    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const final = finalItems(replayed);
    expect(final.map((item) => item.kind)).toContain("plan");
    expect(final.find((item) => item.kind === "plan")).toMatchObject({
      title: "Test plan",
      steps: [expect.objectContaining({ title: "Write tests", status: "completed" })],
    });
  });

  it("appends a visible edit plan from create_edit_plan without approval", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry(createCodingTools());
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-edit-plan",
            name: "create_edit_plan",
            arguments: {
              title: "Coordinate runtime changes",
              files: [
                { path: "src/main/application/agent-runtime.ts", action: "update" },
                { path: "tests/main/application/agent-runtime.test.ts", action: "update" },
              ],
              steps: [
                { title: "Update runtime boundary", status: "pending" },
                { title: "Cover runtime behavior", status: "pending" },
              ],
              verification: ["npm test -- tests/main/application/agent-runtime.test.ts"],
            },
          },
        ],
        raw: {},
      },
      {
        text: "Plan ready.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Plan multi-file edit",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    const final = finalItems(await collectThreadItems(thread.id));
    expect(final).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          name: "create_edit_plan",
          status: "completed",
          result: expect.objectContaining({
            files: [
              expect.objectContaining({ path: "src/main/application/agent-runtime.ts" }),
              expect.objectContaining({ path: "tests/main/application/agent-runtime.test.ts" }),
            ],
          }),
        }),
        expect.objectContaining({
          kind: "plan",
          title: "Coordinate runtime changes",
          steps: [
            expect.objectContaining({ title: "Update runtime boundary", status: "pending" }),
            expect.objectContaining({ title: "Cover runtime behavior", status: "pending" }),
          ],
        }),
      ]),
    );
  });

  it("injects matched project skills as dynamic system context", async () => {
    const workspace = path.join(userDataDir, "workspace");
    await writeWorkspaceSkill(workspace, ".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Follow the example skill.",
        "keywords: example skill",
      ],
      body: "Use the example skill instructions.",
    });
    const thread = await store.createThread({
      title: "Skills Runtime",
      workspace,
      mode: "code",
    });
    const skillService = new SkillService();
    const registry = new InMemoryToolRegistry(createSkillTools({ skillService }));

    await createRuntime(registry, undefined, skillService).startTurn({
      threadId: thread.id,
      text: "Please use the example skill.",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].systemPrompt).not.toContain("Active Skill");
    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toContain("run_skill");
    expect(fakePool.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Active Skill: Example Skill (example-skill)"),
        }),
      ]),
    );
  });

  it("runs run_skill without approval and feeds the result back into the tool loop", async () => {
    const workspace = path.join(userDataDir, "workspace");
    await writeWorkspaceSkill(workspace, ".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Follow the example skill.",
      ],
      body: "Use the example skill instructions.",
    });
    const thread = await store.createThread({
      title: "Skills Runtime",
      workspace,
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-skill",
            name: "run_skill",
            arguments: { skillId: "example-skill" },
          },
        ],
        raw: {},
      },
      {
        text: "Skill used.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];
    const skillService = new SkillService();
    const registry = new InMemoryToolRegistry(createSkillTools({ skillService }));

    await createRuntime(registry, undefined, skillService).startTurn({
      threadId: thread.id,
      text: "Run $example-skill.",
    });
    await waitFor(() => fakePool.requests.length === 2 && !events.some((event) => event.kind === "approval_requested"));
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(fakePool.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-skill",
          content: expect.stringContaining("Use the example skill instructions."),
        }),
      ]),
    );
  });

  it("runs subagent skills in an isolated child model loop and returns only the final answer", async () => {
    const workspace = path.join(userDataDir, "workspace");
    await writeWorkspaceSkill(workspace, ".agent/skills/review-skill", {
      frontmatter: [
        "id: review-skill",
        "name: Review Skill",
        "description: Review in isolation.",
        "runAs: subagent",
        "model: skill-model",
        "effort: high",
      ],
      body: "Only return a distilled review.",
    });
    const thread = await store.createThread({
      title: "Skills Runtime",
      workspace,
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-skill",
            name: "run_skill",
            arguments: { skillId: "review-skill", arguments: "Review src/app.ts" },
          },
        ],
        raw: {},
      },
      {
        text: "Subagent found one issue.",
        reasoning: "private child reasoning",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Parent final.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];
    const skillService = new SkillService();
    const registry = new InMemoryToolRegistry(createSkillTools({ skillService }));

    await createRuntime(registry, undefined, skillService).startTurn({
      threadId: thread.id,
      text: "Run $review-skill.",
    });
    await waitFor(() => fakePool.requests.length === 3);
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[1].model).toBe("skill-model");
    expect(fakePool.requests[1].reasoningEffort).toBe("high");
    expect(fakePool.requests[1].systemPrompt).toContain("Only return a distilled review.");
    expect(fakePool.requests[1].messages).toEqual([
      { role: "user", content: "Review src/app.ts" },
    ]);
    expect(fakePool.requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-skill",
          content: expect.stringContaining("Subagent found one issue."),
        }),
      ]),
    );

    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const toolItems = finalItems(replayed).filter((item): item is Extract<Item, { kind: "tool" }> =>
      item.kind === "tool"
    );
    expect(toolItems.map((item) => item.name)).toEqual(["run_skill"]);
    expect(toolItems[0]?.result).toMatchObject({
      isolated: true,
      content: "Subagent found one issue.",
    });
  });

  it("runs built-in subagent skills when no workspace skill is present", async () => {
    const workspace = path.join(userDataDir, "workspace");
    const thread = await store.createThread({
      title: "Built-in Skills Runtime",
      workspace,
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-skill",
            name: "run_skill",
            arguments: { skillId: "review", arguments: "Review the current change." },
          },
        ],
        raw: {},
      },
      {
        text: "Built-in review result.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Parent final.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];
    const skillService = new SkillService();
    const registry = new InMemoryToolRegistry(createSkillTools({ skillService }));

    await createRuntime(registry, undefined, skillService).startTurn({
      threadId: thread.id,
      text: "/review",
    });
    await waitFor(() => fakePool.requests.length === 3);
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Active Skill: Review (review)"),
        }),
      ]),
    );
    expect(fakePool.requests[1].systemPrompt).toContain("isolated code-review subagent");
    expect(fakePool.requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-skill",
          content: expect.stringContaining("Built-in review result."),
        }),
      ]),
    );
  });

  it("limits subagent skill tools to allowed read-only tools without persisting child tool calls", async () => {
    const workspace = path.join(userDataDir, "workspace");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "app.ts"), "export const value = 1;\n", "utf8");
    await writeWorkspaceSkill(workspace, ".agent/skills/review-skill", {
      frontmatter: [
        "id: review-skill",
        "name: Review Skill",
        "description: Review with tools.",
        "runAs: subagent",
        "allowed-tools: read_file, write_file",
      ],
      body: "Read files, then summarize.",
    });
    const thread = await store.createThread({
      title: "Skills Runtime",
      workspace,
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-skill",
            name: "run_skill",
            arguments: { skillId: "review-skill", arguments: "Review src/app.ts" },
          },
        ],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "child-read",
            name: "read_file",
            arguments: { path: "src/app.ts" },
          },
        ],
        raw: {},
      },
      {
        text: "Subagent reviewed the file.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Parent final.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];
    const skillService = new SkillService();
    const registry = new InMemoryToolRegistry([
      ...createSkillTools({ skillService }),
      ...createWorkspaceTools(),
      ...createCodingTools(),
    ]);

    await createRuntime(registry, undefined, skillService).startTurn({
      threadId: thread.id,
      text: "Run $review-skill.",
    });
    await waitFor(() => fakePool.requests.length === 4);
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[1].tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(fakePool.requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "child-read",
          content: expect.stringContaining("export const value = 1;"),
        }),
      ]),
    );
    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const toolItems = finalItems(replayed).filter((item): item is Extract<Item, { kind: "tool" }> =>
      item.kind === "tool"
    );
    expect(toolItems.map((item) => item.name)).toEqual(["run_skill"]);
  });

  it("surfaces invalid skill packages as runtime errors while continuing the turn", async () => {
    const workspace = path.join(userDataDir, "workspace");
    await writeWorkspaceSkill(workspace, ".agent/skills/bad-skill", {
      frontmatter: [
        "id: bad-skill",
        "name: Bad Skill",
        "description: Broken.",
        "priority: not-a-number",
      ],
      body: "Broken skill.",
    });
    const thread = await store.createThread({
      title: "Skills Runtime",
      workspace,
      mode: "code",
    });
    const skillService = new SkillService();

    await createRuntime(new InMemoryToolRegistry([]), undefined, skillService).startTurn({
      threadId: thread.id,
      text: "Run normally.",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "internal",
          message: expect.stringContaining("Skill load warning"),
        }),
      ]),
    );
  });

  it("keeps plan instructions next to the current user message when trimming history", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime(new InMemoryToolRegistry([createPlanTool]));

    await runtime.startTurn({
      threadId: thread.id,
      text: "x".repeat(4000),
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    await modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 12000,
      model_auto_compact_token_limit: 300,
      max_tokens: 1000,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });

    await runtime.startTurn({
      threadId: thread.id,
      text: "Plan",
      mode: "plan",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(thread.id));

    const messages = fakePool.requests[1].messages;
    const currentUserIndex = messages.findIndex(
      (message) => message.role === "user" && message.content === "Plan",
    );
    expect(currentUserIndex).toBeGreaterThan(0);
    expect(messages[currentUserIndex - 1]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Plan mode is active."),
    });
    expect(messages.some((message) => message.role === "user" && message.content === "x".repeat(4000))).toBe(false);
  });

  it("keeps the current user message when an extremely small budget requires fallback compaction", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 1000,
      model_auto_compact_token_limit: 80,
      max_tokens: 200,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });

    const oversizedCurrentInput = `CURRENT-${"x".repeat(10000)}`;
    const runtime = createRuntime();
    await runtime.startTurn({
      threadId: thread.id,
      text: oversizedCurrentInput,
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    const currentUserMessage = fakePool.requests[0].messages.find(
      (message) => message.role === "user",
    );
    expect(currentUserMessage).toMatchObject({
      role: "user",
      content: expect.stringContaining("[context budget: omitted oversized text]"),
    });
    expect(currentUserMessage?.content).not.toBe(oversizedCurrentInput);
  });

  it("uses reserved output tokens to limit the effective context budget", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime();
    const historicalInput = `HISTORY-${"x".repeat(1200)}`;

    await runtime.startTurn({
      threadId: thread.id,
      text: historicalInput,
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    await modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 1200,
      model_auto_compact_token_limit: 1000,
      max_tokens: 900,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });

    await runtime.startTurn({
      threadId: thread.id,
      text: "Continue",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(thread.id));

    const messages = fakePool.requests[1].messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Continue" }),
      ]),
    );
    expect(messages.some((message) => message.content === historicalInput)).toBe(false);
  });

  it("rejects model profiles whose max tokens meet or exceed the context window", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime();

    await expect(modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 300,
      model_auto_compact_token_limit: 300,
      max_tokens: 300,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    })).rejects.toThrow("max_tokens must be < model_context_window.");

    expect(runtime.isThreadInFlight(thread.id)).toBe(false);
  });

  it("executes read-only tools without approval and sends tool results into the follow-up request", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute(input, context) {
          expect(input).toEqual({ path: "src/main/index.ts" });
          expect(context).toMatchObject({
            threadId: thread.id,
            workspace: "/workspace",
          });
          return "file contents";
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "Need source.",
        toolCalls: [
          {
            id: "call-read",
            name: "read_file",
            arguments: { path: "src/main/index.ts" },
          },
        ],
        raw: {},
      },
      {
        text: "The file contains the entrypoint.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read the entrypoint",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(fakePool.requests).toHaveLength(2);
    expect(fakePool.requests[1].messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-read",
              name: "read_file",
              arguments: { path: "src/main/index.ts" },
            },
          ],
        },
        { role: "tool", content: "file contents", toolCallId: "call-read" },
      ]),
    );

    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const final = finalItems(replayed);
    expect(final).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "read_file", status: "completed" }),
        expect.objectContaining({ kind: "assistant", text: "The file contains the entrypoint." }),
      ]),
    );
  });

  it("executes all-read-only tool batches concurrently and preserves model result order", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const createReadTool = (name: string, delayMs: number): AgentTool => ({
      definition: {
        name,
        description: `Read ${name}`,
        inputSchema: { type: "object" },
      },
      metadata: { isReadOnly: true },
      async execute() {
        activeExecutions += 1;
        maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        activeExecutions -= 1;
        return `${name} result`;
      },
    });
    const registry = new InMemoryToolRegistry([
      createReadTool("read_a", 40),
      createReadTool("read_b", 5),
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          { id: "call-a", name: "read_a", arguments: {} },
          { id: "call-b", name: "read_b", arguments: {} },
        ],
        raw: {},
      },
      {
        text: "Done.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read both",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(maxActiveExecutions).toBe(2);
    expect(fakePool.requests[1].messages.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", content: "read_a result", toolCallId: "call-a" },
      { role: "tool", content: "read_b result", toolCallId: "call-b" },
    ]);
  });

  it("keeps mixed read and mutation tool batches sequential", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await store.updateThread(thread.id, { approvalPolicy: "auto" });
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const executionTrace: string[] = [];
    const createTool = (
      name: string,
      metadata: NonNullable<AgentTool["metadata"]>,
    ): AgentTool => ({
      definition: {
        name,
        description: `Tool ${name}`,
        inputSchema: { type: "object" },
      },
      metadata,
      async execute() {
        executionTrace.push(`${name}:start`);
        activeExecutions += 1;
        maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeExecutions -= 1;
        executionTrace.push(`${name}:end`);
        return `${name} result`;
      },
    });
    const registry = new InMemoryToolRegistry([
      createTool("read_context", { isReadOnly: true }),
      createTool("update_context", { isDestructive: false }),
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          { id: "call-read", name: "read_context", arguments: {} },
          { id: "call-update", name: "update_context", arguments: {} },
        ],
        raw: {},
      },
      {
        text: "Done.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read then update",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(maxActiveExecutions).toBe(1);
    expect(executionTrace).toEqual([
      "read_context:start",
      "read_context:end",
      "update_context:start",
      "update_context:end",
    ]);
  });

  it("suppresses the third identical read-only tool call in a turn", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const executeRead = vi.fn(async () => "read result");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_context",
          description: "Read context",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        execute: executeRead,
      },
    ]);
    const canonicalArgs = {
      path: "src/main/index.ts",
      range: { start: 1, end: 20 },
    };
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-1", name: "read_context", arguments: canonicalArgs }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-read-2",
            name: "read_context",
            arguments: { range: { end: 20, start: 1 }, path: "src/main/index.ts" },
          },
        ],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-3", name: "read_context", arguments: canonicalArgs }],
        raw: {},
      },
      {
        text: "Finished.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read the same context repeatedly",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executeRead).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(fakePool.requests).toHaveLength(4);
    const suppressedToolMessage = fakePool.requests[3].messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call-read-3",
    );
    expect(suppressedToolMessage?.content).toEqual(
      expect.stringContaining("repeat_read_only_tool_call"),
    );

    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const toolItems = finalItems(replayed).filter(isToolItemNamed("read_context"));
    expect(toolItems).toHaveLength(3);
    expect(toolItems[0]).toMatchObject({ status: "completed" });
    expect(toolItems[1]).toMatchObject({ status: "completed" });
    expect(toolItems[2]).toMatchObject({
      status: "failed",
      result: {
        code: "tool_repeat_suppressed",
        suppressed: true,
        reason: "repeat_read_only_tool_call",
        count: 3,
        threshold: 3,
      },
    });
  });

  it("does not suppress read-only tool calls when arguments differ", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const executeRead = vi.fn(async () => "read result");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_context",
          description: "Read context",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        execute: executeRead,
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-1", name: "read_context", arguments: { path: "a.ts" } }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-2", name: "read_context", arguments: { path: "b.ts" } }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [
          { id: "call-read-3", name: "read_context", arguments: { path: "a.ts", offset: 1 } },
        ],
        raw: {},
      },
      {
        text: "Finished.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read different context",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executeRead).toHaveBeenCalledTimes(3);
    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const toolItems = finalItems(replayed).filter(isToolItemNamed("read_context"));
    expect(toolItems).toHaveLength(3);
    expect(toolItems.every((item) => item.status === "completed")).toBe(true);
    expect(
      toolItems.some((item) =>
        Boolean(
          item.result &&
          typeof item.result === "object" &&
          "suppressed" in item.result,
        ),
      ),
    ).toBe(false);
  });

  it("clears read-only repeat counts after a turn completes", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const executeRead = vi.fn(async () => "read result");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_context",
          description: "Read context",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        execute: executeRead,
      },
    ]);
    const runtime = createRuntime(registry);
    const args = { path: "src/main/index.ts" };
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-1", name: "read_context", arguments: args }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-2", name: "read_context", arguments: args }],
        raw: {},
      },
      {
        text: "First turn done.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Read twice",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));
    expect(executeRead).toHaveBeenCalledTimes(2);

    events.length = 0;
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read-3", name: "read_context", arguments: args }],
        raw: {},
      },
      {
        text: "Second turn done.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Read again",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executeRead).toHaveBeenCalledTimes(3);
  });

  it("does not suppress repeated non-read-only tool calls", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await store.updateThread(thread.id, { approvalPolicy: "auto" });
    const executeTool = vi.fn(async () => "updated result");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "update_context",
          description: "Update context",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: false },
        execute: executeTool,
      },
    ]);
    const args = { path: "state.json" };
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-update-1", name: "update_context", arguments: args }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-update-2", name: "update_context", arguments: args }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-update-3", name: "update_context", arguments: args }],
        raw: {},
      },
      {
        text: "Finished.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Update repeatedly",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executeTool).toHaveBeenCalledTimes(3);
    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    const toolItems = finalItems(replayed).filter(isToolItemNamed("update_context"));
    expect(toolItems).toHaveLength(3);
    expect(toolItems.every((item) => item.status === "completed")).toBe(true);
  });

  it("requests approval with a structured diff preview for file edits", async () => {
    const workspace = await makeTempDir("runtime-coding-tools-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
          ],
          raw: {},
        },
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-edit",
              name: "edit_file",
              arguments: {
                path: "src/index.ts",
                old_string: "const value = 1;",
                new_string: "const value = 2;",
              },
            },
          ],
          raw: {},
        },
      ];
      const runtime = createRuntime(registry);
      await runtime.startTurn({
        threadId: thread.id,
        text: "Patch value",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));

      const approval = events.find((event) => event.kind === "approval_requested");
      expect(approval).toMatchObject({
        kind: "approval_requested",
        toolName: "edit_file",
        preview: {
          kind: "file_diff",
          path: "src/index.ts",
          added: 1,
          removed: 1,
        },
      });
      if (!approval || approval.kind !== "approval_requested") {
        throw new Error("Expected approval request.");
      }
      runtime.respondApproval({ approvalId: approval.approvalId, decision: "deny" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("rejects schema-invalid destructive tool calls before requesting approval", async () => {
    const execute = vi.fn(async () => "should not run");
    const preview = vi.fn(async () => ({
      kind: "file_diff" as const,
      path: "src/index.ts",
      operation: "update" as const,
      added: 1,
      removed: 1,
      lines: [],
    }));
    const registry = new InMemoryToolRegistry([
      {
        metadata: {
          category: "workspace",
          isDestructive: true,
        },
        definition: {
          name: "schema_write",
          description: "Test destructive schema validation before approval.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
        preview,
        execute,
      },
    ]);
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          { id: "call-schema-write", name: "schema_write", arguments: { text: 42 } },
        ],
        raw: {},
      },
      {
        text: "Finished.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Run schema write",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(preview).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(finalItems(replayed).find(isToolItemNamed("schema_write"))).toMatchObject({
      status: "failed",
      result: {
        code: "tool_schema_invalid",
        message: 'Tool "schema_write" arguments do not match inputSchema: arguments.text must be string.',
      },
    });
  });

  it("keeps preview failures scoped to the tool call", async () => {
    const workspace = await makeTempDir("runtime-coding-preview-failure-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-edit",
              name: "edit_file",
              arguments: {
                path: "src/index.ts",
                old_string: "const value = 1;",
                new_string: "const value = 2;",
              },
            },
          ],
          raw: {},
        },
        {
          text: "Read the file first.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);

      await createRuntime(registry).startTurn({
        threadId: thread.id,
        text: "Patch without reading",
      });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
      expect(events.some((event) => event.kind === "turn_failed")).toBe(false);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "runtime_error",
            code: "tool_failed",
            message: expect.stringContaining("Read the file with read_file"),
          }),
        ]),
      );
      const replayed = [];
      for await (const item of store.replayItems(thread.id)) {
        replayed.push(item);
      }
      expect(
        finalItems(replayed).find((item) => item.kind === "tool" && item.name === "edit_file"),
      ).toMatchObject({
        status: "failed",
        result: {
          code: "tool_execution_failed",
          message: "Read the file with read_file before attempting to edit or overwrite it.",
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("requests approval with a multi-file diff preview for apply_patch", async () => {
    const workspace = await makeTempDir("runtime-apply-patch-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
          ],
          raw: {},
        },
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-patch",
              name: "apply_patch",
              arguments: {
                patch: [
                  "--- a/src/index.ts",
                  "+++ b/src/index.ts",
                  "@@ -1 +1 @@",
                  "-const value = 1;",
                  "+const value = 2;",
                  "--- /dev/null",
                  "+++ b/src/created.ts",
                  "@@ -0,0 +1 @@",
                  "+export const created = true;",
                ].join("\n"),
              },
            },
          ],
          raw: {},
        },
        {
          text: "Patch denied.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];
      const runtime = createRuntime(registry);
      await runtime.startTurn({
        threadId: thread.id,
        text: "Apply patch",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));

      const approval = events.find((event) => event.kind === "approval_requested");
      expect(approval).toMatchObject({
        kind: "approval_requested",
        toolName: "apply_patch",
        preview: {
          kind: "multi_file_diff",
          added: 2,
          removed: 1,
          files: [
            { path: "src/index.ts", operation: "update", added: 1, removed: 1 },
            { path: "src/created.ts", operation: "create", added: 1, removed: 0 },
          ],
        },
      });
      if (!approval || approval.kind !== "approval_requested") {
        throw new Error("Expected apply_patch approval request.");
      }
      runtime.respondApproval({ approvalId: approval.approvalId, decision: "deny" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(await fs.readFile(path.join(workspace, "src", "index.ts"), "utf8"))
        .toBe("const value = 1;\n");
      await expect(fs.access(path.join(workspace, "src", "created.ts")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("drops malformed approval preview lines before emitting approval events", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "edit_file",
          description: "Edit a file",
          inputSchema: { type: "object" },
        },
        async preview() {
          return {
            kind: "file_diff",
            path: "src/index.ts",
            operation: "update",
            added: 1,
            removed: 1,
            lines: [{ type: "added", text: 123 }],
          };
        },
        async execute() {
          return "executed";
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-edit", name: "edit_file", arguments: {} }],
        raw: {},
      },
      {
        text: "Denied.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Needs approval",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    const approval = events.find((event) => event.kind === "approval_requested");
    expect(approval).toMatchObject({
      kind: "approval_requested",
      toolName: "edit_file",
    });
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected approval request.");
    }
    expect(approval.preview).toBeUndefined();
    runtime.respondApproval({ approvalId: approval.approvalId, decision: "deny" });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));
  });

  it("requests approval with a diff preview for rollback_file", async () => {
    const workspace = await makeTempDir("runtime-rollback-file-");
    try {
      await fs.writeFile(path.join(workspace, "file.ts"), "one\n", "utf8");
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
      ]);
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-read", name: "read_file", arguments: { path: "file.ts" } },
          ],
          raw: {},
        },
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-edit",
              name: "edit_file",
              arguments: {
                path: "file.ts",
                old_string: "one",
                new_string: "two",
              },
            },
          ],
          raw: {},
        },
        {
          text: "Edited.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];
      const runtime = createRuntime(registry);
      await runtime.startTurn({
        threadId: thread.id,
        text: "Edit file",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));
      const editApproval = events.find((event) => event.kind === "approval_requested");
      if (!editApproval || editApproval.kind !== "approval_requested") {
        throw new Error("Expected edit approval request.");
      }
      runtime.respondApproval({ approvalId: editApproval.approvalId, decision: "allow" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));
      expect(await fs.readFile(path.join(workspace, "file.ts"), "utf8")).toBe("two\n");

      events.length = 0;
      await store.updateThread(thread.id, { approvalPolicy: "on-request" });
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-rollback",
              name: "rollback_file",
              arguments: { path: "file.ts" },
            },
          ],
          raw: {},
        },
        {
          text: "Rollback denied.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];
      await runtime.startTurn({
        threadId: thread.id,
        text: "Rollback file",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));

      const approval = events.find((event) => event.kind === "approval_requested");
      expect(approval).toMatchObject({
        kind: "approval_requested",
        toolName: "rollback_file",
        preview: {
          kind: "file_diff",
          path: "file.ts",
          operation: "update",
          added: 1,
          removed: 1,
        },
      });
      if (!approval || approval.kind !== "approval_requested") {
        throw new Error("Expected rollback approval request.");
      }
      runtime.respondApproval({ approvalId: approval.approvalId, decision: "deny" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));
      expect(await fs.readFile(path.join(workspace, "file.ts"), "utf8")).toBe("two\n");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("denies write tools in read-only sandbox mode before execution", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await store.updateThread(thread.id, { sandboxMode: "read-only" });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          throw new Error("write_file should not execute in read-only sandbox.");
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "src/index.ts", content: "next" },
          },
        ],
        raw: {},
      },
      {
        text: "Denied.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Try writing",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "write_file"),
    ).toMatchObject({
      status: "failed",
      result: { denied: true },
    });
  });

  it("passes thread sandbox mode into command tool execution context", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await store.updateThread(thread.id, { sandboxMode: "danger-full-access" });
    let observedSandboxMode: string | undefined;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "git_status",
          description: "Read Git status",
          inputSchema: { type: "object" },
        },
        metadata: { category: "command", isReadOnly: true, isDestructive: false },
        async execute(_input, context) {
          observedSandboxMode = context.sandboxMode;
          return JSON.stringify({ ok: true });
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-git-status", name: "git_status", arguments: {} }],
        raw: {},
      },
      {
        text: "Status read.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read git status",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(observedSandboxMode).toBe("danger-full-access");
  });

  it("does not let permission allow rules bypass read-only sandbox mode", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await store.updateThread(thread.id, { sandboxMode: "read-only" });
    await runtimePreferencesStore.update({
      permissionRules: [
        { id: "allow-src", tool: "write", pattern: "src/*", effect: "allow" },
      ],
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          throw new Error("write_file should not execute in read-only sandbox.");
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "src/index.ts", content: "next" },
          },
        ],
        raw: {},
      },
      {
        text: "Denied.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Try writing",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "write_file"),
    ).toMatchObject({
      status: "failed",
      result: { denied: true },
    });
  });

  it("requests approval for run_command even in auto mode and returns output after approval", async () => {
    const workspace = await makeTempDir("runtime-command-tools-");
    try {
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      await store.updateThread(thread.id, { approvalPolicy: "auto" });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-command",
              name: "run_command",
              arguments: {
                command: nodeCommand(
                  "process.stdout.write('hello runtime'); process.stderr.write('warn runtime');",
                ),
              },
            },
          ],
          raw: {},
        },
        {
          text: "Command finished.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];
      const runtime = createRuntime(registry);
      await runtime.startTurn({
        threadId: thread.id,
        text: "Run command",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));

      const approval = events.find((event) => event.kind === "approval_requested");
      expect(approval).toMatchObject({
        kind: "approval_requested",
        toolName: "run_command",
        args: {
          command: nodeCommand(
            "process.stdout.write('hello runtime'); process.stderr.write('warn runtime');",
          ),
        },
      });
      if (!approval || approval.kind !== "approval_requested") {
        throw new Error("Expected command approval request.");
      }
      runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(fakePool.requests).toHaveLength(2);
      const toolMessage = fakePool.requests[1].messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-command",
      );
      expect(toolMessage?.content).toContain("hello runtime");
      expect(toolMessage?.content).toContain("warn runtime");
      const progressEvents = events.filter(
        (event): event is Extract<RuntimeEvent, { kind: "tool_progress" }> =>
          event.kind === "tool_progress",
      );
      expect(progressEvents.some(
        (event) =>
          event.toolCallId === "call-command" &&
          event.stream === "stdout" &&
          event.chunk.includes("hello runtime"),
      )).toBe(true);
      expect(progressEvents.some(
        (event) =>
          event.toolCallId === "call-command" &&
          event.stream === "stderr" &&
          event.chunk.includes("warn runtime"),
      )).toBe(true);
      const replayed = [];
      for await (const item of store.replayItems(thread.id)) {
        replayed.push(item);
      }
      expect(
        finalItems(replayed).find((item) => item.kind === "tool" && item.name === "run_command"),
      ).toMatchObject({
        status: "completed",
        result: {
          cwd: ".",
          exitCode: 0,
          stdout: "hello runtime",
          stderr: "warn runtime",
          timedOut: false,
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("appends completion evidence for coding changes and verification commands", async () => {
    const workspace = await makeTempDir("runtime-completion-evidence-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "index.ts"), "const value = 1;\n", "utf8");
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry([
        ...createWorkspaceTools(),
        ...createCodingTools(),
        ...createCommandTools(),
      ]);
      const command = nodeCommand("process.stdout.write('verification ok');");
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } },
          ],
          raw: {},
        },
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-edit",
              name: "edit_file",
              arguments: {
                path: "src/index.ts",
                old_string: "const value = 1;",
                new_string: "const value = 2;",
              },
            },
          ],
          raw: {},
        },
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-command",
              name: "run_command",
              arguments: { command },
            },
          ],
          raw: {},
        },
        {
          text: "Done.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];
      const runtime = createRuntime(registry);
      await runtime.startTurn({
        threadId: thread.id,
        text: "Patch and verify",
      });

      await waitFor(() => events.filter((event) => event.kind === "approval_requested").length >= 1);
      const editApproval = events.find((event) => event.kind === "approval_requested");
      if (!editApproval || editApproval.kind !== "approval_requested") {
        throw new Error("Expected edit approval request.");
      }
      runtime.respondApproval({ approvalId: editApproval.approvalId, decision: "allow" });
      await waitFor(() => events.filter((event) => event.kind === "approval_requested").length >= 2);
      const approvals = events.filter(
        (event): event is Extract<RuntimeEvent, { kind: "approval_requested" }> =>
          event.kind === "approval_requested",
      );
      const commandApproval = approvals.find((event) => event.toolName === "run_command");
      if (!commandApproval) {
        throw new Error("Expected command approval request.");
      }
      runtime.respondApproval({ approvalId: commandApproval.approvalId, decision: "allow" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      const items = finalItems(await collectThreadItems(thread.id));
      const assistantIndex = items.findIndex((item) => item.kind === "assistant" && item.text === "Done.");
      const evidenceIndex = items.findIndex(
        (item) => item.kind === "system" && item.text.startsWith("Completion evidence:"),
      );
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(evidenceIndex).toBeGreaterThan(assistantIndex);
      const evidence = items[evidenceIndex];
      expect(evidence).toMatchObject({
        kind: "system",
        level: "info",
        text: expect.stringContaining("files changed: 1 file(s): src/index.ts update (+1/-1);"),
      });
      if (evidence.kind !== "system") {
        throw new Error("Expected completion evidence system item.");
      }
      expect(evidence.text).toContain("commands: 1 command(s): run_command passed (exit 0)");
      expect(evidence.text).toContain("checkpoints: 1/1 changed file snapshot(s) available;");
      expect(evidence.text).toContain(
        "remaining risk: not assessed beyond successful commands and available checkpoints.",
      );
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("allows matching command calls without approval when permission rules allow them", async () => {
    const workspace = await makeTempDir("runtime-command-permission-rules-");
    try {
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const command = nodeCommand("process.stdout.write('allowed command');");
      await runtimePreferencesStore.update({
        permissionRules: [
          { id: "allow-node", tool: "command", pattern: command, effect: "allow" },
        ],
      });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-command",
              name: "run_command",
              arguments: { command },
            },
          ],
          raw: {},
        },
        {
          text: "Command finished.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];

      await createRuntime(registry).startTurn({
        threadId: thread.id,
        text: "Run command",
      });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
      const toolMessage = fakePool.requests[1]?.messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-command",
      );
      expect(toolMessage?.content).toContain("allowed command");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("uses session-scoped approval grants for repeated command subjects without bypassing never policy", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const command = "npm test -- --name literal*";
    const registry = new InMemoryToolRegistry([createFakeRunCommandTool()]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-command-1", name: "run_command", arguments: { command } }],
        raw: {},
      },
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-command-2", name: "run_command", arguments: { command } }],
        raw: {},
      },
      {
        text: "Commands finished.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({ threadId: thread.id, text: "Run repeated command" });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));
    const approval = events.find((event) => event.kind === "approval_requested");
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected command approval request.");
    }
    runtime.respondApproval({
      approvalId: approval.approvalId,
      decision: "allow",
      scope: "session",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));
    expect(events.filter((event) => event.kind === "approval_requested")).toHaveLength(1);

    const firstTurnItems = finalItems(await collectThreadItems(thread.id));
    expect(firstTurnItems.filter(isToolItemNamed("run_command"))).toHaveLength(2);

    await store.updateThread(thread.id, { approvalPolicy: "never" });
    const approvalCountBeforeNeverTurn = events.filter(
      (event) => event.kind === "approval_requested",
    ).length;
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-command-never", name: "run_command", arguments: { command } }],
        raw: {},
      },
      {
        text: "Denied.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({ threadId: thread.id, text: "Run command under never" });
    await waitFor(() =>
      events.filter((event) => event.kind === "turn_completed").length >= 2
    );

    expect(events.filter((event) => event.kind === "approval_requested")).toHaveLength(
      approvalCountBeforeNeverTurn,
    );
    const allItems = finalItems(await collectThreadItems(thread.id));
    expect(allItems.find(
      (item) =>
        item.kind === "tool" &&
        item.name === "run_command" &&
        item.toolCallId === "call-command-never",
    )).toMatchObject({
      status: "failed",
      result: { denied: true },
    });
  });

  it("persists exact permission rules from scoped approval responses", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const command = "npm test -- --name literal*";
    const registry = new InMemoryToolRegistry([createFakeRunCommandTool()]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-command", name: "run_command", arguments: { command } }],
        raw: {},
      },
      {
        text: "Command finished.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({ threadId: thread.id, text: "Run command" });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));
    const approval = events.find((event) => event.kind === "approval_requested");
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected command approval request.");
    }
    runtime.respondApproval({
      approvalId: approval.approvalId,
      decision: "allow",
      scope: "persist_rule",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    const preferences = await runtimePreferencesStore.get();
    expect(preferences.permissionRules).toEqual([
      expect.objectContaining({
        tool: "command",
        pattern: command,
        effect: "allow",
        match: "exact",
      }),
    ]);
  });

  it("requests approval for diagnose_workspace before running workspace scripts", async () => {
    const workspace = await makeTempDir("runtime-diagnose-workspace-");
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            typecheck: nodeCommand("process.stderr.write('src/index.ts(1,7): error TS2322: Type mismatch.\\n'); process.exit(2);"),
          },
        }),
        "utf8",
      );
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-diagnose", name: "diagnose_workspace", arguments: {} },
          ],
          raw: {},
        },
        {
          text: "Diagnostics complete.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];

      const runtime = createRuntime(registry);
      await runtime.startTurn({
        threadId: thread.id,
        text: "Diagnose",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));

      const approval = events.find((event) => event.kind === "approval_requested");
      expect(approval).toMatchObject({
        kind: "approval_requested",
        toolName: "diagnose_workspace",
      });
      if (!approval || approval.kind !== "approval_requested") {
        throw new Error("Expected diagnose_workspace approval request.");
      }
      runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(fakePool.requests).toHaveLength(2);
      const toolMessage = fakePool.requests[1].messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-diagnose",
      );
      expect(toolMessage?.content).toContain("TS2322");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("denies diagnose_workspace when approval policy is never", async () => {
    const workspace = await makeTempDir("runtime-diagnose-workspace-never-");
    try {
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      await store.updateThread(thread.id, { approvalPolicy: "never" });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-diagnose", name: "diagnose_workspace", arguments: {} },
          ],
          raw: {},
        },
        {
          text: "Denied.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];

      await createRuntime(registry).startTurn({
        threadId: thread.id,
        text: "Diagnose",
      });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
      const replayed = [];
      for await (const item of store.replayItems(thread.id)) {
        replayed.push(item);
      }
      expect(
        finalItems(replayed).find((item) => item.kind === "tool" && item.name === "diagnose_workspace"),
      ).toMatchObject({
        status: "failed",
        result: { denied: true },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("runs diagnose_file without approval because it is read-only", async () => {
    const workspace = await makeTempDir("runtime-diagnose-file-");
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
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-diagnose-file", name: "diagnose_file", arguments: { path: "src/index.ts" } },
          ],
          raw: {},
        },
        {
          text: "File diagnostics complete.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];

      await createRuntime(registry).startTurn({
        threadId: thread.id,
        text: "Diagnose file",
      });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"), 3000);

      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
      const toolMessage = fakePool.requests[1].messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-diagnose-file",
      );
      expect(toolMessage?.content).toContain("src/index.ts");
      expect(toolMessage?.content).toContain("TS2322");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("runs list_symbols without approval because it is read-only", async () => {
    const workspace = await makeTempDir("runtime-list-symbols-");
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
      await fs.writeFile(
        path.join(workspace, "src", "index.ts"),
        "export function makeValue(): number { return 1; }\n",
        "utf8",
      );
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-list-symbols", name: "list_symbols", arguments: { path: "src/index.ts" } },
          ],
          raw: {},
        },
        {
          text: "Symbols complete.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];

      await createRuntime(registry).startTurn({
        threadId: thread.id,
        text: "List symbols",
      });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"), 3000);

      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
      const toolMessage = fakePool.requests[1].messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-list-symbols",
      );
      expect(toolMessage?.content).toContain("src/index.ts");
      expect(toolMessage?.content).toContain("makeValue");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("runs search_symbols without approval because it is read-only", async () => {
    const workspace = await makeTempDir("runtime-search-symbols-");
    try {
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "src", "index.ts"),
        "export function makeValue(): number { return 1; }\n",
        "utf8",
      );
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            { id: "call-search-symbols", name: "search_symbols", arguments: { query: "makeValue" } },
          ],
          raw: {},
        },
        {
          text: "Symbols listed.",
          reasoning: "",
          toolCalls: [],
          raw: {},
        },
      ];

      await createRuntime(registry).startTurn({
        threadId: thread.id,
        text: "Search symbols",
      });
      await waitFor(() => events.some((event) => event.kind === "turn_completed"));

      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
      const toolMessage = fakePool.requests[1].messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-search-symbols",
      );
      expect(toolMessage?.content).toContain("makeValue");
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("keeps coding and command tools visible in Code threads", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      ...createWorkspaceTools(),
      ...createCodingTools(),
      ...createCommandTools(),
    ]);

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Inspect tools",
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    expect(CODE_ONLY_TOOL_NAMES.every((name) => isCodeOnlyToolName(name))).toBe(true);
    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...CODE_ONLY_TOOL_NAMES]),
    );
  });

  it("keeps command tool names aligned with command tool metadata", () => {
    const metadataCommandNames = createCommandTools()
      .filter((tool) => tool.metadata?.category === "command")
      .map((tool) => tool.definition.name)
      .sort();

    expect([...COMMAND_TOOL_NAMES].sort()).toEqual(metadataCommandNames);
    expect(CODE_ONLY_TOOL_NAMES).toEqual(expect.arrayContaining([...COMMAND_TOOL_NAMES]));
  });

  it("keeps write-mode default tool availability aligned with Code-only policy", () => {
    const disabledInWriteByDefault = RUNTIME_TOOL_NAMES
      .filter((toolName) => !DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write[toolName])
      .sort();

    expect(disabledInWriteByDefault).toEqual([...CODE_ONLY_TOOL_NAMES].sort());
    for (const toolName of RUNTIME_TOOL_NAMES) {
      expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code[toolName]).toBe(true);
    }
  });

  it("excludes coding and command tools from Write thread tool definitions by default", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    const registry = new InMemoryToolRegistry([
      ...createWorkspaceTools(),
      ...createCodingTools(),
      ...createCommandTools(),
    ]);

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Draft notes",
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(thread.id));

    const toolNames = fakePool.requests[0].tools.map((tool) => tool.name);
    for (const name of CODE_ONLY_TOOL_NAMES) {
      expect(toolNames).not.toContain(name);
    }
    expect(toolNames).toEqual(expect.arrayContaining(["list_files", "read_file", "search_files"]));
  });

  it("hides and rejects tools disabled by runtime preferences", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await runtimePreferencesStore.update({
      toolAvailability: { code: { run_command: false } },
    });
    const registry = new InMemoryToolRegistry(createCommandTools());
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-command",
            name: "run_command",
            arguments: { command: nodeCommand("process.stdout.write('nope');") },
          },
        ],
        raw: {},
      },
      {
        text: "Handled unavailable command.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Run command",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).not.toContain("run_command");
    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "tool_not_found",
          message: 'Tool "run_command" is not available in this turn.',
        }),
      ]),
    );
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "run_command"),
    ).toMatchObject({
      status: "failed",
      result: {
        code: "tool_unavailable",
        message: 'Tool "run_command" is not available in this turn.',
      },
    });
  });

  it("allows Write thread code tools when runtime preferences explicitly enable them", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    await runtimePreferencesStore.update({
      toolAvailability: { write: { write_file: true } },
    });
    let executed = false;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          executed = true;
          return "written";
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "draft.md", content: "draft" },
          },
        ],
        raw: {},
      },
      {
        text: "Write allowed.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Write draft",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["write_file"]);
    const approval = events.find((event) => event.kind === "approval_requested");
    expect(approval).toMatchObject({
      kind: "approval_requested",
      toolName: "write_file",
    });
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected write_file approval request.");
    }
    runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executed).toBe(true);
  });

  it("denies matching write calls without approval when permission rules deny them", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    await runtimePreferencesStore.update({
      toolAvailability: { write: { write_file: true } },
      permissionRules: [
        { id: "deny-drafts", tool: "write", pattern: "drafts/*", effect: "deny" },
      ],
    });
    let executed = false;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          executed = true;
          return "written";
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "drafts/blocked.md", content: "draft" },
          },
        ],
        raw: {},
      },
      {
        text: "Write denied.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Write draft",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["write_file"]);
    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(executed).toBe(false);
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "write_file"),
    ).toMatchObject({
      status: "failed",
      result: { denied: true },
    });
  });

  it("rejects forced Code-only tool calls in Write threads before approval or execution", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    let executed = false;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          executed = true;
          throw new Error("write_file should not execute in a Write thread by default.");
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "draft.md", content: "draft" },
          },
        ],
        raw: {},
      },
      {
        text: "Handled unavailable tool.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Write draft",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executed).toBe(false);
    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "tool_not_found",
          message: 'Tool "write_file" is not available in this turn.',
        }),
      ]),
    );
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "write_file"),
    ).toMatchObject({
      status: "failed",
      result: {
        code: "tool_unavailable",
        message: 'Tool "write_file" is not available in this turn.',
      },
    });
  });

  it("allows per-mode tool access policy overrides before applying approval policy", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    let executed = false;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          executed = true;
          return "written";
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "draft.md", content: "draft" },
          },
        ],
        raw: {},
      },
      {
        text: "Write allowed.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(
      registry,
      createToolAccessPolicy({ allowByMode: { write: ["write_file"] } }),
    );
    await runtime.startTurn({
      threadId: thread.id,
      text: "Write draft",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    const approval = events.find((event) => event.kind === "approval_requested");
    expect(approval).toMatchObject({
      kind: "approval_requested",
      toolName: "write_file",
    });
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected write_file approval request.");
    }
    runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executed).toBe(true);
    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["write_file"]);
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "write_file"),
    ).toMatchObject({
      status: "completed",
      result: { content: "written" },
    });
  });

  it("applies runtime preferences when filtering and rejecting disabled tools", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await runtimePreferencesStore.update({
      toolAvailability: {
        code: { run_command: false },
      },
    });
    let executed = false;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "run_command",
          description: "Run command",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          executed = true;
          throw new Error("run_command should not execute when disabled.");
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-command",
            name: "run_command",
            arguments: { command: "npm test" },
          },
        ],
        raw: {},
      },
      {
        text: "Handled disabled command.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Run command",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(executed).toBe(false);
    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual([]);
    expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "tool_not_found",
          message: 'Tool "run_command" is not available in this turn.',
        }),
      ]),
    );
  });

  it("uses runtime preferences to enable write tools before approval policy", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "write",
    });
    await runtimePreferencesStore.update({
      toolAvailability: {
        write: { write_file: true },
      },
    });
    let executed = false;
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "write_file",
          description: "Write file",
          inputSchema: { type: "object" },
        },
        metadata: { isDestructive: true },
        async execute() {
          executed = true;
          return "written";
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            arguments: { path: "draft.md", content: "draft" },
          },
        ],
        raw: {},
      },
      {
        text: "Write allowed.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Write draft",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["write_file"]);
    const approval = events.find((event) => event.kind === "approval_requested");
    expect(approval).toMatchObject({
      kind: "approval_requested",
      toolName: "write_file",
    });
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected write_file approval request.");
    }
    runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));
    expect(executed).toBe(true);
  });

  it("rejects conflicting tool access policy entries", () => {
    expect(() =>
      createToolAccessPolicy({
        allowByMode: { write: ["write_file"] },
        denyByMode: { write: ["write_file"] },
      }),
    ).toThrow("Tool access policy conflict for write:write_file.");
  });

  it("cancels an active run_command when the turn is interrupted", async () => {
    const workspace = await makeTempDir("runtime-command-interrupt-");
    try {
      const thread = await store.createThread({
        title: "Runtime",
        workspace,
        mode: "code",
      });
      const startedPath = path.join(workspace, "started.txt");
      const registry = new InMemoryToolRegistry(createCommandTools());
      fakePool.responses = [
        {
          text: "",
          reasoning: "",
          toolCalls: [
            {
              id: "call-command",
              name: "run_command",
              arguments: {
                command: nodeCommand(
                  "const fs = require('fs'); fs.writeFileSync('started.txt', '1'); setTimeout(() => undefined, 10000);",
                ),
              },
            },
          ],
          raw: {},
        },
      ];
      const runtime = createRuntime(registry);
      const turn = await runtime.startTurn({
        threadId: thread.id,
        text: "Run long command",
      });
      await waitFor(() => events.some((event) => event.kind === "approval_requested"));
      const approval = events.find((event) => event.kind === "approval_requested");
      if (!approval || approval.kind !== "approval_requested") {
        throw new Error("Expected command approval request.");
      }
      runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
      await waitFor(() => fileExists(startedPath));

      await runtime.interruptTurn(turn.id);
      await waitFor(() =>
        events.some(
          (event) => event.kind === "turn_completed" && event.status === "interrupted",
        ),
      );

      expect(fakePool.canceledThreads).toEqual([thread.id]);
      expect(events.some((event) => event.kind === "turn_failed")).toBe(false);
      expect(
        events.some(
          (event) => event.kind === "runtime_error" && event.message.includes("Command was interrupted."),
        ),
      ).toBe(false);
      const replayed = [];
      for await (const item of store.replayItems(thread.id)) {
        replayed.push(item);
      }
      expect(
        finalItems(replayed).find((item) => item.kind === "tool" && item.name === "run_command"),
      ).toMatchObject({
        status: "failed",
        result: {
          message: "Command was interrupted.",
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
  });

  it("labels interrupted command tools consistently beyond run_command", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    let toolStarted = false;
    const interruptibleGitStatusTool: AgentTool = {
      metadata: {
        category: "command",
        isReadOnly: true,
        isDestructive: false,
      },
      definition: {
        name: "git_status",
        description: "Test command tool that waits for interruption.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      async execute(_input, context) {
        toolStarted = true;
        return new Promise<string>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve("{}"), { once: true });
        });
      },
    };
    const registry = new InMemoryToolRegistry([interruptibleGitStatusTool]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-git-status", name: "git_status", arguments: {} }],
        raw: {},
      },
    ];
    const runtime = createRuntime(registry);
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Check git status",
    });
    await waitFor(() => toolStarted);

    await runtime.interruptTurn(turn.id);
    await waitFor(() =>
      events.some(
        (event) => event.kind === "turn_completed" && event.status === "interrupted",
      ),
    );

    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.name === "git_status"),
    ).toMatchObject({
      status: "failed",
      result: {
        message: "Command was interrupted.",
      },
    });
  });

  it("uses update_goal when goal mode is enabled and emits goal updates", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime(
      new InMemoryToolRegistry([
        ...createGoalTools({
          updateGoal: async (threadId, update) => {
            await runtime.updateThreadGoal(threadId, update);
          },
        }),
      ]),
    );
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-1",
            name: "update_goal",
            arguments: { goal: "Finish testing", status: "active" },
          },
        ],
        raw: {},
      },
      {
        text: "Goal updated.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Set goal",
      goalMode: true,
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(events.some((event) => event.kind === "goal_updated")).toBe(true);
    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual(["update_goal"]);
    expect(fakePool.requests[0].systemPrompt).not.toContain("Current thread goal");
    expect(await store.getThread(thread.id)).toMatchObject({
      goal: { text: "Finish testing", status: "active" },
    });
  });

  it("exposes update_goal only for explicit goal mode or active goal threads", async () => {
    const plainThread = await store.createThread({
      title: "Plain",
      workspace: "/workspace",
      mode: "code",
    });
    const activeThread = await store.createThread({
      title: "Active goal",
      workspace: "/workspace",
      mode: "code",
    });
    const completedThread = await store.createThread({
      title: "Completed goal",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime(
      new InMemoryToolRegistry([
        ...createGoalTools({
          updateGoal: async (threadId, update) => {
            await runtime.updateThreadGoal(threadId, update);
          },
        }),
      ]),
    );
    await runtime.updateThreadGoal(activeThread.id, {
      goal: "Ship runtime",
      status: "active",
    });
    await runtime.updateThreadGoal(completedThread.id, {
      goal: "Ship docs",
      status: "complete",
    });

    await runtime.startTurn({
      threadId: plainThread.id,
      text: "Plain",
    });
    await waitFor(() => fakePool.requests.length === 1 && !runtime.isThreadInFlight(plainThread.id));
    await runtime.startTurn({
      threadId: activeThread.id,
      text: "Continue active goal",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(activeThread.id));
    await runtime.startTurn({
      threadId: completedThread.id,
      text: "Follow up completed goal",
    });
    await waitFor(() => fakePool.requests.length === 3 && !runtime.isThreadInFlight(completedThread.id));
    await runtime.startTurn({
      threadId: completedThread.id,
      text: "Restart goal mode",
      goalMode: true,
    });
    await waitFor(() => fakePool.requests.length === 4 && !runtime.isThreadInFlight(completedThread.id));

    expect(fakePool.requests[0].tools.map((tool) => tool.name)).toEqual([]);
    expect(fakePool.requests[1].tools.map((tool) => tool.name)).toEqual(["update_goal"]);
    expect(fakePool.requests[2].tools.map((tool) => tool.name)).toEqual([]);
    expect(fakePool.requests[3].tools.map((tool) => tool.name)).toEqual(["update_goal"]);
  });

  it("preserves terminal goal timestamps and rejects updates to archived threads", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime();

    const completed = await runtime.updateThreadGoal(thread.id, {
      goal: "Finish testing",
      status: "complete",
      summary: "Initial",
    });
    const completedAt = completed.goal?.completedAt;
    expect(completedAt).toBeDefined();

    const edited = await runtime.updateThreadGoal(thread.id, {
      summary: "Edited summary",
    });
    expect(edited.goal).toMatchObject({
      text: "Finish testing",
      status: "complete",
      summary: "Edited summary",
      completedAt,
    });
    await expect(runtime.updateThreadGoal(thread.id, {})).rejects.toThrow(
      "Goal update must include at least one of goal, status, or summary.",
    );
    await expect(runtime.updateThreadGoal(thread.id, { summary: " " })).rejects.toThrow(
      "Goal summary must be a non-empty string.",
    );
    await expect(
      runtime.updateThreadGoal(thread.id, { goal: null, status: "active" }),
    ).rejects.toThrow("Goal clear cannot be combined with status or summary.");

    const reactivated = await runtime.updateThreadGoal(thread.id, {
      status: "active",
    });
    expect(reactivated.goal).toMatchObject({
      text: "Finish testing",
      status: "active",
    });
    expect(reactivated.goal?.completedAt).toBeUndefined();

    const blocked = await runtime.updateThreadGoal(thread.id, {
      status: "blocked",
    });
    const blockedAt = blocked.goal?.blockedAt;
    expect(blockedAt).toBeDefined();

    const blockedEdited = await runtime.updateThreadGoal(thread.id, {
      summary: "Still blocked",
    });
    expect(blockedEdited.goal).toMatchObject({
      status: "blocked",
      blockedAt,
      summary: "Still blocked",
    });

    await store.updateThread(thread.id, { status: "archived" });
    await expect(
      runtime.updateThreadGoal(thread.id, { status: "active" }),
    ).rejects.toThrow("RUNTIME_THREAD_ARCHIVED");
  });

  it("rejects invalid goal statuses at the runtime update boundary", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime();
    const invalidUpdate = { status: "paused" } as unknown as Parameters<
      AgentRuntime["updateThreadGoal"]
    >[1];

    await expect(runtime.updateThreadGoal(thread.id, invalidUpdate)).rejects.toThrow(
      "Goal status must be active, complete, or blocked.",
    );
    expect((await store.getThread(thread.id))?.goal).toBeUndefined();
  });

  it("rejects malformed turn start fields before starting the turn", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const runtime = createRuntime();
    const invalidRequests: Array<{
      request: unknown;
      message: string;
    }> = [
      {
        request: { threadId: thread.id },
        message: "Turn text is required.",
      },
      {
        request: { threadId: " ", text: "Run" },
        message: "Turn threadId is required.",
      },
      {
        request: { threadId: thread.id, text: " " },
        message: "Turn text is required.",
      },
      {
        request: { threadId: thread.id, text: "Run", mode: "planning" },
        message: "Turn mode must be agent or plan.",
      },
      {
        request: { threadId: thread.id, text: "Run", reasoningEffort: "max" },
        message: "Turn reasoningEffort is invalid.",
      },
      {
        request: { threadId: thread.id, text: "Run", attachmentIds: [42] },
        message: "Turn attachmentIds must be a string array.",
      },
      {
        request: { threadId: thread.id, text: "Run", goalMode: "false" },
        message: "Turn goalMode must be a boolean.",
      },
    ];

    for (const item of invalidRequests) {
      await expect(
        runtime.startTurn(item.request as Parameters<AgentRuntime["startTurn"]>[0]),
      ).rejects.toThrow(item.message);
    }
    expect(runtime.isThreadInFlight(thread.id)).toBe(false);
    expect(fakePool.requests).toHaveLength(0);
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed).toEqual([]);
  });

  it("compresses oversized historical tool results only in model requests", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const longToolResult = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return longToolResult;
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read", name: "read_file", arguments: { path: "large.txt" } }],
        raw: {},
      },
      {
        text: "Done",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read a large file",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-read",
          content: expect.stringContaining("[context budget: omitted"),
        }),
      ]),
    );

    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(
      finalItems(replayed).find((item) => item.kind === "tool" && item.toolCallId === "call-read"),
    ).toMatchObject({
      result: { content: longToolResult },
    });
  });

  it("preserves historical tool results within budget when automatic compaction is disabled", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await runtimePreferencesStore.update({
      compaction: { enabled: false },
    });
    const longToolResult = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return longToolResult;
        },
      },
    ]);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read", name: "read_file", arguments: { path: "large.txt" } }],
        raw: {},
      },
      {
        text: "Done",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await createRuntime(registry).startTurn({
      threadId: thread.id,
      text: "Read a large file",
    });
    await waitFor(() => events.some((event) => event.kind === "turn_completed"));

    expect(fakePool.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-read",
          content: longToolResult,
        }),
      ]),
    );
  });

  it("uses recent-only compaction strategy to trim older history first", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    await runtimePreferencesStore.update({
      compaction: { strategy: "recent-only" },
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
        },
      },
    ]);
    const runtime = createRuntime(registry);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-read", name: "read_file", arguments: { path: "large.txt" } }],
        raw: {},
      },
      {
        text: "Done",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Continue done",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Read a large file",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(thread.id));
    await modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 12000,
      model_auto_compact_token_limit: 300,
      max_tokens: 1000,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });

    await runtime.startTurn({
      threadId: thread.id,
      text: "Continue",
    });
    await waitFor(() => fakePool.requests.length === 3 && !runtime.isThreadInFlight(thread.id));

    const messages = fakePool.requests[2].messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Continue" }),
      ]),
    );
    expect(messages.some((message) => message.role === "tool" && message.toolCallId === "call-read")).toBe(false);
  });

  it("keeps large historical tool call rounds while the request is within budget", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return "short result";
        },
      },
    ]);
    const runtime = createRuntime(registry);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-large",
            name: "read_file",
            arguments: { path: "large.txt", query: "x".repeat(7000) },
          },
        ],
        raw: {},
      },
      {
        text: "Read complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Continue complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Read a large file",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(thread.id));

    await runtime.startTurn({
      threadId: thread.id,
      text: "Continue",
    });
    await waitFor(() => fakePool.requests.length === 3 && !runtime.isThreadInFlight(thread.id));

    expect(fakePool.requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ id: "call-large" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call-large" }),
      ]),
    );
  });

  it("compacts completed historical tool call arguments in later model requests", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return "short result";
        },
      },
    ]);
    const runtime = createRuntime(registry);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-complex",
            name: "read_file",
            arguments: {
              path: "large.txt",
              nested: {
                data_base64: "a".repeat(2048),
                note: null,
                query: "x".repeat(9000),
                rows: Array.from({ length: 90 }, (_, index) => ({ index })),
              },
            },
          },
        ],
        raw: {},
      },
      {
        text: "Read complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Continue complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Read with complex arguments",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(thread.id));

    await runtime.startTurn({
      threadId: thread.id,
      text: "Continue",
    });
    await waitFor(() => fakePool.requests.length === 3 && !runtime.isThreadInFlight(thread.id));

    const replayedCall = fakePool.requests[2].messages
      .find((message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === "call-complex")
      )
      ?.toolCalls?.find((call) => call.id === "call-complex");
    if (!replayedCall) throw new Error("Expected replayed complex tool call.");

    const nested = expectRecord(
      replayedCall.arguments.nested,
      "Expected nested arguments to remain an object.",
    );
    expect(nested.data_base64).toBe("[context budget: omitted base64 argument, 2048 bytes]");
    expect(nested.query).toContain("[context budget: omitted long argument tail]");
    expect(nested.note).toBeNull();

    const rows = nested.rows;
    expect(Array.isArray(rows)).toBe(true);
    if (!Array.isArray(rows)) throw new Error("Expected compacted rows to remain an array.");
    expect(rows).toHaveLength(81);
    expect(rows[60]).toEqual({ context_budget_omitted_items: 10 });
  });

  it("trims historical tool call rounds without leaving orphan tool results", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return "short result";
        },
      },
    ]);
    const runtime = createRuntime(registry);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "call-large",
            name: "read_file",
            arguments: { path: "large.txt", query: "x".repeat(7000) },
          },
        ],
        raw: {},
      },
      {
        text: "Read complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: thread.id,
      text: "Read a large file",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(thread.id));

    await modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 12000,
      model_auto_compact_token_limit: 300,
      max_tokens: 1000,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });
    fakePool.response = {
      text: "Continue complete.",
      reasoning: "",
      toolCalls: [],
      raw: {},
    };

    await runtime.startTurn({
      threadId: thread.id,
      text: "Continue",
    });
    await waitFor(() => fakePool.requests.length === 3 && !runtime.isThreadInFlight(thread.id));

    const messages = fakePool.requests[2].messages;
    const completedToolCallIds = new Set(
      messages
        .filter((message) => message.role === "assistant" && message.toolCalls)
        .flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []),
    );
    for (const message of messages) {
      if (message.role === "tool") {
        expect(completedToolCallIds.has(message.toolCallId ?? "")).toBe(true);
      }
    }
    expect(messages.some((message) => message.role === "tool" && message.toolCallId === "call-large")).toBe(false);
  });

  it("starts forked threads without replaying parent tool-call history into the first request", async () => {
    const parent = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return "parent result";
        },
      },
    ]);
    const runtime = createRuntime(registry);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          { id: "parent-call", name: "read_file", arguments: { path: "parent.txt" } },
        ],
        raw: {},
      },
      {
        text: "Parent complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
      {
        text: "Fork complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await runtime.startTurn({
      threadId: parent.id,
      text: "Read parent file",
    });
    await waitFor(() => fakePool.requests.length === 2 && !runtime.isThreadInFlight(parent.id));

    const fork = await store.forkThread(parent.id);
    await runtime.startTurn({
      threadId: fork.id,
      text: "Start fork",
    });
    await waitFor(() => fakePool.requests.length === 3 && !runtime.isThreadInFlight(fork.id));

    const forkRequestMessages = fakePool.requests[2].messages;
    expectProtocolValidToolHistory(forkRequestMessages);
    expect(forkRequestMessages).toEqual([
      { role: "user", content: "Start fork" },
    ]);
  });

  it("keeps resumed compacted request history protocol-valid at the first request boundary", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute() {
          return Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
        },
      },
    ]);
    const initialRuntime = createRuntime(registry);
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: "resume-call",
            name: "read_file",
            arguments: { path: "large.txt", query: "x".repeat(7000) },
          },
        ],
        raw: {},
      },
      {
        text: "Read complete.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    await initialRuntime.startTurn({
      threadId: thread.id,
      text: "Read before restart",
    });
    await waitFor(() => fakePool.requests.length === 2 && !initialRuntime.isThreadInFlight(thread.id));

    await modelConfigStore.update({
      model_provide: DEFAULT_MODEL_CONFIG.model_provide,
      model: DEFAULT_MODEL_CONFIG.model,
      base_url: DEFAULT_MODEL_CONFIG.base_url,
      OPENAI_API_KEY: DEFAULT_MODEL_CONFIG.OPENAI_API_KEY,
      model_context_window: 12000,
      model_auto_compact_token_limit: 300,
      max_tokens: 1000,
      thinking: DEFAULT_MODEL_CONFIG.thinking,
      model_reasoning_effort: DEFAULT_MODEL_CONFIG.model_reasoning_effort,
    });
    fakePool.response = {
      text: "Resume complete.",
      reasoning: "",
      toolCalls: [],
      raw: {},
    };

    const resumedRuntime = createRuntime(registry);
    await resumedRuntime.startTurn({
      threadId: thread.id,
      text: "Resume after restart",
    });
    await waitFor(() => fakePool.requests.length === 3 && !resumedRuntime.isThreadInFlight(thread.id));

    const resumedRequestMessages = fakePool.requests[2].messages;
    expectProtocolValidToolHistory(resumedRequestMessages);
    expect(resumedRequestMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Resume after restart" }),
      ]),
    );
  });

  it("blocks unavailable internal tools and reports runtime errors", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.responses = [
      {
        text: "",
        reasoning: "",
        toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "bad" } }],
        raw: {},
      },
      {
        text: "Handled unavailable tool.",
        reasoning: "",
        toolCalls: [],
        raw: {},
      },
    ];

    const runtime = createRuntime(new InMemoryToolRegistry([]));
    await runtime.startTurn({
      threadId: thread.id,
      text: "Run",
    });
    await waitFor(() =>
      events.some((event) => event.kind === "runtime_error") &&
      !runtime.isThreadInFlight(thread.id),
    );

    expect(events.find((event) => event.kind === "runtime_error")).toMatchObject({
      kind: "runtime_error",
      code: "tool_not_found",
      message: 'Tool "echo" is not available in this turn.',
    });
  });

  it("uses a configurable automatic tool budget and pauses for continuation", async () => {
    process.env.AGENT_MAX_TOOL_ROUNDS = "2";
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: true },
        async execute(call) {
          return JSON.stringify({ path: call.path, content: "still need more" });
        },
      },
    ]);
    fakePool.response = {
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call-read", name: "read_file", arguments: { path: "src/index.ts" } }],
      raw: {},
    };

    const runtime = createRuntime(registry);
    await runtime.startTurn({
      threadId: thread.id,
      text: "Keep inspecting",
    });
    await waitFor(() =>
      events.some((event) => event.kind === "turn_completed" && event.status === "needs_continuation") &&
      !runtime.isThreadInFlight(thread.id),
    );

    expect(fakePool.requests).toHaveLength(3);
    expect(fakePool.requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("You have used 2 of 2 automatic tool round(s)"),
        }),
      ]),
    );
    const systemItems = [];
    const toolItems = [];
    for await (const item of store.replayItems(thread.id)) {
      if (item.kind === "system") systemItems.push(item);
      if (item.kind === "tool") toolItems.push(item);
    }
    expect(toolItems.at(-1)).toMatchObject({
      kind: "tool",
      name: "read_file",
      status: "failed",
      result: {
        code: "tool_budget_exhausted",
        message: expect.stringContaining("tool was not executed"),
      },
    });
    expect(systemItems.at(-1)).toMatchObject({
      level: "warn",
      text: expect.stringContaining("Automatic tool budget reached after 2 round(s)"),
    });
    expect(systemItems.at(-1)?.text).toContain("AGENT_MAX_TOOL_ROUNDS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool_budget_reached",
          maxToolRounds: 2,
          attemptedToolCalls: 1,
        }),
      ]),
    );

    process.env.AGENT_MAX_TOOL_ROUNDS = "32";
    fakePool.response = {
      text: "Final after continue",
      reasoning: "",
      toolCalls: [],
      raw: {},
    };
    await runtime.startTurn({
      threadId: thread.id,
      text: "Continue",
    });
    await waitFor(() => fakePool.requests.length === 4 && !runtime.isThreadInFlight(thread.id));
    expect(fakePool.requests[3].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [
            expect.objectContaining({
              id: "call-read",
              name: "read_file",
              arguments: { path: "src/index.ts" },
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-read",
          content: expect.stringContaining("tool was not executed"),
        }),
      ]),
    );
  });

  it("interrupts turns, denies pending approvals, and emits interrupted completion", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "shell_command",
          description: "Run command",
          inputSchema: { type: "object" },
        },
        async execute() {
          return "executed";
        },
      },
    ]);
    fakePool.response = {
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call-1", name: "shell_command", arguments: {} }],
      raw: {},
    };
    const runtime = createRuntime(registry);
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Needs approval",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    await runtime.interruptTurn(turn.id);
    await waitFor(() =>
      events.some(
        (event) => event.kind === "turn_completed" && event.status === "interrupted",
      ),
    );

    expect(fakePool.canceledThreads).toEqual([thread.id]);
    expect(events.find((event) => event.kind === "item_updated" && event.item.kind === "approval")).toMatchObject({
      kind: "item_updated",
      item: expect.objectContaining({ kind: "approval", decision: "deny" }),
    });
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(finalItems(replayed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          name: "shell_command",
          status: "failed",
          result: expect.objectContaining({
            code: "tool_interrupted",
            message: "Command was interrupted.",
          }),
        }),
      ]),
    );
    expect(await fs.readdir(userDataDir)).toEqual(
      expect.arrayContaining(["threads", "config"]),
    );
  });

  it("keeps user interrupts from being reported as failed when cancel aborts chat", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 30;
    fakePool.rejectCanceledThreads = true;
    const runtime = createRuntime();
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Long run",
    });

    await runtime.interruptTurn(turn.id);
    await waitFor(() => !runtime.isThreadInFlight(thread.id) && fakePool.activeChats === 0);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn_completed",
          status: "interrupted",
        }),
      ]),
    );
    expect(events.some((event) => event.kind === "turn_failed")).toBe(false);
    expect(
      events.some(
        (event) => event.kind === "runtime_error" && event.message === "aborted by cancel",
      ),
    ).toBe(false);
  });

  it("rejects interrupt requests for turns that are not in flight", async () => {
    const runtime = createRuntime();

    await expect(runtime.interruptTurn("missing-turn")).rejects.toThrow(
      "Turn missing-turn is not in flight.",
    );
  });

  it("keeps repeated interrupts for the same in-flight turn idempotent", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 30;
    fakePool.rejectCanceledThreads = true;
    const runtime = createRuntime();
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Long run",
    });

    const firstInterrupt = runtime.interruptTurn(turn.id);
    const secondInterrupt = runtime.interruptTurn(turn.id);
    await Promise.all([firstInterrupt, secondInterrupt]);
    await waitFor(() => !runtime.isThreadInFlight(thread.id) && fakePool.activeChats === 0);

    expect(fakePool.canceledThreads).toEqual([thread.id]);
    expect(events.filter((event) =>
      event.kind === "item_appended" &&
      event.item.kind === "system" &&
      event.item.text === "Interrupted by user"
    )).toHaveLength(1);
    expect(events.filter((event) =>
      event.kind === "turn_completed" &&
      event.turnId === turn.id &&
      event.status === "interrupted"
    )).toHaveLength(1);
  });

  it("persists truncated streamed output before emitting interrupted completion", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 30;
    fakePool.chunks = [{ kind: "text_delta", text: "Partial" }];
    fakePool.rejectCanceledThreads = true;
    const runtime = createRuntime();
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Long run",
    });

    await waitFor(() =>
      events.some(
        (event) => event.kind === "item_updated" && event.item.kind === "assistant",
      ),
    );
    await runtime.interruptTurn(turn.id);
    await waitFor(() => !runtime.isThreadInFlight(thread.id) && fakePool.activeChats === 0);

    const truncatedAssistantIndex = events.findIndex(
      (event) =>
        event.kind === "item_appended" &&
        event.item.kind === "assistant" &&
        event.item.truncated === true,
    );
    const interruptedCompletionIndex = events.findIndex(
      (event) =>
        event.kind === "turn_completed" &&
        event.turnId === turn.id &&
        event.status === "interrupted",
    );
    expect(truncatedAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(interruptedCompletionIndex).toBeGreaterThan(truncatedAssistantIndex);
  });

  it("keeps interrupted turns terminal when partial stream persistence fails", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 30;
    fakePool.chunks = [{ kind: "text_delta", text: "Partial" }];
    fakePool.rejectCanceledThreads = true;
    const originalAppendItem = store.appendItem.bind(store);
    const appendItem = vi.spyOn(store, "appendItem");
    appendItem.mockImplementation(async (threadId, item) => {
      if (item.kind === "assistant" && item.truncated) {
        throw new Error("partial assistant write failed");
      }
      return originalAppendItem(threadId, item);
    });
    const runtime = createRuntime();
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Long run",
    });

    await waitFor(() =>
      events.some(
        (event) => event.kind === "item_updated" && event.item.kind === "assistant",
      ),
    );
    await runtime.interruptTurn(turn.id);
    await waitFor(() => !runtime.isThreadInFlight(thread.id) && fakePool.activeChats === 0);

    const terminalEvents = events.filter(
      (event) => event.kind === "turn_completed" && event.turnId === turn.id,
    );
    expect(terminalEvents).toEqual([
      expect.objectContaining({ status: "interrupted" }),
    ]);
    expect(events.some((event) => event.kind === "turn_failed")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "persistence_error",
          message: "partial assistant write failed",
        }),
      ]),
    );
    appendItem.mockRestore();
  });

  it("finishes interrupt cleanup when the interrupt notice cannot be persisted", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    fakePool.delayMs = 30;
    const originalAppendItem = store.appendItem.bind(store);
    const appendItem = vi.spyOn(store, "appendItem");
    appendItem.mockImplementation(async (threadId, item) => {
      if (item.kind === "system" && item.text === "Interrupted by user") {
        throw new Error("interrupt notice write failed");
      }
      return originalAppendItem(threadId, item);
    });
    const runtime = createRuntime();
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Long run",
    });

    await runtime.interruptTurn(turn.id);
    await waitFor(() => !runtime.isThreadInFlight(thread.id) && fakePool.activeChats === 0);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_error",
          code: "persistence_error",
          message: "interrupt notice write failed",
        }),
        expect.objectContaining({
          kind: "turn_completed",
          status: "interrupted",
        }),
      ]),
    );
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed.some((item) => item.kind === "assistant")).toBe(false);
    appendItem.mockRestore();
  });

  it("reports approval decision persistence failures without leaving the turn waiting", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "shell_command",
          description: "Run command",
          inputSchema: { type: "object" },
        },
        async execute() {
          return "executed";
        },
      },
    ]);
    fakePool.response = {
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call-1", name: "shell_command", arguments: {} }],
      raw: {},
    };
    const originalAppendItem = store.appendItem.bind(store);
    const appendItem = vi.spyOn(store, "appendItem");
    appendItem.mockImplementation(async (threadId, item) => {
      if (item.kind === "approval" && item.decision) {
        throw new Error("approval write failed");
      }
      return originalAppendItem(threadId, item);
    });
    const runtime = createRuntime(registry);
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Needs approval",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    await runtime.interruptTurn(turn.id);
    await waitFor(() =>
      events.some(
        (event) =>
          event.kind === "runtime_error" &&
          event.code === "persistence_error" &&
          event.message === "approval write failed",
      ),
    );
    await waitFor(() => !runtime.isThreadInFlight(thread.id));

    expect(events.find((event) => event.kind === "item_updated" && event.item.kind === "approval")).toMatchObject({
      kind: "item_updated",
      item: expect.objectContaining({ kind: "approval", decision: "deny" }),
    });
    appendItem.mockRestore();
  });

  it("does not execute approved tools after the turn is interrupted while approval resolution is settling", async () => {
    const thread = await store.createThread({
      title: "Runtime",
      workspace: "/workspace",
      mode: "code",
    });
    const executeTool = vi.fn(async () => "executed");
    const registry = new InMemoryToolRegistry([
      {
        definition: {
          name: "shell_command",
          description: "Run command",
          inputSchema: { type: "object" },
        },
        execute: executeTool,
      },
    ]);
    fakePool.response = {
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call-1", name: "shell_command", arguments: {} }],
      raw: {},
    };
    let releaseApprovalWrite: () => void = () => undefined;
    let markApprovalWriteStarted: () => void = () => undefined;
    const approvalWriteStarted = new Promise<void>((resolve) => {
      markApprovalWriteStarted = resolve;
    });
    const approvalWriteGate = new Promise<void>((resolve) => {
      releaseApprovalWrite = resolve;
    });
    const originalAppendItem = store.appendItem.bind(store);
    const appendItem = vi.spyOn(store, "appendItem");
    appendItem.mockImplementation(async (threadId, item) => {
      if (item.kind === "approval" && item.decision === "allow") {
        markApprovalWriteStarted();
        await approvalWriteGate;
      }
      return originalAppendItem(threadId, item);
    });
    const runtime = createRuntime(registry);
    const turn = await runtime.startTurn({
      threadId: thread.id,
      text: "Needs approval",
    });
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));
    const approval = events.find((event) => event.kind === "approval_requested");
    if (!approval || approval.kind !== "approval_requested") {
      throw new Error("Expected approval request.");
    }

    runtime.respondApproval({ approvalId: approval.approvalId, decision: "allow" });
    await approvalWriteStarted;
    await runtime.interruptTurn(turn.id);
    releaseApprovalWrite();
    await waitFor(() => !runtime.isThreadInFlight(thread.id));

    expect(executeTool).not.toHaveBeenCalled();
    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(finalItems(replayed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          name: "shell_command",
          status: "failed",
          result: expect.objectContaining({
            code: "tool_interrupted",
            message: "Command was interrupted.",
          }),
        }),
      ]),
    );
    appendItem.mockRestore();
  });

  it("rejects invalid or stale approval responses instead of treating them as success", () => {
    const runtime = createRuntime();

    expect(() =>
      runtime.respondApproval({ approvalId: "missing", decision: "allow" }),
    ).toThrow("Approval missing is not pending.");

    const invalidDecision = {
      approvalId: "missing",
      decision: "approve",
    } as unknown as ApprovalRespondRequest;
    expect(() => runtime.respondApproval(invalidDecision)).toThrow(
      "Approval decision must be allow or deny.",
    );
  });
});
