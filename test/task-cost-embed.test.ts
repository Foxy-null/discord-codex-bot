import { assertEquals } from "std/assert/mod.ts";
import { buildTaskCostEmbed } from "../src/task-cost-embed.ts";
import { estimateTaskCostUsd } from "../src/task-costs.ts";

Deno.test("Task cost embed: 集計結果を埋め込める", () => {
  const embed = buildTaskCostEmbed({
    threadName: "owner/repo-123",
    summary: {
      totalUsd: 3.2,
      totalJpy: 512,
      estimatedPendingUsd: 0,
      estimatedPendingJpy: 0,
      estimatedTotalUsd: 3.2,
      estimatedTotalJpy: 512,
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 150,
      reasoningOutputTokens: 50,
      totalTokens: 1400,
      pendingCount: 1,
      failedCount: 0,
      readyCount: 2,
      latestTask: null,
    },
    latestTask: {
      taskId: "task-1",
      taskStartedAt: "2026-05-25T00:00:00.000Z",
      taskFinishedAt: "2026-05-25T00:01:00.000Z",
      costStatus: "ready",
      tokenUsage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
      costUsd: 1.2,
      costJpy: 192,
      costFetchedAt: "2026-05-25T00:02:00.000Z",
      costError: null,
    },
    refreshedAt: "2026-05-25T00:03:00.000Z",
  });

  assertEquals(embed.data.title, "Token / Cost Tracker");
  assertEquals(embed.data.fields?.[0].name, "今回のタスク");
  assertEquals(
    embed.data.fields?.[0].value,
    "反映済み\nInput: 90\nCached Input: 10\nOutput: 20\nReasoning: 5\nTotal: 125\nCost: $1.20 / ¥192",
  );
  assertEquals(
    embed.data.fields?.[1].value,
    "Input: 1,000\nCached Input: 200\nOutput: 150\nReasoning: 50\nTotal: 1,400\nCost: $3.20 / ¥512",
  );
});

Deno.test("Task cost embed: 集計待ちの推定コストを表示できる", () => {
  const estimated = estimateTaskCostUsd({
    inputTokens: 1_526_002,
    cachedInputTokens: 1_353_600,
    outputTokens: 14_295,
    reasoningOutputTokens: 7_453,
  }) ?? 0;

  const embed = buildTaskCostEmbed({
    threadName: "owner/repo-123",
    summary: {
      totalUsd: 0,
      totalJpy: 0,
      estimatedPendingUsd: estimated,
      estimatedPendingJpy: 135,
      estimatedTotalUsd: estimated,
      estimatedTotalJpy: 135,
      inputTokens: 1526002,
      cachedInputTokens: 1353600,
      outputTokens: 14295,
      reasoningOutputTokens: 7453,
      totalTokens: 1547750,
      pendingCount: 1,
      failedCount: 0,
      readyCount: 0,
      latestTask: null,
    },
    latestTask: {
      taskId: "task-pending",
      taskStartedAt: "2026-05-25T00:00:00.000Z",
      taskFinishedAt: "2026-05-25T00:01:00.000Z",
      costStatus: "pending",
      tokenUsage: {
        inputTokens: 1526002,
        cachedInputTokens: 1353600,
        outputTokens: 14295,
        reasoningOutputTokens: 7453,
      },
      costUsd: null,
      costJpy: null,
      costFetchedAt: null,
      costError: null,
    },
    refreshedAt: "2026-05-25T00:03:00.000Z",
  });

  assertEquals(
    embed.data.fields?.[0].value,
    "集計待ち\nInput: 172,402\nCached Input: 1,353,600\nOutput: 14,295\nReasoning: 7,453\nTotal: 1,547,750\nCost (est.): $0.84 / ¥135",
  );
  assertEquals(
    embed.data.fields?.[1].value,
    "Input: 172,402\nCached Input: 1,353,600\nOutput: 14,295\nReasoning: 7,453\nTotal: 1,547,750\nCost: $0.00 / ¥0\nEstimated Pending: $0.84 / ¥135\nEstimated Total: $0.84 / ¥135",
  );
});
