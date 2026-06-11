import { describe, expect, it, vi } from "vitest";
import {
  configureWindowsAppIdentity,
  WINDOWS_APP_USER_MODEL_ID,
} from "../../../src/main/application/app-identity";

describe("configureWindowsAppIdentity", () => {
  it("sets a stable AppUserModelID on Windows", () => {
    const setAppUserModelId = vi.fn();

    configureWindowsAppIdentity({ setAppUserModelId }, "win32");

    expect(setAppUserModelId).toHaveBeenCalledWith(WINDOWS_APP_USER_MODEL_ID);
  });

  it("leaves non-Windows platforms unchanged", () => {
    const setAppUserModelId = vi.fn();

    configureWindowsAppIdentity({ setAppUserModelId }, "linux");
    configureWindowsAppIdentity({ setAppUserModelId }, "darwin");

    expect(setAppUserModelId).not.toHaveBeenCalled();
  });
});
