import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import {
  generateBranchName,
  parseRepository,
  pushWorktreeBranch,
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

Deno.test("pushWorktreeBranch: 改名後のコミットだけをoriginへ送り、強制上書きしない", async () => {
  const dir = await Deno.makeTempDir();
  const remote = `${dir}/origin.git`;
  const seed = `${dir}/seed`;
  const worktree = `${dir}/worktree`;
  const run = async (cwd: string, args: string[]) => {
    const output = await new Deno.Command("git", { cwd, args }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
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

    const unchanged = (await pushWorktreeBranch(worktree))._unsafeUnwrap();
    assertEquals(unchanged, { branch: null, hasUncommittedChanges: false });
    assertEquals(
      await run(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]),
      "refs/heads/main",
    );

    await Deno.writeTextFile(`${worktree}/committed.txt`, "committed");
    await run(worktree, ["add", "committed.txt"]);
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
    const statusBefore = await run(worktree, ["status", "--porcelain"]);

    const result = (await pushWorktreeBranch(worktree))._unsafeUnwrap();
    assertEquals(result, { branch, hasUncommittedChanges: true });
    assertEquals(
      await run(remote, ["rev-parse", `refs/heads/${branch}`]),
      featureHead,
    );
    assertEquals(
      await run(remote, ["rev-parse", "refs/heads/main"]),
      initialHead,
    );
    assertEquals(
      await run(remote, ["show", `${branch}:committed.txt`]),
      "committed",
    );
    assertEquals(await run(worktree, ["status", "--porcelain"]), statusBefore);
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

    // Advance the remote on a sibling commit to exercise non-fast-forward rejection.
    await run(seed, ["fetch", "origin", `${branch}`]);
    await run(seed, ["checkout", "-b", branch, "FETCH_HEAD"]);
    await run(seed, ["commit", "--allow-empty", "-m", "remote change"]);
    await run(seed, ["push", "origin", branch]);
    const remoteHead = await run(seed, ["rev-parse", "HEAD"]);
    await run(worktree, [
      "commit",
      "--allow-empty",
      "--only",
      "-m",
      "local change",
    ]);
    const localHead = await run(worktree, ["rev-parse", "HEAD"]);
    assertEquals((await pushWorktreeBranch(worktree)).isErr(), true);
    assertEquals(
      await run(remote, ["rev-parse", `refs/heads/${branch}`]),
      remoteHead,
    );
    assertEquals(await run(worktree, ["rev-parse", "HEAD"]), localHead);
    assertEquals(await run(worktree, ["status", "--porcelain"]), statusBefore);

    await run(worktree, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const protectedBranch = (await pushWorktreeBranch(worktree))
      ._unsafeUnwrapErr();
    assertEquals(protectedBranch.type, "COMMAND_EXECUTION_FAILED");
    if (protectedBranch.type === "COMMAND_EXECUTION_FAILED") {
      assertStringIncludes(protectedBranch.error, "既定ブランチ");
    }
    assertEquals(
      await run(remote, ["rev-parse", "refs/heads/main"]),
      initialHead,
    );

    await run(worktree, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    await run(worktree, ["update-ref", "--no-deref", "HEAD", localHead]);
    assertEquals((await pushWorktreeBranch(worktree)).isErr(), true);
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
