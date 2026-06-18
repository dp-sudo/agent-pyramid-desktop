import { describe, expect, it } from "vitest";
import {
  applyModelConfigToComposer,
  applyModelProfilesToComposer,
  explicitComposerModelProfileId,
  selectComposerModel,
  type ComposerModelState,
} from "../../src/renderer/src/ui/store/composer-model-model";
import {
  DEFAULT_MODEL_CONFIG,
  toRendererModelConfig,
  toRendererModelConfigProfilesState,
} from "../../src/shared/agent-contracts";
import type { ModelConfigProfilesState, RendererModelConfigProfilesState } from "../../src/shared/agent-contracts";

function composer(overrides: Partial<ComposerModelState> = {}): ComposerModelState {
  return {
    model: "base-model",
    modelProfileSelection: "auto",
    reasoningEffort: "medium",
    ...overrides,
  };
}

function profiles(activeProfileId = "profile-2"): RendererModelConfigProfilesState {
  const rawProfiles: ModelConfigProfilesState = {
    activeProfileId,
    profiles: [
      {
        id: "profile-1",
        name: "Selected",
        config: {
          ...DEFAULT_MODEL_CONFIG,
          model: "selected-model",
          model_reasoning_effort: "low",
        },
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
      {
        id: "profile-2",
        name: "Active",
        config: {
          ...DEFAULT_MODEL_CONFIG,
          model: "active-model",
          model_reasoning_effort: "xhigh",
        },
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
    ],
  };
  return toRendererModelConfigProfilesState(rawProfiles);
}

describe("composer model model", () => {
  it("applies base model config without changing profile selection", () => {
    expect(applyModelConfigToComposer(
      composer({ modelProfileId: "profile-1", modelProfileSelection: "explicit" }),
      {
        ...toRendererModelConfig(DEFAULT_MODEL_CONFIG),
        model: "configured-model",
        model_reasoning_effort: "high",
      },
    )).toMatchObject({
      model: "configured-model",
      modelProfileId: "profile-1",
      modelProfileSelection: "explicit",
      reasoningEffort: "high",
    });
  });

  it("selects explicit composer profiles only when explicitly requested", () => {
    expect(selectComposerModel(composer(), "selected-model", "profile-1"))
      .toMatchObject({
        model: "selected-model",
        modelProfileId: "profile-1",
        modelProfileSelection: "explicit",
      });
    expect(selectComposerModel(composer({ modelProfileId: "profile-1" }), "active-model"))
      .toMatchObject({
        model: "active-model",
        modelProfileId: undefined,
        modelProfileSelection: "auto",
      });
    expect(selectComposerModel(composer(), "active-model", "profile-2", "auto"))
      .toMatchObject({
        model: "active-model",
        modelProfileId: "profile-2",
        modelProfileSelection: "auto",
      });
  });

  it("preserves explicit profile selection when refreshed profiles still contain it", () => {
    const next = applyModelProfilesToComposer(
      composer({ modelProfileId: "profile-1", modelProfileSelection: "explicit" }),
      profiles(),
    );

    expect(next).toMatchObject({
      model: "selected-model",
      modelProfileId: "profile-1",
      modelProfileSelection: "explicit",
      reasoningEffort: "low",
    });
  });

  it("falls back to the active profile when explicit selection disappears", () => {
    const next = applyModelProfilesToComposer(
      composer({ modelProfileId: "missing-profile", modelProfileSelection: "explicit" }),
      profiles(),
    );

    expect(next).toMatchObject({
      model: "active-model",
      modelProfileId: "profile-2",
      modelProfileSelection: "auto",
      reasoningEffort: "xhigh",
    });
  });

  it("returns no model profile id unless selection is explicit", () => {
    expect(explicitComposerModelProfileId(composer({
      modelProfileId: "active-profile",
      modelProfileSelection: "auto",
    }))).toBeUndefined();
    expect(explicitComposerModelProfileId(composer({
      modelProfileId: "selected-profile",
      modelProfileSelection: "explicit",
    }))).toBe("selected-profile");
  });
});
