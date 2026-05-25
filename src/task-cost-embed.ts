import { EmbedBuilder } from "discord.js";
import {
  type TaskCostEntry,
  type TaskCostStatus,
} from "./workspace/workspace.ts";
import { type TaskCostSummary, usdToJpy } from "./task-costs.ts";

export interface TaskCostEmbedInput {
  threadName: string;
  summary: TaskCostSummary;
  latestTask?: TaskCostEntry | null;
  refreshedAt?: string;
}

function formatMoneyUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatMoneyJpy(value: number): string {
  return `¥${value.toLocaleString("ja-JP")}`;
}

function formatStatusLabel(status: TaskCostStatus): string {
  switch (status) {
    case "pending":
      return "集計待ち";
    case "ready":
      return "反映済み";
    case "failed":
      return "取得失敗";
  }
}

function formatTaskLine(entry?: TaskCostEntry | null): string {
  if (!entry) {
    return "未確定";
  }

  const status = formatStatusLabel(entry.costStatus);
  if (
    entry.costStatus === "ready" && entry.costUsd !== null &&
    entry.costUsd !== undefined
  ) {
    return `${status} / ${formatMoneyUsd(entry.costUsd)} / ${
      formatMoneyJpy(entry.costJpy ?? usdToJpy(entry.costUsd))
    }`;
  }

  if (entry.costStatus === "failed" && entry.costError) {
    return `${status} / ${entry.costError}`;
  }

  return status;
}

export function buildTaskCostEmbed(input: TaskCostEmbedInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Token / Cost Tracker`)
    .setDescription(`スレッド: ${input.threadName}`)
    .addFields(
      {
        name: "今回のタスク",
        value: formatTaskLine(input.latestTask),
        inline: false,
      },
      {
        name: "スレッド累計",
        value: `${formatMoneyUsd(input.summary.totalUsd)} / ${
          formatMoneyJpy(input.summary.totalJpy)
        }`,
        inline: true,
      },
      {
        name: "件数",
        value: [
          `反映済み: ${input.summary.readyCount}`,
          `集計待ち: ${input.summary.pendingCount}`,
          `取得失敗: ${input.summary.failedCount}`,
        ].join("\n"),
        inline: true,
      },
    )
    .setFooter({
      text: input.refreshedAt
        ? `updated ${input.refreshedAt}`
        : "updated pending",
    });

  return embed;
}
