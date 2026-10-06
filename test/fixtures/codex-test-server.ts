import { fromFileUrl } from "std/path/mod.ts";

export async function installCodexTestServer(dir: string): Promise<void> {
  const fixture = fromFileUrl(
    new URL("./codex-app-server.ts", import.meta.url),
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await Deno.writeTextFile(
    `${dir}/codex`,
    `#!/bin/sh\nexec ${quote(Deno.execPath())} run --allow-read --allow-write ${
      quote(fixture)
    }\n`,
  );
  await Deno.chmod(`${dir}/codex`, 0o755);
}
