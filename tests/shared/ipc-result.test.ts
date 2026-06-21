import { describe, expect, it } from "vitest";
import {
  err,
  ok,
} from "../../src/shared/ipc-result";
import {
  err as barrelErr,
  ok as barrelOk,
} from "../../src/shared/agent-contracts";
import { IPC_ERROR_CODES } from "../../src/shared/ipc-errors";

describe("ipc result contracts", () => {
  it("owns IPC result envelopes while the shared barrel keeps compatibility", () => {
    expect(ok({ id: "thread-1" })).toEqual({
      ok: true,
      value: { id: "thread-1" },
    });
    expect(err(IPC_ERROR_CODES.RUNTIME_THREAD_ARCHIVED, "RUNTIME_THREAD_ARCHIVED")).toEqual({
      ok: false,
      code: "RUNTIME_THREAD_ARCHIVED",
      message: "RUNTIME_THREAD_ARCHIVED",
    });
    expect(barrelOk).toBe(ok);
    expect(barrelErr).toBe(err);
  });
});
