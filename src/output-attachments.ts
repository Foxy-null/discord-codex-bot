import { Buffer } from "node:buffer";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AttachmentPayload } from "discord.js";

export const OUTPUT_ATTACHMENT_INSTRUCTIONS = [
  "To attach a deliverable file to your Discord reply, add a separate line in your final answer: [[attachment:relative/path/to/file.ext]].",
  "Use this only for files you intend to deliver to the user, not ordinary source-code references. Any file type is allowed.",
  "Paths are relative to the current working directory. Files must be inside this thread's working copy. Copy files generated elsewhere into the working copy first; do not use symlinks to outside files.",
  "Put attachment lines only in the final answer, outside code blocks. Do not wrap paths in quotes or Markdown, and do not include these lines in progress messages.",
].join("\n");

export function parseOutputAttachments(text: string): {
  content: string;
  paths: string[];
} {
  const content: string[] = [];
  const paths = new Set<string>();
  let fence: string | undefined;

  for (const line of text.split(/(?<=\n)/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch && fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ""
      ) {
        fence = undefined;
      }
      content.push(line);
      continue;
    }
    if (
      fenceMatch && (fenceMatch[1][0] === "~" ||
        !line.slice(fenceMatch[0].length).includes("`"))
    ) {
      fence = fenceMatch[1];
      content.push(line);
      continue;
    }

    const marker = line.match(
      /^ {0,3}\[\[attachment:([^\r\n]*)\]\][ \t]*(?:\r?\n)?$/,
    );
    if (marker) {
      paths.add(marker[1].trim());
    } else {
      content.push(line);
    }
  }

  return { content: content.join(""), paths: [...paths] };
}

// Discord's Create Message request is limited to 25 MiB including multipart data.
// https://docs.discord.com/developers/resources/message#create-message
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function assertInsideWorktree(root: string, path: string): void {
  const localPath = relative(root, path);
  if (
    localPath === ".." || localPath.startsWith(`..${sep}`) ||
    isAbsolute(localPath)
  ) {
    throw new Error("作業コピー外のファイルは添付できません。");
  }
}

export async function sendOutputAttachments(
  paths: readonly string[],
  worktreePath: string | null | undefined,
  sendFile: (file: AttachmentPayload) => Promise<unknown>,
): Promise<string[]> {
  const failures: string[] = [];
  const sentPaths = new Set<string>();
  for (const path of paths) {
    try {
      if (!worktreePath) {
        throw new Error("作業コピーを取得できませんでした。");
      }
      if (!path) throw new Error("添付ファイルのパスが空です。");
      const root = await Deno.realPath(worktreePath);
      const requestedPath = resolve(root, path);
      assertInsideWorktree(root, requestedPath);
      const realPath = await Deno.realPath(requestedPath);
      assertInsideWorktree(root, realPath);
      if (sentPaths.has(realPath)) continue;
      const info = await Deno.stat(realPath);
      if (!info.isFile) {
        throw new Error("通常のファイルだけを添付できます。");
      }
      if (info.size >= MAX_ATTACHMENT_BYTES) {
        throw new Error("Discordの送信容量制限を超えています。");
      }
      await sendFile({
        attachment: Buffer.from(await Deno.readFile(realPath)),
        name: basename(path),
      });
      sentPaths.add(realPath);
    } catch (error) {
      const reason = error instanceof Deno.errors.NotFound
        ? "ファイルが見つかりません。"
        : error instanceof Error
        ? error.message
        : String(error);
      failures.push(
        `添付できませんでした: ${basename(path) || "(パスなし)"}\n${reason}`,
      );
    }
  }
  return failures;
}
