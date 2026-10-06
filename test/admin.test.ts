import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "std/assert/mod.ts";
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

Deno.test("Admin: コミット・PR言語は保存・復旧し新規・継続・プラン実行に適用する", async () => {
  const baseDir = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH");
  try {
    const workspace = new WorkspaceManager(baseDir);
    await workspace.initialize();
    await Deno.writeTextFile(
      `${baseDir}/codex`,
      `#!/bin/sh
printf '%s\\0' "$@" > codex-args
printf '%s\\n' '{"type":"thread.started","thread_id":"language-session"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"回答"}}'
`,
    );
    await Deno.chmod(`${baseDir}/codex`, 0o755);
    Deno.env.set("PATH", `${baseDir}:${originalPath ?? ""}`);

    const admin = Admin.fromState(null, workspace);
    const languages = [
      undefined,
      "  ",
      " en ",
      "日本語",
    ];
    for (const [index, language] of languages.entries()) {
      const threadId = `language-${index}`;
      assertEquals((await admin.createWorker(threadId, language)).isOk(), true);
      const state = await workspace.loadWorkerState(threadId);
      assertExists(state);
      const expectedLanguage = language?.trim() || null;
      assertEquals(state.commitPrLanguage, expectedLanguage);

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
        const args = (await Deno.readTextFile(`${baseDir}/codex-args`))
          .split("\0").filter(Boolean);
        const prompt = args.at(-1);
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
        assertEquals(args.includes("resume"), turn > 0);
        assertEquals(prompt.includes("You are in plan mode."), turn === 2);
      }
    }
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(baseDir, { recursive: true });
  }
});
