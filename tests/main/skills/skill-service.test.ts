import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillTools } from "../../../src/main/application/tools/skill-tools";
import { SkillService, skillRootsForWorkspace } from "../../../src/main/skills/skill-service";
import { DEFAULT_RUNTIME_PREFERENCES } from "../../../src/shared/agent-contracts";
import { SkillError } from "../../../src/shared/skills";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("SkillService", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("agent-skills-");
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it("discovers skills from project convention roots", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates minimal skill loading for tests.",
        "keywords: example skill",
      ],
      body: "Use this skill when the user asks for the example skill fixture.",
    });
    const service = new SkillService();

    const loaded = await service.loadWorkspaceSkills(workspace, DEFAULT_RUNTIME_PREFERENCES.skills);

    expect(loaded.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(["example-skill", "explore", "review", "teach-me", "interview"]),
    );
    expect(loaded.skills.find((skill) => skill.id === "example-skill")).toMatchObject({
      scope: "project",
    });
    expect(loaded.validationErrors).toEqual([]);
  });

  it("loads built-in skills and lets project skills override them", async () => {
    await writeSkill(".agent/skills/review", {
      frontmatter: [
        "id: review",
        "name: Project Review",
        "description: Project-specific review.",
        "runAs: inline",
      ],
      body: "Use the project review process.",
    });
    const service = new SkillService();

    const loaded = await service.loadWorkspaceSkills(workspace, DEFAULT_RUNTIME_PREFERENCES.skills);

    const review = loaded.skills.find((skill) => skill.id === "review");
    const explore = loaded.skills.find((skill) => skill.id === "explore");
    expect(review).toMatchObject({
      id: "review",
      name: "Project Review",
      scope: "project",
      runAs: "inline",
    });
    expect(review?.body).toContain("Use the project review process.");
    expect(explore).toMatchObject({
      id: "explore",
      scope: "builtin",
      runAs: "subagent",
    });
  });

  it("parses SKILL.md metadata, references, and trigger fields", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates minimal skill loading for tests.",
        "version: 1.2.3",
        "commands: /example",
        "promptPatterns: example\\s+request",
        "fileTypes: ts, .tsx",
        "allowed-tools: read_file, search_files",
        "priority: 7",
      ],
      body: "Use this skill.",
      references: {
        "notes.md": "Reference guidance.",
      },
    });
    const service = new SkillService();

    const [skill] = (await service.loadWorkspaceSkills(workspace, DEFAULT_RUNTIME_PREFERENCES.skills)).skills;

    expect(skill).toMatchObject({
      id: "example-skill",
      name: "Example Skill",
      description: "Demonstrates minimal skill loading for tests.",
      version: "1.2.3",
      trigger: {
        commands: ["/example", "/example-skill"],
        promptPatterns: ["example\\s+request"],
        fileTypes: [".ts", ".tsx"],
      },
      allowedTools: ["read_file", "search_files"],
      priority: 7,
      runAs: "inline",
    });
    expect(skill?.body).toContain("## Reference: notes");
    expect(skill?.body).toContain("Reference guidance.");
  });

  it("loads skills by id with non-empty fields", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates minimal skill loading for tests.",
        "trigger: keyword:example skill",
      ],
      body: "Use this skill.",
    });
    const service = new SkillService();
    await service.loadWorkspaceSkills(workspace, DEFAULT_RUNTIME_PREFERENCES.skills);

    const skill = service.getSkill("example-skill");

    expect(skill?.name).toBeTruthy();
    expect(skill?.description).toBeTruthy();
    expect(skill?.trigger.keywords).toContain("example skill");
    expect(skill?.body).toContain("Use this skill");
  });

  it("keeps missing explicit roots observable", async () => {
    const service = new SkillService();

    const loaded = await service.loadWorkspaceSkills(workspace, {
      ...DEFAULT_RUNTIME_PREFERENCES.skills,
      extraRoots: ["missing-root"],
    });

    expect(loaded.validationErrors).toEqual([
      expect.objectContaining({
        root: path.join(workspace, "missing-root"),
        message: expect.stringContaining("Skills root does not exist"),
      }),
    ]);
  });

  it("keeps missing SKILL.md errors observable for direct package loads", async () => {
    const service = new SkillService();
    const skillDir = path.join(workspace, "missing-skill-file");
    await fs.mkdir(skillDir);

    await expect(service.loadSkillDirectory(skillDir))
      .rejects.toMatchObject({
        code: "skill_manifest_not_found",
      });
  });

  it("keeps invalid field errors observable", async () => {
    await writeSkill(".agent/skills/invalid-skill", {
      frontmatter: [
        "name: Invalid Skill",
        "priority: not-a-number",
      ],
      body: "Invalid.",
    });
    const service = new SkillService();

    const loaded = await service.loadWorkspaceSkills(workspace, DEFAULT_RUNTIME_PREFERENCES.skills);

    expect(loaded.skills.some((skill) => skill.id === "invalid-skill")).toBe(false);
    expect(loaded.validationErrors[0]?.message).toContain("priority");
  });

  it("matches and resolves skills by explicit mention, command, pattern, keyword, and file type", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates matching.",
        "commands: /example",
        "promptPatterns: guided\\s+example",
        "keywords: example skill",
        "fileTypes: ts",
      ],
      body: "Use this skill.",
    });
    const service = new SkillService();
    await service.loadWorkspaceSkills(workspace, DEFAULT_RUNTIME_PREFERENCES.skills);

    expect(service.matchSkill({ text: "please use @example-skill" }).map((skill) => skill.id))
      .toEqual(["example-skill"]);
    expect(service.matchSkill({ text: "/example now" }).map((skill) => skill.id))
      .toEqual(["example-skill"]);
    expect(service.matchSkill({ text: "make a guided example" }).map((skill) => skill.id))
      .toEqual(["example-skill"]);
    expect(service.matchSkill({ text: "please use the example skill" }).map((skill) => skill.id))
      .toEqual(["example-skill"]);
    expect(service.matchSkill({ filePaths: ["src/app.ts"] }).map((skill) => skill.id))
      .toEqual(["example-skill"]);
  });

  it("resolves active turn instructions within the configured budget", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates matching.",
        "keywords: example skill",
      ],
      body: "Use this skill.",
    });
    const service = new SkillService();

    const resolution = await service.resolveTurn({
      workspace,
      preferences: DEFAULT_RUNTIME_PREFERENCES.skills,
      text: "please use the example skill",
    });

    expect(resolution.activeSkillIds).toEqual(["example-skill"]);
    expect(resolution.instructions[0]).toContain("Active Skill: Example Skill");
    expect(resolution.validationErrors).toEqual([]);
  });

  it("does not inline subagent skill bodies into parent turn context", async () => {
    await writeSkill(".agent/skills/review-skill", {
      frontmatter: [
        "id: review-skill",
        "name: Review Skill",
        "description: Review in isolation.",
        "keywords: isolated review",
        "runAs: subagent",
        "allowed-tools: read_file, search_files",
      ],
      body: "PRIVATE SUBAGENT BODY",
    });
    const service = new SkillService();

    const resolution = await service.resolveTurn({
      workspace,
      preferences: DEFAULT_RUNTIME_PREFERENCES.skills,
      text: "please do an isolated review",
    });

    expect(resolution.activeSkillIds[0]).toBe("review-skill");
    expect(resolution.activeSkillIds).toContain("review-skill");
    expect(resolution.instructions[0]).toContain("Run mode: subagent");
    expect(resolution.instructions[0]).toContain("Call run_skill");
    expect(resolution.instructions[0]).not.toContain("PRIVATE SUBAGENT BODY");
  });

  it("lists workspace skills and load warnings through the read-only list_skills tool", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates matching.",
        "keywords: example skill",
      ],
      body: "Use this skill.",
    });
    const service = new SkillService();
    const tool = createSkillTools({ skillService: service })
      .find((candidate) => candidate.definition.name === "list_skills");
    if (!tool) throw new Error("Expected list_skills tool.");

    const result = await tool.execute(
      {},
      {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        runtimePreferences: {
          ...DEFAULT_RUNTIME_PREFERENCES,
          skills: {
            ...DEFAULT_RUNTIME_PREFERENCES.skills,
            extraRoots: ["missing-root"],
          },
        },
      },
    );

    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("Expected structured list_skills result.");
    expect(result.content).toContain("Skills index");
    expect(result.content).toContain("- example-skill: Demonstrates matching.");
    expect(result.content).toContain("Skill load warnings:");
    expect(result.displayResult).toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: "example-skill",
          name: "Example Skill",
          runAs: "inline",
        }),
      ]),
      validationErrors: [
        expect.objectContaining({
          message: expect.stringContaining("Skills root does not exist"),
        }),
      ],
    });
  });

  it("runs the read-only run_skill tool against workspace skills", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates matching.",
      ],
      body: "Use this skill.",
    });
    const service = new SkillService();
    const tool = createSkillTools({ skillService: service })
      .find((candidate) => candidate.definition.name === "run_skill");
    if (!tool) throw new Error("Expected run_skill tool.");

    const result = await tool.execute(
      { skillId: "example-skill" },
      {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
      },
    );

    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("Expected structured run_skill result.");
    expect(result.content).toContain("Skill: Example Skill");
    expect(result.content).toContain("Use this skill.");
    expect(result.displayResult).toMatchObject({
      skillId: "example-skill",
      name: "Example Skill",
    });
  });

  it("rejects subagent skills when run_skill is executed outside AgentRuntime", async () => {
    await writeSkill(".agent/skills/review-skill", {
      frontmatter: [
        "id: review-skill",
        "name: Review Skill",
        "description: Review in isolation.",
        "runAs: subagent",
      ],
      body: "Run in a child context.",
    });
    const service = new SkillService();
    const tool = createSkillTools({ skillService: service })
      .find((candidate) => candidate.definition.name === "run_skill");
    if (!tool) throw new Error("Expected run_skill tool.");

    await expect(tool.execute(
      { skillId: "review-skill" },
      {
        threadId: "thread-1",
        turnId: "turn-1",
        workspace,
        runtimePreferences: DEFAULT_RUNTIME_PREFERENCES,
      },
    )).rejects.toThrow("isolated subagent runner");
  });

  it("uses typed SkillError instances for direct service failures", async () => {
    const service = new SkillService();

    await expect(service.loadSkillDirectory(path.join(workspace, "missing-root")))
      .rejects.toBeInstanceOf(SkillError);
  });

  it("builds deduplicated workspace root candidates", () => {
    const roots = skillRootsForWorkspace(workspace, {
      ...DEFAULT_RUNTIME_PREFERENCES.skills,
      extraRoots: [".agent/skills", " ", ".agent/skills"],
    });

    expect(roots.filter((root) => root.path.endsWith(path.join(".agent", "skills"))))
      .toHaveLength(1);
    expect(roots.some((root) => root.path === path.resolve(workspace))).toBe(false);
    expect(roots[0]).toMatchObject({ scope: "project", missingIsError: false });
  });

  async function writeSkill(
    relativeDir: string,
    input: {
      frontmatter: string[];
      body: string;
      references?: Record<string, string>;
    },
  ): Promise<void> {
    const root = path.join(workspace, relativeDir);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "SKILL.md"),
      ["---", ...input.frontmatter, "---", "", input.body].join("\n"),
      "utf8",
    );
    if (input.references) {
      const referencesDir = path.join(root, "references");
      await fs.mkdir(referencesDir, { recursive: true });
      await Promise.all(Object.entries(input.references).map(([name, content]) =>
        fs.writeFile(path.join(referencesDir, name), content, "utf8")
      ));
    }
  }
});
