import type { SavedAttachment } from "../attachments.ts";
import type { WorkerMessageResult } from "../worker/types.ts";

export type AdminError =
  | { type: "WORKER_NOT_FOUND"; threadId: string }
  | { type: "WORKER_CREATE_FAILED"; threadId: string; reason: string }
  | { type: "CODEX_EXECUTION_FAILED"; threadId: string; error: string }
  | { type: "WORKSPACE_ERROR"; operation: string; error: string }
  | {
    type: "RATE_LIMIT";
    retryAt?: number;
    timestamp?: number;
    message: string;
  };

export interface DiscordMessage {
  content: string;
}

export interface IAdmin {
  routeMessage(
    threadId: string,
    message: string,
    attachments?: readonly SavedAttachment[],
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
  ): Promise<
    import("neverthrow").Result<
      string | WorkerMessageResult | DiscordMessage,
      AdminError
    >
  >;
  getActiveThreadIds(): string[];
}
