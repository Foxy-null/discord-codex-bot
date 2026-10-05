import { assert } from "std/assert/mod.ts";
import type { CodexClient } from "../../src/worker/codex-executor.ts";

export class FakeCodexClient implements CodexClient {
  onNotification = (_method: string, _params: Record<string, unknown>) => {};
  onFailure = (_error: Error) => {};
  calls: { method: string; params: Record<string, unknown> }[] = [];
  closed = false;
  autoComplete = true;
  text = "回答";
  status = "completed";
  hook?: (
    method: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>;
  private threads = 0;
  private turnIds = new Map<string, string>();

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    await this.hook?.(method, params);
    if (method === "thread/start") {
      return {
        thread: {
          id: `${params.ephemeral ? "internal" : "thread"}-${++this.threads}`,
        },
      };
    }
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      const id = `turn-${this.calls.length}`;
      this.turnIds.set(threadId, id);
      this.onNotification("turn/started", {
        threadId,
        turn: { id, status: "inProgress" },
      });
      if (this.autoComplete) this.complete(threadId, this.text, this.status);
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      this.complete(String(params.threadId), "", "interrupted");
    }
    if (method === "turn/steer") {
      return { turnId: this.turnIds.get(String(params.threadId)) };
    }
    return {};
  }

  complete(threadId: string, text = this.text, status = this.status): void {
    const id = this.turnIds.get(threadId)!;
    this.onNotification("item/completed", {
      threadId,
      turnId: id,
      item: { id: "answer", type: "agentMessage", phase: "final_answer", text },
    });
    this.finish(threadId, status, text);
  }

  finish(threadId: string, status = "completed", text = ""): void {
    this.onNotification("turn/completed", {
      threadId,
      turn: {
        id: this.turnIds.get(threadId),
        status,
        error: status === "failed" ? { message: text } : null,
      },
    });
  }

  async waitFor(
    method: string,
    count = 1,
  ): Promise<{ method: string; params: Record<string, unknown> }> {
    const deadline = Date.now() + 3000;
    while (
      this.calls.filter((call) => call.method === method).length < count &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const call = this.calls.filter((call) => call.method === method)[count - 1];
    assert(call, `${method} was not called ${count} times`);
    return call;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
