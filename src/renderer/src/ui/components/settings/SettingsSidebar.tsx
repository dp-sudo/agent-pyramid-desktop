import type { ReactElement } from "react";

export type SettingsCategory =
  | "appearance"
  | "startup"
  | "session"
  | "profiles"
  | "connection"
  | "context"
  | "reasoning";

export interface SettingsSidebarItem {
  id: SettingsCategory;
  label: string;
  description: string;
  marker: string;
}

interface SettingsSidebarProps {
  items: SettingsSidebarItem[];
  activeCategory: SettingsCategory;
  navLabel: string;
  footerTitle: string;
  footerDescription: string;
  backLabel: string;
  onSelect(category: SettingsCategory): void;
  onBack(): void;
}

export function SettingsSidebar({
  items,
  activeCategory,
  navLabel,
  footerTitle,
  footerDescription,
  backLabel,
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
      <nav className="ds-settings-nav" aria-label={navLabel}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ds-settings-nav-item${
              activeCategory === item.id ? " is-active" : ""
            }`}
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
