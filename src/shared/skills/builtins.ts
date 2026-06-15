import type { Skill } from "./types.js";

const BUILTIN_ROOT = "(builtin)";

const READ_ONLY_CODE_TOOLS = [
  "list_files",
  "read_file",
  "search_files",
  "rg_search",
  "list_symbols",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "package_scripts",
  "detect_shell_environment",
  "diagnose_file",
];

export function createBuiltinSkills(): Skill[] {
  return [
    {
      id: "explore",
      name: "Explore",
      description:
        "Explore the workspace in an isolated read-only subagent and return one focused answer.",
      version: "1.0.0",
      trigger: {
        manual: false,
        keywords: ["explore", "investigate", "map the code", "how does"],
        commands: ["/explore"],
        promptPatterns: [],
        fileTypes: [],
      },
      allowedTools: READ_ONLY_CODE_TOOLS,
      priority: 0,
      runAs: "subagent",
      rootDir: BUILTIN_ROOT,
      skillPath: `${BUILTIN_ROOT}/explore`,
      scope: "builtin",
      references: [],
      body: [
        "You are an isolated exploration subagent.",
        "Investigate the workspace read-only, then return a compact answer to the parent.",
        "Start broad, then read only the files needed to support the answer.",
        "When making a negative claim, mention the searches or files checked.",
        "Do not edit files. Do not ask for approvals. Keep the final answer specific and cite paths when useful.",
      ].join("\n\n"),
    },
    {
      id: "review",
      name: "Review",
      description:
        "Review current changes or named files in an isolated read-only subagent and report correctness risks.",
      version: "1.0.0",
      trigger: {
        manual: false,
        keywords: ["review", "code review", "check this change", "find bugs"],
        commands: ["/review"],
        promptPatterns: [],
        fileTypes: [],
      },
      allowedTools: READ_ONLY_CODE_TOOLS,
      priority: 0,
      runAs: "subagent",
      rootDir: BUILTIN_ROOT,
      skillPath: `${BUILTIN_ROOT}/review`,
      scope: "builtin",
      references: [],
      body: [
        "You are an isolated code-review subagent.",
        "Inspect the requested diff, files, or branch state read-only.",
        "Prioritize correctness bugs, security risks, behavior regressions, and missing tests.",
        "Read surrounding code when a diff is not enough to prove impact.",
        "Return findings first, ordered by severity, with file paths and concrete fix direction.",
        "If no issues are found, say that plainly and mention the remaining review scope risk.",
      ].join("\n\n"),
    },
    {
      id: "teach-me",
      name: "Teach Me",
      description:
        "Inline tutoring playbook for explaining a topic through diagnosis, short lessons, and checks.",
      version: "1.0.0",
      trigger: {
        manual: false,
        keywords: ["teach me", "help me understand", "explain to me", "learn"],
        commands: ["/teach-me"],
        promptPatterns: [],
        fileTypes: [],
      },
      allowedTools: [],
      priority: 0,
      runAs: "inline",
      rootDir: BUILTIN_ROOT,
      skillPath: `${BUILTIN_ROOT}/teach-me`,
      scope: "builtin",
      references: [],
      body: [
        "Teach the user a topic through a guided tutoring loop.",
        "First identify the topic and estimate their current level from the prompt.",
        "Use short explanations followed by one or two concrete checks for understanding.",
        "Advance only when the user's answer shows they can apply the idea.",
        "Keep the language aligned with the user's language. Avoid long lectures.",
      ].join("\n\n"),
    },
    {
      id: "interview",
      name: "Interview",
      description:
        "Inline requirements interview playbook for clarifying goals, tradeoffs, constraints, and UX.",
      version: "1.0.0",
      trigger: {
        manual: false,
        keywords: ["interview me", "clarify requirements", "ask me questions"],
        commands: ["/interview"],
        promptPatterns: [],
        fileTypes: [],
      },
      allowedTools: [],
      priority: 0,
      runAs: "inline",
      rootDir: BUILTIN_ROOT,
      skillPath: `${BUILTIN_ROOT}/interview`,
      scope: "builtin",
      references: [],
      body: [
        "Interview the user to clarify requirements before implementation.",
        "Ask non-obvious questions about goals, edge cases, data, UI, workflow, and constraints.",
        "Prefer grouped options when possible and include a recommended option first.",
        "Stop interviewing when the implementation target is concrete enough to verify.",
        "Summarize decisions and remaining uncertainties before moving to implementation or planning.",
      ].join("\n\n"),
    },
  ];
}
