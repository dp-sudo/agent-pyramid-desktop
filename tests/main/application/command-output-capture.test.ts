import { describe, expect, it } from "vitest";
import { createOutputCollector } from "../../../src/main/application/tools/command-output-capture";

describe("command output capture", () => {
  it("retains command output from the beginning until the byte limit", () => {
    const collector = createOutputCollector(8);

    collector.collect("old");
    collector.collect("middle");
    collector.collect("latest");

    expect(collector.finish()).toEqual({
      text: "oldmiddl",
      bytes: Buffer.byteLength("oldmiddlelatest", "utf8"),
      truncated: true,
    });
  });

  it("does not emit a replacement character for truncated UTF-8 sequences", () => {
    const collector = createOutputCollector(1024);

    collector.collect(`${"x".repeat(1023)}你tail`);

    const snapshot = collector.finish();
    expect(snapshot.text).toBe("x".repeat(1023));
    expect(snapshot.text).not.toContain("\uFFFD");
    expect(snapshot.bytes).toBe(Buffer.byteLength(`${"x".repeat(1023)}你tail`, "utf8"));
    expect(snapshot.truncated).toBe(true);
  });

  it("flushes complete buffered UTF-8 text when output is not truncated", () => {
    const collector = createOutputCollector(64);

    collector.collect("hello ");
    collector.collect("你");

    expect(collector.finish()).toEqual({
      text: "hello 你",
      bytes: Buffer.byteLength("hello 你", "utf8"),
      truncated: false,
    });
  });
});
