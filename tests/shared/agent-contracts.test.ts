import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  RENDERER_TO_MAIN_CHANNELS,
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
  SKILL_LIST_CHANNEL,
  SSE_SUBSCRIBE_GLOBAL_CHANNEL,
  SSE_UNSUBSCRIBE_GLOBAL_CHANNEL,
  TURN_START_CHANNEL,
} from "../../src/shared/ipc";
import {
  DEFAULT_DEEPSEEK_MODEL_CONFIG,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_COMMAND_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_SKILLS_ACTIVE_LIMIT,
  DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
  DEFAULT_RUNTIME_PREFERENCES,
  DEFAULT_THREAD_APPROVAL_POLICY,
  DEFAULT_THREAD_LIST_RELATIONS,
  DEFAULT_THREAD_MODE,
  DEFAULT_THREAD_RELATION,
  DEFAULT_THREAD_SANDBOX_MODE,
  DEFAULT_THREAD_STATUS,
  DEFAULT_THREAD_TITLE,
  ISO_TIMESTAMP_PATTERN,
  ITEM_KINDS,
  LLM_PROTOCOLS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
  MCP_SERVER_TRANSPORTS,
  PLAN_STEP_STATUSES,
  RUNTIME_COMPACTION_STRATEGIES,
  RUNTIME_EVENT_KINDS,
  RUNTIME_READ_ONLY_TOOL_NAMES,
  RUNTIME_TOOL_NAMES,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
  THREAD_APPROVAL_POLICIES,
  THREAD_GOAL_STATUSES,
  THREAD_MODES,
  THREAD_RELATIONS,
  THREAD_SANDBOX_MODES,
  THREAD_STATUSES,
  TOOL_FAILURE_CODES,
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
  isSkillListResponse,
  isMcpServerTransport,
  isRuntimeToolName,
  isToolFailureCode,
  isToolFailureResult,
  isThreadApprovalPolicy,
  isThreadGoalStatus,
  isThreadMode,
  isThreadRecord,
  isThreadRelation,
  isThreadSandboxMode,
  isThreadStatus,
  isUuidString,
  normalizeAttachmentName,
  normalizeSupportedAttachmentMimeType,
  ok,
  type WritePutRequest,
} from "../../src/shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../src/shared/ipc-errors";

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
    expect(err(IPC_ERROR_CODES.RUNTIME_TURN_BUSY, "Turn is already running.")).toEqual({
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

  it("validates structured tool failure results", () => {
    expect(TOOL_FAILURE_CODES).toEqual([
      "tool_unavailable",
      "tool_not_registered",
      "tool_schema_invalid",
      "tool_repeat_suppressed",
      "tool_policy_denied",
      "tool_approval_denied",
      "tool_interrupted",
      "tool_execution_failed",
      "tool_budget_exhausted",
    ]);
    expect(isToolFailureCode("tool_schema_invalid")).toBe(true);
    expect(isToolFailureCode("schema_invalid")).toBe(false);
    expect(isToolFailureResult({
      code: "tool_repeat_suppressed",
      message: "Duplicate read-only call suppressed.",
      suppressed: true,
      reason: "repeat_read_only_tool_call",
      count: 3,
      threshold: 3,
    })).toBe(true);
    expect(isToolFailureResult({
      code: "tool_policy_denied",
      message: "Denied.",
      denied: true,
    })).toBe(true);
    expect(isToolFailureResult({
      code: "tool_policy_denied",
      denied: true,
    })).toBe(false);
    expect(isToolFailureResult({
      code: "tool_execution_failed",
      message: "Failed.",
      count: -1,
    })).toBe(false);
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
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(SKILL_LIST_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(SSE_SUBSCRIBE_GLOBAL_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(SSE_UNSUBSCRIBE_GLOBAL_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).not.toContain("agent:run");
  });

  it("validates public skill catalog response summaries", () => {
    const response = {
      workspace: "/workspace",
      enabled: true,
      roots: [
        { path: "/workspace/.agent/skills", scope: "project", missingIsError: false },
        { path: "/home/me/skills", scope: "custom", missingIsError: true },
      ],
      validationErrors: [
        { root: "/workspace/.agent/skills", message: "Invalid SKILL.md" },
      ],
      skills: [
        {
          id: "project/example",
          name: "Example",
          description: "Example skill",
          version: "1.0.0",
          runAs: "inline",
          scope: "project",
          priority: 100,
          rootDir: "/workspace/.agent/skills/example",
          skillPath: "/workspace/.agent/skills/example/SKILL.md",
          allowedTools: ["read_file"],
          trigger: {
            manual: true,
            commands: ["/example"],
            keywords: ["example"],
            promptPatterns: ["review"],
            fileTypes: [".ts"],
          },
          referenceCount: 1,
          referenceNames: ["notes"],
        },
      ],
    };
    const skillEntry = response.skills[0];
    if (!skillEntry) throw new Error("Expected skill catalog entry.");

    expect(isSkillListResponse(response)).toBe(true);
    expect(isSkillListResponse({
      ...response,
      skills: [{ ...skillEntry, scope: "global" }],
    })).toBe(false);
    expect(isSkillListResponse({
      ...response,
      roots: [{ path: "/workspace/.agent/skills", scope: "global" }],
    })).toBe(false);
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
    expect(RUNTIME_TOOL_NAMES).toContain("multi_edit");
    expect(RUNTIME_TOOL_NAMES).toContain("run_command");
    expect(RUNTIME_TOOL_NAMES).toContain("list_skills");
    expect(RUNTIME_TOOL_NAMES).toContain("run_skill");
    expect(RUNTIME_READ_ONLY_TOOL_NAMES).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "rg_search",
      "list_symbols",
      "git_status",
      "git_diff",
      "git_log",
      "git_branch",
      "package_scripts",
      "list_command_sessions",
      "read_command_session",
      "detect_shell_environment",
      "diagnose_file",
      "list_skills",
      "run_skill",
    ]);
    expect(RUNTIME_READ_ONLY_TOOL_NAMES.every((toolName) =>
      RUNTIME_TOOL_NAMES.includes(toolName),
    )).toBe(true);
    expect(PLAN_STEP_STATUSES).toEqual(["pending", "in_progress", "completed"]);
    expect(RUNTIME_COMPACTION_STRATEGIES).toEqual([
      "balanced",
      "recent-only",
      "preserve-tools",
      "aggressive",
    ]);
    expect(isRuntimeToolName("diagnose_file")).toBe(true);
    expect(isRuntimeToolName("list_symbols")).toBe(true);
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
    expect(DEFAULT_RUNTIME_PREFERENCES.skills).toEqual({
      enabled: true,
      activeLimit: DEFAULT_RUNTIME_SKILLS_ACTIVE_LIMIT,
      instructionBudgetBytes: DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
      extraRoots: [],
    });
    expect(DEFAULT_RUNTIME_PREFERENCES.permissionRules).toEqual([]);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code.apply_patch).toBe(true);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.apply_patch).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code.multi_edit).toBe(true);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.multi_edit).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code.list_command_sessions).toBe(true);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.list_command_sessions).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.code.list_symbols).toBe(true);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.list_symbols).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.run_command).toBe(false);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.list_skills).toBe(true);
    expect(DEFAULT_RUNTIME_PREFERENCES.toolAvailability.write.run_skill).toBe(true);
    expect(isRuntimePreferences(DEFAULT_RUNTIME_PREFERENCES)).toBe(true);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      command: { ...DEFAULT_RUNTIME_PREFERENCES.command, timeoutMs: 0 },
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      codeDefaultModelProfileId: "",
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      writeDefaultModelProfileId: " write-profile ",
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      compaction: { ...DEFAULT_RUNTIME_PREFERENCES.compaction, strategy: "full-history" },
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      skills: { ...DEFAULT_RUNTIME_PREFERENCES.skills, activeLimit: -1 },
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      skills: {
        ...DEFAULT_RUNTIME_PREFERENCES.skills,
        extraRoots: ["custom-skills", " custom-skills "],
      },
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      skills: {
        ...DEFAULT_RUNTIME_PREFERENCES.skills,
        extraRoots: ["custom-skills", ""],
      },
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
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      permissionRules: [
        { id: "bad", tool: "command", pattern: "npm *", effect: "sometimes" },
      ],
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      permissionRules: [
        { id: "duplicate", tool: "command", pattern: "npm *", effect: "allow" },
        { id: " duplicate ", tool: "write", pattern: "src/*", effect: "ask" },
      ],
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      permissionRules: [
        { id: "bad\0id", tool: "command", pattern: "npm *", effect: "deny" },
      ],
    })).toBe(false);
    expect(MCP_SERVER_TRANSPORTS).toEqual(["stdio", "streamable-http"]);
    expect(isMcpServerTransport("stdio")).toBe(true);
    expect(isMcpServerTransport("streamable-http")).toBe(true);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [],
    })).toBe(true);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [
        {
          id: "server-1",
          name: "local-mcp",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
        {
          id: "server-2",
          name: "remote-mcp",
          transport: "streamable-http",
          args: [],
          env: {},
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer test" },
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      ],
    })).toBe(true);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [
        {
          id: "server-1",
          name: "docs mcp",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
        {
          id: "server-2",
          name: "docs_mcp",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      ],
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [
        {
          id: "server-1",
          name: "local-mcp",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          url: "not-a-url",
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      ],
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [
        {
          id: "server-1",
          name: "remote-mcp",
          transport: "streamable-http",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      ],
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [
        {
          id: "server-1",
          name: "remote-mcp",
          transport: "streamable-http",
          args: [],
          env: {},
          url: "https://mcp.example.test/mcp",
          headers: {
            Authorization: "Bearer one",
            " Authorization ": "Bearer two",
          },
          enabled: true,
          readOnlyTools: [],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      ],
    })).toBe(false);
    expect(isRuntimePreferences({
      ...DEFAULT_RUNTIME_PREFERENCES,
      mcpServers: [
        {
          id: "server-1",
          name: "local-mcp",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          headers: {},
          enabled: true,
          readOnlyTools: ["tools/list", "   "],
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      ],
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
    expect(MAX_ATTACHMENT_NAME_LENGTH).toBe(180);
    expect(normalizeAttachmentName(" ../avatar.png ")).toBe("avatar.png");
    expect(normalizeAttachmentName("C:\\Users\\dev\\avatar.png")).toBe("avatar.png");
    expect(normalizeAttachmentName("/")).toBeNull();
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
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000004",
      name: "",
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(false);
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000005",
      name: "..",
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(false);
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000006",
      name: "nested/avatar.png",
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(false);
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000007",
      name: "a".repeat(MAX_ATTACHMENT_NAME_LENGTH + 1),
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-06-08T00:00:00.000Z",
    })).toBe(false);
    expect(isAttachmentRecord({
      id: "00000000-0000-4000-8000-000000000008",
      name: "empty.png",
      mimeType: "image/png",
      size: 0,
      createdAt: "2026-06-08T00:00:00.000Z",
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
    expect(DEFAULT_THREAD_TITLE).toBe("New thread");
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
    const primaryThreadId = "00000000-0000-4000-8000-000000000101";
    const forkThreadId = "00000000-0000-4000-8000-000000000102";

    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      goal: {
        text: "Ship",
        status: "active",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      },
    })).toBe(true);
    expect(isThreadRecord({
      id: forkThreadId,
      title: "Fork",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "fork",
      parentThreadId: primaryThreadId,
      forkedAt: "2026-06-08T00:00:00.000Z",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(true);
    expect(isThreadRecord({
      id: "00000000-0000-4000-8000-000000000103",
      title: "Windows Drive",
      workspace: "C:\\workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(true);
    expect(isThreadRecord({
      id: "00000000-0000-4000-8000-000000000104",
      title: "Windows Rooted",
      workspace: "\\workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(true);
    expect(isThreadRecord({
      id: "00000000-0000-4000-8000-000000000105",
      title: "Windows UNC",
      workspace: "\\\\server\\share",
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
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "   ",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      parentThreadId: forkThreadId,
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      forkedAt: "2026-06-08T00:00:00.000Z",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      goal: {
        text: "   ",
        status: "active",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      },
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      goal: {
        text: "Ship",
        status: "active",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
        summary: "   ",
      },
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "relative/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
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
    expect(isThreadRecord({
      id: forkThreadId,
      title: "Fork",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "fork",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: forkThreadId,
      title: "Fork",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "fork",
      parentThreadId: 1,
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })).toBe(false);
    expect(isThreadRecord({
      id: primaryThreadId,
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      goal: {
        text: "Ship",
        status: "paused",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      },
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
      "tool_progress",
      "mcp_server_connection",
      "mcp_tool_list_changed",
      "mcp_surface_changed",
      "tool_budget_reached",
      "goal_updated",
      "runtime_error",
    ]);
    expect(isItemKind("plan")).toBe(true);
    expect(isItemKind("unknown")).toBe(false);
    expect(isRuntimeEventKind("tool_progress")).toBe(true);
    expect(isRuntimeEventKind("mcp_surface_changed")).toBe(true);
    expect(isRuntimeEventKind("tool_started")).toBe(false);
    expect(isRuntimeEvent({
      kind: "mcp_server_connection",
      serverId: "server-1",
      serverName: "local-mcp",
      status: "lazy",
      toolCount: 1,
      occurredAt: "2026-06-08T00:00:00.000Z",
      message: "Retrying from cached MCP schema.",
    })).toBe(true);
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

  it("recognizes tool progress runtime events", () => {
    const event = {
      kind: "tool_progress",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      chunk: "running\n",
      stream: "stdout",
      seq: 1,
    };
    expect(isRuntimeEvent(event)).toBe(true);
    expect(isRuntimeEvent({ ...event, stream: "stdin" })).toBe(false);
    expect(isRuntimeEvent({ ...event, seq: 0 })).toBe(false);
    expect(isRuntimeEvent({ ...event, chunk: 1 })).toBe(false);
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
    const validTurnStarted = {
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
        toolCatalog: {
          fingerprint: "catalog-a",
          toolCount: 2,
          toolNames: ["read_file", "write_file"],
        },
      },
    };
    expect(isRuntimeEvent(validTurnStarted)).toBe(true);
    expect(isRuntimeEvent({
      ...validTurnStarted,
      turn: { ...validTurnStarted.turn, threadId: "thread-2" },
    })).toBe(false);
    expect(isRuntimeEvent({
      ...validTurnStarted,
      turn: { ...validTurnStarted.turn, id: "turn-2" },
    })).toBe(false);
    expect(isRuntimeEvent({
      ...validTurnStarted,
      turn: { ...validTurnStarted.turn, startedAt: "2026-06-08T00:00:01.000Z" },
    })).toBe(false);
    expect(isRuntimeEvent({
      ...validTurnStarted,
      turn: {
        ...validTurnStarted.turn,
        toolCatalog: {
          fingerprint: "catalog-a",
          toolCount: 3,
          toolNames: ["read_file", "write_file"],
        },
      },
    })).toBe(false);
    expect(isRuntimeEvent({
      ...validTurnStarted,
      turn: {
        ...validTurnStarted.turn,
        toolCatalog: {
          fingerprint: "catalog-a",
          toolCount: 1,
          toolNames: [""],
        },
      },
    })).toBe(false);
    const validItemEvent = {
      kind: "item_appended",
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        kind: "system",
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "notice",
        level: "info",
        createdAt: "2026-06-08T00:00:00.000Z",
      },
    };
    expect(isRuntimeEvent(validItemEvent)).toBe(true);
    expect(isRuntimeEvent({
      ...validItemEvent,
      item: { ...validItemEvent.item, threadId: "thread-2" },
    })).toBe(false);
    expect(isRuntimeEvent({
      ...validItemEvent,
      item: { ...validItemEvent.item, turnId: "turn-2" },
    })).toBe(false);
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
    expect(
      isRuntimeEvent({
        kind: "goal_updated",
        threadId: "thread-1",
        goal: {
          text: "   ",
          status: "active",
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});
