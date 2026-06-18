import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantMarkdown,
  closeDanglingCodeFence,
  closeDanglingInlineBackticks,
  countCodeLines,
  extractCodeText,
  isCodeBlockCollapsedByDefault,
  normalizeMarkdownHref,
  normalizeMarkdownImageSrc,
  resolveCollapsedCodeBlockDisplay,
  resolveNextCodeBlockCollapsedState,
  shouldReplaceCopyResetTimer,
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
    expect(html).toContain("class=\"ds-code-block-lines\"");
    expect(html).toContain("chat.codeLineCount");
    expect(html).toContain(
      "<button type=\"button\" aria-label=\"chat.copyCode\" title=\"chat.copyCode\">chat.copyCode</button>",
    );
    expect(html).toContain("class=\"ds-markdown-table-wrap\"");
    expect(html).toContain("class=\"ds-markdown-task-checkbox");
  });

  it("renders visible inline code without leaving empty placeholder pills", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={"Use `src/main` and `window.agentApi`; ignore `` and `   `."} />,
    );

    expect(html).toContain("<code>src/main</code>");
    expect(html).toContain("<code>window.agentApi</code>");
    expect(html).not.toContain("<code></code>");
    expect(html).not.toContain("<code>   </code>");
  });

  it("renders short fenced code blocks from the extracted source text", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={["```ts", "const value = 1;", "console.log(value);", "```"].join("\n")}
        codeBlockCollapseLineThreshold={8}
      />,
    );

    expect(html).toContain("class=\"ds-code-block\"");
    expect(html).toContain("<span>ts</span>");
    // rehype-highlight wraps the body in a single hljs code element carrying
    // the language class, with token spans inside; the raw code text survives
    // across those spans.
    expect(html).toContain("class=\"hljs language-ts\"");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("console");
    expect(html).toContain("value");
    expect(html).not.toContain("is-collapsed");
  });

  it("does not render an empty fenced code block shell", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={["Before", "", "```ts", "   ", "```", "", "After"].join("\n")} />,
    );

    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).not.toContain("class=\"ds-code-block\"");
    expect(html).not.toContain("chat.copyCode");
  });

  it("applies rehype-highlight syntax tokens inside fenced code blocks", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={["```ts", "const value = 1;", "```"].join("\n")}
      />,
    );

    // rehype-highlight wraps tokens in hljs-* spans; the keyword (const) and
    // number (1) tokens confirm the highlighter ran while the outer code
    // shell language label is preserved as a single hljs code element.
    expect(html).toContain("class=\"hljs-keyword\"");
    expect(html).toContain("class=\"hljs-number\"");
    expect(html).toContain("class=\"hljs language-ts\"");
  });

  it("collapses long code blocks by default without hiding the copy control", () => {
    const longCode = Array.from({ length: 19 }, (_, index) => `line ${index + 1}`).join("\n");
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={["```txt", longCode, "```"].join("\n")} />,
    );

    expect(isCodeBlockCollapsedByDefault(longCode)).toBe(true);
    expect(isCodeBlockCollapsedByDefault("short\ncode")).toBe(false);
    expect(html).toContain("class=\"ds-code-block is-collapsed\"");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("class=\"ds-code-block-collapse-note\"");
    expect(html).toContain("chat.collapsedCodePreview");
    const controlsMatch = /aria-controls="([^"]+)"/.exec(html);
    const preIdMatch = /<pre[^>]* id="([^"]+)"/.exec(html);
    if (!controlsMatch || !preIdMatch) {
      throw new Error(`Expected collapsed code block control and pre id in: ${html}`);
    }
    expect(controlsMatch[1]).toBe(preIdMatch[1]);
    expect(html).toContain("chat.expandCode");
    expect(html).toContain("chat.copyCode");
    expect(html).toContain("line 12");
    expect(html).not.toContain("line 19");
  });

  it("renders only a bounded source preview while a long code block is collapsed", () => {
    const longCode = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(resolveCollapsedCodeBlockDisplay(longCode, 5)).toEqual({
      text: ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"),
      hiddenLineCount: 15,
    });
  });

  it("uses the configured code block collapse threshold", () => {
    const code = Array.from({ length: 4 }, (_, index) => `line ${index + 1}`).join("\n");
    const collapsedHtml = renderToStaticMarkup(
      <AssistantMarkdown
        text={["```txt", code, "```"].join("\n")}
        codeBlockCollapseLineThreshold={3}
      />,
    );
    const openHtml = renderToStaticMarkup(
      <AssistantMarkdown
        text={["```txt", code, "```"].join("\n")}
        codeBlockCollapseLineThreshold={4}
      />,
    );

    expect(isCodeBlockCollapsedByDefault(code, 3)).toBe(true);
    expect(isCodeBlockCollapsedByDefault(code, 4)).toBe(false);
    expect(collapsedHtml).toContain("class=\"ds-code-block is-collapsed\"");
    expect(openHtml).not.toContain("class=\"ds-code-block is-collapsed\"");
    expect(openHtml).not.toContain("ds-code-block-collapse-note");
  });

  it("counts code block lines without treating a trailing newline as an extra line", () => {
    expect(countCodeLines("")).toBe(0);
    expect(countCodeLines("one")).toBe(1);
    expect(countCodeLines("one\ntwo\n")).toBe(2);
  });

  it("updates code block collapse state only while the user has not overridden it", () => {
    expect(
      resolveNextCodeBlockCollapsedState({
        currentCollapsed: false,
        defaultCollapsed: true,
        userControlled: false,
      }),
    ).toBe(true);
    expect(
      resolveNextCodeBlockCollapsedState({
        currentCollapsed: false,
        defaultCollapsed: true,
        userControlled: true,
      }),
    ).toBe(false);
    expect(
      resolveNextCodeBlockCollapsedState({
        currentCollapsed: true,
        defaultCollapsed: false,
        userControlled: true,
      }),
    ).toBe(false);
  });

  it("replaces only pending code-copy reset timers", () => {
    expect(shouldReplaceCopyResetTimer(null)).toBe(false);
    expect(shouldReplaceCopyResetTimer(1)).toBe(true);
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
    expect(closeDanglingInlineBackticks(text)).toBe(text);
    expect(html).toContain("class=\"ds-code-block\"");
    expect(html).toContain("<span>tsx</span>");
    // The dangling fence is closed before parsing, so the body is highlighted
    // and tokens render as spans rather than raw text.
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-literal");
  });

  it("repairs dangling inline backticks without counting fenced code", () => {
    expect(closeDanglingInlineBackticks("Use `src/main")).toBe("Use `src/main`");
    expect(closeDanglingInlineBackticks([
      "```txt",
      "literal ` backtick",
      "```",
    ].join("\n"))).toBe([
      "```txt",
      "literal ` backtick",
      "```",
    ].join("\n"));
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

  it("keeps unexpected markdown URL normalization failures observable", () => {
    const originalUrl = globalThis.URL;
    vi.stubGlobal("URL", class {
      constructor() {
        throw new Error("Unexpected URL parser failure.");
      }
    });
    try {
      expect(() => normalizeMarkdownHref("https://example.com")).toThrow(
        "Unexpected URL parser failure.",
      );
      expect(() => normalizeMarkdownImageSrc("https://example.com/image.png")).toThrow(
        "Unexpected URL parser failure.",
      );
    } finally {
      vi.stubGlobal("URL", originalUrl);
    }
  });

  it("renders unsafe links as plain text instead of clickable anchors", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={"[bad](javascript:alert(1)) and [ok](https://example.com)"} />,
    );

    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("bad and");
    expect(html).toContain("href=\"https://example.com/\"");
  });

  it("renders only safe markdown images with lazy async loading", () => {
    expect(normalizeMarkdownImageSrc(" https://example.com/image.png ")).toBe(
      "https://example.com/image.png",
    );
    expect(normalizeMarkdownImageSrc("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(normalizeMarkdownImageSrc("data:text/html;base64,AAAA")).toBeNull();
    expect(normalizeMarkdownImageSrc("javascript:alert(1)")).toBeNull();
    expect(normalizeMarkdownImageSrc("file:///tmp/image.png")).toBeNull();

    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={[
          "![safe](https://example.com/image.png)",
          "![unsafe](javascript:alert(1))",
        ].join("\n")}
      />,
    );

    expect(html).toContain("class=\"ds-markdown-image-frame\"");
    expect(html).toContain("loading=\"lazy\"");
    expect(html).toContain("decoding=\"async\"");
    expect(html).toContain("src=\"https://example.com/image.png\"");
    expect(html).not.toContain("javascript:alert");
  });
});
