import { err, ok, Result } from "neverthrow";
import type { CodexStatusError, CodexUsageStatus } from "./codex-status.ts";
import type { CodexUpdateError, CodexUpdateResult } from "./codex-update.ts";

export type CodexStatusWithAutoUpdateError =
  | CodexStatusError
  | {
    type: "AUTO_UPDATE_FAILED";
    statusError: Extract<CodexStatusError, { type: "UPDATE_REQUIRED" }>;
    updateError: CodexUpdateError;
  };

export interface CodexStatusProviderLike {
  getStatus(
    cwd: string,
  ): Promise<Result<CodexUsageStatus, CodexStatusError>>;
}

export type CodexUpdateRunner = () => Promise<
  Result<CodexUpdateResult, CodexUpdateError>
>;

export async function getCodexStatusWithAutoUpdate(
  cwd: string,
  provider: CodexStatusProviderLike,
  updateCodexCli: CodexUpdateRunner,
): Promise<Result<CodexUsageStatus, CodexStatusWithAutoUpdateError>> {
  const first = await provider.getStatus(cwd);
  if (first.isOk()) {
    return ok(first.value);
  }
  if (first.error.type !== "UPDATE_REQUIRED") {
    return err(first.error);
  }

  const updateResult = await updateCodexCli();
  if (updateResult.isErr()) {
    return err({
      type: "AUTO_UPDATE_FAILED",
      statusError: first.error,
      updateError: updateResult.error,
    });
  }

  const retry = await provider.getStatus(cwd);
  return retry.isOk() ? ok(retry.value) : err(retry.error);
}
