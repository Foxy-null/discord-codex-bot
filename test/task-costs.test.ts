import { assertEquals } from "std/assert/mod.ts";
import {
  createTaskCostEntry,
  estimateTaskCostUsd,
  OpenAiCostsClient,
  summarizeTaskCosts,
  usdToJpy,
} from "../src/task-costs.ts";

Deno.test("Task costs: USD を固定レートで JPY に変換できる", () => {
  assertEquals(usdToJpy(1), 160);
  assertEquals(usdToJpy(1.5), 240);
});

Deno.test("Task costs: ready な台帳だけを集計できる", () => {
  const entries = [
    {
      ...createTaskCostEntry("task-1"),
      taskFinishedAt: "2026-05-25T00:01:00.000Z",
      costStatus: "ready" as const,
      tokenUsage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
      costUsd: 1.25,
      costJpy: 200,
    },
    {
      ...createTaskCostEntry("task-2"),
      taskFinishedAt: "2026-05-25T00:02:00.000Z",
      costStatus: "pending" as const,
    },
  ];

  const summary = summarizeTaskCosts(entries);
  assertEquals(summary.totalUsd, 1.25);
  assertEquals(summary.totalJpy, 200);
  assertEquals(summary.inputTokens, 100);
  assertEquals(summary.cachedInputTokens, 20);
  assertEquals(summary.outputTokens, 30);
  assertEquals(summary.reasoningOutputTokens, 10);
  assertEquals(summary.totalTokens, 140);
  assertEquals(summary.estimatedPendingUsd, 0);
  assertEquals(summary.estimatedPendingJpy, 0);
  assertEquals(summary.estimatedTotalUsd, 1.25);
  assertEquals(summary.estimatedTotalJpy, 200);
  assertEquals(summary.readyCount, 1);
  assertEquals(summary.pendingCount, 1);
});

Deno.test("Task costs: pending task の推定金額を計算できる", () => {
  const estimated = estimateTaskCostUsd({
    inputTokens: 1_526_002,
    cachedInputTokens: 1_353_600,
    outputTokens: 14_295,
    reasoningOutputTokens: 7_453,
  });

  assertEquals(estimated !== null, true);
  if (estimated !== null) {
    assertEquals(Number(estimated.toFixed(6)), 0.843055);
    assertEquals(usdToJpy(estimated), 135);
  }
});

Deno.test("OpenAiCostsClient: Costs API 応答からUSDを抽出できる", async () => {
  const client = new OpenAiCostsClient(
    "admin-key",
    async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              results: [
                {
                  amount: {
                    currency: "usd",
                    value: 1.1,
                  },
                },
                {
                  amount: {
                    currency: "usd",
                    value: "0.9",
                  },
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const result = await client.fetchUsdCostForWindow(
    "2026-05-25T00:00:00.000Z",
    "2026-05-25T00:10:00.000Z",
  );
  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value, 2.0);
  }
});
