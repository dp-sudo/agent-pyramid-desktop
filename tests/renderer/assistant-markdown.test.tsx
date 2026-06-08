import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AssistantMarkdown,
  closeDanglingCodeFence,
  extractCodeText,
  normalizeMarkdownHref,
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

  it("keeps streaming fenced code readable before the model emits the closing fence", () => {
    const text = ["```tsx", "export function App() {", "  return null;", "}"].join("\n");
    const html = renderToStaticMarkup(<AssistantMarkdown text={text} streaming />);

    expect(closeDanglingCodeFence(text)).toBe(`${text}\n\`\`\``);
    expect(html).toContain("class=\"ds-code-block\"");
    expect(html).toContain("<span>tsx</span>");
    expect(html).toContain("return null;");
  });

  it("normalizes markdown links to the same safe navigation surface as Electron", () => {
    expect(normalizeMarkdownHref(" https://example.com/docs ")).toBe("https://example.com/docs");
    expect(normalizeMarkdownHref("http://example.com")).toBe("http://example.com/");
    expect(normalizeMarkdownHref("#heading")).toBe("#heading");
    expect(normalizeMarkdownHref("/local/path")).toBeNull();
    expect(normalizeMarkdownHref("./local/path")).toBeNull();
    expect(normalizeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(normalizeMarkdownHref("file:///etc/passwd")).toBeNull();
  });

  it("renders unsafe links as plain text instead of clickable anchors", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={"[bad](javascript:alert(1)) and [ok](https://example.com)"} />,
    );

    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("bad and");
    expect(html).toContain("href=\"https://example.com/\"");
  });
});
