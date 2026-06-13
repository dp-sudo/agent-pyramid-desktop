import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseSkillListRequest,
  registerSkillHandlers,
} from "../../../src/main/ipc/skills-handlers";
import { SkillService } from "../../../src/main/skills/skill-service";
import { DEFAULT_RUNTIME_PREFERENCES } from "../../../src/shared/agent-contracts";
import { SKILL_LIST_CHANNEL } from "../../../src/shared/ipc";
import type { RuntimePreferencesStore } from "../../../src/main/persistence/runtime-preferences-store";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

type IpcHandler = (_event: unknown, request?: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

describe("skills handlers", () => {
  let workspace: string;

  beforeEach(async () => {
    electronMock.handlers.clear();
    workspace = await makeTempDir("agent-skills-ipc-");
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it("parses skill list requests at the IPC boundary", () => {
    expect(parseSkillListRequest({ workspace: " /workspace " }))
      .toEqual({ workspace: "/workspace" });
    expect(() => parseSkillListRequest(null))
      .toThrow("Skill list request must be an object.");
    expect(() => parseSkillListRequest({ workspace: "" }))
      .toThrow("Skill list workspace must be a non-empty string.");
    expect(() => parseSkillListRequest({ workspace: "bad\0path" }))
      .toThrow("Skill list workspace cannot contain NUL bytes.");
  });

  it("returns a workspace skill catalog without exposing full skill body", async () => {
    await writeSkill(".agent/skills/example-skill", {
      frontmatter: [
        "id: example-skill",
        "name: Example Skill",
        "description: Demonstrates IPC catalog loading.",
        "commands: /example",
      ],
      body: "PRIVATE SKILL BODY",
      references: { "notes.md": "PRIVATE REFERENCE" },
    });
    const store = createRuntimePreferencesStore();
    registerSkillHandlers(new SkillService(), store);
    const handler = electronMock.handlers.get(SKILL_LIST_CHANNEL);
    if (!handler) throw new Error("Expected skills list handler.");

    const result = await handler({}, { workspace });

    expect(result).toMatchObject({
      ok: true,
      value: {
        workspace,
        enabled: true,
        skills: expect.arrayContaining([
          expect.objectContaining({
            id: "example-skill",
            name: "Example Skill",
            description: "Demonstrates IPC catalog loading.",
            scope: "project",
            runAs: "inline",
            referenceCount: 1,
            referenceNames: ["notes"],
          }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE SKILL BODY");
    expect(JSON.stringify(result)).not.toContain("PRIVATE REFERENCE");
  });

  it("surfaces validation warnings through the catalog", async () => {
    const store = createRuntimePreferencesStore({
      ...DEFAULT_RUNTIME_PREFERENCES,
      skills: {
        ...DEFAULT_RUNTIME_PREFERENCES.skills,
        extraRoots: ["missing-root"],
      },
    });
    registerSkillHandlers(new SkillService(), store);
    const handler = electronMock.handlers.get(SKILL_LIST_CHANNEL);
    if (!handler) throw new Error("Expected skills list handler.");

    const result = await handler({}, { workspace });

    expect(result).toMatchObject({
      ok: true,
      value: {
        roots: expect.arrayContaining([
          {
            path: path.join(workspace, "missing-root"),
            scope: "custom",
            missingIsError: true,
          },
        ]),
        validationErrors: [
          expect.objectContaining({
            root: path.join(workspace, "missing-root"),
            message: expect.stringContaining("Skills root does not exist"),
          }),
        ],
      },
    });
  });

  it("returns an empty catalog when skill discovery is disabled", async () => {
    const store = createRuntimePreferencesStore({
      ...DEFAULT_RUNTIME_PREFERENCES,
      skills: {
        ...DEFAULT_RUNTIME_PREFERENCES.skills,
        enabled: false,
      },
    });
    registerSkillHandlers(new SkillService(), store);
    const handler = electronMock.handlers.get(SKILL_LIST_CHANNEL);
    if (!handler) throw new Error("Expected skills list handler.");

    await expect(handler({}, { workspace })).resolves.toEqual({
      ok: true,
      value: {
        workspace,
        enabled: false,
        skills: [],
        roots: [],
        validationErrors: [],
      },
    });
  });

  it("returns error envelopes for malformed requests", async () => {
    const store = createRuntimePreferencesStore();
    registerSkillHandlers(new SkillService(), store);
    const handler = electronMock.handlers.get(SKILL_LIST_CHANNEL);
    if (!handler) throw new Error("Expected skills list handler.");

    await expect(handler({}, { workspace: "bad\0path" })).resolves.toEqual({
      ok: false,
      code: "SKILL_LIST_FAILED",
      message: "Skill list workspace cannot contain NUL bytes.",
    });
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
      for (const [name, content] of Object.entries(input.references)) {
        await fs.writeFile(path.join(referencesDir, name), content, "utf8");
      }
    }
  }
});

function createRuntimePreferencesStore(
  preferences = DEFAULT_RUNTIME_PREFERENCES,
): RuntimePreferencesStore {
  return {
    get: vi.fn(async () => preferences),
  } as unknown as RuntimePreferencesStore;
}
