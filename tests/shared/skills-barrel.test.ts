import { describe, expect, it } from "vitest";

describe("shared skills barrel", () => {
  it("does not expose Node-only registry loaders through the cross-process interface", async () => {
    const skills = await import("../../src/shared/skills");

    expect(skills).toHaveProperty("parseSkillMarkdown");
    expect(skills).toHaveProperty("createBuiltinSkills");
    expect(skills).toHaveProperty("SkillError");
    expect(skills).not.toHaveProperty("SkillRegistry");
    expect(skills).not.toHaveProperty("loadSkills");
    expect(skills).not.toHaveProperty("loadSkillsFromRoots");
  });
});
