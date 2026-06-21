import { describe, expect, it } from "vitest";
import {
  DEFAULT_THREAD_MODE,
  THREAD_MODES,
  isThreadRecord,
} from "../../src/shared/thread-contracts";
import {
  DEFAULT_THREAD_MODE as BARREL_DEFAULT_THREAD_MODE,
  THREAD_MODES as BARREL_THREAD_MODES,
  isThreadRecord as isBarrelThreadRecord,
} from "../../src/shared/agent-contracts";

describe("thread contracts", () => {
  it("owns thread guards while the shared barrel keeps compatibility", () => {
    const thread = {
      id: "00000000-0000-4000-8000-000000000101",
      title: "Thread",
      workspace: "/workspace",
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    };

    expect(THREAD_MODES).toEqual(["code", "write"]);
    expect(DEFAULT_THREAD_MODE).toBe("code");
    expect(isThreadRecord(thread)).toBe(true);
    expect(BARREL_THREAD_MODES).toBe(THREAD_MODES);
    expect(BARREL_DEFAULT_THREAD_MODE).toBe(DEFAULT_THREAD_MODE);
    expect(isBarrelThreadRecord(thread)).toBe(true);
  });
});
