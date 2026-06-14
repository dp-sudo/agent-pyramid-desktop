import { describe, expect, it } from "vitest";
import {
  createSessionCapture,
  dropLeadingUtf8ContinuationBytes,
} from "../../../src/main/application/tools/command-session-capture";

describe("command session capture", () => {
  it("keeps the newest bytes when the retained buffer overflows", () => {
    const capture = createSessionCapture(8);

    capture.collect("old");
    capture.collect("middle");
    capture.collect("latest");

    const snapshot = capture.snapshot(8);
    expect(snapshot.text).toBe("lelatest");
    expect(snapshot.bytes).toBe(Buffer.byteLength("oldmiddlelatest", "utf8"));
    expect(snapshot.truncated).toBe(true);
  });

  it("drops orphaned UTF-8 continuation bytes from tail snapshots", () => {
    const capture = createSessionCapture(32);

    capture.collect(`x你tail`);

    const snapshot = capture.snapshot(6);
    expect(snapshot.text).toBe("tail");
    expect(snapshot.text).not.toContain("\uFFFD");
    expect(snapshot.bytes).toBe(Buffer.byteLength(`x你tail`, "utf8"));
    expect(snapshot.truncated).toBe(true);
  });

  it("returns the original buffer when it already starts on a UTF-8 boundary", () => {
    const buffer = Buffer.from("tail", "utf8");

    expect(dropLeadingUtf8ContinuationBytes(buffer)).toBe(buffer);
  });
});
