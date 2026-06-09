import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  RENDERER_TO_MAIN_CHANNELS,
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
  TURN_START_CHANNEL,
} from "../../src/shared/ipc";
import {
  DEFAULT_DEEPSEEK_MODEL_CONFIG,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
  DEFAULT_RUNTIME_PREFERENCES,
  DEFAULT_THREAD_APPROVAL_POLICY,
  DEFAULT_THREAD_LIST_RELATIONS,
  DEFAULT_THREAD_MODE,
  DEFAULT_THREAD_RELATION,
  DEFAULT_THREAD_SANDBOX_MODE,
  DEFAULT_THREAD_STATUS,
  ISO_TIMESTAMP_PATTERN,
  ITEM_KINDS,
  LLM_PROTOCOLS,
  MAX_ATTACHMENT_BYTES,
  RUNTIME_COMPACTION_STRATEGIES,
  RUNTIME_EVENT_KINDS,
  RUNTIME_TOOL_NAMES,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
  THREAD_APPROVAL_POLICIES,
  THREAD_GOAL_STATUSES,
  THREAD_MODES,
  THREAD_RELATIONS,
  THREAD_SANDBOX_MODES,
  THREAD_STATUSES,
  UUID_PATTERN,
  err,
  isAgentAutonomyLevel,
  isAttachmentRecord,
  isItem,
  isItemKind,
  isIsoTimestampString,
  isLlmProtocol,
  isModelReasoningEffort,
  isNonNegativeInteger,
  isRuntimeCompactionStrategy,
  isRuntimeEvent,
  isRuntimeEventKind,
  isRuntimePreferences,
  isRuntimeToolName,
  isThreadApprovalPolicy,
  isThreadGoalStatus,
  isThreadMode,
  isThreadRecord,
  isThreadRelation,
  isThreadSandboxMode,
  isThreadStatus,
  isUuidString,
  normalizeSupportedAttachmentMimeType,
  ok,
  type WritePutRequest,
} from "../../src/shared/agent-contracts";

