import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// $GG loaded on two deploys and failed on two with ZERO lines changed on the
// logo path. Three independent diagnostic lenses converged: pump.fun's own pin
// (pump.mypinata.cloud) was allowlisted but never in the gateway ladder, and
// IPFS_MAX_TRIES counted the caller's own url — so for a stored ipfs.io url
// only two fallbacks ever ran, and whether the artwork loaded depended on what
// a public gateway happened to have cached that minute.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = strip(readFileSync(new URL("../app/api/logo/route.ts", import.meta.url), "utf8"));
const ladder = strip(readFileSync(new URL("./ipfsGateways.ts", import.meta.url), "utf8"));

test("⚠️ pump.fun's own pin is in the DEFAULT gateway ladder", () => {
  // The ladder moved to lib/ipfsGateways.ts (ONE owner, shared with the logo
  // resolver); the route must read it from there rather than keep a copy.
  assert.match(ladder, /"https:\/\/pump\.mypinata\.cloud\/ipfs\/"/);
  assert.match(src, /from "@\/lib\/ipfsGateways"/, "the route grew its own copy of the ladder");
  assert.doesNotMatch(src, /const IPFS_GATEWAYS/, "a second ladder in the route is the drift this module exists to end");
  // …and early enough that a stored ipfs.io url still reaches it: the caller's
  // url is slot one, so the pin has to be within the first (MAX_TRIES - 1)
  // entries that differ from it.
  const order = [...ladder.matchAll(/"(https:\/\/[^"]+\/ipfs\/)"/g)].map((m) => m[1]);
  const idx = order.indexOf("https://pump.mypinata.cloud/ipfs/");
  assert.ok(idx >= 0 && idx <= 1, `the pin must be first or second in the ladder, found at ${idx}: ${order.join(", ")}`);
});

test("⚠️ the caller's own url no longer eats a fallback slot", () => {
  const m = /const IPFS_MAX_TRIES = (\d+);/.exec(src);
  assert.ok(m, "IPFS_MAX_TRIES must be declared");
  assert.ok(Number(m[1]) >= 4, `three real fallbacks behind the caller's url need MAX_TRIES ≥ 4, got ${m[1]}`);
});

test("the pin's host is allowlisted, or the ladder entry could never fire", () => {
  // A gateway in the list that the allowlist refuses is a fallback that cannot
  // fire — which reads exactly like one that never helps.
  assert.match(src, /"mypinata\.cloud"/);
});

// ── the reason the route carries, in full ────────────────────────────────────
//
// Three lenses found the bot printing one sentence for every refusal because
// the proxy's reason never reached it. The route now says which gateway said
// what AND how long it took, names the one that served a 200, and records the
// one case that used to push nothing (a body that died mid-download).

test("⚠️ every recorded gateway outcome carries elapsed ms", () => {
  // Per LINE, not per template literal: the first push nests a template
  // (`${res ? \`HTTP …\` : "no answer"}`), and a backtick-delimited scan stops
  // at the inner one and reports the outer push as having no elapsed time —
  // a guard that goes red on the code it exists to approve.
  const pushes = src.split("\n").filter((l) => /why\.push\(/.test(l));
  assert.ok(pushes.length >= 3, `expected the three outcomes recorded, found ${pushes.length}`);
  for (const p of pushes) assert.match(p, /\$\{ms\(\)\}/, `no elapsed on: ${p.trim()}`);
});

test("a 200 names the gateway that served it (x-logo-via)", () => {
  assert.match(src, /"x-logo-via": `\$\{url\.hostname\} \$\{ms\(\)\}`/);
});

test("⚠️ a body that died mid-download is RECORDED, not a bare 404", () => {
  // This case used to `continue` with nothing pushed, so it reported exactly
  // like a CID nobody had.
  assert.match(src, /why\.push\(`\$\{url\.hostname\}: body died after \$\{ms\(\)\}`\)/);
});
