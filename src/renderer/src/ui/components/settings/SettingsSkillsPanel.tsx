import type {
  KeyboardEvent,
  ReactElement,
} from "react";
import {
  DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MAX_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  MIN_RUNTIME_SKILLS_ACTIVE_LIMIT,
  MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
  type RuntimePreferences,
  type RuntimePreferencesUpdate,
  type RuntimeSkillCatalogEntry,
  type SkillListResponse,
} from "../../../../../shared/agent-contracts";
import {
  type RuntimeSkillsDraft,
} from "../../settings-runtime-preferences-model";
import {
  type RuntimeSkillsDraftField,
  type SettingsTranslator,
} from "../../settings-runtime-model";
import {
  SettingRow,
  SettingsCard,
  Toggle,
} from "./SettingsControls";

export interface SettingsSkillsPanelProps {
  t: SettingsTranslator;
  runtimePreferences: RuntimePreferences;
  runtimeControlsDisabled: boolean;
  skillsDraft: RuntimeSkillsDraft;
  workspaceRoot: string;
  skillCatalog: SkillListResponse | null;
  skillCatalogLoading: boolean;
  skillCatalogError: string;
  onUpdateRuntimePreferences: (update: RuntimePreferencesUpdate) => void | Promise<void>;
  onUpdateSkillsDraft: (field: RuntimeSkillsDraftField, value: string) => void;
  onCommitSkillsDraft: (
    field: RuntimeSkillsDraftField,
    raw?: string,
  ) => void | Promise<void>;
  onSkillsDraftKeyDown: (
    field: RuntimeSkillsDraftField,
    event: KeyboardEvent<HTMLInputElement>,
  ) => void;
  onUpdateSkillsExtraRoots: (value: string) => void;
  onCommitSkillsExtraRoots: (raw?: string) => void | Promise<void>;
  onSkillsExtraRootsKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRefreshSkillCatalog: () => void | Promise<void>;
}

