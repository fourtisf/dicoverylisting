// ds:probe — FIND DEXSCREENER'S REAL CANDLE REQUEST, ON THE BOX THAT HAS TO MAKE IT.
//
// `providers/dsChart.ts` ships a GUESSED request shape, on purpose: DexScreener
// publishes no OHLCV endpoint, so every part of the request is a `.env` line
// rather than a deploy. `chart:check` then tells you whether the guess works —
// and when it does not, it tells you to go read the real shape out of your own
// browser's DevTools. That last step is the gap this script closes:
//
//     THE BOX IS NOT A BROWSER, BUT IT CAN READ THE BROWSER'S CODE.
//
// DexScreener's chart is a TradingView chart fed by its own datafeed, and the
// code that builds those URLs ships in the page's JS bundle. So rather than
// guess again, this walks the same path a human with DevTools would:
//
//   1. RESOLVE  our token's deepest pair through the DOCUMENTED api. host.
//   2. DISCOVER fetch dexscreener.com's own bundle and read the datafeed
//      host/path out of it. Whatever it finds is tried FIRST, ahead of every
//      built-in guess, because it came from the caller itself.
//   3. PROBE    ask each candidate for real, with dsChart's own headers, and
//      classify the answer: refused / wrong path / talking-but-refusing the
//      params / bars.
//   4. PRINT    the exact .env lines for whatever answered with bars.
//
// ⚠️ IT PROVES NOTHING FROM A SANDBOX. Whether a host answers is a property of
// THIS box's egress today — the rule `raid:check`, `launchpads:check`,
// `fonts:check` and `chart:check` all state. It was written on a box that
// cannot reach any dexscreener.com host at all, so every line below is about
// how to ASK, and only the box you run it on can say what comes back.
//
//   npm run ds:probe                          # the shipped sample
//   npm run ds:probe -- solana VJdpSDDLof…    # one token you are looking at
//   npm run ds:probe -- bsc 0x8b7a…7777
//
// Exits non-zero when nothing returned bars, because that is the state worth
// acting on. Node 18: global fetch, no dependencies, no TypeScript import —
// the same floor `chart:check` documents.
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m";

const strip = (s) => String(s ?? "").trim().replace(/\/+$/, "");
const PAIRS_BASE = strip(process.env.DS_PAIRS_API) || "https://api.dexscreener.com";
const SITE_BASE = strip(process.env.DS_SITE) || "https://dexscreener.com";
const TIMEOUT_MS = Number(process.env.DS_PROBE_TIMEOUT_MS) || 15_000;

/** The build stamp of the checkout, for the reason every other check prints
 *  one: a report read as a statement about a fix that was never deployed. */
function stamp() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

/** dsChart.ts's own header set, copied deliberately rather than imported: this
 *  script must run on node 18 without type stripping, and a probe that asks
 *  with DIFFERENT headers than the provider would is measuring the wrong
 *  request. Keep the two in step. */
const CHART_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DexvraChart/1.0",
  referer: "https://dexscreener.com/",
  origin: "https://dexscreener.com",
};

async function get(url, { headers = CHART_HEADERS, as = "text" } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    const body = as === "json" ? await res.json().catch(() => null) : await res.text();
    return { ok: res.ok, status: res.status, body, ms: Date.now() - t0 };
  } catch (err) {
    const code = err?.cause?.code || err?.cause?.errno || err?.name || "";
    return { ok: false, status: 0, body: null, ms: Date.now() - t0, why: `${code || "request failed"}: ${err?.message ?? err}` };
  }
}

// ── 1. RESOLVE ───────────────────────────────────────────────────────────────
/** Deepest BASE-side pair, the same rule dsChart.dsTopPair follows: a token is
 *  also the QUOTE side of somebody else's pair, and charting that draws the
 *  other asset's price under our ticker. */
async function topPair(chain, address) {
  const r = await get(`${PAIRS_BASE}/latest/dex/tokens/${address}`, { headers: { accept: "application/json" }, as: "json" });
  if (!r.ok) return { pair: null, why: `api.dexscreener.com ${r.status || "unreachable"}${r.why ? ` (${r.why})` : ""}` };
  const pairs = (r.body?.pairs ?? []).filter(
    (p) => p?.pairAddress && p?.chainId === chain && p?.baseToken?.address?.toLowerCase() === address.toLowerCase(),
  );
  if (!pairs.length) return { pair: null, why: `no ${chain} pair with this token on the base side` };
  const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  return {
    pair: { pairAddress: best.pairAddress, dexId: best.dexId ?? "", chainId: best.chainId, liquidityUsd: best.liquidity?.usd ?? 0 },
    why: null,
  };
}

