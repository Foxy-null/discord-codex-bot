import { TextLineStream } from "std/streams/text_line_stream.ts";
const encoder = new TextEncoder();
async function send(message: Record<string, unknown>, split = false) {
  const bytes = encoder.encode(JSON.stringify(message) + "\n");
  if (split) {
    for (const byte of bytes) await Deno.stdout.write(new Uint8Array([byte]));
  } else await Deno.stdout.write(bytes);
}
for await (
  const line of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
) {
  const message = JSON.parse(line) as Record<string, unknown>;
  await Deno.writeTextFile("codex-requests.jsonl", line + "\n", {
    append: true,
  });
  if (!message.method) {
    await send({
      method: "test/serverResponse",
      params: { response: message },
    });
    continue;
  }
  if (message.id === undefined) continue;
  if (message.method === "test/disconnect") {
    await Deno.stderr.write(encoder.encode("test server disconnected"));
    Deno.exit(7);
  }
  if (message.method === "test/error") {
    await send({
      id: message.id,
      error: { code: -32600, message: "no active turn" },
    });
    continue;
  }
  if (message.method === "test/malformedError") {
    await send({ id: message.id, error: "invalid" });
    continue;
  }
  if (message.method === "test/unicode") {
    await send({ id: message.id, result: { text: "日本語" } }, true);
    continue;
  }
  if (message.method === "test/serverRequest") {
    await send({
      id: "server-request",
      method: "item/tool/requestUserInput",
      params: {},
    });
  }
  await send({ id: message.id, result: {} });
}
