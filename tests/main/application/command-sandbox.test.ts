import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CommandSandboxUnavailableError,
  createCommandSpawnOptions,
  createCommandSpawnSpec,
  createWindowsHelperCommandSandboxEngine,
  describeCommandSandbox,
} from "../../../src/main/application/tools/command-sandbox";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

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

  it("fails closed for Windows workspace-write commands when the helper is unavailable", () => {
    expect(() => createCommandSpawnSpec(
      { file: "cmd.exe", args: ["/d", "/s", "/c", "echo hi"] },
      {
        cwd: "C:\\workspace",
        stdin: "ignore",
        sandboxMode: "workspace-write",
        platform: "win32",
        engine: createWindowsHelperCommandSandboxEngine(undefined),
      },
    )).toThrow(CommandSandboxUnavailableError);
    expect(() => createCommandSpawnSpec(
      { file: "cmd.exe", args: ["/d", "/s", "/c", "echo hi"] },
      {
        cwd: "C:\\workspace",
        stdin: "ignore",
        sandboxMode: "workspace-write",
        platform: "win32",
        engine: createWindowsHelperCommandSandboxEngine(undefined),
      },
    )).toThrow("Windows command sandbox helper is unavailable");
  });

  it("allows explicit danger-full-access commands to use direct host spawn on Windows", () => {
    const spec = createCommandSpawnSpec(
      { file: "cmd.exe", args: ["/d", "/s", "/c", "echo hi"] },
      {
        cwd: "C:\\workspace",
        stdin: "ignore",
        sandboxMode: "danger-full-access",
        platform: "win32",
      },
    );

    expect(spec.file).toBe("cmd.exe");
    expect(spec.args).toEqual(["/d", "/s", "/c", "echo hi"]);
    expect(spec.options.detached).toBe(false);
    expect(spec.sandbox.osJail).toMatchObject({
      enabled: false,
      required: false,
      available: true,
      engine: "direct",
    });
  });

  it("routes Windows workspace-write commands through a configured helper", async () => {
    const tempDir = await makeTempDir("command-sandbox-helper-");
    try {
      const helperPath = path.join(tempDir, "agent-command-sandbox-helper.exe");
      await fs.writeFile(helperPath, "", "utf8");
      const spec = createCommandSpawnSpec(
        { file: "cmd.exe", args: ["/d", "/s", "/c", "echo hi"] },
        {
          cwd: "C:\\workspace",
          stdin: "pipe",
          sandboxMode: "workspace-write",
          platform: "win32",
          engine: createWindowsHelperCommandSandboxEngine(helperPath),
        },
      );
      const payload = JSON.parse(
        Buffer.from(String(spec.args[2]), "base64").toString("utf8"),
      ) as {
        version: number;
        cwd: string;
        command: { file: string; args: string[] };
        stdin: string;
      };

      expect(spec.file).toBe(helperPath);
      expect(spec.args.slice(0, 2)).toEqual(["run", "--request-base64"]);
      expect(spec.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect(spec.sandbox.osJail).toMatchObject({
        enabled: true,
        required: true,
        available: true,
        engine: "windows-helper",
        helperPath,
      });
      expect(payload).toEqual({
        version: 1,
        cwd: "C:\\workspace",
        command: { file: "cmd.exe", args: ["/d", "/s", "/c", "echo hi"] },
        stdin: "pipe",
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
