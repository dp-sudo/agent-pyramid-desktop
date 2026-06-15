import { describe, expect, it } from "vitest";
import {
  createCommandSpawnOptions,
  describeCommandSandbox,
} from "../../../src/main/application/tools/command-sandbox";

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

describe("command sandbox", () => {
  it("builds foreground spawn options with a sanitized non-inherited boundary", () => {
    const originalSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "secret";
    try {
      const options = createCommandSpawnOptions({
        cwd: "/workspace",
        stdin: "ignore",
        sandboxMode: "workspace-write",
      });

      expect(options.cwd).toBe("/workspace");
      expect(options.shell).toBe(false);
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(options.windowsHide).toBe(true);
      expect(options.env?.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (originalSecret === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalSecret;
      }
    }
  });

  it("keeps session stdin piped while preserving the same spawn sandbox", () => {
    const options = createCommandSpawnOptions({
      cwd: "/workspace",
      stdin: "pipe",
      sandboxMode: "danger-full-access",
    });

    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("reports platform cleanup and explicit OS jail boundaries", () => {
    expect(describeCommandSandbox("workspace-write", "win32")).toMatchObject({
      mode: "workspace-write",
      cwdBoundary: "workspace-realpath",
      environment: "credential-filtered",
      processCleanup: "windows-taskkill-tree",
      osJail: { enabled: false },
    });
    expect(describeCommandSandbox("read-only", "linux")).toMatchObject({
      mode: "read-only",
      processCleanup: "posix-process-group",
      osJail: { enabled: false },
    });
  });

  it("uses POSIX process groups outside Windows", () => {
    withPlatform("linux", () => {
      expect(createCommandSpawnOptions({
        cwd: "/workspace",
        stdin: "ignore",
      }).detached).toBe(true);
    });
    withPlatform("win32", () => {
      expect(createCommandSpawnOptions({
        cwd: "C:\\workspace",
        stdin: "ignore",
      }).detached).toBe(false);
    });
  });
});
