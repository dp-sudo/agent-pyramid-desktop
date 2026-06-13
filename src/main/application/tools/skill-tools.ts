import { normalizeSkillId } from "../../../shared/skills/index.js";
import type { SkillService } from "../../skills/skill-service.js";
import type { AgentTool } from "../../domain/agent/types.js";

export type SkillToolDeps = {
  skillService: SkillService;
};

export function createSkillTools(deps: SkillToolDeps): AgentTool[] {
  return [
    {
      definition: {
        name: "list_skills",
        description: [
          "List project skills available in the active workspace with descriptions, triggers, run modes, roots, and load warnings.",
          "Use this before run_skill when you need to discover which playbooks are available.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      metadata: {
        isReadOnly: true,
        isDestructive: false,
        category: "skill",
      },
      async execute(_input, context) {
        if (!context.workspace) {
          throw new Error("list_skills requires a workspace.");
        }
        const preferences = context.runtimePreferences?.skills;
        if (!preferences) {
          throw new Error("list_skills requires runtime skills preferences.");
        }
        const loaded = await deps.skillService.loadWorkspaceSkills(context.workspace, preferences);
        return {
          toolCallId: "",
          name: "list_skills",
          content: formatSkillCatalog(loaded),
          displayResult: {
            skills: loaded.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              runAs: skill.runAs,
              scope: skill.scope,
              rootDir: skill.rootDir,
              skillPath: skill.skillPath,
              triggers: skill.trigger,
              allowedTools: skill.allowedTools,
            })),
            roots: loaded.roots,
            validationErrors: loaded.validationErrors,
          },
        };
      },
    },
    {
      definition: {
        name: "run_skill",
        description: [
          "Load a project skill by id and return its SKILL.md instructions.",
          "Use this when the user explicitly invokes a skill or when a matched skill needs its full playbook.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            skillId: {
              type: "string",
              description: "The skill id or name, for example review-code or teach-me.",
            },
            arguments: {
              type: "string",
              description: "Optional free-form arguments for the skill instructions.",
            },
          },
          required: ["skillId"],
        },
      },
      metadata: {
        isReadOnly: true,
        isDestructive: false,
        category: "skill",
      },
      async execute(input, context) {
        const skillId = parseSkillId(input.skillId);
        const skillArguments = parseOptionalSkillArguments(input.arguments);
        if (!context.workspace) {
          throw new Error("run_skill requires a workspace.");
        }
        const preferences = context.runtimePreferences?.skills;
        if (!preferences) {
          throw new Error("run_skill requires runtime skills preferences.");
        }
        const loaded = await deps.skillService.loadWorkspaceSkills(context.workspace, preferences);
        const normalizedId = normalizeSkillId(skillId);
        const skill = loaded.skills.find((candidate) =>
          candidate.id === normalizedId ||
          normalizeSkillId(candidate.name) === normalizedId
        );
        if (!skill) {
          throw new Error(`Skill "${skillId}" was not found.`);
        }
        if (skill.runAs === "subagent") {
          throw new Error(
            `Skill "${skill.id}" must be executed by AgentRuntime's isolated subagent runner.`,
          );
        }
        return {
          toolCallId: "",
          name: "run_skill",
          content: [
            `Skill: ${skill.name} (${skill.id})`,
            skill.description ? `Description: ${skill.description}` : "",
            `Run mode: ${skill.runAs}`,
            skill.allowedTools.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
            skill.body,
            skillArguments ? `Arguments: ${skillArguments}` : "",
          ].filter(Boolean).join("\n\n"),
          displayResult: {
            skillId: skill.id,
            name: skill.name,
            description: skill.description,
            rootDir: skill.rootDir,
            skillPath: skill.skillPath,
            validationErrors: loaded.validationErrors,
          },
        };
      },
    },
  ];
}

type SkillCatalogLoadResult = Awaited<ReturnType<SkillService["loadWorkspaceSkills"]>>;

function formatSkillCatalog(loaded: SkillCatalogLoadResult): string {
  const lines = ["Skills index"];
  if (loaded.skills.length === 0) {
    lines.push("No skills discovered in the active workspace.");
  } else {
    for (const skill of loaded.skills) {
      const tag = skill.runAs === "subagent" ? " [subagent]" : "";
      lines.push(`- ${skill.id}${tag}: ${skill.description || "(no description)"}`);
      lines.push(`  name: ${skill.name}`);
      lines.push(`  scope: ${skill.scope}`);
      lines.push(`  root: ${skill.rootDir}`);
      lines.push(`  triggers: ${formatSkillTriggers(skill.trigger)}`);
      if (skill.allowedTools.length > 0) {
        lines.push(`  allowedTools: ${skill.allowedTools.join(", ")}`);
      }
    }
  }
  if (loaded.validationErrors.length > 0) {
    lines.push("", "Skill load warnings:");
    for (const warning of loaded.validationErrors) {
      lines.push(`- ${warning.root}: ${warning.message}`);
    }
  }
  return lines.join("\n");
}

function formatSkillTriggers(trigger: SkillCatalogLoadResult["skills"][number]["trigger"]): string {
  const parts = [
    trigger.manual ? "manual" : "",
    trigger.commands.length ? `commands=${trigger.commands.join(",")}` : "",
    trigger.keywords.length ? `keywords=${trigger.keywords.join(",")}` : "",
    trigger.promptPatterns.length ? `patterns=${trigger.promptPatterns.join(",")}` : "",
    trigger.fileTypes.length ? `fileTypes=${trigger.fileTypes.join(",")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "none";
}

function parseSkillId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("run_skill requires a non-empty skillId.");
  }
  if (value.includes("\0")) {
    throw new Error("run_skill skillId cannot contain NUL bytes.");
  }
  return value.trim();
}

function parseOptionalSkillArguments(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error("run_skill arguments must be a string when provided.");
  }
  if (value.includes("\0")) {
    throw new Error("run_skill arguments cannot contain NUL bytes.");
  }
  return value.trim();
}
