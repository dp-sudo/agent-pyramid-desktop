import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InitialSessionUsageHeatmap } from "../../src/renderer/src/ui/components/chat/InitialSessionUsageHeatmap";

describe("InitialSessionUsageHeatmap", () => {
  it("exposes the usage cells as one labeled graphic", () => {
    const html = renderToStaticMarkup(<InitialSessionUsageHeatmap />);

    expect(html).toContain("class=\"ds-usage-heatmap\" role=\"img\" aria-label=\"usage.heatmap\"");
    expect(html.match(/class="ds-usage-cell"/g)).toHaveLength(35);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(35);
  });
});
