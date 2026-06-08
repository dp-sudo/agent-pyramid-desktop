import { describe, expect, it, vi } from "vitest";
import { parseModelConfigProfileCreateRequest } from "../../../src/main/ipc/model-config-handlers";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("model config handlers", () => {
  it("parses profile create requests without treating non-booleans as activate", () => {
    expect(
      parseModelConfigProfileCreateRequest({
        name: "DeepSeek",
        config: { model: "deepseek-v4-flash" },
        activate: false,
      }),
    ).toEqual({
      name: "DeepSeek",
      config: { model: "deepseek-v4-flash" },
      activate: false,
    });

    expect(() =>
      parseModelConfigProfileCreateRequest({
        name: "DeepSeek",
        config: { model: "deepseek-v4-flash" },
        activate: "false",
      }),
    ).toThrow("Model config profile activate must be a boolean.");
  });

  it("rejects malformed profile create requests at the IPC boundary", () => {
    expect(() => parseModelConfigProfileCreateRequest(null))
      .toThrow("Model config profile create request must be an object.");
    expect(() => parseModelConfigProfileCreateRequest({ name: " ", config: {} }))
      .toThrow("Model config profile name is required.");
    expect(() => parseModelConfigProfileCreateRequest({ name: "DeepSeek" }))
      .toThrow("Model config profile config must be an object.");
  });
});
