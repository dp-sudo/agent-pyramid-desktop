import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseApprovalRespondRequest,
  registerApprovalHandlers,
} from "../../../src/main/ipc/approvals-handlers";
import { APPROVAL_RESPOND_CHANNEL } from "../../../src/shared/ipc";
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
    respondApproval: vi.fn(),
  } as unknown as AgentRuntime;
}

describe("approval handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
  });

  it("parses approval responses strictly at the IPC boundary", () => {
    expect(parseApprovalRespondRequest({
      approvalId: " approval-1 ",
      decision: "allow",
    })).toEqual({
      approvalId: "approval-1",
      decision: "allow",
    });
    expect(() => parseApprovalRespondRequest(null)).toThrow(
      "Approval response request must be an object.",
    );
    expect(() => parseApprovalRespondRequest({
      approvalId: "approval-1",
      decision: "approve",
    })).toThrow("Approval decision must be allow or deny.");
    expect(() => parseApprovalRespondRequest({
      approvalId: " ",
      decision: "deny",
    })).toThrow("Approval response requires approvalId.");
  });

  it("responds to valid approval requests", async () => {
    const runtime = createRuntime();
    registerApprovalHandlers(runtime);
    const handler = electronMock.handlers.get(APPROVAL_RESPOND_CHANNEL);
    if (!handler) throw new Error("Expected approval respond handler.");

    const result = await handler({}, {
      approvalId: " approval-1 ",
      decision: "deny",
    });

    expect(result).toEqual({
      ok: true,
      value: { approvalId: "approval-1", decision: "deny" },
    });
    expect(runtime.respondApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      decision: "deny",
    });
  });

  it("returns an error envelope for malformed approval requests", async () => {
    const runtime = createRuntime();
    registerApprovalHandlers(runtime);
    const handler = electronMock.handlers.get(APPROVAL_RESPOND_CHANNEL);
    if (!handler) throw new Error("Expected approval respond handler.");

    const result = await handler({}, { approvalId: "approval-1", decision: "approve" });

    expect(result).toEqual({
      ok: false,
      code: "APPROVAL_RESPOND_FAILED",
      message: "Approval decision must be allow or deny.",
    });
    expect(runtime.respondApproval).not.toHaveBeenCalled();
  });

  it("keeps runtime approval errors traceable", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.respondApproval).mockImplementation(() => {
      throw new Error("Approval approval-1 is not pending.");
    });
    registerApprovalHandlers(runtime);
    const handler = electronMock.handlers.get(APPROVAL_RESPOND_CHANNEL);
    if (!handler) throw new Error("Expected approval respond handler.");

    const result = await handler({}, {
      approvalId: "approval-1",
      decision: "allow",
    });

    expect(result).toEqual({
      ok: false,
      code: "APPROVAL_RESPOND_FAILED",
      message: "Approval approval-1 is not pending.",
    });
  });
});
