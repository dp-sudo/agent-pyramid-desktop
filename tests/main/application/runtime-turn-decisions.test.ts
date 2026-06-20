import { describe, expect, it } from "vitest";
import {
  GOAL_MODE_INSTRUCTION,
  PLAN_MODE_INSTRUCTION,
  buildRuntimeContextMessages,
  resolveTurnModelProfile,
} from "../../../src/main/application/runtime-turn-decisions";
import type {
  ModelConfig,
  ModelConfigProfile,
  ModelConfigProfilesState,
  RuntimePreferences,
  ThreadRecord,
  TurnRecord,
} from "../../../src/shared/agent-contracts";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_RUNTIME_PREFERENCES,
} from "../../../src/shared/agent-contracts";
import type { SkillTurnResolution } from "../../../src/shared/skills";

describe("runtime turn decisions", () => {
  it("resolves model profiles by explicit request, mode default, request model, active profile, then fallback", () => {
    const code = profile("code", "code-model");
    const write = profile("write", "write-model");
    const active = profile("active", "active-model");
    const state: ModelConfigProfilesState = {
      activeProfileId: active.id,
      profiles: [code, write, active],
    };
    const preferences: RuntimePreferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      codeDefaultModelProfileId: code.id,
      writeDefaultModelProfileId: write.id,
    };

    expect(resolveTurnModelProfile(
      state,
      { threadId: "thread", text: "Hi", modelProfileId: active.id },
      "code",
      preferences,
    )).toBe(active);
    expect(resolveTurnModelProfile(
      state,
      { threadId: "thread", text: "Hi" },
      "write",
      preferences,
    )).toBe(write);
    expect(resolveTurnModelProfile(
      state,
      { threadId: "thread", text: "Hi", model: "active-model" },
      "code",
      { ...preferences, codeDefaultModelProfileId: null },
    )).toBe(active);
    expect(resolveTurnModelProfile(
      state,
      { threadId: "thread", text: "Hi" },
      "code",
      { ...preferences, codeDefaultModelProfileId: "missing" },
    )).toBe(active);
    expect(resolveTurnModelProfile(
      { activeProfileId: "missing", profiles: [code] },
      { threadId: "thread", text: "Hi" },
      "code",
      { ...preferences, codeDefaultModelProfileId: null },
    )).toBe(code);
  });

  it("throws traceable errors for missing explicit or empty profile states", () => {
    const state: ModelConfigProfilesState = {
      activeProfileId: "active",
      profiles: [profile("active", "active-model")],
    };

    expect(() =>
      resolveTurnModelProfile(
        state,
        { threadId: "thread", text: "Hi", modelProfileId: "missing" },
        "code",
        DEFAULT_RUNTIME_PREFERENCES,
      ),
    ).toThrow("Model config profile missing not found.");
    expect(() =>
      resolveTurnModelProfile(
        { activeProfileId: "missing", profiles: [] },
        { threadId: "thread", text: "Hi" },
        "code",
        DEFAULT_RUNTIME_PREFERENCES,
      ),
    ).toThrow("No model config profile is available.");
  });

  it("builds runtime context messages for plan, goal, and skill instructions", () => {
    const messages = buildRuntimeContextMessages({
      turn: turn({ mode: "plan", goalMode: true }),
      thread: thread({ goal: {
        text: "Ship the feature",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } }),
      skillResolution: skillResolution(["Use repo vocabulary."]),
    });

    expect(messages).toEqual([{
      role: "system",
      content: [
        PLAN_MODE_INSTRUCTION,
        GOAL_MODE_INSTRUCTION,
        "Current thread goal: Ship the feature",
        [
          "Matched Agent Skills are active for this turn.",
          "Follow each Active Skill instruction when it is relevant to the user's request.",
          "Use repo vocabulary.",
        ].join("\n\n"),
      ].join("\n\n"),
    }]);
  });

  it("does not add context messages when no runtime context is active", () => {
    expect(buildRuntimeContextMessages({
      turn: turn(),
      thread: thread(),
      skillResolution: null,
    })).toEqual([]);
  });
});

function profile(id: string, model: string): ModelConfigProfile {
  return {
    id,
    name: id,
    config: {
      ...DEFAULT_MODEL_CONFIG,
      model,
    } satisfies ModelConfig,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function thread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread",
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

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn",
    threadId: "thread",
    status: "in-flight",
    startedAt: "2026-01-01T00:00:00.000Z",
    model: "model",
    mode: "agent",
    ...overrides,
  };
}

function skillResolution(instructions: string[]): SkillTurnResolution {
  return {
    activeSkillIds: [],
    activations: [],
    instructions,
    injectedBytes: 0,
    validationErrors: [],
  };
}
