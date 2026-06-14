import { describe, expect, it } from "vitest";
import {
  createPackageManagerInvocation,
  createSelectedShellInvocation,
  createShellInvocation,
  toWslPath,
} from "../../../src/main/application/tools/command-invocation";

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

describe("command invocation helpers", () => {
  it("builds default shell invocations without spawning a process", () => {
    withPlatform("win32", () => {
      const originalComSpec = process.env.ComSpec;
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
      try {
        expect(createShellInvocation("npm run test")).toEqual({
          file: "C:\\Windows\\System32\\cmd.exe",
          args: ["/d", "/s", "/c", "npm run test"],
        });
      } finally {
        if (originalComSpec === undefined) {
          delete process.env.ComSpec;
        } else {
          process.env.ComSpec = originalComSpec;
        }
      }
    });

    withPlatform("linux", () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = "/bin/bash";
      try {
        expect(createShellInvocation("npm run test")).toEqual({
          file: "/bin/bash",
          args: ["-c", "npm run test"],
        });
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL;
        } else {
          process.env.SHELL = originalShell;
        }
      }
    });
  });

  it("applies explicit shell args and package manager shims", async () => {
    await expect(createSelectedShellInvocation("console.log(1)", {
      shell: "default",
      shellPath: "node",
      shellArgs: ["-e", "{command}"],
    })).resolves.toEqual({
      file: "node",
      args: ["-e", "console.log(1)"],
    });

    withPlatform("win32", () => {
      expect(createPackageManagerInvocation("npm", ["run", "build"])).toEqual({
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", "npm run build"],
      });
    });
    withPlatform("linux", () => {
      expect(createPackageManagerInvocation("npm", ["run", "build"])).toEqual({
        file: "npm",
        args: ["run", "build"],
      });
    });
  });

  it("converts Windows paths for WSL command cwd values", () => {
    expect(toWslPath("C:\\Users\\Ada\\project")).toBe("/mnt/c/Users/Ada/project");
    expect(toWslPath("/mnt/d/workspace")).toBe("/mnt/d/workspace");
  });
});
