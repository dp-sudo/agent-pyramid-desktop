import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillError } from "../../shared/skills/index.js";
import { SkillService } from "./skill-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = path.join(repoRoot, "tests", "fixtures", "skills");

describe("SkillService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("discovers skills from a fixtures root", async () => {
    const service = new SkillService();

    const skills = await service.loadSkills(fixturesRoot);

    expect(skills.map((skill) => skill.id)).toEqual(["example-skill"]);
  });

  it("parses SKILL.md name, description, and trigger", async () => {
    const service = new SkillService();

    const [skill] = await service.loadSkills(fixturesRoot);

    expect(skill).toMatchObject({
      id: "example-skill",
      name: "Example Skill",
      description: "Demonstrates minimal skill loading for tests.",
      trigger: {
        kind: "keyword",
        value: "example skill",
      },
    });
  });

  it("loads skills by id with non-empty fields", async () => {
    const service = new SkillService();
    await service.loadSkills(fixturesRoot);

    const skill = service.getSkill("example-skill");

    expect(skill?.name).toBeTruthy();
    expect(skill?.description).toBeTruthy();
    expect(skill?.trigger.value).toBeTruthy();
    expect(skill?.body).toContain("Use this skill");
  });

  it("keeps missing root errors observable", async () => {
    const service = new SkillService();

    await expect(service.loadSkills(path.join(tempRoot, "missing-root")))
      .rejects.toMatchObject({
        code: "skills_root_not_found",
      });
  });

  it("keeps missing SKILL.md errors observable", async () => {
    const service = new SkillService();
    const skillDir = path.join(tempRoot, "missing-skill-file");
    await fs.mkdir(skillDir);

    await expect(service.loadSkillDirectory(skillDir))
      .rejects.toMatchObject({
        code: "skill_manifest_not_found",
      });
  });

  it("keeps missing field errors observable", async () => {
    const service = new SkillService();
    const skillDir = path.join(tempRoot, "invalid-skill");
    await fs.mkdir(skillDir);
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Invalid Skill",
        "trigger: keyword:invalid",
        "---",
        "",
        "This skill is missing description.",
      ].join("\n"),
      "utf8",
    );

    await expect(service.loadSkillDirectory(skillDir))
      .rejects.toMatchObject({
        code: "skill_manifest_invalid",
      });
  });

  it("matches a loaded skill by trigger", async () => {
    const service = new SkillService();
    await service.loadSkills(fixturesRoot);

    expect(service.matchSkill({ text: "please use the example skill" }).map((skill) => skill.id))
      .toEqual(["example-skill"]);
  });

  it("uses typed SkillError instances for service failures", async () => {
    const service = new SkillService();

    await expect(service.loadSkills(path.join(tempRoot, "missing-root")))
      .rejects.toBeInstanceOf(SkillError);
  });
});
