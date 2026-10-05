import { assertEquals, assertRejects } from "std/assert/mod.ts";
import {
  CodexRpcError,
  DefaultCodexClient,
} from "../src/worker/codex-executor.ts";
import { installCodexTestServer } from "./fixtures/codex-test-server.ts";

Deno.test("CodexClient: 持続stdio接続で初期化・UTF-8分割・要求照合・通知・切断を処理する", async () => {
  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("PATH");
  await installCodexTestServer(dir);
  Deno.env.set("PATH", `${dir}:${previous ?? ""}`);
  const client = new DefaultCodexClient(dir);
  try {
    const handled = Promise.withResolvers<Record<string, unknown>>();
    client.onNotification = (method, params) => {
      if (method === "test/serverResponse") handled.resolve(params);
    };
    const [a, b] = await Promise.all([
      client.request("test/unicode", {}),
      client.request("test/unicode", {}),
    ]);
    assertEquals(a.text, "日本語");
    assertEquals(b.text, "日本語");
    await assertRejects(
      () => client.request("test/error", {}),
      CodexRpcError,
      "no active turn",
    );
    await assertRejects(
      () => client.request("test/malformedError", {}),
      Error,
      "不正な応答",
    );
    await client.request("test/serverRequest", {});
    const response = (await handled.promise).response as {
      error: { code: number };
    };
    assertEquals(response.error.code, -32601);
    const log = (await Deno.readTextFile(`${dir}/codex-requests.jsonl`)).split(
      "\n",
    ).filter(Boolean).map((line) => JSON.parse(line));
    assertEquals(
      log.filter((request) => request.method === "initialize").length,
      1,
    );
    assertEquals(log[1].method, "initialized");
    await assertRejects(
      () => client.request("test/disconnect", {}),
      Error,
      "Codex接続が終了",
    );
    // This is a new request, not a replay of the request that disconnected.
    assertEquals((await client.request("test/unicode", {})).text, "日本語");
    await client.close();
    await assertRejects(
      () => client.request("test/unicode", {}),
      Error,
      "終了しています",
    );
  } finally {
    await client.close();
    if (previous === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", previous);
    await Deno.remove(dir, { recursive: true });
  }
});
