import { assertEquals } from "std/assert/mod.ts";
import { err, ok } from "neverthrow";
import {
  type CodexStatusProviderLike,
  getCodexStatusWithAutoUpdate,
} from "../src/codex-status-auto-update.ts";
import type { CodexUsageStatus } from "../src/codex-status.ts";

function status(percentLeft: number): CodexUsageStatus {
  return {
    fiveHour: { percentLeft, resets: "23:57" },
    weekly: { percentLeft: 80, resets: "18:06 on 17 May" },
    capturedAt: "2026-05-13T00:00:00.000Z",
  };
}

Deno.test("getCodexStatusWithAutoUpdate: status取得成功時はupdateしない", async () => {
  let updateCalls = 0;
  const provider: CodexStatusProviderLike = {
    getStatus: () => Promise.resolve(ok(status(73))),
  };

  const result = await getCodexStatusWithAutoUpdate(
    "/tmp",
    provider,
    () => {
      updateCalls++;
      return Promise.resolve(ok({ code: 0, output: "" }));
    },
  );

  assertEquals(result.isOk(), true);
  assertEquals(result._unsafeUnwrap().fiveHour?.percentLeft, 73);
  assertEquals(updateCalls, 0);
});

Deno.test("getCodexStatusWithAutoUpdate: update通知時はupdate後に再取得する", async () => {
  let statusCalls = 0;
  let updateCalls = 0;
  const provider: CodexStatusProviderLike = {
    getStatus: () => {
      statusCalls++;
      return Promise.resolve(
        statusCalls === 1
          ? err({
            type: "UPDATE_REQUIRED" as const,
            output: "Update available!",
          })
          : ok(status(68)),
      );
    },
  };

  const result = await getCodexStatusWithAutoUpdate(
    "/tmp",
    provider,
    () => {
      updateCalls++;
      return Promise.resolve(ok({ code: 0, output: "updated" }));
    },
  );

  assertEquals(result.isOk(), true);
  assertEquals(result._unsafeUnwrap().fiveHour?.percentLeft, 68);
  assertEquals(statusCalls, 2);
  assertEquals(updateCalls, 1);
});

Deno.test("getCodexStatusWithAutoUpdate: update失敗時は再取得しない", async () => {
  let statusCalls = 0;
  const provider: CodexStatusProviderLike = {
    getStatus: () => {
      statusCalls++;
      return Promise.resolve(
        err({ type: "UPDATE_REQUIRED" as const, output: "Update available!" }),
      );
    },
  };

  const result = await getCodexStatusWithAutoUpdate(
    "/tmp",
    provider,
    () =>
      Promise.resolve(
        err({ type: "COMMAND_FAILED" as const, code: 1, output: "denied" }),
      ),
  );

  assertEquals(result.isErr(), true);
  assertEquals(result._unsafeUnwrapErr().type, "AUTO_UPDATE_FAILED");
  assertEquals(statusCalls, 1);
});