export function SettingsSkillsPanel({
  t,
  runtimePreferences,
  runtimeControlsDisabled,
  skillsDraft,
  workspaceRoot,
  skillCatalog,
  skillCatalogLoading,
  skillCatalogError,
  onUpdateRuntimePreferences,
  onUpdateSkillsDraft,
  onCommitSkillsDraft,
  onSkillsDraftKeyDown,
  onUpdateSkillsExtraRoots,
  onCommitSkillsExtraRoots,
  onSkillsExtraRootsKeyDown,
  onRefreshSkillCatalog,
}: SettingsSkillsPanelProps): ReactElement {
  return (
    <SettingsCard
      title={t("settings.sections.skills")}
      description={t("settings.sections.skillsDesc")}
    >
      <SettingRow
        title={t("settings.fields.skillsEnabled")}
        description={t("settings.descriptions.skillsEnabled")}
        control={
          <Toggle
            checked={runtimePreferences.skills.enabled}
            label={t("settings.fields.skillsEnabled")}
            disabled={runtimeControlsDisabled}
            onChange={(checked) =>
              void onUpdateRuntimePreferences({ skills: { enabled: checked } })
            }
          />
        }
      />
      <SettingRow
        title={t("settings.fields.skillsActiveLimit")}
        description={t("settings.descriptions.skillsActiveLimit")}
        controlId="skills_active_limit"
        control={
          <input
            id="skills_active_limit"
            type="number"
            min={MIN_RUNTIME_SKILLS_ACTIVE_LIMIT}
            max={MAX_RUNTIME_SKILLS_ACTIVE_LIMIT}
            step={1}
            value={skillsDraft.activeLimit}
            disabled={runtimeControlsDisabled || !runtimePreferences.skills.enabled}
            onChange={(event) => onUpdateSkillsDraft("activeLimit", event.target.value)}
            onBlur={(event) =>
              void onCommitSkillsDraft("activeLimit", event.currentTarget.value)
            }
            onKeyDown={(event) => onSkillsDraftKeyDown("activeLimit", event)}
          />
        }
      />
      <SettingRow
        title={t("settings.fields.skillsInstructionBudgetBytes")}
        description={t("settings.descriptions.skillsInstructionBudgetBytes", {
          defaultBytes: DEFAULT_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES,
        })}
        controlId="skills_instruction_budget_bytes"
        control={
          <input
            id="skills_instruction_budget_bytes"
            type="number"
            min={MIN_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES}
            max={MAX_RUNTIME_SKILLS_INSTRUCTION_BUDGET_BYTES}
            step={1024}
            value={skillsDraft.instructionBudgetBytes}
            disabled={runtimeControlsDisabled || !runtimePreferences.skills.enabled}
            onChange={(event) =>
              onUpdateSkillsDraft("instructionBudgetBytes", event.target.value)
            }
            onBlur={(event) =>
              void onCommitSkillsDraft(
                "instructionBudgetBytes",
                event.currentTarget.value,
              )
            }
            onKeyDown={(event) =>
              onSkillsDraftKeyDown("instructionBudgetBytes", event)
            }
          />
        }
      />
      <SettingRow
        title={t("settings.fields.skillsExtraRoots")}
        description={t("settings.descriptions.skillsExtraRoots")}
        controlId="skills_extra_roots"
        wide
        control={
          <textarea
            id="skills_extra_roots"
            rows={4}
            value={skillsDraft.extraRoots}
            placeholder={t("settings.placeholders.skillsExtraRoots")}
            disabled={runtimeControlsDisabled || !runtimePreferences.skills.enabled}
            onChange={(event) => onUpdateSkillsExtraRoots(event.target.value)}
            onBlur={(event) => void onCommitSkillsExtraRoots(event.currentTarget.value)}
            onKeyDown={onSkillsExtraRootsKeyDown}
          />
        }
      />
      <SettingRow
        title={t("settings.fields.skillsCatalog")}
        description={t("settings.descriptions.skillsCatalog")}
        wide
        control={
          <div className="ds-settings-skill-catalog">
            <div className="ds-settings-skill-catalog-toolbar">
              <span>
                {workspaceRoot || t("settings.skills.noWorkspace")}
              </span>
              <button
                type="button"
                className="ds-settings-secondary-action"
                disabled={!workspaceRoot || skillCatalogLoading}
                onClick={() => void onRefreshSkillCatalog()}
              >
                {skillCatalogLoading
                  ? t("settings.skills.loading")
                  : t("settings.skills.refresh")}
              </button>
            </div>
            {skillCatalogError ? (
              <p className="ds-settings-skill-error">{skillCatalogError}</p>
            ) : null}
            {!workspaceRoot ? (
              <p className="ds-settings-empty-note">
                {t("settings.skills.noWorkspaceDesc")}
              </p>
            ) : null}
            {workspaceRoot && skillCatalog && !skillCatalogLoading ? (
              <>
                <div className="ds-settings-skill-meta">
                  <span>
                    {t("settings.skills.catalogSummary", {
                      count: skillCatalog.skills.length,
                      roots: skillCatalog.roots.length,
                    })}
                  </span>
                  <span>
                    {skillCatalog.enabled
                      ? t("settings.skills.enabled")
                      : t("settings.skills.disabled")}
                  </span>
                </div>
                {skillCatalog.validationErrors.length > 0 ? (
                  <div className="ds-settings-skill-warnings">
                    <strong>{t("settings.skills.validationWarnings")}</strong>
                    {skillCatalog.validationErrors.map((warning) => (
                      <span key={`${warning.root}:${warning.message}`}>
                        {warning.root}: {warning.message}
                      </span>
                    ))}
                  </div>
                ) : null}
                {skillCatalog.roots.length > 0 ? (
                  <div className="ds-settings-skill-roots">
                    <strong>{t("settings.skills.roots")}</strong>
                    {skillCatalog.roots.map((root) => (
                      <span key={`${root.scope}:${root.path}`}>
                        {t(`settings.skillScopes.${root.scope}`)} · {root.path}
                      </span>
                    ))}
                  </div>
                ) : null}
                {skillCatalog.skills.length === 0 ? (
                  <p className="ds-settings-empty-note">
                    {t("settings.skills.empty")}
                  </p>
                ) : (
                  <div className="ds-settings-skill-list">
                    {skillCatalog.skills.map((skill) => (
                      <article className="ds-settings-skill-card" key={skill.id}>
                        <div className="ds-settings-skill-card-header">
                          <div>
                            <strong>{skill.name}</strong>
                            <span>{skill.id}</span>
                          </div>
                          <span>
                            {t(`settings.skillScopes.${skill.scope}`)} ·{" "}
                            {t(`settings.skillRunModes.${skill.runAs}`)}
                          </span>
                        </div>
                        {skill.description ? <p>{skill.description}</p> : null}
                        <div className="ds-settings-skill-card-meta">
                          <span>{formatSkillTriggerSummary(skill, t)}</span>
                          {skill.allowedTools.length > 0 ? (
                            <span>
                              {t("settings.skills.allowedTools", {
                                tools: skill.allowedTools.join(", "),
                              })}
                            </span>
                          ) : null}
                          {skill.referenceCount > 0 ? (
                            <span>
                              {t("settings.skills.references", {
                                count: skill.referenceCount,
                                names: skill.referenceNames.join(", "),
                              })}
                            </span>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        }
      />
    </SettingsCard>
  );
}

export function formatSkillTriggerSummary(
  skill: RuntimeSkillCatalogEntry,
  t: SettingsTranslator,
): string {
  const parts: string[] = [];
  if (skill.trigger.manual) {
    parts.push(t("settings.skills.manualTrigger"));
  }
  if (skill.trigger.commands.length > 0) {
    parts.push(t("settings.skills.commands", {
      values: skill.trigger.commands.join(", "),
    }));
  }
  if (skill.trigger.keywords.length > 0) {
    parts.push(t("settings.skills.keywords", {
      values: skill.trigger.keywords.join(", "),
    }));
  }
  if (skill.trigger.promptPatterns.length > 0) {
    parts.push(t("settings.skills.promptPatterns", {
      values: skill.trigger.promptPatterns.join(", "),
    }));
  }
  if (skill.trigger.fileTypes.length > 0) {
    parts.push(t("settings.skills.fileTypes", {
      values: skill.trigger.fileTypes.join(", "),
    }));
  }
  return parts.length > 0 ? parts.join(" · ") : t("settings.skills.noTriggers");
}
