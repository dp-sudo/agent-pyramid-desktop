import type { RendererModelConfigProfile } from "../../../shared/agent-contracts";
import type { SettingsCategory } from "./components/settings/SettingsSidebar";
import type { SettingsFormState } from "./settings-model-config-model";

export type SaveState = "idle" | "dirty" | "loading" | "saving" | "saved" | "error";

export function emptyStringToNullableProfileId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isProfileDeletePending(
  pendingDeleteProfileId: string | null,
  profileId: string,
): boolean {
  return pendingDeleteProfileId === profileId;
}

export function prunePendingProfileDeleteId(
  pendingDeleteProfileId: string | null,
  profiles: readonly Pick<RendererModelConfigProfile, "id">[],
): string | null {
  if (!pendingDeleteProfileId) return null;
  return profiles.some((profile) => profile.id === pendingDeleteProfileId)
    ? pendingDeleteProfileId
    : null;
}

export function shouldBlockSettingsNavigation(
  saveState: SaveState,
  hasUnsavedChanges = false,
): boolean {
  return saveState === "dirty" || (saveState === "error" && hasUnsavedChanges);
}

export function shouldAllowSettingsCategorySelection(
  currentCategory: SettingsCategory,
  nextCategory: SettingsCategory,
  saveState: SaveState,
  hasUnsavedChanges = false,
): boolean {
  return (
    currentCategory === nextCategory ||
    !shouldBlockSettingsNavigation(saveState, hasUnsavedChanges)
  );
}

export function shouldDisableModelProfileControls(
  hasAgentApi: boolean,
  saveState: SaveState,
  profileBusy: string,
): boolean {
  return !hasAgentApi ||
    saveState === "loading" ||
    saveState === "saving" ||
    Boolean(profileBusy);
}

export function hasUnsavedProfileChanges(
  activeProfile: RendererModelConfigProfile | null,
  profileName: string,
  form: SettingsFormState,
  apiKeyDirty = false,
): boolean {
  if (!activeProfile) return false;
  return (
    profileName !== activeProfile.name ||
    form.model_provide !== activeProfile.config.model_provide ||
    form.model !== activeProfile.config.model ||
    form.protocol !== activeProfile.config.protocol ||
    form.base_url !== activeProfile.config.base_url ||
    apiKeyDirty ||
    form.model_context_window !== String(activeProfile.config.model_context_window) ||
    form.model_auto_compact_token_limit !==
      String(activeProfile.config.model_auto_compact_token_limit) ||
    form.max_tokens !== String(activeProfile.config.max_tokens) ||
    form.thinking !== activeProfile.config.thinking ||
    form.model_reasoning_effort !== activeProfile.config.model_reasoning_effort ||
    form.agent_autonomy !== activeProfile.config.agent_autonomy
  );
}
