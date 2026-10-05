import { err, ok, Result } from "neverthrow";
import {
  formatPromptWithAttachments,
  getCodexImagePaths,
  type SavedAttachment,
} from "../attachments.ts";
import type { GitRepository } from "../git-utils.ts";
import { MESSAGES } from "../constants.ts";
import {
  OUTPUT_ATTACHMENT_INSTRUCTIONS,
  parseOutputAttachments,
} from "../output-attachments.ts";
import { splitIntoDiscordChunks } from "../utils/discord-message.ts";
import { type WorkerState, WorkspaceManager } from "../workspace/workspace.ts";
import {
  asRecord,
  type CodexClient,
  CodexRpcError,
  DefaultCodexClient,
} from "./codex-executor.ts";
import { extractRateLimitTimestamp } from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";
import { SessionLogger } from "./session-logger.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import type { IWorker, MessageAttachments, WorkerError } from "./types.ts";

const DIAGNOSTIC_SECTION_LIMIT = 1800;

interface RunningTurn {
  threadId: string;
  id: string | null;
  done: PromiseWithResolvers<Record<string, unknown>>;
  finalText: string;
  raw: string;
  onProgress: (content: string) => Promise<void>;
  progress: Promise<void>;
}
interface ActiveMessage {
  phase: "starting" | "running" | "stopping" | "finalizing";
  finished: PromiseWithResolvers<void>;
  ready: PromiseWithResolvers<RunningTurn | null>;
  turn: RunningTurn | null;
  autoPush: boolean;
  cancelled: boolean;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(
      /((?:PASS(?:WORD)?|TOKEN|SECRET|COOKIE|AUTHORIZATION|API[_-]?KEY|DISCORD_TOKEN)\s*=\s*)[^\n\r]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(auth\[password\]\s*=\s*)[^\s"'&\\]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(password|passwd|token|secret|api[_-]?key)(["'\]\s:=>-]+)[^"',\s&\\]+/gi,
      "$1$2[REDACTED]",
    );
}

