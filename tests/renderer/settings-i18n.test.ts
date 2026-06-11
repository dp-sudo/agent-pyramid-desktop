import { describe, expect, it } from "vitest";
import en from "../../src/renderer/src/i18n/locales/en/translation.json";
import zhCN from "../../src/renderer/src/i18n/locales/zh-CN/translation.json";

describe("settings i18n resources", () => {
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
      "settings.nav.sessionDesc",
      "settings.showAdvanced",
      "settings.showAdvancedDesc",
      "settings.sections.attachments",
      "settings.sections.attachmentsDesc",
      "settings.sections.commandLimits",
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
      "settings.fields.showDiffByDefault",
      "settings.fields.autoScrollOnRequest",
      "settings.fields.showReadOnlyToolRecords",
      "settings.fields.showFailureToasts",
      "settings.profileDefaults.activeProfile",
      "settings.approvalPolicies.on-request",
      "settings.sandboxModes.workspace-write",
      "settings.compactionStrategies.preserve-tools",
      "settings.toolNames.run_command",
      "settings.errors.integerRange",
      "composer.placeholder",
      "composer.writePlaceholder",
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
