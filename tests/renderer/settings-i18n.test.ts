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
      "settings.nav.commandLimits",
      "settings.sections.commandLimits",
      "settings.descriptions.protocol",
      "settings.descriptions.codeDefaultModelProfile",
      "settings.descriptions.writeDefaultModelProfile",
      "settings.descriptions.defaultApprovalPolicy",
      "settings.descriptions.defaultSandboxMode",
      "settings.descriptions.commandTimeout",
      "settings.descriptions.commandMaxOutput",
      "settings.descriptions.compactionEnabled",
      "settings.descriptions.compactionStrategy",
      "settings.descriptions.showDiffByDefault",
      "settings.descriptions.autoScrollOnRequest",
      "settings.descriptions.showReadOnlyToolRecords",
      "settings.descriptions.showFailureToasts",
      "settings.fields.protocol",
      "settings.fields.codeDefaultModelProfile",
      "settings.fields.writeDefaultModelProfile",
      "settings.fields.defaultApprovalPolicy",
      "settings.fields.defaultSandboxMode",
      "settings.fields.commandTimeout",
      "settings.fields.commandMaxOutput",
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
    ];

    for (const locale of [en, zhCN]) {
      for (const path of paths) {
        const value = getStringPath(locale, path);
        expect(value, path).toBeTruthy();
        expect(value, path).not.toMatch(/\?{2,}/);
      }
    }
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
