// ⚠️ A BUDGET SMALLER THAN THE WORK IT WAITS ON TURNS A FIX INTO A NO-OP.
//
// `post:check` on the box reported `$GG` as a logo the row HAS and could not
// load. That part was the check working — but reading the two timeouts against
// each other turned up a defect in the fix itself:
//
//   /api/logo   fails over across 3 IPFS gateways at 5s each, following
//               redirects inside each, and its `deadline` only ever gated
//               STARTING another gateway → 15s+ in the ordinary slow case
//   the bot     waited 12s
//
// So a proxy doing exactly what it was written to do outlasted its caller, the
// fetch recorded "unreachable", and the "only an UNREACHABLE proxy falls
// through" branch went and fetched the RAW single-gateway url — the one thing
// routing through the proxy exists to replace. Same shape as the curve read
// sitting fourth in an 8s queue.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-logoproxy-"));

const test = require("node:test");
const assert = require("node:assert");
const fulfil = require("../src/fulfillment");

/** The route's own ceiling, read out of its source — the number this must beat. */
function routeTotalMs() {
  const src = fss.readFileSync(
    path.join(__dirname, "..", "..", "src", "app", "api", "logo", "route.ts"),
    "utf8",
  );
  const m = /const TOTAL_MS = ([0-9_]+);/.exec(src);
  assert.ok(m, "the route must declare a single TOTAL_MS — it is the contract this test checks");
  return Number(m[1].replace(/_/g, ""));
}

test("the bot waits LONGER than /api/logo's own budget", () => {
  const route = routeTotalMs();
  const bot = fulfil._LOGO_PROXY_MS;
  assert.ok(
    bot > route,
    `the bot's ${bot}ms must exceed the route's ${route}ms, or a WORKING proxy reads as unreachable ` +
      "and the banner falls back to the raw single-gateway fetch the proxy replaces",
  );
});

test("⚠️ the route caps every fetch by what is LEFT of the total, not by perTry", () => {
  // The deadline used to gate only STARTING another gateway, so a request
  // already in flight could run past the whole budget — which is how the route
  // came to outlast its caller in the first place. A source scan, because the
  // alternative is standing up three deliberately-slow IPFS gateways.
  const src = fss
    .readFileSync(path.join(__dirname, "..", "..", "src", "app", "api", "logo", "route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /signal: AbortSignal\.timeout\(Math\.min\(perTry, left\(\)\)\)/,
    "every fetch — redirect hops included — must be bounded by the remaining total");
  assert.ok(!/signal: AbortSignal\.timeout\(perTry\)/.test(src),
    "an unbounded perTry is what let the route outlast the bot");
});

test("a proxy that ANSWERED and one that could not be REACHED get different sentences", () => {
  // "No gateway has this CID" sends an operator to the artwork; "/api/logo did
  // not answer" sends them to the web app. One sentence for both is the
  // wrong-layer diagnosis this repo keeps paying for.
  const src = fss
    .readFileSync(require.resolve("../src/fulfillment.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // ⚠️ THE PROPERTY, NOT THE SPELLING. The first cut pinned the literal
  // "no gateway served it as an image" — and the round after replaced that
  // sentence with the proxy's own per-gateway reason (x-logo-why), because one
  // sentence for every refusal was itself the wrong-layer diagnosis. A guard on
  // wording goes red over code that keeps the rule perfectly.
  assert.match(src, /viaProxy\.reached\s*\?/, "the two are chosen by whether the host answered");
  assert.match(src, /did not answer in \$\{LOGO_PROXY_MS\}ms/, "unreachable names the web app and the budget");
  assert.match(src, /logo unusable\$\{detail\}/, "answered carries the proxy's own reason");
  assert.match(src, /x-logo-why/, "…read off the header the route sets for exactly this");
});

test("a slow-but-answering proxy is still a REFUSAL, never a raw retry", () => {
  // Driven: the proxy takes longer than the old 12s and still answers 404.
  // Under the old budget this aborted, read as unreachable, and fetched the raw
  // url; under the new one it is an answer and the raw url is never touched.
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("/api/logo?u=")) {
      await new Promise((r) => setTimeout(r, 13_000)); // past the OLD 12s, inside the new 15s
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("89504e470d0a1a0a", "hex") };
  };
  return fulfil
    ._fetchLogoUrl("https://ipfs.io/ipfs/bafybeiSLOW")
    .then((buf) => {
      assert.strictEqual(buf, null, "a 404 from the proxy is an answer, however long it took");
      assert.strictEqual(asked.length, 1, `the raw url must never be fetched: ${asked.join(", ")}`);
    })
    .finally(() => {
      global.fetch = orig;
    });
});