function truncateDiagnostic(text: string, limit = DIAGNOSTIC_SECTION_LIMIT) {
  const trimmed = redactSensitiveText(text).trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(-limit)}\n...前半を省略しました`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export class Worker implements IWorker {
  private readonly configuration: WorkerConfiguration;
  private readonly sessionLogger: SessionLogger;
  private readonly formatter = new MessageFormatter();
  private client: CodexClient | null;
  private loaded = false;
  private disposed = false;
  private active: ActiveMessage | null = null;
  private internalTurn: RunningTurn | null = null;
  private internalReady: PromiseWithResolvers<RunningTurn | null> | null = null;
  private lastExecutionSucceeded = false;
  private inputChain: Promise<void> = Promise.resolve();
  private readonly turns = new Map<string, RunningTurn>();

  constructor(
    private state: WorkerState,
    private readonly workspaceManager: WorkspaceManager,
    client?: CodexClient,
    appendSystemPrompt?: string,
  ) {
    this.configuration = new WorkerConfiguration(appendSystemPrompt);
    this.sessionLogger = new SessionLogger(workspaceManager);
    this.client = client ?? null;
    if (this.client) this.attachClient(this.client);
  }

  private attachClient(client: CodexClient): void {
    client.onNotification = (method, params) => this.receive(method, params);
    client.onFailure = (error) => {
      this.loaded = false;
      for (const turn of this.turns.values()) turn.done.reject(error);
    };
  }

  private getClient(): CodexClient {
    if (!this.client) {
      this.client = new DefaultCodexClient(this.state.worktreePath!);
      this.attachClient(this.client);
    }
    return this.client;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.inputChain.then(operation);
    this.inputChain = result.then(() => {}, () => {});
    return result;
  }

  async processMessage(
    message: string,
    attachments: MessageAttachments = [],
    onProgress: (content: string) => Promise<void> = async () => {},
    onReaction?: (emoji: string) => Promise<void>,
    onComplete?: (reply: string) => Promise<void>,
  ): Promise<Result<string | null, WorkerError>> {
    try {
      // Only preparation and RPC acceptance are serialized, never the whole running turn.
      const accepted = await this.serialize(async () => {
        if (this.active && this.active.phase !== "running") {
          await this.active.finished.promise;
        }
        if (this.disposed) throw new Error("このWorkerは終了しています。");
        if (!this.state.repository || !this.state.worktreePath) {
          this.lastExecutionSucceeded = false;
          return {
            completion: Promise.resolve(
              err<string | null, WorkerError>({ type: "REPOSITORY_NOT_SET" }),
            ),
          };
        }
        let saved: readonly SavedAttachment[];
        try {
          saved = typeof attachments === "function"
            ? await attachments()
            : attachments;
        } catch (error) {
          return {
            completion: Promise.resolve(
              err<string | null, WorkerError>({
                type: "WORKSPACE_ERROR",
                operation: "prepareAttachments",
                error: truncateDiagnostic(formatUnknownError(error)),
              }),
            ),
          };
        }
        if (this.active && this.active.phase !== "running") {
          await this.active.finished.promise;
        }
        if (this.disposed) throw new Error("このWorkerは終了しています。");
        const input = this.buildInput(message, saved);
        const current = this.active;
        if (current) {
          try {
            const accepted = await this.getClient().request("turn/steer", {
              threadId: this.state.sessionId,
              expectedTurnId: current.turn!.id,
              input,
            });
            if (accepted.turnId !== current.turn!.id) {
              throw new Error(
                "追加指示の受理先ターンを確認できませんでした。入力は自動再送しません。",
              );
            }
            await this.reportProgress(onProgress, "追加指示を受け付けました。");
            return {
              completion: Promise.resolve(ok<string | null, WorkerError>(null)),
            };
          } catch (error) {
            // Retry only an explicit rejection after the original turn has ended.
            if (
              !(error instanceof CodexRpcError) || error.code !== -32600 ||
              !/no active turn|does not have an active turn|active turn not found|expected active turn id .* but found|expected.*turn.*(?:mismatch|match)|turn.*(?:mismatch|does not match)/i
                .test(error.message)
            ) throw error;
            await current.finished.promise;
          }
        }
        this.lastExecutionSucceeded = false;
        const active: ActiveMessage = {
          phase: "starting",
          finished: Promise.withResolvers<void>(),
          ready: Promise.withResolvers<RunningTurn | null>(),
          turn: null,
          autoPush: this.state.autoPush === true && !this.isPlanMode(),
          cancelled: false,
        };
        this.active = active;
        try {
          await onReaction?.("⚙️").catch(() => {});
          await this.reportProgress(
            onProgress,
            "🤖 Codexが処理を開始しました...",
          );
          await this.ensureThread();
          active.turn = await this.startTurn(
            this.state.sessionId!,
            input,
            onProgress,
          );
          active.ready.resolve(active.turn);
          if (active.phase === "starting") active.phase = "running";
          return { completion: this.finishMessage(active, onComplete) };
        } catch (error) {
          this.release(active);
          throw error;
        }
      });
      return await accepted.completion;
    } catch (error) {
      return err(await this.executionError(error));
    }
  }

  private async ensureThread(): Promise<void> {
    if (this.loaded) return;
    const params = this.configuration.buildThreadParams(
      this.state.worktreePath!,
    );
    const response = await this.getClient().request(
      this.state.sessionId ? "thread/resume" : "thread/start",
      {
        ...params,
        ...(this.state.sessionId ? { threadId: this.state.sessionId } : {}),
      },
    );
    const id = asRecord(response.thread).id;
    if (typeof id !== "string" || !id) {
      throw new Error("Codex会話IDを取得できませんでした。");
    }
    // Keep the existing disk field; its value is Codex's thread.id, not session tree root.
    this.state.sessionId = id;
    const saved = await this.save();
    if (saved.isErr()) throw new Error("Codex会話IDを保存できませんでした。");
    this.loaded = true;
  }

  private async startTurn(
    threadId: string,
    input: Record<string, unknown>[],
    onProgress: (content: string) => Promise<void> = async () => {},
  ): Promise<RunningTurn> {
    const turn: RunningTurn = {
      threadId,
      id: null,
      done: Promise.withResolvers<Record<string, unknown>>(),
      finalText: "",
      raw: "",
      onProgress,
      progress: Promise.resolve(),
    };
    // Register before the request: notifications can precede the RPC response.
    this.turns.set(threadId, turn);
    void turn.done.promise.catch(() => {});
    try {
      const response = await this.getClient().request("turn/start", {
        threadId,
        input,
      });
      const id = asRecord(response.turn).id;
      if (typeof id !== "string" || !id) {
        throw new Error("CodexターンIDを取得できませんでした。");
      }
      if (turn.id && turn.id !== id) {
        throw new Error("CodexターンIDが一致しません。");
      }
      turn.id = id;
      return turn;
    } catch (error) {
      this.turns.delete(threadId);
      throw error;
    }
  }

  private receive(method: string, params: Record<string, unknown>): void {
    if (typeof params.threadId !== "string") return;
    const running = this.turns.get(params.threadId);
    if (!running) return;
    if (
      typeof params.turnId === "string" && running.id &&
      params.turnId !== running.id
    ) return;
    // ponytail: buffer one turn; stream logs to disk if output size becomes a problem.
    running.raw += JSON.stringify({ method, params }) + "\n";
    if (method === "turn/started" || method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (
        typeof turn.id !== "string" || (running.id && running.id !== turn.id)
      ) return;
      running.id = turn.id;
      if (method === "turn/completed") {
        if (
          this.active &&
          (running === this.active.turn ||
            (this.active.phase === "starting" &&
              running.threadId === this.state.sessionId))
        ) this.active.phase = "finalizing";
        running.done.resolve(turn);
      }
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = asRecord(params.item);
    let progress = "";
    if (item.type === "contextCompaction") {
      progress = method === "item/started"
        ? "コンテキスト圧縮を開始しました。"
        : "コンテキスト圧縮が完了しました。";
    } else if (method === "item/completed") {
      if (item.type === "agentMessage" && typeof item.text === "string") {
        progress = item.text;
        if (item.phase !== "commentary" && item.delivery !== "async") {
          running.finalText = item.text;
        }
      } else if (item.type === "commandExecution") {
        progress = String(item.aggregatedOutput ?? item.command ?? "");
      } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
        progress = item.summary.filter((text) => typeof text === "string").join(
          "\n",
        );
      } else if (item.type === "fileChange") {
        progress = "ファイルの変更を反映しました。";
      }
    }
    if (progress) {
      const text =
        parseOutputAttachments(this.formatter.formatResponse(progress)).content;
      running.progress = running.progress.then(() =>
        this.reportProgress(running.onProgress, text)
      );
    }
  }

  private async finishMessage(
    active: ActiveMessage,
    onComplete?: (reply: string) => Promise<void>,
  ): Promise<Result<string | null, WorkerError>> {
    const running = active.turn!;
    try {
      const turn = await running.done.promise;
      active.phase = "finalizing";
      await running.progress;
      await this.saveRawCodexOutput(running.raw, running.threadId);
      if (turn.status === "failed") {
        throw new Error(
          String(
            asRecord(turn.error ?? {}).message ?? "Codex実行に失敗しました。",
          ),
        );
      }
      if (turn.status !== "completed" && turn.status !== "interrupted") {
        throw new Error("Codex終了状態が不正です。");
      }
      this.lastExecutionSucceeded = turn.status === "completed" &&
        active.autoPush && !active.cancelled;
      const reply = turn.status === "interrupted"
        ? "⛔ Codex実行を中断しました。"
        : this.formatter.formatResponse(
          running.finalText.trim() || MESSAGES.NO_FINAL_RESPONSE,
        );
      await onComplete?.(reply);
      return ok(onComplete ? null : reply);
    } catch (error) {
      this.lastExecutionSucceeded = false;
      return err(await this.executionError(error, running));
    } finally {
      this.turns.delete(running.threadId);
      this.release(active);
    }
  }

  private release(active: ActiveMessage): void {
    active.ready.resolve(null);
    if (this.active === active) this.active = null;
    active.finished.resolve();
  }

  private buildInput(
    message: string,
    attachments: readonly SavedAttachment[],
  ): Record<string, unknown>[] {
    const prompt = formatPromptWithAttachments(
      [
        this.commitPrLanguageInstruction(),
        "This preference applies only to commit messages and pull request titles and descriptions. Continue replying in the conversation's language.",
        OUTPUT_ATTACHMENT_INSTRUCTIONS,
        ...(this.isPlanMode()
          ? [
            "You are in plan mode.",
            "Return an implementation plan before coding.",
            "If coding is needed, include clear ordered steps.",
          ]
          : []),
        message,
      ].join("\n\n"),
      attachments,
    );
    return [
      { type: "text", text: prompt, text_elements: [] },
      ...getCodexImagePaths(attachments).map((path) => ({
        type: "localImage",
        path,
      })),
    ];
  }

  private async reportProgress(
    onProgress: (content: string) => Promise<void>,
    content: string,
  ): Promise<void> {
    try {
      for (const chunk of splitIntoDiscordChunks(content)) {
        if (chunk.trim()) await onProgress(chunk);
      }
    } catch (error) {
      console.error("[Worker] progress callback failed", error);
    }
  }

  private async saveRawCodexOutput(
    output: string,
    sessionId?: string | null,
  ): Promise<string | null> {
    const result = await this.sessionLogger.saveRawJsonlOutput(
      this.state.repository?.fullName,
      sessionId ?? undefined,
      redactSensitiveText(output),
    );
    if (result.isErr()) {
      console.error(
        "[SessionLogger] failed to save Codex output",
        result.error,
      );
      return null;
    }
    return result.value;
  }

  private async executionError(
    error: unknown,
    running?: RunningTurn,
  ): Promise<WorkerError> {
    const detail = truncateDiagnostic(formatUnknownError(error));
    const timestamp = extractRateLimitTimestamp(detail);
    if (
      timestamp !== undefined ||
      /usage limit|rate limit|usage_limit_reached/i.test(detail)
    ) {
      return {
        type: "RATE_LIMIT",
        timestamp,
        retryAt: timestamp,
        message: detail,
      };
    }
    const log = running
      ? await this.saveRawCodexOutput(running.raw, running.threadId)
      : null;
    return {
      type: "CODEX_EXECUTION_FAILED",
      error: ["Codex実行失敗", detail, log ? `保存ログ: ${log}` : ""].filter(
        Boolean,
      ).join("\n"),
    };
  }

  async stopExecution(
    onProgress?: (content: string) => Promise<void>,
  ): Promise<boolean> {
    const active = this.active;
    if (active?.phase === "starting") await active.ready.promise;
    const internal = this.internalReady
      ? await this.internalReady.promise
      : this.internalTurn;
    const running = internal ??
      (active?.phase === "running" ? active.turn : null);
    if (!running?.id) return false;
    if (active) {
      active.phase = "stopping";
      active.cancelled = true;
    }
    this.lastExecutionSucceeded = false;
    try {
      await this.getClient().request("turn/interrupt", {
        threadId: running.threadId,
        turnId: running.id,
      });
    } catch (error) {
      if (
        !(error instanceof CodexRpcError) || error.code !== -32600 ||
        !/no active turn|does not have an active turn|active turn not found/i
          .test(error.message)
      ) throw error;
    }
    await running.done.promise;
    if (onProgress) {
      await this.reportProgress(onProgress, "⛔ Codex実行を中断しました。");
    }
    return true;
  }

  async close(): Promise<void> {
    this.disposed = true;
    try {
      await this.stopExecution();
      if (this.active) await this.active.finished.promise;
      await this.inputChain;
    } finally {
      await this.client?.close();
    }
  }

  getName(): string {
    return this.state.workerName;
  }

  getRepository(): GitRepository | null {
    if (!this.state.repository) return null;
    return {
      ...this.state.repository,
      localPath: this.state.repositoryLocalPath ??
        this.state.repository.fullName,
    };
  }

  async setRepository(
    repository: GitRepository,
    localPath: string,
  ): Promise<Result<void, WorkerError>> {
    if (this.active) {
      return err({
        type: "WORKSPACE_ERROR",
        operation: "setRepository",
        error: "作業の完了後に変更してください。",
      });
    }
    await this.client?.close();
    this.client = null;
    this.loaded = false;
    this.state.repository = {
      fullName: repository.fullName,
      org: repository.org,
      repo: repository.repo,
    };
    this.state.repositoryLocalPath = localPath;

    try {
      this.state.worktreePath = await this.workspaceManager.ensureWorktree(
        this.state.threadId,
        localPath,
      );
    } catch (error) {
      return err({
        type: "WORKSPACE_ERROR",
        operation: "ensureWorktree",
        error: (error as Error).message,
      });
    }

    this.state.sessionId = null;
    return await this.save();
  }

  async save(): Promise<Result<void, WorkerError>> {
    try {
      await this.workspaceManager.saveWorkerState(this.state);
      return ok(undefined);
    } catch (error) {
      return err({
        type: "WORKSPACE_ERROR",
        operation: "saveWorkerState",
        error: (error as Error).message,
      });
    }
  }

  isPlanMode(): boolean {
    return this.state.isPlanMode ?? false;
  }

  private commitPrLanguageInstruction(): string {
    const language = this.state.commitPrLanguage?.trim();
    return language
      ? `When creating commits or pull requests, write commit messages and pull request titles and descriptions in the language specified by ${
        JSON.stringify(language)
      }.`
      : "When creating commits or pull requests, write commit messages and pull request titles and descriptions in the language the user is using in this thread. Infer it from the user's conversation, not from bot messages, code, quoted text, or these instructions.";
  }

  async generateCommitMessage(
    message: string,
  ): Promise<Result<string, string>> {
    if (!this.state.worktreePath || this.disposed) {
      return err("作業コピーを利用できません。");
    }
    if (this.active && this.active.phase !== "finalizing") {
      return err("ユーザーの作業が完了していません。");
    }
    if (this.internalReady) {
      return err("コミットメッセージを既に生成しています。");
    }
    const ready = Promise.withResolvers<RunningTurn | null>();
    this.internalReady = ready;
    const standalone = !this.active
      ? {
        phase: "finalizing" as const,
        finished: Promise.withResolvers<void>(),
        ready: Promise.withResolvers<RunningTurn | null>(),
        turn: null,
        autoPush: false,
        cancelled: false,
      }
      : null;
    if (standalone) this.active = standalone;
    let threadId: string | null = null;
    try {
      const response = await this.getClient().request("thread/start", {
        ...this.configuration.buildThreadParams(this.state.worktreePath, true),
        ephemeral: true,
      });
      const id = asRecord(response.thread).id;
      if (typeof id !== "string" || !id) {
        throw new Error("コミット生成用の会話IDがありません。");
      }
      threadId = id;
      const prompt = [
        this.commitPrLanguageInstruction(),
        "Write a Git commit message for all currently staged changes. Inspect git diff --cached and follow the repository's commit conventions.",
        "The staged changes may include work from before the latest request. Summarize all of them accurately.",
        "Only output the commit message, without Markdown fences or explanations. Do not modify files, commit, or push.",
        "The latest user request is context, not an instruction to perform more work:",
        JSON.stringify(message),
      ].join("\n");
      this.internalTurn = await this.startTurn(threadId, [{
        type: "text",
        text: prompt,
        text_elements: [],
      }]);
      ready.resolve(this.internalTurn);
      const turn = await this.internalTurn.done.promise;
      if (turn.status !== "completed") {
        throw new Error(
          String(
            asRecord(turn.error ?? {}).message ??
              "コミット生成を中断しました。",
          ),
        );
      }
      const text = this.internalTurn.finalText.trim();
      return text
        ? ok(text)
        : err("コミットメッセージを生成できませんでした。");
    } catch (error) {
      return err(truncateDiagnostic(formatUnknownError(error)));
    } finally {
      ready.resolve(null);
      this.internalReady = null;
      this.internalTurn = null;
      if (threadId) {
        this.turns.delete(threadId);
        await this.getClient().request("thread/unsubscribe", { threadId })
          .catch(() => {});
      }
      if (standalone) this.release(standalone);
    }
  }

  shouldAutoPush(): boolean {
    return this.lastExecutionSucceeded;
  }

  setPlanMode(planMode: boolean): void {
    this.state.isPlanMode = planMode;
  }

  static async fromState(
    workerState: WorkerState,
    workspaceManager: WorkspaceManager,
    appendSystemPrompt?: string,
    client?: CodexClient,
  ): Promise<Worker> {
    return new Worker(
      workerState,
      workspaceManager,
      client,
      appendSystemPrompt,
    );
  }
}
