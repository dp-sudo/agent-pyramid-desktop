import { describe, expect, it } from "vitest";
import {
  isPathInsideOrEqual,
  isSamePath,
  toPortableRelativePath,
} from "../../../src/main/application/path-utils";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

describe("main path utils", () => {
  it("uses Windows case-insensitive path containment semantics", () => {
    withPlatform("win32", () => {
      expect(isSamePath("C:\\Workspace", "c:\\workspace")).toBe(true);
      expect(isPathInsideOrEqual("C:\\Workspace", "c:\\workspace\\src\\index.ts")).toBe(true);
      expect(isPathInsideOrEqual("C:\\Workspace", "C:\\WorkspaceSibling\\file.ts")).toBe(false);
      expect(toPortableRelativePath("C:\\Workspace", "c:\\workspace\\docs\\Guide.md"))
        .toBe("docs/Guide.md");
    });
  });

  it("uses POSIX case-sensitive path containment semantics", () => {
    withPlatform("linux", () => {
      expect(isSamePath("/workspace", "/Workspace")).toBe(false);
      expect(isPathInsideOrEqual("/workspace", "/workspace/src/index.ts")).toBe(true);
      expect(isPathInsideOrEqual("/workspace", "/workspace-sibling/file.ts")).toBe(false);
      expect(toPortableRelativePath("/workspace", "/workspace/docs/guide.md"))
        .toBe("docs/guide.md");
    });
  });
});
