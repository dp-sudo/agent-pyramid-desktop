import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "../../src/renderer/src/ui/components/settings/SettingsSidebar";

describe("SettingsSidebar", () => {
  it("exposes the active category as the current navigation item", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSidebar, {
        items: [
          {
            id: "appearance",
            label: "Appearance",
            description: "Language and theme",
            marker: "01",
          },
          {
            id: "startup",
            label: "Startup",
            description: "Startup view",
            marker: "02",
          },
        ],
        activeCategory: "startup",
        navLabel: "Settings navigation",
        searchLabel: "Search",
        searchPlaceholder: "Filter settings",
        searchValue: "",
        emptyLabel: "No settings",
        footerTitle: "Basic",
        footerDescription: "Local preferences",
        backLabel: "Back",
        onSearch: vi.fn(),
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );

    expect(html).toContain("aria-current=\"page\"");
    expect(html).toContain("class=\"ds-settings-nav-item is-active\"");
    expect(html).toContain("Startup");
  });
});
