import { assertEquals, assertExists } from "std/assert/mod.ts";
import { dirname, fromFileUrl } from "std/path/mod.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";

const testRoot = dirname(fromFileUrl(import.meta.url));
const fixtureRoot = `${testRoot}/fixtures`;

async function createTestDir(prefix: string): Promise<string> {
  await Deno.mkdir(fixtureRoot, { recursive: true });
  return await Deno.makeTempDir({ dir: fixtureRoot, prefix });
}

Deno.test("WorkspaceManager: worker state を保存・読み込みできる", async () => {
  const baseDir = await createTestDir("workspace_test_");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "123",
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      sessionId: "s1",
    };
    await manager.saveWorkerState(state);

    const loaded = await manager.loadWorkerState("123");
    assertExists(loaded);
    assertEquals(loaded?.workerName, "w1");
    assertEquals(loaded?.sessionId, "s1");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test(
  "WorkspaceManager: thread info は初回メッセージ関連フィールドを補完する",
  async () => {
    const baseDir = await createTestDir("workspace_test_");
    try {
      const manager = new WorkspaceManager(baseDir);
      await manager.initialize();

      await manager.saveThreadInfo({
        threadId: "thread-1",
        repositoryFullName: "a/b",
        repositoryLocalPath: "a/b",
        worktreePath: "/tmp/worktree",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: "active",
      });

      const loaded = await manager.loadThreadInfo("thread-1");
      assertExists(loaded);
      assertEquals(loaded?.firstUserMessageReceivedAt, null);
      assertEquals(loaded?.autoRenamedByFirstMessage, false);
      assertEquals(loaded?.welcomeEmbedMessageId, null);
    } finally {
      await Deno.remove(baseDir, { recursive: true });
    }
  },
);

Deno.test("WorkspaceManager: task cost entry を個別ファイルで保存・読み込みできる", async () => {
  const baseDir = await createTestDir("workspace_test_");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    await manager.saveTaskCostEntry("thread-1", {
      taskId: "task-1",
      taskStartedAt: "2026-05-25T00:00:00.000Z",
      taskFinishedAt: "2026-05-25T00:01:00.000Z",
      costStatus: "ready",
      tokenUsage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
      costUsd: 1.25,
      costJpy: 200,
      costFetchedAt: "2026-05-25T00:02:00.000Z",
      costError: null,
    });

    const loaded = await manager.loadTaskCostEntry("thread-1", "task-1");
    assertExists(loaded);
    assertEquals(loaded?.taskId, "task-1");
    assertEquals(loaded?.costStatus, "ready");
    assertEquals(loaded?.tokenUsage?.inputTokens, 120);

    const entries = await manager.loadTaskCostEntries("thread-1");
    assertEquals(entries.length, 1);
    assertEquals(entries[0].taskId, "task-1");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("WorkspaceManager: 添付ファイルをメッセージ単位で保存できる", async () => {
  const baseDir = await createTestDir("workspace_test_");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    const saved = await manager.saveMessageAttachments(
      "thread-1",
      "message-1",
      [
        {
          id: "att-1",
          name: "hello world.txt",
          url: "data:text/plain;base64,aGVsbG8=",
          contentType: "text/plain",
          size: 5,
        },
      ],
    );

    assertEquals(saved.length, 1);
    assertEquals(saved[0].originalName, "hello world.txt");
    assertEquals(saved[0].savedName, "001_att-1_hello_world.txt");
    assertEquals(await Deno.readTextFile(saved[0].path), "hello");

    const metadataPath = `${
      manager.getMessageAttachmentsDir(
        "thread-1",
        "message-1",
      )
    }/attachments.json`;
    assertExists(await Deno.stat(metadataPath));
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("WorkspaceManager: 一時ファイルはWORK_BASE_DIR配下に作成する", async () => {
  const baseDir = await createTestDir("workspace_test_");
  const originalTmpDir = Deno.env.get("TMPDIR");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    Deno.env.set("TMPDIR", "tmpfile");
    const tempPath = await manager.createTempFile({
      prefix: "last-message-",
      suffix: ".txt",
    });

    assertEquals(tempPath.startsWith(`${manager.getTempDir()}/`), true);
    await Deno.writeTextFile(tempPath, "ok");
    assertEquals(await Deno.readTextFile(tempPath), "ok");
    await Deno.remove(tempPath);
  } finally {
    if (originalTmpDir === undefined) {
      Deno.env.delete("TMPDIR");
    } else {
      Deno.env.set("TMPDIR", originalTmpDir);
    }
    await Deno.remove(baseDir, { recursive: true });
  }
});