// ── 2. DISCOVER ──────────────────────────────────────────────────────────────
/** Path templates read out of DexScreener's own bundle.
 *
 *  The bundle builds these URLs by CONCATENATION, so a literal in the source
 *  is a fragment ("/dex/chart/amm/", "/bars/") rather than a whole path. What
 *  this can honestly recover is therefore the HOST and the fragments — printed
 *  in full so a human can assemble the rest, and turned into candidates where
 *  a fragment is complete enough to try. Anything it finds is tried first. */
export function scanBundle(src) {
  const found = { hosts: new Set(), fragments: new Set(), templates: new Set() };
  for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]*dexscreener\.com)/gi)) found.hosts.add(m[1].toLowerCase());
  // Any quoted literal that looks like part of a datafeed route.
  for (const m of src.matchAll(/["'`](\/(?:dex|u|chart)\/[A-Za-z0-9/_.$%{}-]*)["'`]/g)) {
    const p = m[1];
    if (/chart|bar|candle|ohlc|log/i.test(p)) found.fragments.add(p);
  }
  // A whole template, if one ships intact.
  //
  // ⚠️ THE CHARACTER CLASS MUST ALLOW BRACES ON BOTH SIDES OF THE KEYWORD. It
  // used to stop at `{`, so the one thing worth finding —
  // `/dex/chart/amm/v9/{dex}/bars/{chain}/{pair}` — fell through to `fragments`
  // and was never probed: the sweep asked six built-in guesses and skipped the
  // template the bundle had just handed it. Caught by the stub, which is the
  // whole reason a script about an unreachable host has one.
  for (const m of src.matchAll(/["'`](\/[A-Za-z0-9/_${}-]*(?:bars|candles|ohlcv)[A-Za-z0-9/_${}-]*)["'`]/g)) {
    found.templates.add(m[1]);
  }
  return found;
}

async function discover(chain, pairAddress) {
  const page = await get(`${SITE_BASE}/${chain}/${pairAddress}`, {
    headers: { ...CHART_HEADERS, accept: "text/html,application/xhtml+xml" },
  });
  if (!page.ok) return { ok: false, why: `${SITE_BASE} ${page.status || "unreachable"}${page.why ? ` (${page.why})` : ""}`, hosts: [], fragments: [], templates: [], scripts: 0 };

  const srcs = [...String(page.body).matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const urls = srcs
    .map((s) => (s.startsWith("http") ? s : `${SITE_BASE}${s.startsWith("/") ? "" : "/"}${s}`))
    .filter((u) => /\.js(\?|$)/i.test(u));

  const all = { hosts: new Set(), fragments: new Set(), templates: new Set() };
  // The page itself can carry an inline datafeed config.
  for (const k of ["hosts", "fragments", "templates"]) for (const v of scanBundle(String(page.body))[k]) all[k].add(v);

  let read = 0;
  for (const u of urls.slice(0, 40)) {
    const js = await get(u, { headers: { ...CHART_HEADERS, accept: "*/*" } });
    if (!js.ok) continue;
    read++;
    const hit = scanBundle(String(js.body));
    for (const k of ["hosts", "fragments", "templates"]) for (const v of hit[k]) all[k].add(v);
  }
  return {
    ok: true,
    why: null,
    scripts: read,
    hosts: [...all.hosts],
    fragments: [...all.fragments].sort(),
    templates: [...all.templates].sort(),
  };
}

// ── 3. PROBE ─────────────────────────────────────────────────────────────────
/** The shapes dsChart.ts ships, plus the neighbours a renamed segment would
 *  land on. Discovered ones go in front of these. */
const BUILTIN_PATHS = [
  "/dex/chart/amm/v3/{dex}/bars/{chain}/{pair}",
  "/dex/chart/amm/v2/{dex}/bars/{chain}/{pair}",
  "/dex/chart/amm/v1/{dex}/bars/{chain}/{pair}",
  "/dex/chart/amm/{dex}/bars/{chain}/{pair}",
  "/dex/chart/bars/{chain}/{pair}",
  "/dex/chart/{chain}/{pair}/bars",
  "/dex/bars/{chain}/{pair}",
  "/u/chart/bars/{chain}/{pair}",
  // TradingView's UDF convention — see UDF_ROOTS.
  "/dex/chart/amm/v3/{dex}/history",
  "/dex/chart/history",
  "/history",
];
const BUILTIN_QUERIES = [
  "from={from}&to={to}&res={res}&cb={limit}",
  "from={from}&to={to}&resolution={res}&countback={limit}",
  "from={from}&to={to}&res={res}&countback={limit}",
  // UDF's own spelling: the symbol travels in the QUERY, not the path.
  "symbol={chain}%3A{pair}&from={from}&to={to}&resolution={res}",
  "symbol={pair}&from={from}&to={to}&resolution={res}",
];

/**
 * ⚠️ FIND THE DATAFEED ROOT BEFORE GUESSING ITS BARS PATH.
 *
 * DexScreener's chart is TradingView, and a TradingView chart is fed by a UDF
 * datafeed. UDF datafeeds SELF-IDENTIFY: `GET {root}/config` answers with a
 * `supported_resolutions` array, and nothing else on the internet answers that
 * way by accident. So instead of spraying bars paths and reading 404s, ask each
 * candidate root one cheap question first — a hit pins the root exactly, and
 * from there `/history` is a convention rather than a guess.
 *
 * This is the part that can turn "somewhere in this host" into an answer
 * without a browser, which is the whole problem this script exists for.
 */
const UDF_ROOTS = [
  "/dex/chart/amm/v3/{dex}",
  "/dex/chart/amm/{dex}",
  "/dex/chart",
  "/dex",
  "",
];

/** A UDF /config answer, or null. `supported_resolutions` is the tell. */
async function udfConfig(base, root, vars) {
  const url = `${base}${fill(root, vars)}/config`;
  const r = await get(url);
  if (!r.ok) return null;
  const j = safeJson(r.body);
  if (j && Array.isArray(j.supported_resolutions)) return { url, resolutions: j.supported_resolutions };
  return null;
}

export const fill = (tpl, v) =>
  tpl.replace(/\{dex\}/g, v.dex).replace(/\{chain\}/g, v.chain).replace(/\{pair\}/g, v.pair)
     // `{fromSec}`/`{toSec}` before `{from}`/`{to}`, or the shorter token eats
     // the longer one and leaves a stray "Sec" — the same ordering rule
     // dsChartQuery states.
     .replace(/\{fromSec\}/g, Math.floor(v.from / 1000))
     .replace(/\{toSec\}/g, Math.floor(v.to / 1000))
     .replace(/\{from\}/g, v.from).replace(/\{to\}/g, v.to).replace(/\{res\}/g, v.res).replace(/\{limit\}/g, v.limit);

/**
 * THE DEEP QUERY SWEEP — run once the path is KNOWN.
 *
 * The first live run ended with `35×404 · 15×403 · 5×400`, and the 400 was the
 * whole answer: `/dex/chart/amm/v3/{dex}/bars/{chain}/{pair}` — the shipped
 * default — EXISTS and refused every query shape we had. It also refused with
 * an EMPTY BODY, so the upstream named nothing and the five guesses ran out.
 *
 * Guessing more PATHS at that point is wasted: 11 paths × 5 queries spends 55
 * requests to learn one thing. One known path × a real parameter grid spends
 * about the same and can actually land. So when a path answers 400, the sweep
 * escalates onto it instead of stopping.
 *
 * ⚠️ THE UNIT IS THE FIRST SUSPECT. DexScreener's DOCUMENTED api. host returns
 * `pairCreatedAt` in epoch MILLISECONDS, and this repo has already been bitten
 * by that exact asymmetry in the other direction — `barToRow` converts ms→s
 * because a millisecond stamp read as seconds is silently dropped as "the
 * future". Sending seconds to a feed that wants milliseconds is the same scar,
 * pointing back. So the grid varies the UNIT before anything else.
 */
const DEEP_GRID = {
  // Both spellings of the window, because only one of them can be right.
  unit: ["s", "ms"],
  // Every name a TradingView-shaped feed uses for the bar size…
  resKey: ["res", "resolution", "tf", "interval"],
  // …and every spelling of the value itself.
  resVal: ["15", "15m", "m15"],
  // How many bars back. The empty string means "omit it" — a required-looking
  // parameter that is actually forbidden is one way to earn a 400.
  cbKey: ["cb", "countback", "limit", ""],
  // ⚠️ AN EXTRA PARAMETER THE FEED REQUIRES AND WE NEVER SEND LOOKS EXACTLY
  // LIKE A WRONG ONE WE DO. The live box answered 400 to all five original
  // shapes with an EMPTY body — the host names nothing, so a missing required
  // parameter and a misspelled optional one are indistinguishable from the
  // outside. A chart feed has to be told which currency to quote in
  // somewhere, and "" (send nothing extra) stays first so the simplest
  // request is still tried before any of these.
  extra: ["", "q=usd", "currency=usd", "type=usd", "quote=usd"],
};

/** Every query string in the grid, coarsest axis first so a hit is found early. */
export function deepQueries(nowMs = Date.now(), hours = 6, limit = 100) {
  const out = [];
  for (const unit of DEEP_GRID.unit) {
    const div = unit === "ms" ? 1 : 1000;
    const to = Math.floor(nowMs / div);
    const from = Math.floor((nowMs - hours * 3600_000) / div);
    // The placeholders dsChartQuery understands for THIS unit, so whatever
    // wins can be written straight into DS_CHART_QUERY and mean the same
    // thing when the app substitutes its own window.
    const fromTok = unit === "ms" ? "{from}" : "{fromSec}";
    const toTok = unit === "ms" ? "{to}" : "{toSec}";
    for (const resKey of DEEP_GRID.resKey) {
      for (const resVal of DEEP_GRID.resVal) {
        for (const cbKey of DEEP_GRID.cbKey) {
        for (const extra of DEEP_GRID.extra) {
          // ⚠️ THE TEMPLATE MUST CARRY {res}, NOT THE SPELLING THAT WON.
          // Freezing `resolution=15` into DS_CHART_QUERY draws 15m candles on
          // the 1h, 4h and 1d tabs — a chart that looks like it works because
          // the tab you are on happens to be the one that was probed. Same
          // defect as baking the dex id into the path. `{res}` is only usable
          // when the winning spelling is what DS_RES already produces ("15");
          // any other vocabulary needs a code change, and `canon` says so.
          const canon = resVal === "15";
          const q = [`from=${from}`, `to=${to}`, `${resKey}=${encodeURIComponent(resVal)}`];
          const tpl = [`from=${fromTok}`, `to=${toTok}`, `${resKey}=${canon ? "{res}" : encodeURIComponent(resVal)}`];
          if (cbKey) { q.push(`${cbKey}=${limit}`); tpl.push(`${cbKey}={limit}`); }
          if (extra) { q.push(extra); tpl.push(extra); }
          out.push({ q: q.join("&"), tpl: tpl.join("&"), unit, resKey, resVal, cbKey: cbKey || "(omitted)", extra: extra || "(none)", canon });
        }
        }
      }
    }
  }
  return out;
}

/** dsChart.barsOf, in plain JS — same envelope vocabulary, same one level of
 *  nesting. A probe that parses more leniently than the provider would report
 *  a shape the provider then cannot read. */
export function barsOf(body, depth = 0) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object" || depth > 2) return null;
  for (const k of ["bars", "data", "candles", "rows", "result"]) {
    const v = body[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const inner = barsOf(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

/** What the answer MEANS — the distinction dsChart.ts is built around and the
 *  only thing that makes a red line actionable. */
export function classify(r) {
  if (r.status === 0) return { mark: `${R}✗${X}`, verdict: `could not ask (${r.why ?? "no answer"})`, win: false };
  if ([401, 403, 451].includes(r.status)) return { mark: `${R}✗${X}`, verdict: `${r.status} — the host refuses THIS SERVER, not this path`, win: false };
  if (r.status === 429) return { mark: `${Y}·${X}`, verdict: "429 — rate limited, ask again later", win: false };
  if (r.status === 404) return { mark: `${D}·${X}`, verdict: "404 — wrong path (the host is fine)", win: false };
  if (r.status === 400) return { mark: `${Y}·${X}`, verdict: `400 — RIGHT PATH, wrong parameters${hint(r)}`, win: false };
  if (!r.ok) return { mark: `${R}✗${X}`, verdict: `${r.status}${hint(r)}`, win: false };
  const bars = barsOf(safeJson(r.body));
  if (!bars) return { mark: `${Y}·${X}`, verdict: `200 but no bar list found${hint(r)} — try DS_CHART_BARS_KEY`, win: false };
  if (!bars.length) return { mark: `${Y}·${X}`, verdict: "200, empty bar list — asked, nothing there", win: false };
  return { mark: `${G}✓${X}`, verdict: `${G}200 with ${bars.length} bar(s)${X}`, win: true, bars };
}

const safeJson = (t) => { try { return typeof t === "string" ? JSON.parse(t) : t; } catch { return null; } };
const hint = (r) => {
  const flat = String(r.body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flat ? ` ${D}— ${flat.slice(0, 110)}${flat.length > 110 ? "…" : ""}${X}` : "";
};

/**
 * Upsert keys into a .env file's TEXT, preserving everything else.
 *
 * ⚠️ AN OPERATOR'S .env IS THE MOST DANGEROUS FILE ON THE BOX. It holds
 * ADMIN_PASS_HASH, INTERNAL_API_TOKEN and the bot keys, and this script has no
 * business touching any of them. So: replace a key that is already there, in
 * place, and append the ones that are not. Never reorder, never reformat,
 * never drop a comment, never rewrite a line it did not put there.
 */
export function upsertEnv(text, kv) {
  let out = String(text ?? "");
  if (out && !out.endsWith("\n")) out += "\n";
  for (const [k, v] of Object.entries(kv)) {
    const line = `${k}=${v}`;
    // Only a real assignment at the start of a line — a commented-out
    // `#DS_CHART_PATH=` stays a comment, and a key that merely appears inside
    // another value is not this key.
    const re = new RegExp(`^${k}=.*$`, "m");
    out = re.test(out) ? out.replace(re, line) : out + line + "\n";
  }
  return out;
}

/** Write the winning shape into .env.local, after a backup. */
function applyEnv(kv, file) {
  const target = resolve(file);
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existsSync(target)) {
    // A dated copy, because the next line rewrites a file holding secrets.
    const bak = `${target}.bak-dsprobe`;
    copyFileSync(target, bak);
    console.log(`  ${D}backed up ${target} → ${bak}${X}`);
  }
  writeFileSync(target, upsertEnv(before, kv), "utf8");
  return target;
}

// ── main ─────────────────────────────────────────────────────────────────────
const SAMPLE = [{ chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC (Solana)" }];
const rawArgv = process.argv.slice(2);
/** `--write` applies the winning shape to .env.local instead of printing it for
 *  a human to paste. Opt-in: a probe that edits an operator's environment
 *  without being asked is not a probe. */
const WRITE = rawArgv.includes("--write");
const ENV_FILE = (rawArgv.find((a) => a.startsWith("--env="))?.slice(6) ?? ".env.local").trim();
const argv = rawArgv.filter((a) => !a.startsWith("--"));
const targets = argv.length >= 2 ? [{ chain: argv[0], address: argv[1], label: `${argv[1].slice(0, 10)}… (${argv[0]})` }] : SAMPLE;

async function main() {
  console.log(`\nWhat is DexScreener's real candle request?   ${D}checkout ${stamp()}${X}`);
  console.log(`${D}  Whether a host answers is a property of THIS box's egress today.${X}\n`);

  let anyWin = false;
  for (const t of targets) {
    console.log(`${C}${t.label}${X}  ${D}${t.chain} ${t.address}${X}`);

    const { pair, why } = await topPair(t.chain, t.address);
    if (!pair) { console.log(`  ${R}✗ resolve${X} ${why}\n`); continue; }
    console.log(`  ${G}✓ resolve${X} pair ${pair.pairAddress} ${D}dex=${pair.dexId || "?"} liq=$${Math.round(pair.liquidityUsd).toLocaleString()}${X}`);

    const d = await discover(pair.chainId, pair.pairAddress);
    if (!d.ok) console.log(`  ${Y}· discover${X} ${d.why} ${D}(candidates fall back to the built-in guesses)${X}`);
    else {
      console.log(`  ${G}✓ discover${X} read ${d.scripts} bundle(s) ${D}hosts: ${d.hosts.join(", ") || "none"}${X}`);
      for (const f of d.fragments.slice(0, 25)) console.log(`      ${D}fragment${X} ${f}`);
      for (const f of d.templates.slice(0, 25)) console.log(`      ${C}template${X} ${f}`);
      if (!d.fragments.length && !d.templates.length) console.log(`      ${D}nothing datafeed-shaped in the bundle — it may be built from split literals${X}`);
    }

    const bases = (process.env.DS_CHART_API ? [strip(process.env.DS_CHART_API)] : [...(d.hosts ?? []).filter((h) => h.startsWith("io.")).map((h) => `https://${h}`), "https://io.dexscreener.com"]);
    // Discovered first, then the built-in guesses. A discovered string is only
    // a candidate PATH if it can actually address a pair — the bundle also
    // yields prefixes like "/dex/log/amm/v9/", which are worth PRINTING for a
    // human to assemble but not worth an HTTP request.
    const addressable = (p) => p.includes("{pair}") || p.includes("{chain}");
    const discovered = [...(d.templates ?? []), ...(d.fragments ?? [])].filter(addressable);
    const paths = [...new Set([...discovered, ...BUILTIN_PATHS])]; // mutable: UDF hits are unshifted in front
    // ⚠️ MILLISECONDS, BECAUSE THAT IS WHAT dsChart.ts SENDS. It builds its
    // window from `Date.now()`. This probe asked in SECONDS, so every request
    // it made was a different request from the one the app makes — and the 400
    // it reported may have been its own unit, not the app's shape. A guard is
    // only honest while it measures the stack the caller actually uses; this
    // repo states that rule about fonts:check and it applies here identically.
    const nowMs = Date.now();
    const vars = { dex: pair.dexId, chain: pair.chainId, pair: pair.pairAddress, from: nowMs - 6 * 3600_000, to: nowMs, res: "15", limit: 100 };

    // A UDF datafeed answers /config with `supported_resolutions`, which no
    // other endpoint does by accident. A hit here pins the ROOT exactly, so
    // /history stops being a guess — and it goes to the front of the sweep.
    const udfPaths = [];
    for (const base of [...new Set(bases)]) {
      for (const root of UDF_ROOTS) {
        const cfg = await udfConfig(base, root, vars);
        if (!cfg) continue;
        console.log(`  ${G}✓ udf${X} ${cfg.url} ${D}resolutions: ${cfg.resolutions.slice(0, 8).join(",")}${X}`);
        // ⚠️ THE TEMPLATE, NOT THE FILLED PATH. `root` still holds `{dex}`, and
        // the dex id is per-token: pinning `/dex/chart/amm/v3/raydium/history`
        // into DS_CHART_PATH would draw every Raydium pair and 404 every
        // Uniswap, Pancake and Orca one — a fix that looks like it worked
        // because the token in front of you happens to be on the right AMM.
        udfPaths.push(`${root}/history`);
      }
    }
    if (udfPaths.length) paths.unshift(...udfPaths);

    console.log(`  ${D}probing ${[...new Set(bases)].length} base(s) × ${paths.length} path(s) × ${BUILTIN_QUERIES.length} query shape(s)${X}`);
    let win = null;
    const base0 = [...new Set(bases)][0];
    const seen = new Map(); // status -> count, so a silent sweep still shows its work
    // ⚠️ THE NEAR MISS IS THE ANSWER, AND IT WAS BURIED. A real run asked 55
    // times and reported "35×404 · 15×403 · 5×400" — that 400 is one path
    // saying "I EXIST, your parameters are wrong", i.e. the single most
    // valuable line in the sweep. It scrolled off the top among fifty others,
    // and the guidance underneath said "a line 400 → that PATH is right"
    // without naming WHICH. A diagnosis the reader has to go hunting for is
    // the defect this whole script exists to remove, one level up.
    const answered = new Map(); // status -> Map(path -> first body hint)
    const note = (status, path, why) => {
      const m = answered.get(status) ?? new Map();
      if (!m.has(path)) m.set(path, why);
      answered.set(status, m);
    };
    for (const base of [...new Set(bases)]) {
      for (const path of paths) {
        for (const q of BUILTIN_QUERIES) {
          const url = `${base}${fill(path, vars)}?${fill(q, vars)}`;
          const r = await get(url);
          const v = classify(r);
          const key = r.status === 0 ? "could not ask" : String(r.status);
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (r.status && r.status !== 404) note(r.status, path, v.verdict);
          // Only a hit, or something that is TALKING to us, is worth a line —
          // a full 404 matrix would bury the one line that matters.
          if (v.win || r.status === 400 || (r.status === 200 && !v.win) || [401, 403, 429, 451].includes(r.status)) {
            console.log(`    ${v.mark} ${D}${path}${X} ${D}?${q}${X}\n        ${v.verdict} ${D}${r.ms}ms${X}`);
          }
          if (v.win && !win) { win = { base, path, q }; break; }
        }
        if (win) break;
      }
      if (win) break;
    }
    // ⚠️ ALWAYS SAY WHAT THE SWEEP SAW. Only lines worth acting on are printed
    // above, so a run that is all 404s prints nothing at all — which reads as
    // "it never asked" rather than "the path is wrong everywhere", and those
    // need opposite next steps.
    const tally = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}×${k}`).join(" · ");
    console.log(`  ${D}asked ${[...seen.values()].reduce((a, b) => a + b, 0)}: ${tally || "nothing"}${X}`);

    // The sweep's findings, named — printed AFTER the tally so they are the
    // last thing on screen, which is where a scrolled terminal leaves the
    // reader. 404s are deliberately not listed: "these seven paths do not
    // exist" is the one fact nobody can act on.
    // ⚠️ A KNOWN PATH IS WORTH MORE THAN ANOTHER ROUND OF PATHS. If something
    // answered 400 the path is settled, so escalate onto it with the real
    // parameter grid rather than reporting a dead end and waiting for a human
    // to come back with a browser.
    let near = answered.get(400);
    if (!win && near?.size) {
      const path = [...near.keys()][0];
      const grid = deepQueries();
      // Announce the cost: 480 shapes at the pace below is the better part of a
      // minute, and a script that goes silent for that long reads as hung —
      // which is how the first version of the token probe was reported.
      const eta = Math.round((grid.length * 110) / 1000);
      console.log(`\n  ${C}▸ path found — sweeping ${grid.length} query shapes on it${X} ${D}${path}${X}`);
      console.log(`    ${D}~${eta}s, paced. Stops early on a hit, or if the host starts refusing.${X}`);
      let refusals = 0;
      let tried = 0;
      for (const g of grid) {
        const r = await get(`${base0}${fill(path, vars)}?${g.q}`);
        const v = classify(r);
        if (v.win) {
          win = { base: base0, path, q: g.tpl };
          console.log(`    ${G}✓${X} ${D}${g.unit} · ${g.resKey}=${g.resVal} · ${g.cbKey} · ${g.extra}${X}  ${v.verdict}`);
          if (!g.canon) {
            // The feed names bar sizes differently from DS_RES, so no template
            // can carry the reader's timeframe — every tab would draw the one
            // size that was probed. Saying this is the difference between a
            // chart that works and one that lies on four tabs out of five.
            console.log(`    ${Y}⚠ it wants "${g.resVal}", but DS_RES sends "15"/"60"/"240"/"1D".${X}`);
            console.log(`      ${Y}The query below PINS ${g.resVal} — every timeframe tab would draw that size.${X}`);
            console.log(`      ${Y}Send me this line: DS_RES needs the feed's vocabulary, which is a code change.${X}`);
          }
          break;
        }
        if ([401, 403, 429, 451].includes(r.status)) refusals++;
        // ⚠️ STOP WHEN THE HOST STARTS REFUSING. Cloudflare answers a burst
        // with 403s, and grinding through 96 of them proves nothing and looks
        // exactly like a wrong grid. Ten in a row is the host talking, not the
        // parameters.
        if (refusals >= 10) {
          console.log(`    ${R}✗${X} the host began refusing this server mid-sweep (${refusals}×) — stopped`);
          break;
        }
        // A dot per 40 shapes, so a long sweep visibly progresses.
        if (++tried % 40 === 0) process.stdout.write(`    ${D}… ${tried}/${grid.length}${X}\n`);
        // Paced: this is somebody else's private endpoint, not ours to hammer.
        await new Promise((r2) => setTimeout(r2, 60));
      }
      if (!win) console.log(`    ${Y}·${X} none of ${grid.length} query shapes was accepted`);
      near = answered.get(400);
    }

    if (near?.size && !win) {
      console.log(`\n  ${Y}▸ THIS PATH EXISTS — only the query is wrong:${X}`);
      for (const [path, why] of near) {
        console.log(`      ${C}${path}${X}`);
        // The upstream's own words usually name the missing parameter, which
        // is the difference between one more .env line and another sweep.
        // bodyHint() prefixes " — "; strip the verdict AND that separator so
        // the upstream's own sentence reads as a sentence.
        const body = String(why).replace(/^400 — RIGHT PATH, wrong parameters\s*/, "").replace(/^—\s*/, "").trim();
        if (body) console.log(`      ${D}it said:${X} ${body}`);
      }
      console.log(`      ${D}Pin it and fix only the query:${X}`);
      console.log(`      ${G}DS_CHART_PATH=${[...near.keys()][0]}${X}`);
    }
    for (const st of [403, 401, 451, 429]) {
      const m = answered.get(st);
      if (!m?.size) continue;
      console.log(`\n  ${R}▸ ${st} on ${m.size} path(s)${X} ${D}— about this server, not about the path:${X}`);
      for (const path of [...m.keys()].slice(0, 6)) console.log(`      ${D}${path}${X}`);
    }

    if (win) {
      anyWin = true;
      const kv = { DS_CHART_API: win.base, DS_CHART_PATH: win.path, DS_CHART_QUERY: win.q };
      if (WRITE) {
        const target = applyEnv(kv, ENV_FILE);
        console.log(`\n  ${G}FOUND IT — and written to ${target}.${X}\n`);
        for (const [k, v] of Object.entries(kv)) console.log(`${G}${k}=${v}${X}`);
        console.log(`\n  ${C}pm2 restart dexvra --update-env${X}   ${D}then:  npm run chart:check${X}\n`);
      } else {
        console.log(`\n  ${G}FOUND IT.${X} Re-run with ${C}--write${X} to apply it, or paste into ${C}${ENV_FILE}${X}:\n`);
        for (const [k, v] of Object.entries(kv)) console.log(`${G}${k}=${v}${X}`);
        console.log(`\n  ${D}Then:  pm2 restart dexvra --update-env  &&  npm run chart:check${X}\n`);
      }
    } else {
      console.log(`\n  ${R}Nothing returned bars.${X} Read the lines above in this order:\n`);
      console.log(`   ${D}• every line 403/401 → the host refuses this server's IP. DS_CHART_HEADERS may help;${X}`);
      console.log(`   ${D}  if not, this box cannot use the datafeed and GeckoTerminal stays the only source.${X}`);
      console.log(`   ${D}• a line 400 → that PATH is right and the query is not. Copy the real query off${X}`);
      console.log(`   ${D}  dexscreener.com in a browser (DevTools → Network → filter "bars") → DS_CHART_QUERY.${X}`);
      console.log(`   ${D}• only 404s → the path moved. The fragments printed above are what its own bundle${X}`);
      console.log(`   ${D}  still contains; assemble one and pin it with DS_CHART_PATH.${X}`);
      console.log(`   ${D}• could not ask → egress. curl -sS -o /dev/null -w '%{http_code}' https://io.dexscreener.com/\n${X}`);
    }
  }
  process.exit(anyWin ? 0 : 1);
}

// ⚠️ ONLY WHEN RUN, NEVER WHEN IMPORTED. The pure halves above are covered by
// src/lib/dsChartProbe.test.ts — a real test that drives them, rather than the
// source guard this repo falls back to when a module cannot be imported. That
// only works if importing this file does not fire a network sweep and call
// process.exit() inside the test runner.
const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_DIRECTLY) main().catch((err) => { console.error(err); process.exit(1); });
