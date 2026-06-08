import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  RENDERER_TO_MAIN_CHANNELS,
  TURN_START_CHANNEL,
} from "../../src/shared/ipc";
import {
  DEFAULT_DEEPSEEK_MODEL_CONFIG,
  DEFAULT_MODEL_CONFIG,
  err,
  isAgentAutonomyLevel,
  isModelReasoningEffort,
  isRuntimeEvent,
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

  it("keeps key renderer-invoked channels in the allowlist", () => {
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(TURN_START_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(ATTACHMENT_DELETE_CHANNEL);
    expect(RENDERER_TO_MAIN_CHANNELS).toContain(
      MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
    );
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
    expect(DEFAULT_DEEPSEEK_MODEL_CONFIG.model_provide).toBe("DeepSeek");
    expect(DEFAULT_DEEPSEEK_MODEL_CONFIG.base_url).toBe("https://api.deepseek.com");
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
    expect(
      isRuntimeEvent({
        kind: "tool_budget_reached",
        threadId: "thread-1",
        turnId: "turn-1",
        maxToolRounds: 32,
        attemptedToolCalls: 1,
        message: "Continue",
        reachedAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});
