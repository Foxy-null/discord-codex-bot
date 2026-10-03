import { join } from "std/path/mod.ts";
import { err, ok, Result } from "neverthrow";
import { exec } from "./utils/exec.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";

export type GitUtilsError =
  | { type: "INVALID_REPOSITORY_NAME"; message: string }
  | { type: "CLONE_FAILED"; error: string }
  | { type: "UPDATE_FAILED"; error: string }
  | { type: "WORKTREE_CREATE_FAILED"; error: string }
  | { type: "COMMAND_EXECUTION_FAILED"; command: string; error: string };

export interface GitRepository {
  org: string;
  repo: string;
  fullName: string;
  localPath: string;
}

export interface RepoSetupResult {
  path: string;
  wasUpdated: boolean;
}

export function parseRepository(
  repoSpec: string,
): Result<GitRepository, GitUtilsError> {
  const match = repoSpec.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (!match) {
    return err({
      type: "INVALID_REPOSITORY_NAME",
      message: "リポジトリ名は <org>/<repo> 形式で指定してください",
    });
  }

  const [, org, repo] = match;
  return ok({
    org,
    repo,
    fullName: `${org}/${repo}`,
    localPath: join(org, repo),
  });
}

export async function ensureRepository(
  repository: GitRepository,
  workspaceManager: WorkspaceManager,
): Promise<Result<RepoSetupResult, GitUtilsError>> {
  const fullPath = workspaceManager.getRepositoryPath(
    repository.org,
    repository.repo,
  );

  const exists = await directoryExists(fullPath);
  if (exists) {
    const updateResult = await updateRepository(fullPath);
    if (updateResult.isErr()) {
      return err(updateResult.error);
    }
    return ok({ path: fullPath, wasUpdated: true });
  }

  await Deno.mkdir(
    join(workspaceManager.getRepositoriesDir(), repository.org),
    {
      recursive: true,
    },
  );

  const cloneResult = await exec(
    `git clone https://github.com/${repository.fullName}.git "${fullPath}"`,
  );
  if (cloneResult.isErr()) {
    return err({
      type: "CLONE_FAILED",
      error: cloneResult.error.error || cloneResult.error.message,
    });
  }

  return ok({ path: fullPath, wasUpdated: false });
}

async function updateRepository(
  repoPath: string,
): Promise<Result<void, GitUtilsError>> {
  const fetch = await exec(`cd "${repoPath}" && git fetch --all --prune`);
  if (fetch.isErr()) {
    return err({
      type: "UPDATE_FAILED",
      error: fetch.error.error || fetch.error.message,
    });
  }

  const defaultBranchResult = await exec(
    `cd "${repoPath}" && git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`,
  );
  const defaultBranch = defaultBranchResult.isOk() &&
      defaultBranchResult.value.output.trim()
    ? defaultBranchResult.value.output.trim()
    : "main";

  const checkout = await exec(
    `cd "${repoPath}" && git checkout ${defaultBranch}`,
  );
  if (checkout.isErr()) {
    return err({
      type: "UPDATE_FAILED",
      error: checkout.error.error || checkout.error.message,
    });
  }

  const reset = await exec(
    `cd "${repoPath}" && git reset --hard origin/${defaultBranch}`,
  );
  if (reset.isErr()) {
    return err({
      type: "UPDATE_FAILED",
      error: reset.error.error || reset.error.message,
    });
  }
  return ok(undefined);
}

export async function isWorktreeCopyExists(
  worktreePath: string,
): Promise<boolean> {
  return await directoryExists(worktreePath);
}

