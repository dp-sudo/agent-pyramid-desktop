import { describe, expect, it } from "vitest";
import {
  buildTurnCompletionEvidenceText,
} from "../../../src/main/application/completion-evidence";
import type { ToolItem } from "../../../src/shared/agent-contracts";

function toolItem(
  name: string,
  result: unknown,
  status: ToolItem["status"] = "completed",
): ToolItem {
  return {
    kind: "tool",
    id: `tool-${name}`,
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: `call-${name}`,
    name,
    args: {},
    result,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("completion evidence", () => {
  it("does not treat a running command session snapshot as successful command evidence", () => {
    const text = buildTurnCompletionEvidenceText({
      items: [
        toolItem("start_command_session", {
          sessionId: "session-1",
          command: "npm run dev",
          cwd: ".",
          status: "running",
          exitCode: undefined,
          timedOut: false,
        }),
      ],
      checkpointState: { kind: "not_configured" },
    });

    expect(text).toContain("commands: 1 command(s): start_command_session still running: npm run dev;");
    expect(text).toContain(
      "remaining risk: one or more commands failed, timed out, or did not report a zero exit code.",
    );
  });

  it("treats a stopped command session with exit code zero as successful evidence", () => {
    const text = buildTurnCompletionEvidenceText({
      items: [
        toolItem("stop_command_session", {
          sessionId: "session-1",
          command: "npm test",
          cwd: ".",
          status: "exited",
          exitCode: 0,
          timedOut: false,
        }),
      ],
      checkpointState: { kind: "not_configured" },
    });

    expect(text).toContain("commands: 1 command(s): stop_command_session passed (exit 0): npm test;");
    expect(text).toContain("remaining risk: no file changes were made in this turn.");
  });

  it("does not treat command session input writes as terminal command success", () => {
    const text = buildTurnCompletionEvidenceText({
      items: [
        toolItem("write_command_session", {
          sessionId: "session-1",
          bytesWritten: 5,
        }),
      ],
      checkpointState: { kind: "not_configured" },
    });

    expect(text).toContain("commands: 1 command(s): write_command_session input written;");
    expect(text).toContain(
      "remaining risk: one or more commands failed, timed out, or did not report a zero exit code.",
    );
  });
});
