import { describe, expect, it } from "vitest";
import {
  createLineRegex,
  hasNodeErrorCode,
  numberInRange,
  optionalEnum,
  optionalLimitedString,
  optionalString,
  optionalStringArray,
  requiredBoolean,
  requiredCommand,
  requiredCommandForTool,
  requiredLimitedString,
  requiredPath,
  requiredRegexPattern,
  requiredSessionInput,
} from "../../../src/main/application/tools/command-input";
import {
  MAX_COMMAND_BYTES,
  MAX_REGEX_PATTERN_BYTES,
} from "../../../src/main/application/constants";

describe("command input helpers", () => {
  it("normalizes command strings while preserving tool-specific error messages", () => {
    expect(requiredCommand("  npm test  ")).toBe("npm test");
    expect(requiredCommandForTool("  echo ok  ", "shell_command")).toBe("echo ok");

    expect(() => requiredCommand("")).toThrow(
      "run_command requires a non-empty command string.",
    );
    expect(() => requiredCommand("bad\0command")).toThrow(
      "run_command command cannot contain NUL bytes.",
    );
    expect(() => requiredCommand("x".repeat(MAX_COMMAND_BYTES + 1))).toThrow(
      `run_command command exceeds ${MAX_COMMAND_BYTES} bytes.`,
    );
    expect(() => requiredCommandForTool("", "shell_command")).toThrow(
      "shell_command requires a non-empty command string.",
    );
  });

  it("validates bounded string and session input", () => {
    expect(requiredLimitedString("  value  ", "required", 16)).toBe("value");
    expect(requiredSessionInput("  value  ", "required", 16)).toBe("  value  ");
    expect(optionalLimitedString("  value  ", 16, "query")).toBe("value");
    expect(optionalLimitedString("   ", 16, "query")).toBeUndefined();
    expect(optionalString("  path  ")).toBe("path");
    expect(optionalString(undefined)).toBeUndefined();

    expect(() => requiredLimitedString("", "required", 16)).toThrow("required");
    expect(() => requiredSessionInput("", "required", 16)).toThrow("required");
    expect(() => optionalLimitedString(12, 16, "query")).toThrow("query must be a string.");
    expect(() => optionalString(12)).toThrow("optional string value must be a string.");
  });

  it("validates structured scalar input", () => {
    expect(requiredRegexPattern("test")).toBe("test");
    expect(requiredPath("  src  ", "path required")).toBe("src");
    expect(optionalStringArray([" a ", "b"], "shell_args")).toEqual(["a", "b"]);
    expect(optionalEnum("bash", ["sh", "bash"], "shell")).toBe("bash");
    expect(requiredBoolean(false, "case_sensitive")).toBe(false);
    expect(numberInRange(undefined, 1, 5, 3, "max_results")).toBe(3);
    expect(numberInRange(4, 1, 5, 3, "max_results")).toBe(4);

    expect(() => requiredRegexPattern("x".repeat(MAX_REGEX_PATTERN_BYTES + 1))).toThrow(
      `string value exceeds ${MAX_REGEX_PATTERN_BYTES} bytes.`,
    );
    expect(() => requiredPath("bad\0path", "path required")).toThrow(
      "path cannot contain NUL bytes.",
    );
    expect(() => optionalStringArray([""], "shell_args")).toThrow(
      "shell_args entries must be non-empty strings.",
    );
    expect(() => optionalEnum("cmd", ["sh", "bash"], "shell")).toThrow(
      "shell must be one of: sh, bash.",
    );
    expect(() => requiredBoolean("yes", "case_sensitive")).toThrow(
      "case_sensitive must be a boolean.",
    );
    expect(() => numberInRange(6, 1, 5, 3, "max_results")).toThrow(
      "max_results must be an integer between 1 and 5.",
    );
  });

  it("wraps invalid regex and checks Node error codes", () => {
    expect(createLineRegex("abc", "u").test("abc")).toBe(true);
    expect(() => createLineRegex("[", "u")).toThrow("rg_search pattern is invalid:");
    expect(hasNodeErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(hasNodeErrorCode({ code: "EACCES" }, "ENOENT")).toBe(false);
    expect(hasNodeErrorCode(null, "ENOENT")).toBe(false);
  });
});
