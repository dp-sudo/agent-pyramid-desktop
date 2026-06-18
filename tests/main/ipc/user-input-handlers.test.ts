import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseUserInputRespondRequest,
  registerUserInputHandlers,
} from "../../../src/main/ipc/user-input-handlers";
import { USER_INPUT_RESPOND_CHANNEL } from "../../../src/shared/ipc";
import type { AgentRuntime } from "../../../src/main/application/agent-runtime";

type IpcHandler = (_event: unknown, request: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

function createRuntime(): AgentRuntime {
  return {
    respondUserInput: vi.fn(),
  } as unknown as AgentRuntime;
}

describe("user input handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
  });

  it("parses user input responses strictly at the IPC boundary", () => {
    expect(parseUserInputRespondRequest({
      userInputId: " input-1 ",
      answer: " docs/guide.md ",
    })).toEqual({
      userInputId: "input-1",
      answer: "docs/guide.md",
    });
    expect(parseUserInputRespondRequest({
      userInputId: "input-1",
      cancelled: true,
    })).toEqual({
      userInputId: "input-1",
      cancelled: true,
    });
    expect(() => parseUserInputRespondRequest(null)).toThrow(
      "User input response request must be an object.",
    );
    expect(() => parseUserInputRespondRequest({
      userInputId: " ",
      answer: "answer",
    })).toThrow("User input response requires userInputId.");
    expect(() => parseUserInputRespondRequest({
      userInputId: "input-1",
      answer: 1,
    })).toThrow("User input answer must be a string.");
    expect(() => parseUserInputRespondRequest({
      userInputId: "input-1",
      answer: " ",
    })).toThrow("User input response requires a non-empty answer or cancelled=true.");
  });

  it("responds to valid user input requests", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.respondUserInput).mockReturnValue({
      userInputId: "input-1",
      accepted: true,
      answer: "docs/guide.md",
    });
    registerUserInputHandlers(runtime);
    const handler = electronMock.handlers.get(USER_INPUT_RESPOND_CHANNEL);
    if (!handler) throw new Error("Expected user input respond handler.");

    const result = await handler({}, {
      userInputId: " input-1 ",
      answer: " docs/guide.md ",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        userInputId: "input-1",
        accepted: true,
        answer: "docs/guide.md",
      },
    });
    expect(runtime.respondUserInput).toHaveBeenCalledWith({
      userInputId: "input-1",
      answer: "docs/guide.md",
    });
  });

  it("returns a stable envelope for stale user input responses", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.respondUserInput).mockReturnValue({
      userInputId: "input-1",
      accepted: false,
      cancelled: true,
      reason: "not_pending",
    });
    registerUserInputHandlers(runtime);
    const handler = electronMock.handlers.get(USER_INPUT_RESPOND_CHANNEL);
    if (!handler) throw new Error("Expected user input respond handler.");

    const result = await handler({}, {
      userInputId: "input-1",
      cancelled: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        userInputId: "input-1",
        accepted: false,
        cancelled: true,
        reason: "not_pending",
      },
    });
  });

  it("returns an error envelope for malformed user input requests", async () => {
    const runtime = createRuntime();
    registerUserInputHandlers(runtime);
    const handler = electronMock.handlers.get(USER_INPUT_RESPOND_CHANNEL);
    if (!handler) throw new Error("Expected user input respond handler.");

    const result = await handler({}, { userInputId: "input-1", answer: " " });

    expect(result).toEqual({
      ok: false,
      code: "USER_INPUT_RESPOND_FAILED",
      message: "User input response requires a non-empty answer or cancelled=true.",
    });
    expect(runtime.respondUserInput).not.toHaveBeenCalled();
  });
});
