import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  normalizePackageScripts,
  optionalPackageManager,
  optionalPackageScriptName,
  packageInstallArgs,
  packageRunScriptArgs,
  readPackageJson,
} from "../../../src/main/application/tools/command-package";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("command package helpers", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("command-package-");
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it("reads package.json, normalizes scripts, and resolves package manager priority", async () => {
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@9.0.0",
        scripts: {
          build: "tsc",
          ignored: 42,
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(workspace, "package-lock.json"), "{}", "utf8");

    const packageJson = await readPackageJson(workspace);

    expect(normalizePackageScripts(packageJson.scripts)).toEqual({ build: "tsc" });
    expect(await detectPackageManager(workspace, packageJson)).toBe("pnpm");
  });

  it("falls back to lockfiles and npm defaults", async () => {
    await expect(detectPackageManager(workspace, {})).resolves.toBe("npm");

    await fs.writeFile(path.join(workspace, "yarn.lock"), "", "utf8");
    await expect(detectPackageManager(workspace, {})).resolves.toBe("yarn");
  });

  it("builds package run and install arguments without invoking commands", async () => {
    expect(packageRunScriptArgs("npm", "test")).toEqual(["run", "test"]);
    expect(packageRunScriptArgs("yarn", "test")).toEqual(["run", "test"]);

    expect(packageInstallArgs("npm", false, workspace)).toEqual(["install"]);
    expect(() => packageInstallArgs("npm", true, workspace))
      .toThrow("package_install frozen_lockfile requires package-lock.json or npm-shrinkwrap.json for npm.");
    await fs.writeFile(path.join(workspace, "package-lock.json"), "{}", "utf8");
    expect(packageInstallArgs("npm", true, workspace)).toEqual(["ci"]);
    expect(packageInstallArgs("pnpm", true, workspace)).toEqual(["install", "--frozen-lockfile"]);
  });

  it("validates optional package manager and script names", () => {
    expect(optionalPackageManager(undefined)).toBeUndefined();
    expect(optionalPackageManager("bun")).toBe("bun");
    expect(() => optionalPackageManager("cargo"))
      .toThrow("manager must be npm, pnpm, yarn, or bun.");

    expect(optionalPackageScriptName(" build:app ")).toBe("build:app");
    expect(() => optionalPackageScriptName("--filter"))
      .toThrow("script must be a package script name, not a package-manager option: --filter");
    expect(() => optionalPackageScriptName("build app"))
      .toThrow("script cannot contain whitespace or control characters.");
  });
});
