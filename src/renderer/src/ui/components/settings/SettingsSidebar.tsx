import type { ReactElement } from "react";

export type SettingsCategory =
  | "appearance"
  | "startup"
  | "layout"
  | "session"
  | "profiles"
  | "connection"
  | "context"
  | "reasoning"
  | "compaction"
  | "permissions"
  | "mcpServers"
  | "toolAccess"
  | "commandLimits"
  | "modelDefaults"
  | "attachments"
  | "approvalPresentation";

export interface SettingsSidebarItem {
  id: SettingsCategory;
  label: string;
  description: string;
  marker: string;
  advanced?: boolean;
  searchKeywords?: readonly string[];
}

interface SettingsSidebarProps {
  items: SettingsSidebarItem[];
  activeCategory: SettingsCategory;
  navLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchValue: string;
  emptyLabel: string;
  showAdvanced: boolean;
  showAdvancedLabel: string;
  showAdvancedDescription: string;
  footerTitle: string;
  footerDescription: string;
  backLabel: string;
  onSearch(value: string): void;
  onToggleAdvanced(value: boolean): void;
  onSelect(category: SettingsCategory): void;
  onBack(): void;
}

export function SettingsSidebar({
  items,
  activeCategory,
  navLabel,
  searchLabel,
  searchPlaceholder,
  searchValue,
  emptyLabel,
  showAdvanced,
  showAdvancedLabel,
  showAdvancedDescription,
  footerTitle,
  footerDescription,
  backLabel,
  onSearch,
  onToggleAdvanced,
  onSelect,
  onBack,
}: SettingsSidebarProps): ReactElement {
  return (
    <aside className="ds-settings-sidebar">
      <div className="ds-settings-sidebar-top">
        <button type="button" className="ds-settings-back" onClick={onBack}>
          <span aria-hidden="true">&lt;</span>
          {backLabel}
        </button>
      </div>
      <label className="ds-settings-search">
        <span>{searchLabel}</span>
        <input
          type="search"
          value={searchValue}
          placeholder={searchPlaceholder}
          onChange={(event) => onSearch(event.target.value)}
        />
      </label>
      <div className="ds-settings-advanced-filter">
        <div>
          <span>{showAdvancedLabel}</span>
          <small>{showAdvancedDescription}</small>
        </div>
        <button
          type="button"
          className={`ds-settings-toggle-switch${showAdvanced ? " is-on" : ""}`}
          role="switch"
          aria-checked={showAdvanced}
          aria-label={showAdvancedLabel}
          onClick={() => onToggleAdvanced(!showAdvanced)}
        >
          <span />
        </button>
      </div>
      <nav className="ds-settings-nav" aria-label={navLabel}>
        {items.length === 0 ? (
          <div className="ds-settings-nav-empty">{emptyLabel}</div>
        ) : null}
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ds-settings-nav-item${
              activeCategory === item.id ? " is-active" : ""
            }`}
            aria-current={activeCategory === item.id ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span className="ds-settings-nav-marker" aria-hidden="true">
              {item.marker}
            </span>
            <span className="ds-settings-nav-copy">
              <span>{item.label}</span>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="ds-settings-sidebar-footer">
        <div className="ds-settings-sidebar-orb" aria-hidden="true">
          S
        </div>
        <div>
          <strong>{footerTitle}</strong>
          <span>{footerDescription}</span>
        </div>
      </div>
    </aside>
  );
}
