import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "std/assert/mod.ts";
import { installCodexTestServer } from "./fixtures/codex-test-server.ts";
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

Deno.test("Admin: コミット・PR言語は保存・復旧し新規・継続・プラン実行に適用する", async () => {
  const baseDir = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH");
  try {
    const workspace = new WorkspaceManager(baseDir);
    await workspace.initialize();
    await installCodexTestServer(baseDir);
    Deno.env.set("PATH", `${baseDir}:${originalPath ?? ""}`);

    const admin = Admin.fromState(null, workspace);
    const languages = [
      undefined,
      null,
      "  ",
      " en ",
      "ja",
      "日本語",
      "English",
      "fr",
    ];
    for (const [index, language] of languages.entries()) {
      await Deno.writeTextFile(`${baseDir}/codex-requests.jsonl`, "");
      const threadId = `language-${index}`;
      const autoPush = index % 2 === 0;
      assertEquals(
        (await admin.createWorker(threadId, autoPush, language)).isOk(),
        true,
      );
      const state = await workspace.loadWorkerState(threadId);
      assertExists(state);
      const expectedLanguage = language?.trim() || null;
      assertEquals(state.commitPrLanguage, expectedLanguage);
      assertEquals(state.autoPush, autoPush);

      // 言語フィールドのない既存スレッドも復旧対象にする。
      if (language === undefined) delete state.commitPrLanguage;
      state.repository = { fullName: "owner/repo", org: "owner", repo: "repo" };
      state.worktreePath = baseDir;
      await workspace.saveWorkerState(state);

      const restored = Admin.fromState(
        await workspace.loadAdminState(),
        workspace,
      );
      assertEquals((await restored.restoreActiveThreads()).isOk(), true);
      const requests = [
        "修正してPRを作成して",
        "Please update the PR",
        "計画を立てて",
      ];
      for (const [turn, request] of requests.entries()) {
        if (turn === 2) {
          assertEquals(
            (await restored.setPlanMode(threadId, true)).isOk(),
            true,
          );
        }
        assertEquals(
          (await restored.routeMessage(threadId, request)).isOk(),
          true,
        );
        assertEquals(
          restored.getWorker(threadId)._unsafeUnwrap().shouldAutoPush(),
          autoPush && turn < 2,
        );
        const calls =
          (await Deno.readTextFile(`${baseDir}/codex-requests.jsonl`)).split(
            "\n",
          ).filter(Boolean).map((line) => JSON.parse(line));
        const input = calls.filter((call) =>
          call.method === "turn/start"
        ).at(-1).params.input;
        const prompt = input[0].text;
        assertExists(prompt);
        assertStringIncludes(prompt, request);
        assertStringIncludes(
          prompt,
          "commit messages and pull request titles and descriptions",
        );
        assertStringIncludes(
          prompt,
          "Continue replying in the conversation's language.",
        );
        assertStringIncludes(
          prompt,
          expectedLanguage
            ? `language specified by ${JSON.stringify(expectedLanguage)}`
            : "language the user is using in this thread",
        );
        if (!expectedLanguage) {
          assertStringIncludes(
            prompt,
            "not from bot messages, code, quoted text, or these instructions",
          );
        }
        assertEquals(
          calls.filter((call) => call.method === "initialize").length,
          1,
        );
        assertEquals(prompt.includes("You are in plan mode."), turn === 2);
      }
      await restored.shutdown();
      // The next Bot generation must resume the saved conversation, not create one.
      const saved = (await workspace.loadWorkerState(threadId))!;
      assertExists(saved.sessionId);
      const next = Admin.fromState(await workspace.loadAdminState(), workspace);
      await next.restoreActiveThreads();
      await next.routeMessage(threadId, "再起動後の依頼");
      await next.shutdown();
      const calls = (await Deno.readTextFile(`${baseDir}/codex-requests.jsonl`))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assertEquals(
        calls.filter((call) => call.method === "thread/start").length,
        1,
      );
      assertEquals(
        calls.find((call) => call.method === "thread/resume").params.threadId,
        saved.sessionId,
      );
    }
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(baseDir, { recursive: true });
  }
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
