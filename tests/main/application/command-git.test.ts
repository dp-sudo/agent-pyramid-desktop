import { describe, expect, it } from "vitest";
import {
  assertPlainGitPathspec,
  gitPathspecArgs,
  optionalGitLogRef,
  parseGitStatusLine,
} from "../../../src/main/application/tools/command-git";

describe("command git helpers", () => {
  it("parses short status entries and rename payloads", () => {
    expect(parseGitStatusLine(" M src/app.ts")).toEqual({
      xy: " M",
      path: "src/app.ts",
    });
    expect(parseGitStatusLine("R  old-name.ts -> new-name.ts")).toEqual({
      xy: "R ",
      originalPath: "old-name.ts",
      path: "new-name.ts",
    });
  });

  it("builds pathspec argument separators only when needed", () => {
    expect(gitPathspecArgs([])).toEqual([]);
    expect(gitPathspecArgs(["src/app.ts"])).toEqual(["--", "src/app.ts"]);
  });

  it("rejects pathspec magic and globs", () => {
    expect(() => assertPlainGitPathspec("src/app.ts", "git_diff")).not.toThrow();
    expect(() => assertPlainGitPathspec(":(glob)src/*.ts", "git_diff"))
      .toThrow("git_diff pathspec must be a plain workspace-relative path");
    expect(() => assertPlainGitPathspec("src/*.ts", "git_diff"))
      .toThrow("git_diff pathspec must be a plain workspace-relative path");
    expect(() => assertPlainGitPathspec("src/[abc].ts", "git_diff"))
      .toThrow("git_diff pathspec must be a plain workspace-relative path");
  });

  it("normalizes and validates git log refs", () => {
    expect(optionalGitLogRef(undefined)).toBeUndefined();
    expect(optionalGitLogRef(" HEAD ")).toBe("HEAD");
    expect(optionalGitLogRef("feature/main")).toBe("feature/main");

    for (const ref of ["--all", ":(glob)*", "HEAD name", "HEAD\nnext", `HEAD${"\0"}next`]) {
      expect(() => optionalGitLogRef(ref)).toThrow("git_log ref");
    }
  });
});
