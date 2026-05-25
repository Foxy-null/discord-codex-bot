import { err, ok, Result } from "neverthrow";
import type { SavedAttachment } from "../attachments.ts";
import type { WorkerError } from "../worker/types.ts";
import type { WorkerMessageResult } from "../worker/types.ts";
import type { DiscordMessage } from "./types.ts";
import { WorkerManager } from "./worker-manager.ts";

export type MessageRouterError =
  | { type: "WORKER_NOT_FOUND"; threadId: string }
  | {
    type: "RATE_LIMIT_ERROR";
    threadId: string;
    timestamp?: number;
    message: string;
  }
  | {
    type: "MESSAGE_PROCESSING_ERROR";
    threadId: string;
    workerErrorType: WorkerError["type"];
    error: string;
  };

function formatWorkerError(error: WorkerError): string {
  switch (error.type) {
    case "CODEX_EXECUTION_FAILED":
      return error.error;
    case "WORKSPACE_ERROR":
    case "SESSION_LOG_FAILED":
      return `${error.operation}: ${error.error}`;
    case "REPOSITORY_NOT_SET":
      return "Repository is not set.";
    case "RATE_LIMIT":
      return error.message;
  }
}

export class MessageRouter {
  constructor(private readonly workerManager: WorkerManager) {}

  async routeMessage(
    threadId: string,
    message: string,
    attachments: readonly SavedAttachment[] = [],
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
  ): Promise<
    Result<string | WorkerMessageResult | DiscordMessage, MessageRouterError>
  > {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return err({ type: "WORKER_NOT_FOUND", threadId });
    }

    if (onReaction) {
      await onReaction("👀").catch(() => {});
    }

    const result = await worker.processMessage(
      message,
      attachments,
      onProgress,
      onReaction,
    );
    if (result.isErr()) {
      const error = result.error;
      if (error.type === "RATE_LIMIT") {
        return err({
          type: "RATE_LIMIT_ERROR",
          threadId,
          timestamp: error.timestamp,
          message: error.message,
        });
      }
      if (error.type === "REPOSITORY_NOT_SET") {
        return ok(
          "リポジトリが設定されていません。/start でリポジトリを指定してください。",
        );
      }
      return err({
        type: "MESSAGE_PROCESSING_ERROR",
        threadId,
        workerErrorType: error.type,
        error: formatWorkerError(error),
      });
    }

    return ok(result.value);
  }
}
