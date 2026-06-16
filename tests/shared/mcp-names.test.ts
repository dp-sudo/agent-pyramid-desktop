import { describe, expect, it } from "vitest";
import { toMcpNameSegment, namespaceMcpToolName } from "../../src/shared/mcp-names";

describe("toMcpNameSegment", () => {
  it("normalizes simple alphanumeric names", () => {
    expect(toMcpNameSegment("my-server")).toBe("my-server");
  });

  it("replaces non-alphanumeric characters with underscores", () => {
    expect(toMcpNameSegment("my server!")).toBe("my_server");
  });

  it("trims leading and trailing underscores", () => {
    expect(toMcpNameSegment("__leading__")).toBe("leading");
    expect(toMcpNameSegment("trailing__")).toBe("trailing");
  });

  it("collapses internal __ to single _ so namespace separator cannot be smuggled (L-8)", () => {
    // Without L-8 fix, a server named "foo__bar" would produce segment
    // "foo__bar" which visually collides with the mcp__<server>__<tool>
    // namespace boundary.
    expect(toMcpNameSegment("foo__bar")).toBe("foo_bar");
    expect(toMcpNameSegment("a__b__c")).toBe("a_b_c");
    expect(toMcpNameSegment("server___name")).toBe("server_name");
  });

  it("falls back to 'tool' for empty or invalid inputs", () => {
    expect(toMcpNameSegment("")).toBe("tool");
    expect(toMcpNameSegment("   ")).toBe("tool");
    expect(toMcpNameSegment("___")).toBe("tool");
    // "---" is a valid segment (matches [A-Za-z0-9-] pattern).
    expect(toMcpNameSegment("---")).toBe("---");
  });
});

describe("namespaceMcpToolName", () => {
  it("produces correct namespaced tool name", () => {
    expect(namespaceMcpToolName("my-server", "my-tool")).toBe("mcp__my-server__my-tool");
  });

  it("collapses __ in both server and tool segments (L-8)", () => {
    expect(namespaceMcpToolName("foo__bar", "baz__qux")).toBe("mcp__foo_bar__baz_qux");
  });
});
