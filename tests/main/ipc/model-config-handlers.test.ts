import { describe, expect, it, vi } from "vitest";
import {
  parseModelConfigUpdateRequest,
  parseModelConfigProfileCreateRequest,
  parseModelConfigProfileIdRequest,
  parseModelConfigProfileUpdateRequest,
  registerModelConfigHandlers,
} from "../../../src/main/ipc/model-config-handlers";
import {
  MODEL_CONFIG_UPDATE_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
} from "../../../src/shared/ipc";
import type { ModelConfigStore } from "../../../src/main/persistence/model-config-store";

type IpcHandler = (_event: unknown, request: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

function createStore(): ModelConfigStore {
  return {
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    setActiveProfile: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    listProfiles: vi.fn(),
    createProfile: vi.fn(),
  } as unknown as ModelConfigStore;
}

describe("model config handlers", () => {
  it("parses model config update requests before store normalization", () => {
    expect(parseModelConfigUpdateRequest({
      model_provide: " MiniMax ",
      model: " MiniMax-M3 ",
      protocol: "anthropic-compatible",
      base_url: " https://api.example.test/v1 ",
      OPENAI_API_KEY: "",
      thinking: false,
      model_context_window: 128000,
      model_auto_compact_token_limit: 96000,
      max_tokens: 4096,
      model_reasoning_effort: "high",
      agent_autonomy: "deep",
    })).toEqual({
      model_provide: "MiniMax",
      model: "MiniMax-M3",
      protocol: "anthropic-compatible",
      base_url: "https://api.example.test/v1",
      OPENAI_API_KEY: "",
      thinking: false,
      model_context_window: 128000,
      model_auto_compact_token_limit: 96000,
      max_tokens: 4096,
      model_reasoning_effort: "high",
      agent_autonomy: "deep",
    });

    expect(() => parseModelConfigUpdateRequest(null))
      .toThrow("Model config update request must be an object.");
    expect(() => parseModelConfigUpdateRequest({}))
      .toThrow("Model config update request must include at least one field.");
    expect(() => parseModelConfigUpdateRequest({ thinking: "false" }))
      .toThrow("thinking must be a boolean.");
    expect(() => parseModelConfigUpdateRequest({ protocol: "custom" }))
      .toThrow("protocol must be one of openai-compatible, anthropic-compatible.");
    expect(() => parseModelConfigUpdateRequest({ OPENAI_API_KEY: false }))
      .toThrow("OPENAI_API_KEY must be a string.");
    expect(() => parseModelConfigUpdateRequest({ model_reasoning_effort: "extreme" }))
      .toThrow("model_reasoning_effort must be one of low, medium, high, xhigh.");
    expect(() => parseModelConfigUpdateRequest({ max_tokens: 1.5 }))
      .toThrow("max_tokens must be a positive integer.");
  });

  it("parses profile id requests at the IPC boundary", () => {
    expect(parseModelConfigProfileIdRequest({ id: " profile-1 " })).toEqual({
      id: "profile-1",
    });
    expect(() => parseModelConfigProfileIdRequest(null))
      .toThrow("Model config profile request must be an object.");
    expect(() => parseModelConfigProfileIdRequest({ id: " " }))
      .toThrow("Model config profile id is required.");
  });

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

    expect(
      parseModelConfigProfileCreateRequest({
        name: "Defaults",
        config: {},
      }),
    ).toEqual({
      name: "Defaults",
      config: {},
    });
  });

  it("rejects malformed profile create requests at the IPC boundary", () => {
    expect(() => parseModelConfigProfileCreateRequest(null))
      .toThrow("Model config profile create request must be an object.");
    expect(() => parseModelConfigProfileCreateRequest({ name: " ", config: {} }))
      .toThrow("Model config profile name is required.");
    expect(() => parseModelConfigProfileCreateRequest({ name: "DeepSeek" }))
      .toThrow("Model config profile config must be an object.");
    expect(() => parseModelConfigProfileCreateRequest({
      name: "DeepSeek",
      config: { thinking: "true" },
    })).toThrow("thinking must be a boolean.");
  });

  it("parses profile update requests and rejects silent no-op config payloads", () => {
    expect(
      parseModelConfigProfileUpdateRequest({
        id: " profile-1 ",
        name: "DeepSeek",
        config: { model: "deepseek-v4-flash", protocol: "anthropic-compatible" },
      }),
    ).toEqual({
      id: "profile-1",
      name: "DeepSeek",
      config: { model: "deepseek-v4-flash", protocol: "anthropic-compatible" },
    });
    expect(() => parseModelConfigProfileUpdateRequest({ id: "profile-1", name: " " }))
      .toThrow("Model config profile name is required.");
    expect(() => parseModelConfigProfileUpdateRequest({ id: "profile-1", config: null }))
      .toThrow("Model config profile config must be an object.");
    expect(() => parseModelConfigProfileUpdateRequest({ id: "profile-1", config: [] }))
      .toThrow("Model config profile config must be an object.");
    expect(() => parseModelConfigProfileUpdateRequest({ id: "profile-1" }))
      .toThrow("Model config profile update must include name or config.");
    expect(() => parseModelConfigProfileUpdateRequest({ id: "profile-1", config: {} }))
      .toThrow("Model config update request must include at least one field.");
    expect(() => parseModelConfigProfileUpdateRequest({
      id: "profile-1",
      config: { OPENAI_API_KEY: false },
    })).toThrow("OPENAI_API_KEY must be a string.");
  });

  it("returns an error envelope for malformed config update requests before store access", async () => {
    const store = createStore();
    registerModelConfigHandlers(store);
    const handler = electronMock.handlers.get(MODEL_CONFIG_UPDATE_CHANNEL);
    if (!handler) throw new Error("Expected model config update handler.");

    const result = await handler({}, {});

    expect(result).toEqual({
      ok: false,
      code: "MODEL_CONFIG_UPDATE_FAILED",
      message: "Model config update request must include at least one field.",
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("returns an error envelope for malformed profile update requests before store access", async () => {
    const store = createStore();
    registerModelConfigHandlers(store);
    const handler = electronMock.handlers.get(MODEL_CONFIG_PROFILES_UPDATE_CHANNEL);
    if (!handler) throw new Error("Expected model config profile update handler.");

    const result = await handler({}, { id: "profile-1", config: {} });

    expect(result).toEqual({
      ok: false,
      code: "MODEL_CONFIG_PROFILES_UPDATE_FAILED",
      message: "Model config update request must include at least one field.",
    });
    expect(store.updateProfile).not.toHaveBeenCalled();
  });

  it("returns an error envelope for malformed delete and activate requests", async () => {
    const store = createStore();
    registerModelConfigHandlers(store);
    const deleteHandler = electronMock.handlers.get(MODEL_CONFIG_PROFILES_DELETE_CHANNEL);
    const activateHandler = electronMock.handlers.get(MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL);
    if (!deleteHandler) throw new Error("Expected model config profile delete handler.");
    if (!activateHandler) throw new Error("Expected model config profile activate handler.");

    const deleted = await deleteHandler({}, { id: "" });
    const activated = await activateHandler({}, undefined);

    expect(deleted).toEqual({
      ok: false,
      code: "MODEL_CONFIG_PROFILES_DELETE_FAILED",
      message: "Model config profile id is required.",
    });
    expect(activated).toEqual({
      ok: false,
      code: "MODEL_CONFIG_PROFILES_ACTIVATE_FAILED",
      message: "Model config profile request must be an object.",
    });
    expect(store.deleteProfile).not.toHaveBeenCalled();
    expect(store.setActiveProfile).not.toHaveBeenCalled();
  });
});
