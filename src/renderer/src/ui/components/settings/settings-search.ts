import type { SettingsCategory, SettingsSidebarItem } from "./SettingsSidebar";
import { RUNTIME_TOOL_NAMES } from "../../../../../shared/agent-contracts";

type SettingsTranslator = (key: string) => string;

const ADVANCED_SETTINGS_CATEGORIES = new Set<SettingsCategory>([
  "context",
  "reasoning",
  "toolAccess",
  "commandLimits",
]);

const SETTINGS_CATEGORY_SEARCH_KEY_PATHS: Record<SettingsCategory, readonly string[]> = {
  appearance: [
    "settings.fields.locale",
    "settings.descriptions.locale",
    "settings.fields.theme",
    "settings.descriptions.theme",
    "settings.fields.followSystemTheme",
    "settings.descriptions.followSystemTheme",
    "settings.themes.light",
    "settings.themes.dark",
  ],
  startup: [
    "settings.fields.defaultStartupView",
    "settings.descriptions.defaultStartupView",
    "settings.startupViews.code",
    "settings.startupViews.write",
  ],
  layout: [
    "settings.fields.rememberLeftSidebarWidth",
    "settings.descriptions.rememberLeftSidebarWidth",
    "settings.fields.rememberRightSidebarWidth",
    "settings.descriptions.rememberRightSidebarWidth",
    "settings.fields.defaultInspectorMode",
    "settings.descriptions.defaultInspectorMode",
    "settings.fields.codeBlockCollapseLineThreshold",
    "settings.descriptions.codeBlockCollapseLineThreshold",
    "settings.fields.openReasoningByDefault",
    "settings.descriptions.openReasoningByDefault",
    "settings.inspectorDefaults.closed",
    "settings.inspectorDefaults.changes",
    "settings.inspectorDefaults.todo",
    "settings.inspectorDefaults.plan",
  ],
  session: [
    "settings.fields.showArchivedThreadsByDefault",
    "settings.descriptions.showArchivedThreadsByDefault",
    "settings.fields.restoreLastWorkspaceOnStartup",
    "settings.descriptions.restoreLastWorkspaceOnStartup",
  ],
  profiles: [
    "settings.profiles.title",
    "settings.profiles.subtitle",
    "settings.profiles.addMiniMax",
    "settings.profiles.addDeepSeek",
    "settings.profiles.addCustom",
    "settings.profiles.duplicate",
    "settings.profiles.delete",
  ],
  connection: [
    "settings.fields.profileName",
    "settings.descriptions.profileName",
    "settings.fields.modelProvide",
    "settings.descriptions.modelProvide",
    "settings.fields.model",
    "settings.descriptions.model",
    "settings.fields.protocol",
    "settings.descriptions.protocol",
    "settings.fields.baseUrl",
    "settings.descriptions.baseUrl",
    "settings.fields.apiKey",
    "settings.descriptions.apiKey",
    "settings.protocols.openai-compatible",
    "settings.protocols.anthropic-compatible",
  ],
  context: [
    "settings.fields.contextWindow",
    "settings.descriptions.contextWindow",
    "settings.fields.compactLimit",
    "settings.descriptions.compactLimit",
    "settings.fields.maxTokens",
    "settings.descriptions.maxTokens",
  ],
  reasoning: [
    "settings.fields.thinking",
    "settings.descriptions.thinking",
    "settings.fields.reasoningEffort",
    "settings.descriptions.reasoningEffort",
    "settings.fields.agentAutonomy",
    "settings.descriptions.agentAutonomy",
    "settings.efforts.low",
    "settings.efforts.medium",
    "settings.efforts.high",
    "settings.efforts.xhigh",
    "settings.autonomy.conservative",
    "settings.autonomy.balanced",
    "settings.autonomy.deep",
  ],
  compaction: [
    "settings.fields.compactionEnabled",
    "settings.descriptions.compactionEnabled",
    "settings.fields.compactionStrategy",
    "settings.descriptions.compactionStrategy",
    "settings.compactionStrategies.balanced",
    "settings.compactionStrategies.recent-only",
    "settings.compactionStrategies.preserve-tools",
    "settings.compactionStrategies.aggressive",
  ],
  permissions: [
    "settings.fields.defaultApprovalPolicy",
    "settings.descriptions.defaultApprovalPolicy",
    "settings.fields.defaultSandboxMode",
    "settings.descriptions.defaultSandboxMode",
    "settings.approvalPolicies.auto",
    "settings.approvalPolicies.on-request",
    "settings.approvalPolicies.untrusted",
    "settings.approvalPolicies.never",
    "settings.sandboxModes.read-only",
    "settings.sandboxModes.workspace-write",
    "settings.sandboxModes.danger-full-access",
  ],
  toolAccess: [
    "settings.fields.codeToolAccess",
    "settings.fields.writeToolAccess",
    ...RUNTIME_TOOL_NAMES.map((toolName) => `settings.toolNames.${toolName}`),
  ],
  commandLimits: [
    "settings.fields.commandTimeout",
    "settings.descriptions.commandTimeout",
    "settings.fields.commandMaxOutput",
    "settings.descriptions.commandMaxOutput",
  ],
  modelDefaults: [
    "settings.fields.codeDefaultModelProfile",
    "settings.descriptions.codeDefaultModelProfile",
    "settings.fields.writeDefaultModelProfile",
    "settings.descriptions.writeDefaultModelProfile",
    "settings.profileDefaults.activeProfile",
  ],
  attachments: [
    "settings.fields.allowComposerImageUpload",
    "settings.descriptions.allowComposerImageUpload",
    "settings.fields.allowComposerImagePaste",
    "settings.descriptions.allowComposerImagePaste",
  ],
  approvalPresentation: [
    "settings.fields.showDiffByDefault",
    "settings.descriptions.showDiffByDefault",
    "settings.fields.autoScrollOnRequest",
    "settings.descriptions.autoScrollOnRequest",
    "settings.fields.showReadOnlyToolRecords",
    "settings.descriptions.showReadOnlyToolRecords",
    "settings.fields.showFailureToasts",
    "settings.descriptions.showFailureToasts",
  ],
};

export function getSettingsCategorySearchKeywords(
  category: SettingsCategory,
  t: SettingsTranslator,
): string[] {
  return SETTINGS_CATEGORY_SEARCH_KEY_PATHS[category].map((key) => t(key));
}

export function filterSettingsSidebarItems(
  items: readonly SettingsSidebarItem[],
  query: string,
  options: { showAdvanced?: boolean } = {},
): SettingsSidebarItem[] {
  const showAdvanced = options.showAdvanced ?? true;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const availableItems = showAdvanced
    ? [...items]
    : items.filter((item) => !item.advanced);
  if (!normalizedQuery) return availableItems;
  return availableItems.filter((item) =>
    [item.label, item.description, item.id, ...(item.searchKeywords ?? [])]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
}

export function isSettingsCategoryAdvanced(category: SettingsCategory): boolean {
  return ADVANCED_SETTINGS_CATEGORIES.has(category);
}
