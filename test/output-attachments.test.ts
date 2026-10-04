import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { Buffer } from "node:buffer";
import { join } from "std/path/mod.ts";
import {
  parseOutputAttachments,
  sendOutputAttachments,
} from "../src/output-attachments.ts";

Deno.test("成果物添付: 専用の指定だけを読み取り、通常のリンクとコード例を保持する", () => {
  const body = [
    "[ソース](src/main.ts) と [外部](https://example.com/report.pdf)",
    "例: `[[attachment:inline.txt]]`",
    "    [[attachment:indented-code.txt]]",
    "\t[[attachment:tab-indented-code.txt]]",
    "````text",
    "[[attachment:example.txt]]",
    "```",
    "[[attachment:still-an-example.txt]]",
    "````",
    "~~~text",
    "[[attachment:tilde-example.txt]]",
    "~~~",
  ].join("\r\n");
  const parsed = parseOutputAttachments(
    `${body}\r\n[[attachment:reports/結果 file.pdf]]\r\n[[attachment:archive.zip]]\r\n[[attachment:archive.zip]]`,
  );
  assertEquals(parsed.content, `${body}\r\n`);
  assertEquals(parsed.paths, ["reports/結果 file.pdf", "archive.zip"]);
  assertEquals(parseOutputAttachments("普通の返信\n"), {
    content: "普通の返信\n",
    paths: [],
  });
  assertEquals(parseOutputAttachments("[[attachment:only.zip]]"), {
    content: "",
    paths: ["only.zip"],
  });
  assertEquals(
    parseOutputAttachments("```inline code```\n[[attachment:report.pdf]]"),
    { content: "```inline code```\n", paths: ["report.pdf"] },
  );
});

Deno.test("成果物添付: 外部パス・不存在・容量超過・送信失敗があっても残りの全ファイルを送る", async () => {
  const dir = await Deno.makeTempDir();
  const worktree = join(dir, "worktree");
  const sibling = join(dir, "worktree-other");
  try {
    await Deno.mkdir(worktree);
    await Deno.mkdir(sibling);
    await Deno.mkdir(join(worktree, "directory"));
    const outside = join(sibling, "outside.txt");
    await Deno.writeTextFile(outside, "must not be uploaded");
    await Deno.symlink(outside, join(worktree, "escape.txt"));
    const files = ["結果 file.pdf", "denied.zip", "after.txt"];
    for (let index = 0; index < 11; index++) files.push(`report-${index}.csv`);
    for (const file of files) {
      await Deno.writeFile(join(worktree, file), new Uint8Array([0, 1, 255]));
    }
    await Deno.symlink(join(worktree, files[0]), join(worktree, "alias.pdf"));
    const oversized = await Deno.open(join(worktree, "oversized.zip"), {
      create: true,
      write: true,
    });
    try {
      await oversized.truncate(25 * 1024 * 1024);
    } finally {
      oversized.close();
    }

    const sent: string[] = [];
    const failures = await sendOutputAttachments(
      [
        files[0],
        "./結果 file.pdf",
        "alias.pdf",
        "denied.zip",
        "missing.txt",
        "oversized.zip",
        "directory",
        "../worktree-other/outside.txt",
        outside,
        "escape.txt",
        "",
        ...files.slice(2),
      ],
      worktree,
      async (file) => {
        assertEquals(Buffer.isBuffer(file.attachment), true);
        assertEquals([...file.attachment as Buffer], [0, 1, 255]);
        if (file.name === "denied.zip") throw new Error("Missing Permissions");
        sent.push(file.name!);
      },
    );
    assertEquals(sent, [files[0], ...files.slice(2)]);
    assertEquals(failures.length, 8);
    assertStringIncludes(failures[0], "denied.zip\nMissing Permissions");
    assertStringIncludes(failures[1], "missing.txt\nファイルが見つかりません");
    assertStringIncludes(failures[2], "oversized.zip\nDiscordの送信容量制限");
    assertStringIncludes(failures[3], "directory\n通常のファイル");
    for (const failure of failures.slice(4, 7)) {
      assertStringIncludes(failure, "作業コピー外");
    }
    assertStringIncludes(failures[6], "escape.txt");
    assertStringIncludes(failures[7], "パスが空");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("成果物添付: 作業コピーを取得できない場合はファイルごとに通知する", async () => {
  const failures = await sendOutputAttachments(
    ["report.pdf", "archive.zip"],
    null,
    async () => {
      throw new Error("must not be called");
    },
  );
  assertEquals(failures, [
    "添付できませんでした: report.pdf\n作業コピーを取得できませんでした。",
    "添付できませんでした: archive.zip\n作業コピーを取得できませんでした。",
  ]);
});