export function generateBranchName(workerName: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `worker/${date}/worker-${hh}${mm}${ss}-${workerName}`;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

export async function renameInitialBranch(
  worktreePath: string,
  workerName: string,
  desiredBranch: string,
  collisionSuffix: string,
): Promise<Result<string | null, GitUtilsError>> {
  const current = await runGit(worktreePath, ["branch", "--show-current"]);
  if (current.code !== 0) {
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git branch --show-current",
      error: current.stderr,
    });
  }
  if (
    !new RegExp(
      `^worker/\\d{4}-\\d{2}-\\d{2}/worker-\\d{6}-${workerName}$`,
    ).test(current.stdout)
  ) {
    return ok(null);
  }

  const valid = await runGit(worktreePath, [
    "check-ref-format",
    "--branch",
    desiredBranch,
  ]);
  if (valid.code !== 0) {
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git check-ref-format --branch",
      error: valid.stderr,
    });
  }

  const exists = await runGit(worktreePath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${desiredBranch}`,
  ]);
  const branchName = exists.code === 0
    ? `${desiredBranch}-${collisionSuffix.slice(0, 8)}`
    : desiredBranch;
  const renamed = await runGit(worktreePath, ["branch", "-m", branchName]);
  if (renamed.code !== 0) {
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git branch -m",
      error: renamed.stderr,
    });
  }
  return ok(branchName);
}

export interface PushWorktreeResult {
  branch: string | null;
  hasUncommittedChanges: boolean;
}

export async function pushWorktreeBranch(
  worktreePath: string,
): Promise<Result<PushWorktreeResult, GitUtilsError>> {
  let command = "git symbolic-ref HEAD";
  try {
    const current = await runGit(worktreePath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (current.code !== 0) {
      throw new Error(current.stderr || "作業ブランチを取得できませんでした。");
    }
    const branch = current.stdout;

    command = "git symbolic-ref refs/remotes/origin/HEAD";
    const defaultRef = await runGit(worktreePath, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    if (defaultRef.code !== 0) {
      throw new Error(
        defaultRef.stderr || "originの既定ブランチを取得できませんでした。",
      );
    }
    if (
      branch === "main" || branch === "master" ||
      defaultRef.stdout === `refs/remotes/origin/${branch}`
    ) {
      throw new Error(`既定ブランチへの自動プッシュは行いません: ${branch}`);
    }

    command = "git status --porcelain";
    const status = await runGit(worktreePath, ["status", "--porcelain"]);
    if (status.code !== 0) throw new Error(status.stderr);
    const hasUncommittedChanges = status.stdout.length > 0;

    command = "git rev-list --count origin/HEAD..HEAD";
    const ahead = await runGit(worktreePath, [
      "rev-list",
      "--count",
      `${defaultRef.stdout}..HEAD`,
      "--",
    ]);
    if (ahead.code !== 0) throw new Error(ahead.stderr);
    if (ahead.stdout === "0") {
      return ok({ branch: null, hasUncommittedChanges });
    }

    command = "git push --set-upstream origin HEAD";
    const pushed = await runGit(worktreePath, [
      "push",
      "--set-upstream",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ]);
    if (pushed.code !== 0) throw new Error(pushed.stderr);
    return ok({ branch, hasUncommittedChanges });
  } catch (error) {
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createWorktreeCopy(
  repositoryPath: string,
  workerName: string,
  worktreePath: string,
): Promise<Result<void, GitUtilsError>> {
  await Deno.mkdir(worktreePath, { recursive: true });
  const rsync = await exec(`rsync -a "${repositoryPath}/" "${worktreePath}/"`);
  if (rsync.isErr()) {
    return err({
      type: "WORKTREE_CREATE_FAILED",
      error: rsync.error.error || rsync.error.message,
    });
  }

  const branchName = generateBranchName(workerName);
  const createBranch = await exec(
    `cd "${worktreePath}" && git checkout -b ${branchName}`,
  );

  if (createBranch.isErr()) {
    // テストや.gitが無いケース向けに最小初期化
    const init = await exec(`cd "${worktreePath}" && git init`);
    if (init.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: init.error.error || init.error.message,
      });
    }
    await exec(`cd "${worktreePath}" && git config user.name "Discord Bot"`);
    await exec(
      `cd "${worktreePath}" && git config user.email "bot@example.com"`,
    );
    await exec(`cd "${worktreePath}" && git add .`);
    await exec(
      `cd "${worktreePath}" && git commit -m "Initial worktree copy for ${workerName}" || true`,
    );
    const rename = await exec(
      `cd "${worktreePath}" && git branch -m ${branchName}`,
    );
    if (rename.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: rename.error.error || rename.error.message,
      });
    }
  }

  return ok(undefined);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}
