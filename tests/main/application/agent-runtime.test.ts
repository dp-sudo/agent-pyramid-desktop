import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../../src/main/application/agent-runtime";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import type { LlmRequest, LlmResponse, LlmStreamChunk } from "../../../src/main/domain/agent/types";
import { AttachmentStore } from "../../../src/main/persistence/attachment-store";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import { ModelConfigStore } from "../../../src/main/persistence/model-config-store";
import type { LlmWorkerPool } from "../../../src/main/infrastructure/llm-worker/worker-pool";
import type { RuntimeEvent } from "../../../src/shared/agent-contracts";
import { DEFAULT_MODEL_CONFIG } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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
  delayMs = 0;

  async chat(
    thread: { id: string },
    request: LlmRequest,
    onChunk: (chunk: LlmStreamChunk) => void,
  ): Promise<LlmResponse> {
    void thread;
    this.requests.push(request);
    for (const chunk of this.chunks) {
      onChunk(chunk);
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.responses.shift() ?? this.response;
  }

  cancel(threadId: string): void {
    this.canceledThreads.push(threadId);
  }
}

function finalItems<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AgentRuntime", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;
  let attachmentStore: AttachmentStore;
  let modelConfigStore: ModelConfigStore;
  let bus: RuntimeEventBus;
  let fakePool: FakePool;
  let events: RuntimeEvent[];

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-runtime-");
    store = new JsonlThreadStore(userDataDir);
    attachmentStore = new AttachmentStore(userDataDir);
    modelConfigStore = new ModelConfigStore(userDataDir);
    bus = new RuntimeEventBus();
    fakePool = new FakePool();
    events = [];
    for (const kind of [
      "turn_started",
      "turn_completed",
      "turn_failed",
      "item_appended",
      "item_updated",
      "approval_requested",
      "goal_updated",
      "runtime_error",
    ] as const) {
      bus.on(kind, (event) => events.push(event));
    }
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  function createRuntime(registry = new InMemoryToolRegistry([])): AgentRuntime {
    return new AgentRuntime({
      store,
      attachmentStore,
      modelConfigStore,
      pool: fakePool as unknown as LlmWorkerPool,
      bus,
      registry,
    });
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

    const replayed = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed.map((item) => item.kind)).toEqual(["user", "reasoning", "assistant"]);
    expect(replayed.at(-1)).toMatchObject({ kind: "assistant", text: "Hello" });
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
    expect(await store.getThread(thread.id)).toMatchObject({
      goal: { text: "Finish testing", status: "active" },
    });
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

    await createRuntime(new InMemoryToolRegistry([])).startTurn({
      threadId: thread.id,
      text: "Run",
    });
    await waitFor(() => events.some((event) => event.kind === "runtime_error"));

    expect(events.find((event) => event.kind === "runtime_error")).toMatchObject({
      kind: "runtime_error",
      code: "internal",
      message: 'Tool "echo" is not available in this turn.',
    });
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
    expect(events.find((event) => event.kind === "item_updated")).toMatchObject({
      kind: "item_updated",
      item: expect.objectContaining({ kind: "approval", decision: "deny" }),
    });
    expect(await fs.readdir(userDataDir)).toEqual(
      expect.arrayContaining(["threads", "config"]),
    );
  });
});
