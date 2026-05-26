import { EmbedBuilder } from "discord.js";
import {
  estimateTaskCostUsd,
  type TaskCostSummary,
  usdToJpy,
} from "./task-costs.ts";
import {
  type TaskCostEntry,
  type TaskCostStatus,
  type TaskTokenUsage,
} from "./workspace/workspace.ts";

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

function formatTokens(value: number): string {
  return value.toLocaleString("ja-JP");
}

function getDisplayInputTokens(usage: TaskTokenUsage): number {
  return Math.max(0, usage.inputTokens - usage.cachedInputTokens);
}

function formatTokenUsageLine(usage?: TaskTokenUsage | null): string {
  if (!usage) {
    return "未確定";
  }

  const segments = [
    `Input ${formatTokens(getDisplayInputTokens(usage))} (cached ${
      formatTokens(usage.cachedInputTokens)
    })`,
    `Output ${formatTokens(usage.outputTokens)}`,
  ];
  if ((usage.reasoningOutputTokens ?? 0) > 0) {
    segments.push(`Reasoning ${formatTokens(usage.reasoningOutputTokens ?? 0)}`);
  }
  segments.push(`Total ${
    formatTokens(
      usage.inputTokens + usage.outputTokens +
        (usage.reasoningOutputTokens ?? 0),
    )
  }`);
  return segments.join(" | ");
}

function formatCostLine(
  usd: number,
  jpy: number,
  label = "Cost",
): string {
  return `${label}: ${formatMoneyUsd(usd)} / ${formatMoneyJpy(jpy)}`;
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

  const lines = [formatStatusLabel(entry.costStatus)];
  lines.push(formatTokenUsageLine(entry.tokenUsage));
  if (
    entry.costStatus === "ready" && entry.costUsd !== null &&
    entry.costUsd !== undefined
  ) {
    lines.push(
      formatCostLine(entry.costUsd, entry.costJpy ?? usdToJpy(entry.costUsd)),
    );
    return lines.join("\n");
  }

  if (entry.costStatus === "pending" && entry.tokenUsage) {
    const estimatedUsd = estimateTaskCostUsd(entry.tokenUsage) ?? 0;
    if (estimatedUsd > 0) {
      lines.push(
        formatCostLine(estimatedUsd, usdToJpy(estimatedUsd), "Cost (est.)"),
      );
    }
    return lines.join("\n");
  }

  if (entry.costStatus === "failed" && entry.costError) {
    lines.push(`Cost: ${entry.costError}`);
    return lines.join("\n");
  }

  return lines.join("\n");
}

function formatSummaryLine(summary: TaskCostSummary): string {
  const lines = [`Total: ${formatTokens(summary.totalTokens)}`];
  if (summary.reasoningOutputTokens > 0) {
    lines.push(`Reasoning: ${formatTokens(summary.reasoningOutputTokens)}`);
  }
  lines.push(formatCostLine(summary.totalUsd, summary.totalJpy));
  if (summary.estimatedPendingUsd > 0) {
    lines.push(
      formatCostLine(
        summary.estimatedPendingUsd,
        summary.estimatedPendingJpy,
        "Estimated Pending",
      ),
    );
    lines.push(
      formatCostLine(
        summary.estimatedTotalUsd,
        summary.estimatedTotalJpy,
        "Estimated Total",
      ),
    );
  }
  return lines.join("\n");
}

export function buildTaskCostEmbed(input: TaskCostEmbedInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Token / Cost Tracker`)
    .setDescription(`スレッド: ${input.threadName}`)
    .addFields(
      {
        name: "今回のタスク",
        value: formatTaskLine(input.latestTask),
        inline: true,
      },
      {
        name: "スレッド累計",
        value: formatSummaryLine(input.summary),
        inline: true,
      },
      {
        name: "件数",
        value: [
          `反映済み: ${input.summary.readyCount}`,
          `集計待ち: ${input.summary.pendingCount}`,
          `取得失敗: ${input.summary.failedCount}`,
        ].join(" / "),
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
