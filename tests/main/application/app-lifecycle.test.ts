import { describe, expect, it, vi } from "vitest";
import { AppLifecycle } from "../../../src/main/application/app-lifecycle";

describe("AppLifecycle", () => {
  it("runs cleanup hooks in registration order", async () => {
    const calls: string[] = [];
    const lifecycle = new AppLifecycle();
    lifecycle.registerCleanup({ name: "first", run: () => calls.push("first") });
    lifecycle.registerCleanup({ name: "second", run: async () => calls.push("second") });

    await lifecycle.runCleanup();

    expect(calls).toEqual(["first", "second"]);
  });

  it("logs cleanup failures and continues running later hooks", async () => {
    const calls: string[] = [];
    const logger = { error: vi.fn() };
    const lifecycle = new AppLifecycle(logger);
    const failure = new Error("failed");
    lifecycle.registerCleanup({
      name: "first",
      run: () => {
        throw failure;
      },
    });
    lifecycle.registerCleanup({ name: "second", run: () => calls.push("second") });

    await lifecycle.runCleanup();

    expect(logger.error).toHaveBeenCalledWith("[main] first cleanup failed:", failure);
    expect(calls).toEqual(["second"]);
  });

  it("coalesces repeated cleanup calls", async () => {
    const run = vi.fn(async () => undefined);
    const lifecycle = new AppLifecycle();
    lifecycle.registerCleanup({ name: "once", run });

    await Promise.all([lifecycle.runCleanup(), lifecycle.runCleanup()]);
    await lifecycle.runCleanup();

    expect(run).toHaveBeenCalledTimes(1);
  });
});
