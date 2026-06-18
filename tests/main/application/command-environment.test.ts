import { describe, expect, it } from "vitest";
import {
  buildCommandEnvironment,
  isAllowedCommandEnvironmentName,
  isSensitiveEnvironmentName,
} from "../../../src/main/application/tools/command-environment";

describe("command environment", () => {
  it("preserves only allowlisted platform variables", () => {
    const environment = buildCommandEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/ada",
      TEMP: "/tmp",
      MY_DB_PW: "secret",
      COMPANY_AUTH: "token",
      CUSTOM_SAFE_LOOKING_VALUE: "still-hidden",
      OPENAI_API_KEY: "sk-secret",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/ada",
      TEMP: "/tmp",
    });
  });

  it("treats non-allowlisted names as sensitive by default", () => {
    expect(isAllowedCommandEnvironmentName("Path")).toBe(true);
    expect(isSensitiveEnvironmentName("Path")).toBe(false);
    expect(isAllowedCommandEnvironmentName("COMPANY_AUTH")).toBe(false);
    expect(isSensitiveEnvironmentName("COMPANY_AUTH")).toBe(true);
    expect(isSensitiveEnvironmentName("CUSTOM_SAFE_LOOKING_VALUE")).toBe(true);
  });
});
