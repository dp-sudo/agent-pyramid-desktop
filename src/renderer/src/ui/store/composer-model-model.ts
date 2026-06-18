import type {
  ModelReasoningEffort,
  RendererModelConfig,
  RendererModelConfigProfilesState,
} from "../../../../shared/agent-contracts";

export interface ComposerModelState {
  model: string;
  modelProfileId?: string;
  modelProfileSelection: "auto" | "explicit";
  reasoningEffort?: ModelReasoningEffort;
}

export function applyModelConfigToComposer<T extends ComposerModelState>(
  composer: T,
  config: RendererModelConfig,
): T {
  return {
    ...composer,
    model: config.model,
    reasoningEffort: config.model_reasoning_effort,
  };
}

export function applyModelProfilesToComposer<T extends ComposerModelState>(
  composer: T,
  profiles: RendererModelConfigProfilesState,
): T {
  const currentExplicitProfile = composer.modelProfileId &&
    composer.modelProfileSelection === "explicit"
    ? profiles.profiles.find((profile) => profile.id === composer.modelProfileId)
    : undefined;
  const activeProfile =
    profiles.profiles.find((profile) => profile.id === profiles.activeProfileId) ??
    profiles.profiles[0];
  const selectedProfile = currentExplicitProfile ?? activeProfile;
  if (!selectedProfile) return composer;
  return {
    ...composer,
    model: selectedProfile.config.model,
    modelProfileId: selectedProfile.id,
    modelProfileSelection: currentExplicitProfile ? "explicit" : "auto",
    reasoningEffort: selectedProfile.config.model_reasoning_effort,
  };
}

export function selectComposerModel<T extends ComposerModelState>(
  composer: T,
  model: string,
  modelProfileId?: string,
  modelProfileSelection?: ComposerModelState["modelProfileSelection"],
): T {
  return {
    ...composer,
    model,
    modelProfileId,
    modelProfileSelection:
      modelProfileSelection ??
      (modelProfileId ? "explicit" : "auto"),
  };
}

export function explicitComposerModelProfileId<T extends ComposerModelState>(
  composer: T,
): string | undefined {
  return composer.modelProfileSelection === "explicit"
    ? composer.modelProfileId
    : undefined;
}