describe("shared agent contracts", () => {
  it("validates model reasoning effort values", () => {
    expect(isModelReasoningEffort("low")).toBe(true);
    expect(isModelReasoningEffort("xhigh")).toBe(true);
    expect(isModelReasoningEffort("max")).toBe(false);
    expect(isModelReasoningEffort(undefined)).toBe(false);
  });

  it("validates agent autonomy values", () => {
    expect(isAgentAutonomyLevel("balanced")).toBe(true);
    expect(isAgentAutonomyLevel("deep")).toBe(true);
    expect(isAgentAutonomyLevel("unlimited")).toBe(false);
    expect(isAgentAutonomyLevel(undefined)).toBe(false);
  });

  it("creates stable IPC envelopes", () => {
    expect(ok({ id: "thread-1" })).toEqual({
      ok: true,
      value: { id: "thread-1" },
    });
    expect(err("RUNTIME_TURN_BUSY", "Turn is already running.")).toEqual({
      ok: false,
      code: "RUNTIME_TURN_BUSY",
      message: "Turn is already running.",
    });
  });

  it("validates LLM protocol values", () => {
    expect(LLM_PROTOCOLS).toEqual(["openai-compatible", "anthropic-compatible"]);
    expect(isLlmProtocol("openai-compatible")).toBe(true);
    expect(isLlmProtocol("anthropic-compatible")).toBe(true);
    expect(isLlmProtocol("custom")).toBe(false);
    expect(isLlmProtocol(undefined)).toBe(false);
  });

  it("keeps UUID validation as a shared persistence boundary", () => {
    expect(UUID_PATTERN.test("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuidString("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isUuidString("../outside")).toBe(false);
    expect(isUuidString("attachment-1")).toBe(false);
  });

  it("keeps ISO timestamp validation as a shared persistence boundary", () => {
    expect(ISO_TIMESTAMP_PATTERN.test("2026-06-08T00:00:00.000Z")).toBe(true);
    expect(isIsoTimestampString("2026-06-08T00:00:00.000Z")).toBe(true);
    expect(isIsoTimestampString("2026-06-08")).toBe(false);
    expect(isIsoTimestampString("2026-02-30T00:00:00.000Z")).toBe(false);
    expect(isIsoTimestampString("not-a-date")).toBe(false);
  });

  it("keeps key renderer-invoked channels in the allowlist", () => {
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(TURN_START_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(ATTACHMENT_DELETE_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(
      MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
    );
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(RUNTIME_PREFERENCES_GET_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(RUNTIME_PREFERENCES_UPDATE_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).not.toContain("agent:run");
  });

  it("keeps provider defaults internally consistent", () => {
    expect(DEFAULT_MODEL_CONFIG.model_auto_compact_token_limit).toBeLessThanOrEqual(
      DEFAULT_MODEL_CONFIG.model_context_window,
    );
    expect(DEFAULT_MODEL_CONFIG.max_tokens).toBeLessThan(
      DEFAULT_MODEL_CONFIG.model_context_window,
    );
    expect(DEFAULT_MODEL_CONFIG.agent_autonomy).toBe("balanced");
    expect(DEFAULT_MODEL_CONFIG.protocol).toBe("openai-compatible");
    expect(DEFAULT_DEEPSEEK_MODEL_CONFIG.model_provide).toBe("DeepSeek");
    expect(DEFAULT_DEEPSEEK_MODEL_CONFIG.base_url).toBe("https://api.deepseek.com");
  });

  it("keeps runtime preferences defaults and guards as a shared contract", () => {
    expect(RUNTIME_TOOL_NAMES).toContain("apply_patch");
    expect(RUNTIME_TOOL_NAMES).toContain("run_command");
    expect(RUNTIME_COMPACTION_STRATEGIES).toEqual([
      "balanced",
      "recent-only",
      "preserve-tools",
      "aggressive",
    ]);
    expect(isRuntimeToolName("diagnose_file")).toBe(true);
    expect(isRuntimeToolName("unknown_tool")).toBe(false);
    expect(isRuntimeCompactionStrategy("preserve-tools")).toBe(true);
    expect(isRuntimeCompactionStrategy("full-history")).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.defaultApprovalPolicy).toBe(
      DEFAULT_THREAD_APPROVAL_POLICY,
    );
    expect(DEFAULT_RUNTIME_PREFERENCES.defaultSandboxMode).toBe(
      DEFAULT_THREAD_SANDBOX_MODE,
    );
    expect(DEFAULT_RUNTIME_PREFERENCES.command.timeoutMs).toBe(
      DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
    );
    expect(DEFAULT_RUNTIME_PREFERENCES.command.maxOutputBytes).toBe(
      DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
    );
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code.apply_patch).toBe(true);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.apply_patch).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.run_command).toBe(false);
    expect(isRuntimePreferences(DEFAULT_RUNTIME_PREFERENCES)).toBe(true);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      command: { ...DEFAULT_RUNTIME_PREFERENCES.command, timeoutMs: 0 },
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      compaction: { ...DEFAULT_RUNTIME_PREFERENCES.compaction, strategy: "full-history" },
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      toolAvailability: {
        ...DEFAULT_RUNTIME_PREFERENCES.toolAvailability,
        write: {
          ...DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write,
          run_command: "false",
        },
      },
    })).toBe(false);
  });

  it("keeps supported attachment MIME types as a shared contract", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(12 * 1024 * 1024);
    expect(SUPPORTED_ATTACHMENT_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(normalizeSupportedAttachmentMimeType(" IMAGE/PNG ")).toBe("image/png");
    expect(normalizeSupportedAttachmentMimeType("image/svg+xml")).toBeNull();
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000001",
      name: "avatar.png",
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(true);
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000002",
      name: "avatar.svg",
      mimeType: "image/svg+xml",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(false);
    expect(isAttachmentRecord({
      id: "attachment-1",
      name: "avatar.png",
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(false);
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000003",
      name: "avatar.png",
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08",
    })).toBe(false);
  });

  it("keeps thread field domains as a shared contract", () => {
    expect(THREAD_RELATIONS).toEqual(["primary", "fork", "side"]);
    expect(THREAD_GOAL_STATUSES).toEqual(["active", "complete", "blocked"]);
    expect(THREAD_STATUSES).toEqual(["active", "archived"]);
    expect(THREAD_MODES).toEqual(["code", "write"]);
    expect(THREAD_APPROVAL_POLICIES).toEqual(["auto", "on-request", "untrusted", "never"]);
    expect(THREAD_SANDBOX_MODES).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(DEFAULT_THREAD_RELATION).toBe("primary");
    expect(DEFAULT_THREAD_MODE).toBe("code");
    expect(DEFAULT_THREAD_STATUS).toBe("active");
    expect(DEFAULT_THREAD_APPROVAL_POLICY).toBe("on-request");
    expect(DEFAULT_THREAD_SANDBOX_MODE).toBe("workspace-write");
    expect(DEFAULT_THREAD_LIST_RELATIONS).toEqual(["primary", "fork"]);

    expect(isThreadRelation("primary")).toBe(true);
    expect(isThreadRelation("branch")).toBe(false);
    expect(isThreadGoalStatus("blocked")).toBe(true);
    expect(isThreadGoalStatus("paused")).toBe(false);
    expect(isThreadStatus("archived")).toBe(true);
    expect(isThreadStatus("deleted")).toBe(false);
    expect(isThreadMode("write")).toBe(true);
    expect(isThreadMode("chat")).toBe(false);
    expect(isThreadApprovalPolicy("on-request")).toBe(true);
    expect(isThreadApprovalPolicy("sometimes")).toBe(false);
    expect(isThreadSandboxMode("workspace-write")).toBe(true);
    expect(isThreadSandboxMode("full-access")).toBe(false);
    expect(isThreadRecord({
      id: "thread-1",
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(true);
    expect(isThreadRecord({
      id: "thread-1",
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "sometimes",
      sandboxMode: "workspace-write",
    })).toBe(false);
  });

  it("keeps item and runtime event kinds as shared contracts", () => {
    expect(ITEM_KINDS).toEqual([
      "user",
      "assistant",
      "reasoning",
      "tool",
      "compaction",
      "approval",
      "user_input",
      "plan",
      "system",
    ]);
    expect(RUNTIME_EVENT_KINDS).toEqual([
      "turn_started",
      "turn_completed",
      "turn_failed",
      "item_appended",
      "item_updated",
      "approval_requested",
      "tool_budget_reached",
      "goal_updated",
      "runtime_error",
    ]);
    expect(isItemKind("plan")).toBe(true);
    expect(isItemKind("unknown")).toBe(false);
    expect(isRuntimeEventKind("tool_budget_reached")).toBe(true);
    expect(isRuntimeEventKind("tool_started")).toBe(false);
  });

  it("keeps write put requests limited to the implemented plain write contract", () => {
    const request = {
      workspace: "/workspace",
      path: "notes.md",
      content: "# Notes\n",
    } satisfies WritePutRequest;

    expect(request).toEqual({
      workspace: "/workspace",
      path: "notes.md",
      content: "# Notes\n",
    });
  });

  it("recognizes tool budget runtime events", () => {
    const event = {
        kind: "tool_budget_reached",
        threadId: "thread-1",
        turnId: "turn-1",
        maxToolRounds: 32,
        attemptedToolCalls: 1,
        message: "Continue",
        reachedAt: "2026-06-08T00:00:00.000Z",
    };
    expect(isRuntimeEvent(event)).toBe(true);
    expect(isRuntimeEvent({ ...event, maxToolRounds: 0 })).toBe(false);
    expect(isRuntimeEvent({ ...event, attemptedToolCalls: -1 })).toBe(false);
    expect(isRuntimeEvent({ ...event, attemptedToolCalls: 1.5 })).toBe(false);
  });

  it("validates approval preview shapes on items and events", () => {
    const preview = {
      kind: "file_diff",
      path: "src/index.ts",
      operation: "update",
      added: 1,
      removed: 1,
      lines: [
        { type: "removed", text: "old" },
        { type: "added", text: "new" },
      ],
    };
    expect(
      isItem({
        kind: "approval",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "edit_file",
        args: {},
        preview,
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isRuntimeEvent({
        kind: "approval_requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "edit_file",
        args: {},
        preview,
      }),
    ).toBe(true);
    expect(
      isItem({
        kind: "approval",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "edit_file",
        args: {},
        preview: { kind: "file_diff", path: "src/index.ts" },
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "approval_requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "edit_file",
        args: {},
        preview: { kind: "multi_file_diff", files: [{ kind: "file_diff" }] },
      }),
    ).toBe(false);
    expect(
      isItem({
        kind: "approval",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "edit_file",
        args: {},
        preview: {
          kind: "file_diff",
          path: "src/index.ts",
          operation: "update",
          added: -1,
          removed: 0,
          lines: [],
        },
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "approval_requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "apply_patch",
        args: {},
        preview: {
          kind: "multi_file_diff",
          files: [],
          added: 1.5,
          removed: 0,
        },
      }),
    ).toBe(false);
  });

  it("rejects records that only have a known kind but miss required fields", () => {
    expect(isItem({ kind: "assistant", id: "item-1" })).toBe(false);
    expect(
      isItem({
        kind: "assistant",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Hello",
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isItem({
        kind: "assistant",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Hello",
        createdAt: "not-a-date",
      }),
    ).toBe(false);
    expect(
      isItem({
        kind: "compaction",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        summary: "Compact",
        replacedItemCount: 2,
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isItem({
        kind: "compaction",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        summary: "Compact",
        replacedItemCount: 1.5,
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isItem({
        kind: "user",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "See attached",
        attachmentIds: ["attachment-1"],
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "avatar.png",
            mimeType: "image/png",
            size: 128,
            createdAt: "2026-06-08T00:00:00.000Z",
          },
        ],
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isItem({
        kind: "user",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "See attached",
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            name: "avatar.svg",
            mimeType: "image/svg+xml",
            size: 128,
            createdAt: "2026-06-08T00:00:00.000Z",
          },
        ],
        createdAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(isRuntimeEvent({ kind: "turn_completed", threadId: "thread-1" })).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "runtime_error",
        threadId: "thread-1",
        turnId: "turn-1",
        code: "provider_http",
        message: "LLM stream failed with HTTP 429",
      }),
    ).toBe(true);
    expect(
      isRuntimeEvent({
        kind: "runtime_error",
        threadId: "thread-1",
        turnId: "turn-1",
        code: "provider_error",
        message: "LLM stream error event: rate limited",
      }),
    ).toBe(true);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "in-flight",
        completedAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-08T00:00:00.000Z",
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          totalTokens: 11,
          cacheHitRate: null,
        },
      }),
    ).toBe(true);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-08",
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-08T00:00:00.000Z",
        usage: {
          inputTokens: "8",
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-08T00:00:00.000Z",
        usage: {
          inputTokens: -1,
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-08T00:00:00.000Z",
        usage: {
          outputTokens: 1.5,
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        completedAt: "2026-06-08T00:00:00.000Z",
        usage: {
          cacheHitRate: 1.1,
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "turn_started",
        threadId: "thread-1",
        turnId: "turn-1",
        startedAt: "2026-06-08T00:00:00.000Z",
        turn: {
          id: "turn-1",
          threadId: "thread-1",
          status: "in-flight",
          startedAt: "2026-06-08T00:00:00.000Z",
          model: "MiniMax-M3",
          mode: "agent",
          goalMode: false,
          usage: { totalTokens: "11" },
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeEvent({
        kind: "goal_updated",
        threadId: "thread-1",
        goal: {
          text: "Ship",
          status: "active",
          createdAt: "2026-06-08",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});
