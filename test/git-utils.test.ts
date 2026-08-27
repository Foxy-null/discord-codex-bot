import { assertEquals } from "std/assert/mod.ts";
import {
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
