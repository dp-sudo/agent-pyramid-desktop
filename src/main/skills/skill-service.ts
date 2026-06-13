import {
  SkillRegistry,
  loadSkillFromDirectory,
  loadSkills,
  type Skill,
  type SkillMatchInput,
} from "../../shared/skills/index.js";

export class SkillService {
  private registry = new SkillRegistry();

  /**
   * Loads all SKILL.md packages from a root without wiring them into AgentRuntime.
   * Errors stay typed so callers can expose missing roots and invalid manifests.
   */
  async loadSkills(rootDir: string): Promise<Skill[]> {
    const skills = await loadSkills(rootDir);
    this.registry = new SkillRegistry(skills);
    return this.registry.listSkills();
  }

  /**
   * Loads one package directory directly; this keeps SKILL.md absence observable
   * instead of making discovery silently skip malformed packages.
   */
  async loadSkillDirectory(skillDir: string): Promise<Skill> {
    const loaded = await loadSkillFromDirectory(skillDir);
    const nextSkills = this.registry
      .listSkills()
      .filter((skill) => skill.id !== loaded.id);
    this.registry = new SkillRegistry([...nextSkills, loaded]);
    return loaded;
  }

  listSkills(): Skill[] {
    return this.registry.listSkills();
  }

  getSkill(id: string): Skill | undefined {
    return this.registry.getSkill(id);
  }

  matchSkill(input: SkillMatchInput): Skill[] {
    return this.registry.matchSkill(input);
  }
}
