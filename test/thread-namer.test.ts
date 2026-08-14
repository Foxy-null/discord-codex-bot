import { assertEquals } from "std/assert/mod.ts";
import {
  generateConversationNamesWithCodex,
  parseConversationNames,
} from "../src/thread-namer.ts";

Deno.test("parseConversationNames: 名前を正規化する", () => {
  const result = parseConversationNames(`\`\`\`json
    {"threadName":" 初回応答後の名前更新 ","branchPrefix":"FEAT","branchSlug":"Auto Name / First Reply"}
  \`\`\``);

  assertEquals(result._unsafeUnwrap(), {
    threadName: "初回応答後の名前更新",
    branchName: "feat/auto-name-first-reply",
  });
});

Deno.test("parseConversationNames: 未許可prefixを拒否する", () => {
  const result = parseConversationNames(
    '{"threadName":"名前","branchPrefix":"worker","branchSlug":"task"}',
  );
  assertEquals(result.isErr(), true);
});

Deno.test("generateConversationNamesWithCodex: stdoutを一度だけ回収する", async () => {
  const dir = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH");
  try {
    const text = JSON.stringify({
      threadName: "タイトル生成修正",
      branchPrefix: "fix",
      branchSlug: "collect-stdout-once",
    });
    const event = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text },
    });
    const fakeCodex = `${dir}/codex`;
    await Deno.writeTextFile(
      fakeCodex,
      `#!/bin/sh\nprintf '%s\\n' '${event}'\n`,
    );
    await Deno.chmod(fakeCodex, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath ?? ""}`);

    const result = await generateConversationNamesWithCodex(
      "依頼",
      "回答",
      undefined,
      dir,
    );
    assertEquals(result._unsafeUnwrap(), {
      threadName: "タイトル生成修正",
      branchName: "fix/collect-stdout-once",
    });
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true });
  }
});
