import { assertEquals } from "std/assert/mod.ts";
import { WorkerConfiguration } from "../src/worker/worker-configuration.ts";

Deno.test("WorkerConfiguration: 検索・承認・実行権限・追加指示をApp Serverへ引き継ぐ", () => {
  const config = new WorkerConfiguration("追加指示");
  assertEquals(config.buildThreadParams("/work"), {
    cwd: "/work",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: { web_search: "live" },
    developerInstructions: "追加指示",
  });
  assertEquals(
    new WorkerConfiguration().buildThreadParams("/work").developerInstructions,
    undefined,
  );
});
