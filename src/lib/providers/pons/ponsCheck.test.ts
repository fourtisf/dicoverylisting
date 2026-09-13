import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// ⚠️ `pons:check` PRINTED A GREEN `token.logo() → ipfs://…` OVER AN APP THAT
// WAS DISCARDING IT. Sections 1–5 read the CONTRACT; the bot and the site read
// the APP, and those are different stacks — so the check was honest about the
// chain and silent about the only thing the listing form depends on. Section 6
// closes that, and it is DRIVEN here rather than read: `node --check` proves
// syntax, and the defect this catches is a runtime shape.

const SCRIPT = fileURLToPath(new URL("../../../../scripts/pons-check.mjs", import.meta.url));
const TOKEN = "0x85ad1ec672f2d589f21dd3ac8b2164127d4651af";
const LOGO = "ipfs://bafkreif3og7rosylkz34ho7mbgzdkyscslhnastl3qszh6qykfwzg6lk3m";

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const abiString = (s: string) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return `0x${w(32)}${w(s.length)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};
const launchRecord = () => {
  const words = Array.from({ length: 16 }, () => w(0));
  words[1] = "1".repeat(40).padStart(64, "0"); // the curve
  words[8] = w(250); // creator tax
  words[14] = w(1); // exists
  return `0x${words.join("")}`;
};

const ANSWER: Record<string, string> = {
  "0x3cf28b5a": launchRecord(),
  "0x0902f1ac": `0x${w(1000)}${w(2000)}`,
  "0x4f1f58fd": `0x${w(900)}`,
  "0x808bcddc": `0x${w(500)}`,
  "0xe7c2b772": `0x${w(0)}`,
  "0x313ce567": `0x${w(18)}`,
  "0x18160ddd": `0x${w(10n ** 24n)}`,
  "0x95d89b41": abiString("TRENCHWIRE"),
  "0x06fdde03": abiString("Trenchwire"),
  "0xfb7f21eb": abiString(LOGO),
};

/** A Robinhood node and a dexvra server in one process. The CONTRACT always
 *  publishes the logo; `appLogo` is whether the APP serves it — the whole
 *  difference between the shipped bug and the fix. */
type ChainLogo = true | false | "revert"; // published · left blank · the call fails

type Quote = "coinbase" | "none" | "no-spot" | "rpc-refused" | undefined;

async function stub(appLogo: boolean, chainLogo: ChainLogo = true, quote: Quote = undefined) {
  // "rpc-refused": the node answers HTTP 429 to every eth_call (the cheap
  // methods still answer, as the box showed), and the app serves the record
  // its own refused read produced.
  const rpcRefused = quote === "rpc-refused";
  const rpc = (req: { id?: number; method?: string; params?: { data?: string }[] }) => {
    if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1237" };
    if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: req.id, result: "0x1" };
    if (req.method === "eth_getCode") return { jsonrpc: "2.0", id: req.id, result: "0x6001" };
    const sel = String(req.params?.[0]?.data ?? "").slice(0, 10);
    if (sel === "0xfb7f21eb" && chainLogo === "revert") {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "execution reverted" } };
    }
    const hit = sel === "0xfb7f21eb" && chainLogo === false ? abiString("") : ANSWER[sel];
    return hit
      ? { jsonrpc: "2.0", id: req.id, result: hit }
      : { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "stub: no answer" } };
  };

  const server = http.createServer((req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        if (rpcRefused && entries.some((e: { method?: string }) => e?.method === "eth_call")) {
          res.writeHead(429, { "content-type": "text/plain" });
          res.end("rate limited");
          return;
        }
        send(200, Array.isArray(parsed) ? parsed.map(rpc) : rpc(parsed));
      });
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/pons/launches") return send(200, { items: [{ address: TOKEN }] });
    if (path === "/api/pons") {
      return send(200, {
        launch: {
          address: TOKEN,
          name: "Trenchwire",
          symbol: "TRENCHWIRE",
          logo: appLogo ? LOGO : null,
          socials: { twitter: "https://x.com/Trenchwire_", telegram: null, website: null },
          // The USD figure as the app's ETH/USD ladder produced it — or the
          // ladder's own refusal, which is what section 7 has to read.
          ...(quote === "coinbase" ? { priceUsd: 0.0000048, mcapUsd: 4494.71, quoteUsdSource: "coinbase", marketWhy: null } : {}),
          ...(quote === "none"
            ? { priceUsd: null, mcapUsd: null, priceQuote: 1.5e-9, quoteUsdSource: null, marketWhy: "no USD reference for ETH — coinbase: Coinbase 503; dexscreener: DexScreener 403; geckoterminal: rate limited" }
            : {}),
          // A current build whose curve READ answered and produced no spot —
          // `priceQuote` is an explicit null and `readWhy` is null. Not the
          // node and not the ladder.
          ...(quote === "no-spot"
            ? { priceUsd: null, mcapUsd: null, priceQuote: null, quoteSymbol: "ETH", quoteUsdSource: null, readWhy: null, marketWhy: "the curve and the pool answered no price" }
            : {}),
          ...(quote === "rpc-refused"
            ? { name: null, symbol: null, logo: null, priceUsd: null, mcapUsd: null, priceQuote: null, quoteSymbol: "ETH", quoteUsdSource: null, readWhy: "rpc 429 (rate limited)", marketWhy: "could not read the curve — rpc 429 (rate limited)" }
            : {}),
        },
      });
    }
    if (path === "/api/tokens") return send(200, { build: "stub" });
    return send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function run(appLogo: boolean, chainLogo: ChainLogo = true, quote: Quote = undefined): Promise<string> {
  const s = await stub(appLogo, chainLogo, quote);
  try {
    return await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT],
        // ⚠️ The check reads a repo .env of its own; a real PONS_RPC_URL in it
        // would send this test at the live chain. Both are pinned here.
        { env: { ...process.env, PONS_RPC_URL: s.origin, SITE_ORIGIN: s.origin }, timeout: 60_000 },
        (_err, stdout) => resolve(String(stdout)),
      );
    });
  } finally {
    s.close();
  }
}

// The stripe of the run that matters. Each section is asserted on its own
// stripe rather than on the exit code: the direct rung probes in section 7
// reach three hosts a sandbox cannot, and those are printed as notes, never
// as the verdict.
const section6 = (out: string) => out.slice(out.indexOf("6 · The listing autofill")).split("7 · ")[0];
// ANSI-stripped: the ✓/✗ marks are wrapped in colour codes, and a regex over
// the raw stream matches the escape rather than the mark.
const section7 = (out: string) => {
  const plain = out.replace(/\x1B\[[0-9;]*m/g, "");
  return plain.slice(plain.indexOf("7 · The ETH/USD reference")).split("\nVerdict")[0];
};

test("the check goes RED when the app drops a logo the chain published", async () => {
  const out = section6(await run(false));
  assert.match(out, /drops 1 field\(s\) the chain published/);
  assert.match(out, /logo — the contract publishes ipfs:\/\//);
});

test("…and GREEN when the app serves it, naming what the form would fill", async () => {
  const out = section6(await run(true));
  assert.doesNotMatch(out, /drops \d+ field/);
  assert.match(out, /the form would autofill: symbol · name · logo · twitter/);
});

// ⚠️ "The creator filled nothing in" and "the app dropped it" are DIFFERENT
// FACTS, and only the second is a defect. A check that reddened on the first
// would be permanently red on any pad where most creators skip the artwork —
// the state `chart:preview` sat in for weeks, which trains the reader to
// ignore the red. The contract publishes no logo here, so this is the only
// fixture that reaches that branch: without it the rule is untested and a
// mutation run says so.
test("a token whose creator set no logo is not a red mark", async () => {
  const out = section6(await run(false, false));
  assert.doesNotMatch(out, /drops \d+ field/);
  assert.match(out, /the form would autofill: symbol · name · twitter/);
});

// ⚠️ ONE FAULT, ONE ALERT. A `logo()` that reverts is already a red mark in
// section 4 — the CONTRACT read failed. Reporting it again here as "the app
// serves nothing" would send the operator to the app over a chain problem,
// which is this file's whole subject pointing the other way.
test("a contract read that failed is not blamed on the app", async () => {
  const out = await run(false, "revert");
  assert.match(out, /token\.logo\(\) → /); // section 4 says so
  assert.doesNotMatch(section6(out), /drops \d+ field/);
});

// ── Section 7 reads the APP's ladder, not GeckoTerminal alone ───────────────
//
// It used to probe GT directly and print "every USD figure is null while this
// is refused" over a 429 — a check lying in the alarming direction from the
// day the app's ETH/USD reference became a ladder with two keyless rungs
// above GT. The verdict is the app's own record now; the direct probes are
// notes about this box's egress.
test("section 7 is GREEN when the app priced ETH, and names the rung", async () => {
  const out = section7(await run(true, true, "coinbase"));
  assert.match(out, /✓ .*ETH reference from coinbase/);
  assert.doesNotMatch(out, /✗/, `no red mark over a priced record:\n${out}`);
});

test("…and RED when every rung refused, carrying the ladder's own sentence", async () => {
  const out = section7(await run(true, true, "none"));
  assert.match(out, /✗ no USD price — no USD reference for ETH — coinbase: .*dexscreener: .*geckoterminal: /);
  assert.match(out, /priceQuote, in ETH\) are unaffected/, "the chain's own answer is stated as intact");
});

// ⚠️ A curve that ANSWERED no price is neither the node nor the ladder. The
// first cut printed the ladder's sentences ("every rung refuses",
// "GECKOTERMINAL_API_KEY…") under ANY marketWhy, directly above three probes
// showing every rung answering — over a record whose priceQuote was null.
test("…and a curve that answered no price is a warning about the CURVE, never the ladder", async () => {
  const out = section7(await run(true, true, "no-spot"));
  assert.match(out, /⚠ no ETH price to convert — the curve and the pool answered no price/);
  assert.doesNotMatch(out, /✗/, `no red mark:\n${out}`);
  assert.doesNotMatch(out, /EVERY rung refuses|GECKOTERMINAL_API_KEY/);
});

test("…and a record with no USD figure and no reason is a warning, never a fault", async () => {
  // An ERC-20-quoted launch, or an app build older than the ladder.
  const out = section7(await run(true, true, undefined));
  assert.match(out, /⚠ the app reports no USD price and no reason/);
  assert.doesNotMatch(out, /✗/);
});

test("⚠️ the verdict is the app's read — a direct probe never turns the code", async () => {
  // Comment-stripped source scan: the three direct probes may only ever
  // `note()`; a `bad(` or `broken++` inside the probe loop is the old check
  // back — GT unreachable from a box reading as a broken feed.
  const src = readFileSync(SCRIPT, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const sec = src.slice(src.indexOf('head("7 ·'), src.indexOf("// ── Verdict") > 0 ? src.indexOf("// ── Verdict") : src.indexOf('head("Verdict")'));
  const loop = sec.slice(sec.indexOf("for (const [name, fn] of probes)"));
  assert.ok(loop.length > 0, "the probe loop exists");
  assert.doesNotMatch(loop, /\bbad\(|broken\+\+/, "a direct probe may not turn the verdict");
  assert.match(sec, /launch\.marketWhy/, "the verdict reads the app's own reason");
});

// ── A node that refuses is named ONCE, and nothing is measured over it ──────
//
// The box: HTTP 429 from the public Robinhood RPC, printed as one ✗ per
// token, then "the creator filled nothing in" over an app whose own read had
// failed, then the ladder's sentences over a curve the node refused to read
// — under three probes showing every rung answering — then "the chain layer
// is healthy". Four sections, each measuring the limit and reporting it as a
// fact about something else.
test("⚠️ HTTP 429 from the node is one line about the node — not a fact about every token", async () => {
  const out = (await run(true, true, "rpc-refused")).replace(/\x1B\[[0-9;]*m/g, "");
  assert.match(out, /the RPC is rate-limiting this box — HTTP 429/);
  assert.equal((out.match(/getLaunchedToken failed/g) || []).length, 0, "no per-token ✗ over one refusal");
  assert.match(out, /skipped — the node is rate-limiting/, "section 5 does not replay into the limit");
  assert.doesNotMatch(out, /the creator filled nothing in/, "section 6 makes no claim about the creator over a refused read");
  assert.match(out, /the app's own read failed: rpc 429/);
  assert.doesNotMatch(out, /every USD figure on the feed is null while EVERY rung refuses/, "section 7 does not blame the ladder for a refused curve read");
  assert.match(out, /no ETH price to convert — the curve could not be read: rpc 429/);
  assert.match(out, /the node rate-limited this box \(HTTP 429\)/, "the verdict names the node");
  assert.doesNotMatch(out, /the chain layer is healthy/, "…and does not call the chain layer healthy over it");
});
