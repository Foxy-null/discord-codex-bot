import { assert, assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { Worker } from "../src/worker/worker.ts";
import { CodexRpcError } from "../src/worker/codex-executor.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";
import { FakeCodexClient } from "./fixtures/fake-codex-client.ts";

async function setup(overrides: Partial<WorkerState> = {}) {
  const dir = await Deno.makeTempDir();
  const workspace = new WorkspaceManager(dir);
  await workspace.initialize();
  const now = new Date().toISOString();
  const state: WorkerState = {
    workerName: "w1",
    threadId: "discord-1",
    repository: { fullName: "owner/repo", org: "owner", repo: "repo" },
    worktreePath: dir,
    status: "active",
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
  const client = new FakeCodexClient();
  const worker = new Worker(state, workspace, client);
  return {
    dir,
    workspace,
    state,
    client,
    worker,
    async cleanup() {
      await worker.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("Worker: 既存保存形式・作業コピー・会話ID・プラン設定を復元する", async () => {
  const env = await setup({
    sessionId: "old-thread",
    isPlanMode: true,
  });
  try {
    await env.worker.save();
    const state = (await env.workspace.loadWorkerState("discord-1"))!;
    const worker = await Worker.fromState(
      state,
      env.workspace,
      undefined,
      env.client,
    );
    assertEquals(
      (await worker.processMessage("計画して"))._unsafeUnwrap(),
      "回答",
    );
    assertEquals(env.client.calls[0].method, "thread/resume");
    assertEquals(env.client.calls[0].params.threadId, "old-thread");
    assertEquals(env.client.calls[0].params.cwd, env.dir);
    const input = env.client.calls.find((c) => c.method === "turn/start")!
      .params.input as { text: string }[];
    assertStringIncludes(input[0].text, "You are in plan mode.");
    assertEquals(
      (await env.workspace.loadWorkerState("discord-1"))?.sessionId,
      "old-thread",
    );
    await worker.close();
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 初回準備中の入力を受信順にSteerし、会話IDを終了前に保存する", async () => {
  const env = await setup();
  env.client.autoComplete = false;
  const prepared = Promise.withResolvers<void>();
  let completions = 0;
  try {
    const first = env.worker.processMessage(
      "最初",
      async () => {
        await prepared.promise;
        return [];
      },
      undefined,
      undefined,
      async () => {
        completions++;
      },
    );
    const extra = env.worker.processMessage("追加");
    assertEquals(env.client.calls.length, 0);
    prepared.resolve();
    const steer = await env.client.waitFor("turn/steer");
    assertEquals(steer.params.threadId, "thread-1");
    assertEquals(typeof steer.params.expectedTurnId, "string");
    assertEquals((await extra)._unsafeUnwrap(), null);
    assertEquals(
      env.client.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
    assertEquals(
      (await env.workspace.loadWorkerState("discord-1"))?.sessionId,
      "thread-1",
    );
    assertEquals(completions, 0);
    env.client.complete("thread-1");
    assertEquals((await first)._unsafeUnwrap(), null);
    assertEquals(completions, 1);
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: Steer前後の最終回答と添付を生成順に残し、完了時に一度だけ返信する", async () => {
  const env = await setup();
  env.client.autoComplete = false;
  const replies: string[] = [];
  const progress: string[] = [];
  const original = "元の回答\n[[attachment:report.pdf]]";
  const acknowledgement = "以後、ログ全文は出しません。";
  const emit = (id: string, text: string) =>
    env.client.onNotification("item/completed", {
      threadId: "thread-1",
      item: {
        id,
        type: "agentMessage",
        phase: "final_answer",
        delivery: null,
        text,
      },
    });
  try {
    const first = env.worker.processMessage(
      "元の依頼",
      [],
      async (text) => {
        progress.push(text);
      },
      undefined,
      async (text) => {
        replies.push(text);
      },
    );
    await env.client.waitFor("turn/start");
    emit("original", original);
    assertEquals(
      (await env.worker.processMessage("ログ全文の出力をやめて"))
        ._unsafeUnwrap(),
      null,
    );
    emit("acknowledgement", acknowledgement);
    emit("original", original);
    assertEquals(replies, []);
    env.client.finish("thread-1");
    assertEquals((await first)._unsafeUnwrap(), null);
    assertEquals(replies, [`${original}\n\n${acknowledgement}`]);
    assert(progress.includes(original));
    assert(progress.includes(acknowledgement));
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 完了直前に拒否された追加指示だけを、後処理後の新しいターンへ渡す", async () => {
  for (
    const rejection of [
      "no active turn to steer",
      "expected active turn id `old` but found `new`",
    ]
  ) {
    const env = await setup();
    env.client.autoComplete = false;
    try {
      const first = env.worker.processMessage("最初");
      await env.client.waitFor("turn/start");
      env.client.hook = (method) => {
        if (method === "turn/steer") {
          env.client.complete("thread-1");
          throw new CodexRpcError(-32600, rejection);
        }
      };
      const extra = env.worker.processMessage("追加");
      await env.client.waitFor("turn/start", 2);
      env.client.complete("thread-1", "次の回答");
      assertEquals((await extra)._unsafeUnwrap(), "次の回答");
      assertEquals((await first)._unsafeUnwrap(), "回答");
      assertEquals(
        env.client.calls.filter((c) => c.method === "thread/start").length,
        1,
      );
    } finally {
      await env.cleanup();
    }
  }
});

Deno.test("Worker: 通常停止はターンを中断し、同じ接続と会話で次の依頼を開始する", async () => {
  const env = await setup();
  env.client.autoComplete = false;
  try {
    const first = env.worker.processMessage("最初");
    await env.client.waitFor("turn/start");
    assertEquals(await env.worker.stopExecution(), true);
    assertStringIncludes((await first)._unsafeUnwrap()!, "中断");
    assertEquals(env.client.closed, false);
    const second = env.worker.processMessage("次の依頼");
    await env.client.waitFor("turn/start", 2);
    env.client.complete("thread-1");
    await second;
    assertEquals(
      env.client.calls.filter((c) => c.method === "thread/start").length,
      1,
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 起動中に追加入力があっても停止が入力待ちと相互に待たない", async () => {
  const env = await setup({ sessionId: "old-thread" });
  env.client.autoComplete = false;
  const resumed = Promise.withResolvers<void>();
  env.client.hook = async (method) => {
    if (method === "thread/resume") await resumed.promise;
  };
  try {
    const first = env.worker.processMessage("最初");
    await env.client.waitFor("thread/resume");
    const extra = env.worker.processMessage("追加");
    const stopped = env.worker.stopExecution();
    resumed.resolve();
    await env.client.waitFor("turn/interrupt");
    assertEquals(await stopped, true);
    assertStringIncludes((await first)._unsafeUnwrap()!, "中断");
    await env.client.waitFor("turn/start", 2);
    env.client.complete("old-thread");
    assertEquals((await extra)._unsafeUnwrap(), "回答");
  } finally {
    resumed.resolve();
    await env.cleanup();
  }
});

Deno.test("Worker: 添付の準備中に完了しても、途中出力と後処理を終えてから次のターンを始める", async () => {
  const env = await setup();
  env.client.autoComplete = false;
  const preparing = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>();
  const progress = Promise.withResolvers<void>();
  const finalizing = Promise.withResolvers<void>();
  const finalized = Promise.withResolvers<void>();
  try {
    const first = env.worker.processMessage(
      "最初",
      [],
      async (text) => {
        if (text === "回答") await progress.promise;
      },
      undefined,
      async () => {
        finalizing.resolve();
        await finalized.promise;
      },
    );
    await env.client.waitFor("turn/start");
    const extra = env.worker.processMessage("追加", async () => {
      preparing.resolve();
      await prepared.promise;
      return [];
    });
    await preparing.promise;
    env.client.complete("thread-1");
    prepared.resolve();
    progress.resolve();
    await finalizing.promise;
    assertEquals(
      env.client.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
    assertEquals(
      env.client.calls.filter((c) => c.method === "turn/steer").length,
      0,
    );
    finalized.resolve();
    await first;
    await env.client.waitFor("turn/start", 2);
    env.client.complete("thread-1");
    assertEquals((await extra)._unsafeUnwrap(), "回答");
  } finally {
    prepared.resolve();
    progress.resolve();
    finalized.resolve();
    await env.cleanup();
  }
});

Deno.test("Worker: 接続障害や任意のSteerエラーを自動再送せず、既存会話を保持する", async () => {
  const env = await setup({ sessionId: "old-thread" });
  env.client.autoComplete = false;
  try {
    const first = env.worker.processMessage("最初");
    await env.client.waitFor("turn/start");
    env.client.hook = (method) => {
      if (method === "turn/steer") {
        throw new CodexRpcError(-32603, "connection lost");
      }
    };
    assertEquals((await env.worker.processMessage("追加")).isErr(), true);
    assertEquals(
      env.client.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
    env.client.onFailure(new Error("connection lost API_KEY=secret-value"));
    const error = (await first)._unsafeUnwrapErr();
    assert(error.type === "CODEX_EXECUTION_FAILED");
    assertEquals(error.error.includes("secret-value"), false);
    assertEquals(env.state.sessionId, "old-thread");
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 初回失敗・中断でも会話IDを保存し、復元失敗で新規会話を作らない", async () => {
  for (const status of ["failed", "interrupted"]) {
    const env = await setup();
    env.client.status = status;
    try {
      await env.worker.processMessage("依頼");
      assertEquals(
        (await env.workspace.loadWorkerState("discord-1"))?.sessionId,
        "thread-1",
      );
    } finally {
      await env.cleanup();
    }
  }
  const env = await setup({ sessionId: "missing-thread" });
  try {
    env.client.hook = (method) => {
      if (method === "thread/resume") {
        throw new CodexRpcError(-32600, "thread not found");
      }
    };
    assertEquals((await env.worker.processMessage("依頼")).isErr(), true);
    assertEquals(
      env.client.calls.some((c) => c.method === "thread/start"),
      false,
    );
    assertEquals(env.state.sessionId, "missing-thread");
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 生出力と思考要約を隠し、添付・途中出力・進捗エラーを処理する", async () => {
  const env = await setup();
  env.client.autoComplete = false;
  const progress: string[] = [];
  const hiddenItems = [
    {
      type: "commandExecution",
      command: "cat README.md CONTEXT.md",
      aggregatedOutput: "読み取ったファイルの全文",
      exitCode: 0,
    },
    {
      type: "commandExecution",
      command: "deno test",
      aggregatedOutput: "テスト失敗の詳細",
      exitCode: 1,
    },
    { type: "commandExecution", command: "rg TODO" },
    { type: "reasoning", summary: ["内部の思考要約"] },
  ];
  try {
    const request = env.worker.processMessage("画像を見て", [{
      id: "1",
      originalName: "image.png",
      savedName: "image.png",
      path: env.dir + "/image.png",
      contentType: "image/png",
      size: 0,
      url: "",
      isImage: true,
    }], async (text) => {
      progress.push(text);
    });
    const call = await env.client.waitFor("turn/start");
    assertEquals(
      (call.params.input as { type: string }[])[1].type,
      "localImage",
    );
    env.client.onNotification("item/started", {
      threadId: "thread-1",
      item: { type: "contextCompaction" },
    });
    env.client.onNotification("item/completed", {
      threadId: "thread-1",
      item: { type: "contextCompaction" },
    });
    for (const item of hiddenItems) {
      env.client.onNotification("item/completed", {
        threadId: "thread-1",
        item,
      });
    }
    env.client.onNotification("item/completed", {
      threadId: "thread-1",
      item: { type: "fileChange" },
    });
    env.client.onNotification("item/completed", {
      threadId: "thread-1",
      item: {
        id: "answer",
        type: "agentMessage",
        phase: "final_answer",
        text: "回答",
      },
    });
    env.client.onNotification("item/completed", {
      threadId: "thread-1",
      item: { type: "agentMessage", phase: "commentary", text: "途中出力" },
    });
    env.client.finish("thread-1");
    assertEquals(
      (await request)._unsafeUnwrap(),
      "回答",
    );
    assertEquals(progress, [
      "🤖 Codexが処理を開始しました...",
      "コンテキスト圧縮を開始しました。",
      "コンテキスト圧縮が完了しました。",
      "ファイルの変更を反映しました。",
      "回答",
      "途中出力",
    ]);
    const logDir = `${env.dir}/sessions/owner/repo`;
    const logs = await Array.fromAsync(Deno.readDir(logDir));
    assertEquals(logs.length, 1);
    const raw = await Deno.readTextFile(`${logDir}/${logs[0].name}`);
    for (const item of hiddenItems) {
      assertStringIncludes(raw, JSON.stringify(item));
    }
    const original = console.error;
    console.error = () => {};
    try {
      env.client.autoComplete = true;
      assertEquals(
        (await env.worker.processMessage("次", [], async () => {
          throw new Error("Discord unavailable");
        })).isOk(),
        true,
      );
    } finally {
      console.error = original;
    }
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 終了時にターンを中断・接続を回収し、終了後の入力を拒否する", async () => {
  const env = await setup();
  env.client.autoComplete = false;
  try {
    const request = env.worker.processMessage("最初");
    await env.client.waitFor("turn/start");
    await env.worker.close();
    await request;
    assertEquals(env.client.closed, true);
    assertEquals((await env.worker.processMessage("追加")).isErr(), true);
    assertEquals(
      env.client.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("Worker: 別の作業スレッドを独立して並行実行する", async () => {
  const first = await setup();
  const second = await setup({ threadId: "discord-2" });
  first.client.autoComplete = false;
  second.client.autoComplete = false;
  try {
    const a = first.worker.processMessage("依頼1");
    const b = second.worker.processMessage("依頼2");
    await Promise.all([
      first.client.waitFor("turn/start"),
      second.client.waitFor("turn/start"),
    ]);
    second.client.complete("thread-1", "回答2");
    assertEquals((await b)._unsafeUnwrap(), "回答2");
    first.client.complete("thread-1", "回答1");
    assertEquals((await a)._unsafeUnwrap(), "回答1");
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
