import { err, ok, Result } from "neverthrow";
import { type TaskCostEntry, WorkspaceManager } from "./workspace/workspace.ts";

export const USD_TO_JPY_RATE = 160;

export interface TaskCostSummary {
  totalUsd: number;
  totalJpy: number;
  pendingCount: number;
  failedCount: number;
  readyCount: number;
  latestTask: TaskCostEntry | null;
}

export type TaskCostFetchError =
  | { type: "KEY_MISSING" }
  | { type: "REQUEST_FAILED"; error: string }
  | { type: "PARSE_FAILED"; error: string }
  | { type: "NO_DATA" };

export function usdToJpy(usd: number): number {
  return Math.round(usd * USD_TO_JPY_RATE);
}

export function createTaskCostEntry(taskId: string): TaskCostEntry {
  return {
    taskId,
    taskStartedAt: new Date().toISOString(),
    taskFinishedAt: null,
    costStatus: "pending",
    costUsd: null,
    costJpy: null,
    costFetchedAt: null,
    costError: null,
  };
}

export function summarizeTaskCosts(
  entries: readonly TaskCostEntry[],
): TaskCostSummary {
  const readyEntries = entries.filter((entry) => entry.costStatus === "ready");
  const pendingCount =
    entries.filter((entry) => entry.costStatus === "pending").length;
  const failedCount =
    entries.filter((entry) => entry.costStatus === "failed").length;
  const sortedEntries = [...entries].sort((a, b) =>
    (a.taskFinishedAt ?? a.taskStartedAt).localeCompare(
      b.taskFinishedAt ?? b.taskStartedAt,
    )
  );
  const latestTask = sortedEntries.length > 0
    ? sortedEntries[sortedEntries.length - 1] ?? null
    : null;

  return {
    totalUsd: readyEntries.reduce(
      (sum, entry) => sum + (entry.costUsd ?? 0),
      0,
    ),
    totalJpy: readyEntries.reduce(
      (sum, entry) => sum + (entry.costJpy ?? 0),
      0,
    ),
    pendingCount,
    failedCount,
    readyCount: readyEntries.length,
    latestTask,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function readAmountValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export class OpenAiCostsClient {
  constructor(
    private readonly adminKey?: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async fetchUsdCostForWindow(
    startAt: string,
    endAt: string,
  ): Promise<Result<number, TaskCostFetchError>> {
    if (!this.adminKey?.trim()) {
      return err({ type: "KEY_MISSING" });
    }

    const startTime = Math.floor(new Date(startAt).getTime() / 1000);
    const endTime = Math.floor(new Date(endAt).getTime() / 1000);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      return err({ type: "PARSE_FAILED", error: "invalid task time window" });
    }

    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("end_time", String(endTime));
    url.searchParams.set("bucket_width", "1d");

    try {
      const response = await this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${this.adminKey}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return err({
          type: "REQUEST_FAILED",
          error: `OpenAI Costs API returned ${response.status}`,
        });
      }

      const payload = await response.json() as unknown;
      const total = this.extractUsdAmount(payload);
      if (total === null) {
        return err({ type: "NO_DATA" });
      }
      return ok(total);
    } catch (error) {
      return err({
        type: "REQUEST_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private extractUsdAmount(payload: unknown): number | null {
    const record = asRecord(payload);
    if (!record) return null;

    const data = Array.isArray(record.data) ? record.data : [];
    let total = 0;
    let hasValue = false;

    for (const bucket of data) {
      const bucketRecord = asRecord(bucket);
      if (!bucketRecord) continue;
      const results = Array.isArray(bucketRecord.results)
        ? bucketRecord.results
        : [];
      for (const result of results) {
        const resultRecord = asRecord(result);
        if (!resultRecord) continue;
        const amount = asRecord(resultRecord.amount);
        if (!amount) continue;
        const currency = typeof amount.currency === "string"
          ? amount.currency.toLowerCase()
          : "";
        if (currency && currency !== "usd") continue;
        const value = readAmountValue(amount.value);
        if (value === null) continue;
        total += value;
        hasValue = true;
      }
    }

    return hasValue ? total : null;
  }
}

export class TaskCostLedger {
  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly costsClient?: OpenAiCostsClient | null,
  ) {}

  async startTask(threadId: string): Promise<TaskCostEntry> {
    const entry = createTaskCostEntry(crypto.randomUUID());
    await this.workspaceManager.saveTaskCostEntry(threadId, entry);
    return entry;
  }

  async finishTask(
    threadId: string,
    taskId: string,
  ): Promise<TaskCostEntry | null> {
    const current = await this.workspaceManager.loadTaskCostEntry(
      threadId,
      taskId,
    );
    if (!current) return null;
    if (!current.taskFinishedAt) {
      current.taskFinishedAt = new Date().toISOString();
    }
    await this.workspaceManager.saveTaskCostEntry(threadId, current);
    return current;
  }

  async refreshTaskCost(
    threadId: string,
    taskId: string,
  ): Promise<TaskCostEntry | null> {
    const current = await this.workspaceManager.loadTaskCostEntry(
      threadId,
      taskId,
    );
    if (!current) return null;
    if (!current.taskFinishedAt) return current;
    if (!this.costsClient) return current;

    const result = await this.costsClient.fetchUsdCostForWindow(
      current.taskStartedAt,
      current.taskFinishedAt,
    );
    if (result.isErr()) {
      return current;
    }

    const usd = result.value;
    current.costStatus = "ready";
    current.costUsd = usd;
    current.costJpy = usdToJpy(usd);
    current.costFetchedAt = new Date().toISOString();
    current.costError = null;
    await this.workspaceManager.saveTaskCostEntry(threadId, current);
    return current;
  }

  async refreshPendingTasks(threadId: string): Promise<TaskCostEntry[]> {
    const entries = await this.workspaceManager.loadTaskCostEntries(threadId);
    const pendingEntries = entries.filter((entry) =>
      entry.taskFinishedAt && entry.costStatus !== "ready"
    );
    const updated: TaskCostEntry[] = [];
    for (const entry of pendingEntries) {
      const before = JSON.stringify(entry);
      const refreshed = await this.refreshTaskCost(threadId, entry.taskId);
      if (refreshed && JSON.stringify(refreshed) !== before) {
        updated.push(refreshed);
      }
    }
    return updated;
  }

  async summarizeThread(
    threadId: string,
  ): Promise<{ entries: TaskCostEntry[]; summary: TaskCostSummary }> {
    const entries = await this.workspaceManager.loadTaskCostEntries(threadId);
    return {
      entries,
      summary: summarizeTaskCosts(entries),
    };
  }
}
