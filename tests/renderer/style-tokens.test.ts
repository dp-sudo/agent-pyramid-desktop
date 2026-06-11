import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const tokensCss = readFileSync(
  resolve(repoRoot, "src/renderer/src/ui/styles/tokens.css"),
  "utf8",
);
const shellCss = readFileSync(
  resolve(repoRoot, "src/renderer/src/ui/styles/shell.css"),
  "utf8",
);

describe("renderer style tokens", () => {
  it("uses only defined design tokens in shell styles", () => {
    const definedTokens = extractDefinedDesignTokens(tokensCss);
    const referencedTokens = extractReferencedDesignTokens(shellCss);

    expect(
      referencedTokens.filter((token) => !definedTokens.has(token)),
    ).toEqual([]);
  });

  it("keeps component styles on tokenized color and elevation values", () => {
    expect(shellCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(shellCss).not.toMatch(/:\s*(?:white|black)\s*;/i);
    expect(shellCss).not.toMatch(/\brgba\(/i);
  });
});

function extractDefinedDesignTokens(css: string): Set<string> {
  return new Set(
    Array.from(css.matchAll(/(--ds-[\w-]+)\s*:/g), (match) => match[1]),
  );
}

function extractReferencedDesignTokens(css: string): string[] {
  return Array.from(
    new Set(Array.from(css.matchAll(/var\((--ds-[\w-]+)/g), (match) => match[1])),
  ).sort();
}
