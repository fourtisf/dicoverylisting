// The web app's boot line, and the reason it exists.
//
// CLAUDE.md's release flow ends with "verify what is running before believing
// anything about it", and every process prints its commit at boot — except this
// one. That gap has now cost two round trips: a stale remote ref merged as a
// no-op and read as a code fault, then a GT banner that only printed once a
// request happened to import its module, so an operator who restarted and
// immediately grepped the log got nothing at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const HOOK = read("src/instrumentation.ts");
const CONFIG = read("next.config.mjs");
const GT = read("src/lib/providers/gt.ts");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("Next is told to run the hook — without the flag the file is silently ignored", () => {
  // 14.2 still gates register() behind experimental.instrumentationHook, and an
  // ignored file fails exactly like the banner it replaces: quietly.
  assert.match(CONFIG, /experimental: \{ instrumentationHook: true \}/);
});

test("register() prints the BUILD and the GeckoTerminal tier, once, on the node runtime", () => {
  assert.match(HOOK, /export async function register\(\)/);
  assert.match(HOOK, /NEXT_RUNTIME !== "nodejs"/, "the hook runs on edge too — printing there doubles the line");
  assert.match(HOOK, /\[boot\] build \$\{process\.env\.NEXT_PUBLIC_BUILD/);
  assert.match(HOOK, /gtBanner\(\)/);
});

test("⚠️ the GT banner no longer fires from module scope", () => {
  // That is "whenever the first request happens to reach a route that uses GT",
  // which is not boot — and a boot line that is not printed at boot is worse
  // than no boot line.
  const body = code(GT);
  assert.match(body, /export function gtBanner\(\)/);
  const outsideFn = body.slice(0, body.indexOf("export function gtBanner"));
  // ⚠️ THE PROPERTY IS "NOTHING LOGS AT IMPORT TIME", not "there is exactly one
  // console.log in the file". The count was a proxy for it and broke the moment
  // a legitimate diagnostic was added INSIDE a request path — which is not the
  // bug this guards. Every log must sit inside a function; a bare one at module
  // scope is the one that fires on import.
  assert.ok(!/console\.log/.test(outsideFn), "nothing logs at import time");
  const moduleScope = body.replace(/(?:export\s+)?(?:async\s+)?function[\s\S]*?\n}/g, "");
  assert.ok(!/console\.log/.test(moduleScope), "a console.log outside every function fires on import");
});

test("the key itself is never printed — these lines go to pm2's log", () => {
  // ⚠️ THE PROPERTY IS ABOUT WHAT IS PRINTED, not about where it sits in the
  // file. This used to slice "everything after gtBanner" and forbid GT_KEY in
  // it — so it failed on an ordinary truthiness check further down that prints
  // nothing, and it would have MISSED a console.log added above the banner.
  // Every printed line in the file is checked instead: `GT_KEYED` (a boolean)
  // is fine, the key itself never is.
  const printed = [...code(GT).matchAll(/console\.log\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(printed.length > 0, "no printed line found — this guard is describing nothing");
  for (const line of printed)
    assert.ok(!/GT_KEY\b(?!ED)/.test(line), `a printed line references the key itself: ${line.slice(0, 120)}`);
  const banner = GT.slice(GT.indexOf("export function gtBanner"));
  assert.match(banner, /GT_KEYED/, "the banner still reports WHETHER a key is set");
});
