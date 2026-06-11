import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_APP_USER_MODEL_ID } from "../src/main/application/app-identity";

interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  build?: {
    appId?: string;
    directories?: {
      buildResources?: string;
    };
    files?: string[];
    win?: {
      target?: string[];
      icon?: string;
      signAndEditExecutable?: boolean;
      certificateFile?: string;
      certificatePassword?: string;
    };
  };
}

describe("package configuration", () => {
  async function readManifest(): Promise<PackageManifest> {
    const raw = await readFile(join(process.cwd(), "package.json"), "utf8");
    return JSON.parse(raw) as PackageManifest;
  }

  it("does not pin platform-specific Rollup native packages as app dependencies", async () => {
    const manifest = await readManifest();

    expect(manifest.dependencies ?? {}).not.toHaveProperty("@rollup/rollup-win32-x64-msvc");
  });

  it("keeps Windows packaging identity aligned with the main-process identity", async () => {
    const manifest = await readManifest();

    expect(manifest.build?.appId).toBe(WINDOWS_APP_USER_MODEL_ID);
  });

  it("packages the built Electron output for Windows portable distribution", async () => {
    const manifest = await readManifest();

    expect(manifest.scripts?.["package:win"]).toBe("npm run build && electron-builder --win --x64");
    expect(manifest.scripts?.["package:win:signed"]).toBe(
      "npm run build && electron-builder --win --x64 -c.forceCodeSigning=true",
    );
    expect(manifest.build?.files).toEqual(["out/**/*", "package.json"]);
    expect(manifest.build?.win?.target).toEqual(["portable", "zip"]);
  });

  it("uses a checked-in Windows icon without storing signing secrets", async () => {
    const manifest = await readManifest();
    const iconPath = manifest.build?.win?.icon;

    expect(manifest.build?.directories?.buildResources).toBe("resources");
    expect(iconPath).toBe("resources/icons/icon.ico");
    expect(manifest.build?.win?.signAndEditExecutable).toBe(true);
    expect(manifest.build?.win?.certificateFile).toBeUndefined();
    expect(manifest.build?.win?.certificatePassword).toBeUndefined();

    const icon = await readFile(join(process.cwd(), iconPath ?? ""));
    expect(icon.subarray(0, 6)).toEqual(Buffer.from([0, 0, 1, 0, 7, 0]));

    const sizes = Array.from({ length: 7 }, (_, index) => {
      const offset = 6 + index * 16;
      const width = icon[offset] === 0 ? 256 : icon[offset];
      const height = icon[offset + 1] === 0 ? 256 : icon[offset + 1];
      return `${width}x${height}`;
    });
    expect(sizes).toEqual(["16x16", "24x24", "32x32", "48x48", "64x64", "128x128", "256x256"]);
  });
});
