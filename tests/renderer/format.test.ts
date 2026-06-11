import { describe, expect, it } from "vitest";
import { formatBytes } from "../../src/renderer/src/ui/format";

describe("renderer format helpers", () => {
  it("formats byte values with the existing B, KB, and MB display policy", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
  });
});
