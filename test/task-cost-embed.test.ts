import { assertEquals } from "std/assert/mod.ts";
import { buildTaskCostEmbed } from "../src/task-cost-embed.ts";

Deno.test("Task cost embed: 集計結果を埋め込める", () => {
  const embed = buildTaskCostEmbed({
    threadName: "owner/repo-123",
    summary: {
      totalUsd: 3.2,
      totalJpy: 512,
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
      costUsd: 1.2,
      costJpy: 192,
      costFetchedAt: "2026-05-25T00:02:00.000Z",
      costError: null,
    },
    refreshedAt: "2026-05-25T00:03:00.000Z",
  });

  assertEquals(embed.data.title, "Token / Cost Tracker");
  assertEquals(embed.data.fields?.[0].name, "今回のタスク");
  assertEquals(embed.data.fields?.[1].value, "$3.20 / ¥512");
});
