import { assertEquals } from "std/assert/mod.ts";
import { Admin } from "../src/admin/admin.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

Deno.test("Admin: active thread ids は内部状態のコピーを返す", () => {
  const admin = Admin.fromState(
    {
      activeThreadIds: ["thread-1", "thread-2"],
      lastUpdated: new Date().toISOString(),
    },
    new WorkspaceManager("."),
  );

  const ids = admin.getActiveThreadIds();
  ids.push("thread-3");

  assertEquals(admin.getActiveThreadIds(), ["thread-1", "thread-2"]);
});

Deno.test("Admin: 自動プッシュは新規で既定true、falseも保存・復元する", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const workspace = new WorkspaceManager(dir);
    await workspace.initialize();
    const admin = Admin.fromState(null, workspace);
    (await admin.createWorker("default"))._unsafeUnwrap();
    (await admin.createWorker("disabled", false))._unsafeUnwrap();

    assertEquals((await workspace.loadWorkerState("default"))?.autoPush, true);
    assertEquals(
      (await workspace.loadWorkerState("disabled"))?.autoPush,
      false,
    );

    const restored = Admin.fromState(
      await workspace.loadAdminState(),
      workspace,
    );
    (await restored.restoreActiveThreads())._unsafeUnwrap();
    for (const threadId of ["default", "disabled"]) {
      const worker = restored.getWorker(threadId)._unsafeUnwrap();
      (await worker.save())._unsafeUnwrap();
    }
    assertEquals((await workspace.loadWorkerState("default"))?.autoPush, true);
    assertEquals(
      (await workspace.loadWorkerState("disabled"))?.autoPush,
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
