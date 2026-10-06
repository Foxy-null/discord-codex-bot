import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { err, ok } from "neverthrow";
import {
  commitAndPushWorktreeBranch,
  generateBranchName,
  parseRepository,
  renameInitialBranch,
} from "../src/git-utils.ts";

Deno.test("parseRepository: owner/repo を解析できる", () => {
  const parsed = parseRepository("octocat/hello-world");
  if (parsed.isErr()) {
    throw new Error("parse failed");
  }
  assertEquals(parsed.value.org, "octocat");
  assertEquals(parsed.value.repo, "hello-world");
});

Deno.test("commitAndPushWorktreeBranch: 全変更をコミットしてoriginへ送り、失敗時も保持する", async () => {
  const dir = await Deno.makeTempDir();
  const remote = `${dir}/origin.git`;
  const seed = `${dir}/seed`;
  const worktree = `${dir}/worktree`;
  const run = async (cwd: string, args: string[]) => {
    const output = await new Deno.Command("git", { cwd, args }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
  };
  let generationCount = 0;
  const commitMessage =
    "✨ 既存の変更と新しい変更をまとめる\n\n`引用`と$(文字列)を保持する";
  const generate = () => {
    generationCount++;
    return Promise.resolve(ok(commitMessage));
  };
  try {
    await run(dir, ["init", "--bare", "-b", "main", remote]);
    await run(dir, ["init", "-b", "main", seed]);
    await run(seed, ["config", "user.name", "Test"]);
    await run(seed, ["config", "user.email", "test@example.com"]);
    await run(seed, ["commit", "--allow-empty", "-m", "initial"]);
    await run(seed, ["remote", "add", "origin", remote]);
    await run(seed, ["push", "origin", "main"]);
    const initialHead = await run(seed, ["rev-parse", "HEAD"]);
    await run(dir, ["clone", remote, worktree]);
    await run(worktree, ["config", "user.name", "Test"]);
    await run(worktree, ["config", "user.email", "test@example.com"]);
    // The inherited push defaults must not redirect or publish other branches.
    await run(worktree, ["remote", "add", "upstream", `${dir}/missing.git`]);
    await run(worktree, ["config", "remote.pushDefault", "upstream"]);
    await run(worktree, ["config", "remote.origin.push", "main"]);
    await run(worktree, ["config", "push.default", "matching"]);
    const workerBranch = "worker/2026-10-03/worker-120000-test-bot";
    await run(worktree, ["checkout", "-b", workerBranch]);

    const unchanged = (await commitAndPushWorktreeBranch(worktree, generate))
      ._unsafeUnwrap();
    assertEquals(unchanged, {
      branch: null,
      commitMessage: null,
      hasUncommittedChanges: false,
    });
    assertEquals(generationCount, 0);
    assertEquals(
      await run(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]),
      "refs/heads/main",
    );

    await Deno.writeTextFile(`${worktree}/committed.txt`, "committed");
    await Deno.writeTextFile(`${worktree}/deleted.txt`, "delete later");
    await Deno.writeTextFile(`${worktree}/.gitignore`, "*.ignored\n");
    await run(worktree, ["add", "--all"]);
    await run(worktree, ["commit", "-m", "feature"]);
    const featureHead = await run(worktree, ["rev-parse", "HEAD"]);
    const branch = "feat/auto-push";
    const renamed = (await renameInitialBranch(
      worktree,
      "test-bot",
      branch,
      "123456789",
    ))._unsafeUnwrap();
    assertEquals(renamed, branch);
    await Deno.writeTextFile(`${worktree}/committed.txt`, "modified");
    await Deno.writeTextFile(`${worktree}/uncommitted.txt`, "untracked");
    await Deno.writeTextFile(`${worktree}/staged.txt`, "staged");
    await run(worktree, ["add", "staged.txt"]);
    await Deno.remove(`${worktree}/deleted.txt`);
    await Deno.writeTextFile(`${worktree}/private.ignored`, "ignored");

    const result = (await commitAndPushWorktreeBranch(worktree, async () => {
      assertStringIncludes(
        await run(worktree, ["diff", "--cached", "--name-only"]),
        "uncommitted.txt",
      );
      return await generate();
    }))._unsafeUnwrap();
    assertEquals(result, {
      branch,
      commitMessage,
      hasUncommittedChanges: false,
    });
    assertEquals(generationCount, 1);
    const committedHead = await run(worktree, ["rev-parse", "HEAD"]);
    assertEquals(await run(worktree, ["rev-parse", "HEAD^"]), featureHead);
    assertEquals(
      await run(worktree, ["log", "-1", "--format=%B"]),
      commitMessage,
    );
    assertEquals(
      await run(remote, ["rev-parse", `refs/heads/${branch}`]),
      committedHead,
    );
    assertEquals(
      await run(remote, ["rev-parse", "refs/heads/main"]),
      initialHead,
    );
    assertEquals(
      await run(remote, ["show", `${branch}:committed.txt`]),
      "modified",
    );
    assertEquals(await run(remote, ["show", `${branch}:staged.txt`]), "staged");
    assertEquals(
      await run(remote, ["show", `${branch}:uncommitted.txt`]),
      "untracked",
    );
    assertEquals(
      await run(remote, [
        "ls-tree",
        "--name-only",
        branch,
        "deleted.txt",
        "private.ignored",
      ]),
      "",
    );
    assertEquals(await run(worktree, ["status", "--porcelain"]), "");
    assertEquals(
      await run(worktree, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
      `origin/${branch}`,
    );
    assertEquals(
      await run(remote, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${workerBranch}`,
      ]),
      "",
    );

    // Already committed work is pushed without another commit or generation.
    await run(worktree, ["commit", "--allow-empty", "-m", "manual commit"]);
    const manualHead = await run(worktree, ["rev-parse", "HEAD"]);
    const pushedOnly = (await commitAndPushWorktreeBranch(worktree, generate))
      ._unsafeUnwrap();
    assertEquals(pushedOnly.commitMessage, null);
    assertEquals(generationCount, 1);
    assertEquals(
      await run(remote, ["rev-parse", `refs/heads/${branch}`]),
      manualHead,
    );
    await commitAndPushWorktreeBranch(worktree, generate);
    assertEquals(await run(worktree, ["rev-parse", "HEAD"]), manualHead);
    assertEquals(generationCount, 1);

    // Generation and commit-hook failures never push or discard the changes.
    await run(worktree, ["config", "status.showUntrackedFiles", "no"]);
    await Deno.writeTextFile(`${worktree}/pending.txt`, "pending");
    for (const message of [err("generation failed"), ok("   ")]) {
      assertEquals(
        (await commitAndPushWorktreeBranch(
          worktree,
          () => Promise.resolve(message),
        )).isErr(),
        true,
      );
      assertEquals(await run(worktree, ["rev-parse", "HEAD"]), manualHead);
      assertEquals(
        await run(remote, ["rev-parse", `refs/heads/${branch}`]),
        manualHead,
      );
      assertEquals(
        await Deno.readTextFile(`${worktree}/pending.txt`),
        "pending",
      );
    }
    await run(worktree, ["config", "--unset", "status.showUntrackedFiles"]);
    const hooks = `${dir}/hooks`;
    await Deno.mkdir(hooks);
    await Deno.writeTextFile(`${hooks}/pre-commit`, "#!/bin/sh\nexit 1\n");
    await Deno.chmod(`${hooks}/pre-commit`, 0o755);
    await run(worktree, ["config", "core.hooksPath", hooks]);
    const failedCommit = (await commitAndPushWorktreeBranch(worktree, generate))
      ._unsafeUnwrapErr();
    assertEquals(failedCommit.type, "COMMAND_EXECUTION_FAILED");
    if (failedCommit.type === "COMMAND_EXECUTION_FAILED") {
      assertEquals(failedCommit.command, "git commit");
    }
    assertEquals(await run(worktree, ["rev-parse", "HEAD"]), manualHead);
    assertEquals(
      await run(remote, ["rev-parse", `refs/heads/${branch}`]),
      manualHead,
    );
    assertStringIncludes(
      await run(worktree, ["status", "--porcelain"]),
      "pending.txt",
    );
    await run(worktree, ["config", "--unset", "core.hooksPath"]);

    // Advance the remote on a sibling commit to exercise non-fast-forward rejection.
    await run(seed, ["fetch", "origin", `${branch}`]);
    await run(seed, ["checkout", "-b", branch, "FETCH_HEAD"]);
    await run(seed, ["commit", "--allow-empty", "-m", "remote change"]);
    await run(seed, ["push", "origin", branch]);
    const remoteHead = await run(seed, ["rev-parse", "HEAD"]);
    const rejectedPush = (await commitAndPushWorktreeBranch(worktree, generate))
      ._unsafeUnwrapErr();
    if (rejectedPush.type === "COMMAND_EXECUTION_FAILED") {
      assertEquals(rejectedPush.command, "git push --set-upstream origin HEAD");
    }
    const localHead = await run(worktree, ["rev-parse", "HEAD"]);
    assertEquals(localHead === manualHead, false);
    assertEquals(
      await run(remote, ["rev-parse", `refs/heads/${branch}`]),
      remoteHead,
    );
    assertEquals(await run(worktree, ["rev-parse", "HEAD"]), localHead);
    assertEquals(await run(worktree, ["status", "--porcelain"]), "");
    assertEquals(await run(worktree, ["show", "HEAD:pending.txt"]), "pending");

    // An unresolved merge is rejected before git add can mark it resolved.
    await run(worktree, ["checkout", "-b", "conflict-source"]);
    await Deno.writeTextFile(`${worktree}/committed.txt`, "source");
    await run(worktree, ["add", "--all"]);
    await run(worktree, ["commit", "-m", "source"]);
    await run(worktree, ["checkout", branch]);
    await Deno.writeTextFile(`${worktree}/committed.txt`, "target");
    await run(worktree, ["add", "--all"]);
    await run(worktree, ["commit", "-m", "target"]);
    const merge = await new Deno.Command("git", {
      cwd: worktree,
      args: ["merge", "conflict-source"],
    }).output();
    assertEquals(merge.code, 1);
    const unmergedStatus = await run(worktree, ["status", "--porcelain"]);
    const countBeforeConflict = generationCount;
    assertEquals(
      (await commitAndPushWorktreeBranch(worktree, generate)).isErr(),
      true,
    );
    assertEquals(
      await run(worktree, ["status", "--porcelain"]),
      unmergedStatus,
    );
    assertEquals(generationCount, countBeforeConflict);
    await run(worktree, ["merge", "--abort"]);

    await run(worktree, ["checkout", "main"]);
    await Deno.writeTextFile(`${worktree}/protected.txt`, "do not stage");
    const protectedStatus = await run(worktree, ["status", "--porcelain"]);
    for (const protectedName of ["main", "master", "trunk"]) {
      if (protectedName !== "main") {
        await run(worktree, ["checkout", "-b", protectedName]);
      }
      if (protectedName === "trunk") {
        await run(worktree, [
          "update-ref",
          "refs/remotes/origin/trunk",
          initialHead,
        ]);
        await run(worktree, [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/trunk",
        ]);
      }
      const protectedBranch =
        (await commitAndPushWorktreeBranch(worktree, generate))
          ._unsafeUnwrapErr();
      assertEquals(protectedBranch.type, "COMMAND_EXECUTION_FAILED");
      if (protectedBranch.type === "COMMAND_EXECUTION_FAILED") {
        assertStringIncludes(protectedBranch.error, "既定ブランチ");
      }
      assertEquals(await run(worktree, ["rev-parse", "HEAD"]), initialHead);
      assertEquals(
        await run(worktree, ["status", "--porcelain"]),
        protectedStatus,
      );
      assertEquals(generationCount, countBeforeConflict);
    }
    assertEquals(
      await run(remote, ["rev-parse", "refs/heads/main"]),
      initialHead,
    );

    await run(worktree, ["checkout", "--detach", initialHead]);
    assertEquals(
      (await commitAndPushWorktreeBranch(worktree, generate)).isErr(),
      true,
    );
    assertEquals(
      await run(worktree, ["status", "--porcelain"]),
      protectedStatus,
    );
    assertEquals(generationCount, countBeforeConflict);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateBranchName: workerプレフィックスを含む", () => {
  const name = generateBranchName("test-bot");
  assertEquals(name.startsWith("worker/"), true);
  assertEquals(name.includes("test-bot"), true);
});

Deno.test("renameInitialBranch: 初期workerブランチだけを変更する", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = (args: string[]) =>
      new Deno.Command("git", { args, cwd: dir }).output();
    await run(["init", "-b", "worker/2026-08-13/worker-120000-test-bot"]);
    await run(["config", "user.name", "Test"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["commit", "--allow-empty", "-m", "initial"]);
    await run(["branch", "feat/clear-purpose"]);
    const result = await renameInitialBranch(
      dir,
      "test-bot",
      "feat/clear-purpose",
      "123456789",
    );
    assertEquals(result._unsafeUnwrap(), "feat/clear-purpose-12345678");
    const current = await new Deno.Command("git", {
      args: ["branch", "--show-current"],
      cwd: dir,
      stdout: "piped",
    }).output();
    assertEquals(
      new TextDecoder().decode(current.stdout).trim(),
      "feat/clear-purpose-12345678",
    );

    const skipped = await renameInitialBranch(
      dir,
      "test-bot",
      "fix/do-not-overwrite",
      "123456789",
    );
    assertEquals(skipped._unsafeUnwrap(), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
