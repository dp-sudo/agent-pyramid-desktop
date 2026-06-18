import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore } from "../../../src/main/persistence/checkpoint-store";
import type { ThreadRecord } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

describe("CheckpointStore", () => {
  let userDataDir: string;
  let workspace: string;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-checkpoints-");
    workspace = await makeTempDir("agent-checkpoint-workspace-");
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
    await removeTempDir(workspace);
  });

  it("persists turn checkpoints and restores earliest snapshots from the selected turn", async () => {
    const store = new CheckpointStore(userDataDir);
    await store.init();
    await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
    await fs.writeFile(path.join(workspace, "a.txt"), "v0\n", "utf8");

    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      prompt: "first",
      createdAt: "2026-06-12T01:00:00.000Z",
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v0\n",
      afterContent: "v1\n",
      beforeSha256: sha256("v0\n"),
      afterSha256: sha256("v1\n"),
    });
    await fs.writeFile(path.join(workspace, "a.txt"), "v1\n", "utf8");

    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      prompt: "second",
      createdAt: "2026-06-12T02:00:00.000Z",
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v1\n",
      afterContent: "v2\n",
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      toolName: "write_file",
      relativePath: "sub/b.txt",
      operation: "create",
      beforeContent: null,
      afterContent: "new\n",
      beforeSha256: null,
      afterSha256: sha256("new\n"),
    });
    await fs.writeFile(path.join(workspace, "a.txt"), "v2\n", "utf8");
    await fs.writeFile(path.join(workspace, "sub", "b.txt"), "new\n", "utf8");

    const resumed = new CheckpointStore(userDataDir);
    const metas = await resumed.list(THREAD_ID);
    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({
      prompt: "first",
      canRewindCode: true,
      files: [{ path: "a.txt", operation: "update" }],
    });
    expect(metas[1]).toMatchObject({
      prompt: "second",
      canRewindCode: true,
      files: [
        { path: "a.txt", operation: "update" },
        { path: "sub/b.txt", operation: "create" },
      ],
    });

    const thread = makeThread();
    const restored = await resumed.restoreCode(thread, "turn-1");

    expect(restored).toEqual({
      restoredPaths: ["a.txt"],
      deletedPaths: ["sub/b.txt"],
    });
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("v1\n");
    await expect(fs.stat(path.join(workspace, "sub", "b.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps only the first snapshot for a path in one turn", async () => {
    const store = new CheckpointStore(userDataDir);
    await store.init();
    await fs.writeFile(path.join(workspace, "a.txt"), "original\n", "utf8");
    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      prompt: "touch twice",
      createdAt: "2026-06-12T01:00:00.000Z",
    });

    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "original\n",
      afterContent: "first\n",
      beforeSha256: sha256("original\n"),
      afterSha256: sha256("first\n"),
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "first\n",
      afterContent: "second\n",
      beforeSha256: sha256("first\n"),
      afterSha256: sha256("second\n"),
    });
    await fs.writeFile(path.join(workspace, "a.txt"), "second\n", "utf8");

    await store.restoreCode(makeThread(), "turn-0");

    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("original\n");
    expect((await store.list(THREAD_ID))[0].files).toHaveLength(1);
  });

  it("discards selected file snapshots from a turn without deleting the checkpoint", async () => {
    const store = new CheckpointStore(userDataDir);
    await store.init();
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "a0\n", "utf8");
    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      prompt: "partial failure",
      createdAt: "2026-06-12T01:00:00.000Z",
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      toolName: "apply_patch",
      relativePath: "src/a.ts",
      operation: "update",
      beforeContent: "a0\n",
      afterContent: "a1\n",
      beforeSha256: sha256("a0\n"),
      afterSha256: sha256("a1\n"),
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      toolName: "apply_patch",
      relativePath: "src/b.ts",
      operation: "create",
      beforeContent: null,
      afterContent: "b1\n",
      beforeSha256: null,
      afterSha256: sha256("b1\n"),
    });

    await expect(store.discardFileSnapshots({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace: path.join(workspace, "..", path.basename(workspace)),
      relativePaths: ["./src/a.ts", "src/missing.ts"],
    })).resolves.toBe(1);

    const checkpoints = await store.list(THREAD_ID);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      turnId: "turn-0",
      prompt: "partial failure",
      files: [{ path: "src/b.ts", operation: "create" }],
    });
  });

  it("finds the latest same-workspace file snapshot for restart-safe rollback", async () => {
    const store = new CheckpointStore(userDataDir);
    await store.init();
    await fs.writeFile(path.join(workspace, "a.txt"), "v2\n", "utf8");

    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      prompt: "first",
      createdAt: "2026-06-12T01:00:00.000Z",
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v0\n",
      afterContent: "v1\n",
      beforeSha256: sha256("v0\n"),
      afterSha256: sha256("v1\n"),
    });
    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      prompt: "second",
      createdAt: "2026-06-12T02:00:00.000Z",
    });
    await store.recordFileSnapshot({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v1\n",
      afterContent: "v2\n",
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    });

    const resumed = new CheckpointStore(userDataDir);
    const snapshot = await resumed.latestFileSnapshot({
      threadId: THREAD_ID,
      workspace,
      relativePath: "./a.txt",
    });

    expect(snapshot).toMatchObject({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v1\n",
      afterContent: "v2\n",
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    });
    expect(await resumed.latestFileSnapshot({
      threadId: THREAD_ID,
      workspace: path.join(workspace, "..", "agent-checkpoint-other-workspace"),
      relativePath: "a.txt",
    })).toBeNull();
  });

  it("refuses to restore hostile snapshot paths outside the workspace", async () => {
    const outside = path.join(await makeTempDir("agent-checkpoint-outside-"), "evil.txt");
    try {
      await fs.writeFile(outside, "keep\n", "utf8");
      const store = new CheckpointStore(userDataDir);
      await store.init();
      const checkpointPath = path.join(userDataDir, "checkpoints", `${THREAD_ID}.jsonl`);
      await fs.writeFile(
        checkpointPath,
        `${JSON.stringify({
          threadId: THREAD_ID,
          turnId: "turn-0",
          workspace,
          prompt: "hostile",
          createdAt: "2026-06-12T01:00:00.000Z",
          files: [{
            path: "../evil.txt",
            operation: "update",
            toolName: "edit_file",
            beforeContent: "hacked\n",
            afterContent: "changed\n",
            beforeSha256: sha256("hacked\n"),
            afterSha256: sha256("changed\n"),
            createdAt: "2026-06-12T01:00:01.000Z",
          }],
        })}\n`,
        "utf8",
      );

      await expect(store.restoreCode(makeThread(), "turn-0")).rejects.toThrow(
        "Path escapes workspace",
      );
      expect(await fs.readFile(outside, "utf8")).toBe("keep\n");
    } finally {
      await removeTempDir(path.dirname(outside));
    }
  });

  it("rechecks restore targets after creating parent directories", async () => {
    const outside = await makeTempDir("agent-checkpoint-race-outside-");
    try {
      const store = new CheckpointStore(userDataDir);
      await store.init();
      const checkpointPath = path.join(userDataDir, "checkpoints", `${THREAD_ID}.jsonl`);
      await fs.writeFile(
        checkpointPath,
        `${JSON.stringify({
          threadId: THREAD_ID,
          turnId: "turn-0",
          workspace,
          prompt: "restore race",
          createdAt: "2026-06-12T01:00:00.000Z",
          files: [{
            path: "drafts/note.md",
            operation: "update",
            toolName: "edit_file",
            beforeContent: "safe\n",
            afterContent: "changed\n",
            beforeSha256: sha256("safe\n"),
            afterSha256: sha256("changed\n"),
            createdAt: "2026-06-12T01:00:01.000Z",
          }],
        })}\n`,
        "utf8",
      );
      const parentPath = path.join(workspace, "drafts");
      const outsideTarget = path.join(outside, "note.md");
      const originalMkdir = fs.mkdir.bind(fs);
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation((async (
        ...args: Parameters<typeof fs.mkdir>
      ) => {
        const result = await originalMkdir(...args);
        const target = args[0];
        if (typeof target === "string" && path.resolve(target) === parentPath) {
          await fs.rm(parentPath, { recursive: true, force: true });
          await fs.symlink(outside, parentPath);
        }
        return result;
      }) as typeof fs.mkdir);

      try {
        await expect(store.restoreCode(makeThread(), "turn-0")).rejects.toThrow(
          "Path escapes workspace: drafts/note.md",
        );
      } finally {
        mkdirSpy.mockRestore();
      }
      await expect(fs.access(outsideTarget)).rejects.toThrow();
    } finally {
      await removeTempDir(outside);
    }
  });

  it("rejects restore writes when the target becomes a symlink before commit", async () => {
    const outside = await makeTempDir("agent-checkpoint-target-race-outside-");
    try {
      const store = new CheckpointStore(userDataDir);
      await store.init();
      const targetPath = path.join(workspace, "a.txt");
      const outsideTarget = path.join(outside, "a.txt");
      await fs.writeFile(targetPath, "changed\n", "utf8");
      await fs.writeFile(outsideTarget, "outside\n", "utf8");
      const checkpointPath = path.join(userDataDir, "checkpoints", `${THREAD_ID}.jsonl`);
      await fs.writeFile(
        checkpointPath,
        `${JSON.stringify({
          threadId: THREAD_ID,
          turnId: "turn-0",
          workspace,
          prompt: "restore target race",
          createdAt: "2026-06-12T01:00:00.000Z",
          files: [{
            path: "a.txt",
            operation: "update",
            toolName: "edit_file",
            beforeContent: "safe\n",
            afterContent: "changed\n",
            beforeSha256: sha256("safe\n"),
            afterSha256: sha256("changed\n"),
            createdAt: "2026-06-12T01:00:01.000Z",
          }],
        })}\n`,
        "utf8",
      );

      const realOpen = fs.open.bind(fs);
      let replaced = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        const target = args[0];
        if (!replaced && typeof target === "string" && path.resolve(target) === targetPath) {
          replaced = true;
          await fs.rm(targetPath, { force: true });
          await fs.symlink(outsideTarget, targetPath);
        }
        return realOpen(...args);
      }) as typeof fs.open);

      try {
        await expect(store.restoreCode(makeThread(), "turn-0")).rejects.toThrow(
          "Checkpoint restore target is a symbolic link: a.txt",
        );
      } finally {
        openSpy.mockRestore();
      }
      expect(await fs.readFile(outsideTarget, "utf8")).toBe("outside\n");
    } finally {
      await removeTempDir(outside);
    }
  });

  it("prunes checkpoints from the selected turn after session rewind", async () => {
    const store = new CheckpointStore(userDataDir);
    await store.init();
    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-0",
      workspace,
      prompt: "keep",
      createdAt: "2026-06-12T01:00:00.000Z",
    });
    await store.beginTurn({
      threadId: THREAD_ID,
      turnId: "turn-1",
      workspace,
      prompt: "remove",
      createdAt: "2026-06-12T02:00:00.000Z",
    });

    await expect(store.pruneFromTurn(THREAD_ID, "turn-1")).resolves.toBe(1);
    expect((await store.list(THREAD_ID)).map((checkpoint) => checkpoint.turnId))
      .toEqual(["turn-0"]);
  });

  function makeThread(): ThreadRecord {
    return {
      id: THREAD_ID,
      title: "Checkpoint thread",
      workspace,
      mode: "code",
      status: "active",
      relation: "primary",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    };
  }
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
