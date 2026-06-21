import { describe, expect, it } from "vitest";
import {
  buildRuntimeCompletionEvidenceText,
  type RuntimeCompletionEvidenceDeps,
} from "../../../src/main/application/runtime-completion-evidence";
import type {
  Item,
  RuntimeErrorEvent,
  ToolItem,
  TurnRecord,
} from "../../../src/shared/agent-contracts";

describe("runtime completion evidence", () => {
  it("replays only current-turn items before building evidence", async () => {
    const text = await buildRuntimeCompletionEvidenceText(
      deps({
        items: [
          toolItem({
            id: "old-command",
            turnId: "turn-old",
            name: "run_command",
            result: {
              command: "npm test",
              status: "exited",
              exitCode: 0,
              timedOut: false,
            },
          }),
          toolItem({
            id: "current-command",
            turnId: "turn-1",
            name: "run_command",
            result: {
              command: "npm run build",
              status: "exited",
              exitCode: 0,
              timedOut: false,
            },
          }),
        ],
      }),
      turn(),
    );

    expect(text).toContain("commands: 1 command(s): run_command passed (exit 0): npm run build;");
    expect(text).not.toContain("npm test");
  });

  it("reports checkpoint lookup failures as runtime errors without hiding completion evidence", async () => {
    const reported: RuntimeErrorEvent[] = [];
    const text = await buildRuntimeCompletionEvidenceText(
      deps({
        items: [
          toolItem({
            name: "edit_file",
            result: {
              path: "src/index.ts",
              operation: "update",
              diff: { added: 1, removed: 1 },
            },
          }),
          toolItem({
            name: "run_command",
            result: {
              command: "npm test",
              status: "exited",
              exitCode: 0,
              timedOut: false,
            },
          }),
        ],
        checkpointStore: {
          async list() {
            throw new Error("disk unavailable");
          },
        },
        reportRuntimeError(currentTurn, code, message) {
          reported.push({
            kind: "runtime_error",
            threadId: currentTurn.threadId,
            turnId: currentTurn.id,
            code,
            message,
          });
        },
      }),
      turn(),
    );

    expect(text).toContain("files changed: 1 file(s): src/index.ts update (+1/-1);");
    expect(text).toContain("checkpoints: lookup failed (disk unavailable);");
    expect(text).toContain("remaining risk: changed files do not have confirmed checkpoint lookup evidence.");
    expect(reported).toEqual([
      {
        kind: "runtime_error",
        threadId: "thread-1",
        turnId: "turn-1",
        code: "persistence_error",
        message: "Completion evidence checkpoint lookup failed: disk unavailable",
      },
    ]);
  });
});

function deps(options: {
  items: Item[];
  checkpointStore?: RuntimeCompletionEvidenceDeps["checkpointStore"];
  reportRuntimeError?: RuntimeCompletionEvidenceDeps["reportRuntimeError"];
}): RuntimeCompletionEvidenceDeps {
  return {
    store: {
      async *replayItems() {
        for (const item of options.items) {
          yield item;
        }
      },
    },
    ...(options.checkpointStore ? { checkpointStore: options.checkpointStore } : {}),
    reportRuntimeError: options.reportRuntimeError ?? (() => undefined),
  };
}

function turn(): TurnRecord {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    model: "minimax",
    mode: "agent",
  };
}

function toolItem(options: {
  id?: string;
  turnId?: string;
  name: string;
  result: unknown;
  status?: ToolItem["status"];
}): ToolItem {
  return {
    kind: "tool",
    id: options.id ?? `tool-${options.name}`,
    threadId: "thread-1",
    turnId: options.turnId ?? "turn-1",
    toolCallId: `call-${options.id ?? options.name}`,
    name: options.name,
    args: {},
    result: options.result,
    status: options.status ?? "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
