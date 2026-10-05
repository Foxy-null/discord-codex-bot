import type { SavedAttachment } from "../attachments.ts";

export type WorkerError =
  | { type: "REPOSITORY_NOT_SET" }
  | { type: "CODEX_EXECUTION_FAILED"; error: string }
  | {
    type: "RATE_LIMIT";
    timestamp?: number;
    retryAt?: number;
    message: string;
  }
  | { type: "WORKSPACE_ERROR"; operation: string; error: string }
  | { type: "SESSION_LOG_FAILED"; operation: string; error: string };

export type MessageAttachments =
  | readonly SavedAttachment[]
  | (() => Promise<readonly SavedAttachment[]>);

export interface IWorker {
  processMessage(
    message: string,
    attachments?: MessageAttachments,
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
    onComplete?: (reply: string) => Promise<void>,
  ): Promise<import("neverthrow").Result<string | null, WorkerError>>;
  getName(): string;
  getRepository(): import("../git-utils.ts").GitRepository | null;
  setRepository(
    repository: import("../git-utils.ts").GitRepository,
    localPath: string,
  ): Promise<import("neverthrow").Result<void, WorkerError>>;
  save(): Promise<import("neverthrow").Result<void, WorkerError>>;
  stopExecution(
    onProgress?: (content: string) => Promise<void>,
  ): Promise<boolean>;
  close(): Promise<void>;
  isPlanMode(): boolean;
  shouldAutoPush(): boolean;
  generateCommitMessage(
    message: string,
  ): Promise<import("neverthrow").Result<string, string>>;
  setPlanMode(planMode: boolean): void;
}
