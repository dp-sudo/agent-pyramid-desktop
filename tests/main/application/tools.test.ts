import { describe, expect, it, vi } from "vitest";
import { createPlanTool } from "../../../src/main/application/tools/create-plan-tool";
import { echoTool } from "../../../src/main/application/tools/echo-tool";
import { createGoalTools } from "../../../src/main/application/tools/goal-tools";
import { InMemoryToolRegistry } from "../../../src/main/application/tools/in-memory-tool-registry";
import type { ThreadGoalStatus } from "../../../src/shared/agent-contracts";

describe("application tools", () => {
  it("registers and executes tools by name", async () => {
    const registry = new InMemoryToolRegistry([echoTool]);

    expect(registry.listDefinitions()).toEqual([echoTool.definition]);
    await expect(
      registry.execute(
        { id: "call-1", name: "echo", arguments: { text: "hello" } },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).resolves.toEqual({
      toolCallId: "call-1",
      name: "echo",
      content: "hello",
    });
  });

  it("keeps missing and invalid tool failures observable", async () => {
    const registry = new InMemoryToolRegistry([echoTool]);

    await expect(
      registry.execute(
        { id: "call-1", name: "missing", arguments: {} },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    ).rejects.toThrow('Tool "missing" is not registered.');

    await expect(echoTool.execute({}, { threadId: "thread-1", turnId: "turn-1" }))
      .rejects.toThrow("echo tool requires a string field named text.");
  });

  it("normalizes create_plan input into visible plan payloads", async () => {
    const content = await createPlanTool.execute(
      {
        title: " Review ",
        steps: [
          { title: " Read code ", status: "in_progress" },
          { title: "Patch tests", status: "unknown" },
        ],
      },
      { threadId: "thread-1", turnId: "turn-1" },
    );

    expect(JSON.parse(content) as unknown).toEqual({
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
    expect(JSON.parse(result) as unknown).toEqual({ updated: true });
    expect(updateGoal).toHaveBeenCalledWith("thread-1", {
      goal: "Ship tests",
      status: "complete",
      summary: "Done",
    });

    await expect(
      goalTool.execute({ status: "done" }, { threadId: "thread-1", turnId: "turn-1" }),
    ).rejects.toThrow("goal status must be active, complete, or blocked.");
  });
});
