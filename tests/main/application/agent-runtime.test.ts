import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../../src/main/application/agent-runtime";
import { createCommandTools } from "../../../src/main/application/tools/command-tools";
import { createCodingTools } from "../../../src/main/application/tools/coding-tools";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import { createWorkspaceTools } from "../../../src/main/application/tools/workspace-tools";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import type { LlmRequest, LlmResponse, LlmStreamChunk } from "../../../src/main/domain/agent/types";
import { AttachmentStore } from "../../../src/main/persistence/attachment-store";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import { ModelConfigStore } from "../../../src/main/persistence/model-config-store";
import type { LlmWorkerPool } from "../../../src/main/infrastructure/llm-worker/worker-pool";
import type { ApprovalRespondRequest, RuntimeEvent } from "../../../src/shared/agent-contracts";
import { DEFAULT_MODEL_CONFIG } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function nodeCommand(script: string): string {
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

describe("AgentRuntime", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;
  let attachmentStore: AttachmentStore;
  let modelConfigStore: ModelConfigStore;
  let bus: RuntimeEventBus;
  let fakePool: FakePool;
  let events: RuntimeEvent[];
  let previousMaxToolRounds: string | undefined;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-runtime-");
    store = new JsonlThreadStore(userDataDir);
    attachmentStore = new AttachmentStore(userDataDir);
    modelConfigStore = new ModelConfigStore(userDataDir);
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
                command: nodeCommand("process.stdout.write('hello runtime');"),
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
          command: nodeCommand("process.stdout.write('hello runtime');"),
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
          timedOut: false,
        },
      });
    } finally {
      await removeTempDir(workspace);
    }
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
                timeout_ms: 120000,
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
    await waitFor(() => fakePool.requests.length === 3);

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
    await waitFor(() => fakePool.requests.length === 3);

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
    await waitFor(() => events.some((event) => event.kind === "turn_completed" && event.status === "needs_continuation"));

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
    await waitFor(() => fakePool.requests.length === 4);
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
    expect(events.find((event) => event.kind === "item_updated")).toMatchObject({
      kind: "item_updated",
      item: expect.objectContaining({ kind: "approval", decision: "deny" }),
    });
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

    expect(events.find((event) => event.kind === "item_updated")).toMatchObject({
      kind: "item_updated",
      item: expect.objectContaining({ kind: "approval", decision: "deny" }),
    });
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
