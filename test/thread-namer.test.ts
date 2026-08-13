import { assertEquals } from "std/assert/mod.ts";
import { parseConversationNames } from "../src/thread-namer.ts";

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
