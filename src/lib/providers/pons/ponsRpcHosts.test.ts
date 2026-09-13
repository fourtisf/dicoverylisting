import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// ⚠️ "NEVER ONE HARDCODED HOST" — the public Robinhood node answered HTTP 429
// on the box to every process sharing it (the site, the bot, the trade bot
// and the check), and `PONS_RPC_URL` was ONE url: nothing could fail over.
// The config is a comma-separated LIST now and every chain read is handed
// the list. A single read site handed the first entry alone would work on
// a healthy node and never fail over — the reassuring reading — so the rule
// is a source scan over the whole provider, comment-stripped.

const dir = fileURLToPath(new URL(".", import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("every Pons RPC read is handed the HOST LIST, never the first host alone", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  let reads = 0;
  for (const f of files) {
    const src = strip(readFileSync(new URL(f, import.meta.url), "utf8"));
    const single = src.match(/rpc(?:Batch|Send)\(\s*PONS\.rpcUrl\b(?!s)/g) ?? [];
    assert.deepEqual(single, [], `${f}: a read handed PONS.rpcUrl (one host) instead of PONS.rpcUrls`);
    reads += (src.match(/rpc(?:Batch|Send)\(\s*PONS\.rpcUrls\b/g) ?? []).length;
  }
  assert.ok(reads >= 5, `expected the provider's reads to go through rpcUrls, found ${reads}`);
});

test("PONS_RPC_URL splits on commas, trimmed, and the first entry stays rpcUrl", async () => {
  const cfg = fileURLToPath(new URL("../../../config/pons.ts", import.meta.url));
  const script = `import(${JSON.stringify(cfg)}).then((m) => console.log(JSON.stringify({ one: m.PONS.rpcUrl, all: m.PONS.rpcUrls })))`;
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "-e", script],
      { env: { ...process.env, PONS_RPC_URL: " https://a.example/rpc , https://b.example/rpc,, " } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(String(stdout))),
    );
  });
  const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  assert.equal(parsed.one, "https://a.example/rpc");
  assert.deepEqual(parsed.all, ["https://a.example/rpc", "https://b.example/rpc"]);
});
