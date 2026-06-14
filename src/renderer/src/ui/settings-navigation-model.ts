import type {
  SettingsCategory,
  SettingsSidebarItem,
} from "./components/settings/SettingsSidebar";
import {
  getSettingsCategorySearchKeywords,
  isSettingsCategoryAdvanced,
} from "./components/settings/settings-search";

type SettingsNavigationTranslator = (key: string) => string;

export type SettingsSection =
  | "basic"
  | "model"
  | "agent"
  | "tools"
  | "workbench"
  | "visibility";

export interface SettingsSectionItem {
  id: SettingsSection;
  label: string;
  description: string;
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "basic",
  "model",
  "agent",
  "tools",
  "workbench",
  "visibility",
];

const MODEL_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "profiles",
  "connection",
  "context",
  "reasoning",
];
const BASIC_SETTINGS_CATEGORIES: readonly SettingsCategory[] = ["appearance"];
const AGENT_SETTINGS_CATEGORIES: readonly SettingsCategory[] = ["compaction", "skills"];
const TOOLS_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "permissions",
  "mcpServers",
  "toolAccess",
  "commandLimits",
];
const WORKBENCH_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "startup",
  "layout",
  "session",
  "modelDefaults",
  "attachments",
];
const VISIBILITY_SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "approvalPresentation",
];

export function getSettingsSectionItems(
  t: SettingsNavigationTranslator,
): SettingsSectionItem[] {
  return SETTINGS_SECTIONS.map((section) => ({
    id: section,
    label: t(`settings.sectionTabs.${section}`),
    description: t(`settings.sectionTabs.${section}Desc`),
  }));
}

export function canSubmitModelSettingsSection(
  section: SettingsSection,
  category: SettingsCategory,
): boolean {
  return section === "model" && category !== "profiles";
}

export function getDefaultCategoryForSection(
  section: SettingsSection,
): SettingsCategory {
  switch (section) {
    case "basic":
      return "appearance";
    case "model":
      return "profiles";
    case "agent":
      return "compaction";
    case "tools":
      return "permissions";
    case "workbench":
      return "startup";
    case "visibility":
      return "approvalPresentation";
  }
}

export function isSettingsCategoryInSection(
  section: SettingsSection,
  category: SettingsCategory,
): boolean {
  return getSettingsCategoriesForSection(section).includes(category);
}

export function getFirstVisibleSettingsCategoryForSection(
  section: SettingsSection,
  showAdvanced: boolean,
): SettingsCategory | null {
  return getSettingsCategoriesForSection(section)
    .find((category) => showAdvanced || !isSettingsCategoryAdvanced(category)) ?? null;
}

export function getSettingsNavItems(
  section: SettingsSection,
  t: SettingsNavigationTranslator,
): SettingsSidebarItem[] {
  return getSettingsCategoriesForSection(section).map((category, index) => ({
    id: category,
    label: t(`settings.nav.${category}`),
    description: t(`settings.nav.${category}Desc`),
    marker: String(index + 1).padStart(2, "0"),
    advanced: isSettingsCategoryAdvanced(category),
    searchKeywords: getSettingsCategorySearchKeywords(category, t),
  }));
}

function getSettingsCategoriesForSection(
  section: SettingsSection,
): readonly SettingsCategory[] {
  switch (section) {
    case "basic":
      return BASIC_SETTINGS_CATEGORIES;
    case "model":
      return MODEL_SETTINGS_CATEGORIES;
    case "agent":
      return AGENT_SETTINGS_CATEGORIES;
    case "tools":
      return TOOLS_SETTINGS_CATEGORIES;
    case "workbench":
      return WORKBENCH_SETTINGS_CATEGORIES;
    case "visibility":
      return VISIBILITY_SETTINGS_CATEGORIES;
  }
}
