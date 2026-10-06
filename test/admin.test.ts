import { assertEquals, assertRejects } from "std/assert/mod.ts";
import { Admin } from "../src/admin/admin.ts";
import { WorkerManager } from "../src/admin/worker-manager.ts";
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

Deno.test("WorkerManager: 終了失敗があっても全Workerの回収が終わるまで待つ", async () => {
  const dir = await Deno.makeTempDir();
  const finish = Promise.withResolvers<void>();
  try {
    const workspace = new WorkspaceManager(dir);
    await workspace.initialize();
    const manager = new WorkerManager(workspace);
    const first = (await manager.createWorker("one"))._unsafeUnwrap();
    const second = (await manager.createWorker("two"))._unsafeUnwrap();
    const started = Promise.withResolvers<void>();
    first.close = async () => {
      throw new Error("first failed");
    };
    second.close = async () => {
      started.resolve();
      await finish.promise;
    };
    let finished = false;
    const closing = manager.closeAll();
    const settled = closing.then(() => {
      finished = true;
    }, () => {
      finished = true;
    });
    await started.promise;
    assertEquals(finished, false);
    finish.resolve();
    await assertRejects(() => closing, AggregateError, "Workerの終了処理");
    await settled;
    assertEquals(finished, true);
  } finally {
    finish.resolve();
    await Deno.remove(dir, { recursive: true });
  }
});
