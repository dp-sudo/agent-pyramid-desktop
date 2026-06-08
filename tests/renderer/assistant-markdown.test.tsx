import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AssistantMarkdown,
  extractCodeText,
} from "../../src/renderer/src/ui/components/chat/AssistantMarkdown";

describe("AssistantMarkdown", () => {
  it("renders model output with stable wrappers for rich markdown blocks", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={[
          "See [docs](https://example.com).",
          "",
          "```ts",
          "const value = 1;",
          "```",
          "",
          "| A | B |",
          "| - | - |",
          "| long | value |",
          "",
          "- [x] done",
        ].join("\n")}
      />,
    );

    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noreferrer\"");
    expect(html).toContain("class=\"ds-code-block\"");
    expect(html).toContain("class=\"ds-code-block-header\"><span>ts</span>");
    expect(html).toContain("<button type=\"button\">chat.copyCode</button>");
    expect(html).toContain("class=\"ds-markdown-table-wrap\"");
    expect(html).toContain("class=\"ds-markdown-task-checkbox");
  });

  it("extracts only code text from a code block node tree", () => {
    expect(extractCodeText(<code className="language-ts">const value = 1;</code>)).toBe(
      "const value = 1;",
    );
  });
});
