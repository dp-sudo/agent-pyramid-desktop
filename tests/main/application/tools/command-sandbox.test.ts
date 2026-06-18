import { describe, expect, it } from "vitest";
import {
  CommandSandboxUnavailableError,
  createCommandSpawnSpec,
  describeCommandSandbox,
} from "../../../../src/main/application/tools/command-sandbox";
import type { ShellInvocation } from "../../../../src/main/application/tools/command-invocation";

const invocation: ShellInvocation = {
  file: "node",
  args: ["--version"],
};

describe("command sandbox", () => {
  it("fails closed for workspace-write commands when no supported OS jail exists", () => {
    expect(describeCommandSandbox("workspace-write", "linux")).toMatchObject({
      osJail: {
        available: false,
        required: true,
        engine: "unavailable",
      },
    });

    expect(() =>
      createCommandSpawnSpec(invocation, {
        cwd: "/workspace",
        sandboxMode: "workspace-write",
        stdin: "ignore",
        platform: "linux",
      }),
    ).toThrow(CommandSandboxUnavailableError);
  });

  it("keeps danger-full-access on the explicit direct execution path", () => {
    expect(createCommandSpawnSpec(invocation, {
      cwd: "/workspace",
      sandboxMode: "danger-full-access",
      stdin: "ignore",
      platform: "linux",
    })).toMatchObject({
      file: "node",
      args: ["--version"],
      sandbox: {
        osJail: {
          available: true,
          required: false,
          engine: "direct",
        },
      },
    });
  });
});
