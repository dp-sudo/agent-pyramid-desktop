import { describe, expect, it } from "vitest";
import en from "../../src/renderer/src/i18n/locales/en/translation.json";
import zhCN from "../../src/renderer/src/i18n/locales/zh-CN/translation.json";

describe("settings i18n resources", () => {
  it("keeps English and Simplified Chinese resource keys aligned", () => {
    expect(flattenKeys(en)).toEqual(flattenKeys(zhCN));
  });

  it("keeps first-priority Settings control labels readable in both locales", () => {
    const paths = [
      "settings.subtitles.agent",
      "settings.subtitles.tools",
      "settings.subtitles.workbench",
      "settings.subtitles.visibility",
      "settings.sectionTabs.tools",
      "settings.nav.attachments",
      "settings.nav.attachmentsDesc",
      "settings.nav.commandLimits",
      "settings.nav.skills",
      "settings.nav.skillsDesc",
      "settings.nav.mcpServers",
      "settings.nav.mcpServersDesc",
      "settings.nav.sessionDesc",
      "settings.showAdvanced",
      "settings.showAdvancedDesc",
      "settings.sections.attachments",
      "settings.sections.attachmentsDesc",
      "settings.sections.commandLimits",
      "settings.sections.skills",
      "settings.sections.skillsDesc",
      "settings.sections.mcpServers",
      "settings.sections.mcpServersDesc",
      "settings.sections.sessionDesc",
      "settings.descriptions.allowComposerImageUpload",
      "settings.descriptions.allowComposerImagePaste",
      "settings.descriptions.protocol",
      "settings.descriptions.codeDefaultModelProfile",
      "settings.descriptions.writeDefaultModelProfile",
      "settings.descriptions.defaultApprovalPolicy",
      "settings.descriptions.defaultSandboxMode",
      "settings.descriptions.commandTimeout",
      "settings.descriptions.commandMaxOutput",
      "settings.descriptions.codeBlockCollapseLineThreshold",
      "settings.descriptions.openReasoningByDefault",
      "settings.descriptions.compactionEnabled",
      "settings.descriptions.compactionStrategy",
      "settings.descriptions.skillsEnabled",
      "settings.descriptions.skillsActiveLimit",
      "settings.descriptions.skillsInstructionBudgetBytes",
      "settings.descriptions.skillsExtraRoots",
      "settings.descriptions.skillsCatalog",
      "settings.descriptions.showDiffByDefault",
      "settings.descriptions.autoScrollOnRequest",
      "settings.descriptions.showReadOnlyToolRecords",
      "settings.descriptions.showFailureToasts",
      "settings.fields.protocol",
      "settings.fields.allowComposerImageUpload",
      "settings.fields.allowComposerImagePaste",
      "settings.fields.codeDefaultModelProfile",
      "settings.fields.writeDefaultModelProfile",
      "settings.fields.defaultApprovalPolicy",
      "settings.fields.defaultSandboxMode",
      "settings.fields.commandTimeout",
      "settings.fields.commandMaxOutput",
      "settings.fields.codeBlockCollapseLineThreshold",
      "settings.fields.openReasoningByDefault",
      "settings.fields.compactionEnabled",
      "settings.fields.compactionStrategy",
      "settings.fields.skillsEnabled",
      "settings.fields.skillsActiveLimit",
      "settings.fields.skillsInstructionBudgetBytes",
      "settings.fields.skillsExtraRoots",
      "settings.fields.skillsCatalog",
      "settings.fields.showDiffByDefault",
      "settings.fields.autoScrollOnRequest",
      "settings.fields.showReadOnlyToolRecords",
      "settings.fields.showFailureToasts",
      "settings.fields.mcpServerTransport",
      "settings.fields.mcpServerName",
      "settings.fields.mcpServerUrl",
      "settings.placeholders.skillsExtraRoots",
      "settings.skills.noWorkspace",
      "settings.skills.noWorkspaceDesc",
      "settings.skills.loading",
      "settings.skills.refresh",
      "settings.skills.catalogSummary",
      "settings.skills.enabled",
      "settings.skills.disabled",
      "settings.skills.validationWarnings",
      "settings.skills.roots",
      "settings.skills.empty",
      "settings.skills.allowedTools",
      "settings.skills.references",
      "settings.skills.manualTrigger",
      "settings.skills.commands",
      "settings.skills.keywords",
      "settings.skills.promptPatterns",
      "settings.skills.fileTypes",
      "settings.skills.noTriggers",
      "settings.skillScopes.project",
      "settings.skillScopes.custom",
      "settings.skillScopes.builtin",
      "settings.skillRunModes.inline",
      "settings.skillRunModes.subagent",
      "settings.actions.addMcpServer",
      "settings.actions.connectMcpServer",
      "settings.mcpServers.statusSummary",
      "settings.mcpServers.startupStats",
      "settings.mcpTransports.streamable-http",
      "settings.mcpStatuses.cached",
      "settings.mcpStatuses.lazy",
      "settings.mcpStatuses.connected",
      "settings.profileDefaults.activeProfile",
      "settings.approvalPolicies.on-request",
      "settings.sandboxModes.workspace-write",
      "settings.compactionStrategies.preserve-tools",
      "settings.toolNames.run_command",
      "settings.toolNames.run_skill",
      "settings.errors.integerRange",
      "settings.errors.mcpEnvDuplicateKey",
      "settings.errors.mcpHeadersDuplicateKey",
      "composer.placeholder",
      "composer.writePlaceholder",
      "composer.mcpPromptCommandInvalid",
      "composer.mcpPromptNotFound",
      "composer.mcpResourceServerNotFound",
      "chat.collapsedCodePreview",
      "chat.tools.genericCommand",
      "chat.tools.genericPath",
      "chat.tools.genericQuery",
    ];

    for (const locale of [en, zhCN]) {
      for (const path of paths) {
        const value = getStringPath(locale, path);
        expect(value, path).toBeTruthy();
        expect(value, path).not.toMatch(/\?{2,}/);
      }
    }
  });

  it("does not present thread delete confirmation as a configurable setting", () => {
    expect(en.settings.nav.sessionDesc).not.toMatch(/delete/i);
    expect(en.settings.sections.sessionDesc).not.toMatch(/delete confirmation/i);
    expect(zhCN.settings.nav.sessionDesc).not.toContain("删除");
    expect(zhCN.settings.sections.sessionDesc).not.toContain("删除确认");
  });
});

function flattenKeys(source: unknown, prefix = ""): string[] {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return [prefix];
  }
  return Object.entries(source)
    .flatMap(([key, value]) => flattenKeys(value, prefix ? `${prefix}.${key}` : key))
    .sort();
}

function getStringPath(source: unknown, path: string): string {
  let value: unknown = source;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !(key in value)) {
      return "";
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : "";
}
