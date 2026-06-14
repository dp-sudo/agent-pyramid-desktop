import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectLanguageServiceDiagnostics,
  parseTypeScriptDiagnostics,
} from "../../../src/main/application/tools/command-diagnostics";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("command diagnostics helpers", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("command-diagnostics-");
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it("parses TypeScript CLI output relative to the diagnostic cwd and filters escaped paths", async () => {
    const outside = await makeTempDir("command-diagnostics-outside-");
    try {
      const output = [
        "src/index.ts(1,7): error TS2322: inside",
        `${path.join(outside, "external.ts")}(1,7): error TS2322: outside`,
      ].join("\n");

      expect(parseTypeScriptDiagnostics(output, workspace, workspace)).toEqual([
        {
          path: "src/index.ts",
          line: 1,
          column: 7,
          code: "TS2322",
          severity: "error",
          message: "inside",
          source: "typecheck",
        },
      ]);
    } finally {
      await removeTempDir(outside);
    }
  });

  it("collects language-service diagnostics for one workspace file", async () => {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      }),
      "utf8",
    );
    const filePath = path.join(workspace, "src", "index.ts");
    await fs.writeFile(filePath, "const value: string = 1;\n", "utf8");

    const diagnostics = await collectLanguageServiceDiagnostics(workspace, filePath);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        path: "src/index.ts",
        line: 1,
        code: "TS2322",
        severity: "error",
        source: "language_service",
      }),
    ]);
  });
});
