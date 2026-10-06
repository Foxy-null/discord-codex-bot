import { TextLineStream } from "std/streams/text_line_stream.ts";
import { CODEX, PROCESS } from "../constants.ts";

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codexから不正な応答を受信しました。");
  }
  return value as Record<string, unknown>;
}

export class CodexRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export interface CodexClient {
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onFailure: (error: Error) => void;
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DefaultCodexClient implements CodexClient {
  onNotification = (_method: string, _params: Record<string, unknown>) => {};
  onFailure = (_error: Error) => {};
  private process: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ready: Promise<void> | null = null;
  private readers: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  private nextId = 0;
  private stderr = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly cwd: string) {}

  async request(method: string, params: Record<string, unknown>) {
    if (this.closed) throw new Error("Codex接続は終了しています。");
    // A new request may reconnect; a request with an unknown outcome is never replayed.
    if (this.failure) {
      await this.stopProcess();
      this.ready = null;
      this.failure = null;
    }
    this.ready ??= this.open();
    await this.ready;
    return await this.sendRequest(method, params);
  }

  private async open(): Promise<void> {
    this.stderr = "";
    this.writes = Promise.resolve();
    const child = new Deno.Command(CODEX.COMMAND, {
      args: ["app-server", "--listen", "stdio://"],
      cwd: this.cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.process = child;
    this.writer = child.stdin.getWriter();
    const stdout = (async () => {
      for await (
        const line of child.stdout.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream())
      ) {
        if (line.trim()) this.receive(asRecord(JSON.parse(line)));
      }
    })();
    const stderr = (async () => {
      for await (
        const text of child.stderr.pipeThrough(new TextDecoderStream())
      ) {
        this.stderr = (this.stderr + text).slice(-5000);
      }
    })();
    this.readers = Promise.all([stdout, stderr, child.status]).then(() => {
      this.fail(
        new Error(
          `Codex接続が終了しました。${this.stderr ? "\n" + this.stderr : ""}`,
        ),
      );
    }).catch((error) =>
      this.fail(error instanceof Error ? error : new Error(String(error)))
    );
    try {
      await this.sendRequest("initialize", {
        clientInfo: {
          name: "discord_codex_bot",
          title: "Discord Codex Bot",
          version: "1.0.0",
        },
      });
      await this.write({ method: "initialized" });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            `Codex ${method} の応答を確認できませんでした。入力は自動再送しません。`,
          ),
        );
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch((error) =>
        this.fail(error)
      );
    });
  }

  private write(message: Record<string, unknown>): Promise<void> {
    this.writes = this.writes.then(async () => {
      if (!this.writer) throw new Error("Codex接続がありません。");
      await this.writer.write(
        new TextEncoder().encode(JSON.stringify(message) + "\n"),
      );
    });
    return this.writes;
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        // Approval is disabled. Interactive requests must fail explicitly, never hang.
        void this.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Discord Bot does not support ${message.method}`,
          },
        }).catch((error) => this.fail(error));
      } else {
        this.onNotification(message.method, asRecord(message.params ?? {}));
      }
      return;
    }
    if (typeof message.id !== "number") {
      throw new Error("Codex応答に要求IDがありません。");
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    try {
      if (message.error !== undefined) {
        const error = asRecord(message.error);
        pending.reject(
          new CodexRpcError(
            typeof error.code === "number" ? error.code : -32603,
            String(error.message ?? "Codex RPC failed"),
          ),
        );
      } else {
        pending.resolve(asRecord(message.result));
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
    try {
      this.process?.kill("SIGTERM");
    } catch { /* already exited */ }
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, PROCESS.TERMINATION_TIMEOUT_MS);
    try {
      await child.status;
      await this.readers;
    } finally {
      clearTimeout(timer);
      await this.writer?.close().catch(() => {});
      this.writer?.releaseLock();
      this.writer = null;
      this.process = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.fail(new Error("Codex接続を終了しました。"));
    await this.stopProcess();
  }
}
