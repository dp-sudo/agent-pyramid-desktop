import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandProgressReporter } from "../../../src/main/application/tools/command-progress-reporter";

describe("command progress reporter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns undefined when live progress is not requested", () => {
    expect(createCommandProgressReporter(undefined)).toBeUndefined();
  });

  it("batches progress until the flush interval elapses", () => {
    vi.useFakeTimers();
    const progress: Array<{ chunk: string; stream: "stdout" | "stderr" }> = [];
    const reporter = createCommandProgressReporter((chunk, stream) => {
      progress.push({ chunk, stream });
    });
    if (!reporter) throw new Error("Expected reporter.");

    reporter.collect("hello", "stdout");
    expect(progress).toEqual([]);

    vi.advanceTimersByTime(99);
    expect(progress).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(progress).toEqual([{ chunk: "hello", stream: "stdout" }]);
  });

  it("flushes immediately at the byte threshold and splits large text chunks", () => {
    vi.useFakeTimers();
    const progress: Array<{ chunk: string; stream: "stdout" | "stderr" }> = [];
    const reporter = createCommandProgressReporter((chunk, stream) => {
      progress.push({ chunk, stream });
    });
    if (!reporter) throw new Error("Expected reporter.");

    reporter.collect("x".repeat(16 * 1024 + 2), "stderr");

    expect(progress).toEqual([
      { chunk: "x".repeat(16 * 1024), stream: "stderr" },
      { chunk: "xx", stream: "stderr" },
    ]);
  });

  it("preserves UTF-8 characters split across collected buffers", () => {
    const progress: Array<{ chunk: string; stream: "stdout" | "stderr" }> = [];
    const reporter = createCommandProgressReporter((chunk, stream) => {
      progress.push({ chunk, stream });
    });
    if (!reporter) throw new Error("Expected reporter.");

    const encoded = Buffer.from("你", "utf8");
    reporter.collect(encoded.subarray(0, 1), "stdout");
    reporter.collect(encoded.subarray(1), "stdout");
    reporter.flush();

    expect(progress).toEqual([{ chunk: "你", stream: "stdout" }]);
  });

  it("warns once when the progress callback throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reporter = createCommandProgressReporter(() => {
      throw new Error("progress failed");
    });
    if (!reporter) throw new Error("Expected reporter.");

    reporter.collect("one", "stdout");
    reporter.flush();
    reporter.collect("two", "stdout");
    reporter.flush();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[command-tools] failed to report command progress:",
      expect.any(Error),
    );
  });
});
