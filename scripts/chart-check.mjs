// chart:check — CAN THIS BOX DRAW A CHART, AND FROM WHICH SOURCE?
//
// The token page answered `Chart unavailable right now — Couldn't read the
// chart just now (GeckoTerminal 429 (rate limited))`, and the answer was a
// second candle source. But the thing that decides whether that second source
// helps is not in this repo:
//
//   WHETHER AN UPSTREAM ANSWERS IS A PROPERTY OF THE SERVER'S EGRESS TODAY.
//
// `raid:check`, `launchpads:check`, `fonts:check` and `trending:check` all say
// that sentence, and this one says it about a request shape that is a GUESS:
// DexScreener publishes no documented OHLCV endpoint, so `providers/dsChart.ts`
// ships its shape the way `pads.js` ships an unverified pad — every part
// overridable from `.env`, so a wrong guess costs a line rather than a deploy.
// THIS SCRIPT IS HOW YOU FIND OUT WHICH IT IS.
//
//   npm run build && npm start &
//   npm run chart:check                       # the shipped sample, both sources
//   npm run chart:check -- bsc 0x8b7a…7777    # one token you are looking at
//   BASE_URL=http://localhost:3005 npm run chart:check
//
// ⚠️ IT DRIVES THE RUNNING SERVER, NOT A COPY OF THE REQUEST — and not the
// provider module directly either, deliberately. Importing `src/**/*.ts` needs
// node's type stripping (the test script passes --experimental-strip-types);
// PRODUCTION RUNS NODE 18, where that import simply throws, and a check that
// cannot run on the box is the class of fix this repo has already paid six days
// for ("apt-get install is not a fix, it is a request"). Going through
// /api/ohlcv measures the real route, the real provider, the real shared
// cooldown and the box's own egress, on whatever node is actually there.
//
// It asks each source SEPARATELY (`?source=…`), because with GeckoTerminal
// healthy the DexScreener path never runs — and a check that only asked
// normally would report a green chart while saying nothing about whether the
// fallback works. That is `fonts:check` printing nine green ticks over a banner
// drawing boxes.
//
// Exits non-zero when NEITHER source can draw the sample, because that is the
// state the report was filed about. One source down is a ⚠, not a failure —
// having two is the entire point.
import { execSync } from "node:child_process";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m";
const BASE = (process.env.BASE_URL ?? "http://localhost:3005").replace(/\/+$/, "");

/** The build stamp of the CHECKOUT. The server's own is on every answer as
 *  `build`, and the two are printed together for the reason `fonts:check`
 *  prints one at all: every round of this has begun with somebody reading a
 *  check as a statement about the fix they just deployed. A mismatch means the
 *  running server is not this code. */
function stamp() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

// A handful of real, deep pairs on chains BOTH sources carry. Not arbitrary: a
// token with no market would fail for a reason that says nothing about this
// box — the false red `pnlImage` is deliberately not probed for, one feature
// over.
const SAMPLE = [
  { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC (Solana)" },
  { chain: "bsc", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", label: "WBNB (BSC)" },
  { chain: "ethereum", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", label: "WETH (Ethereum)" },
];

const argv = process.argv.slice(2);
const targets =
  argv.length >= 2 ? [{ chain: argv[0], address: argv[1], label: `${argv[1].slice(0, 10)}… (${argv[0]})` }] : SAMPLE;

async function ask(chain, address, source) {
  const qs = new URLSearchParams({ chain, address, tf: "15m", source });
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/ohlcv?${qs}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ms: Date.now() - t0, error: `the server answered HTTP ${res.status}` };
    return { ms: Date.now() - t0, body: await res.json() };
  } catch (err) {
    return { ms: Date.now() - t0, error: err?.message ?? String(err) };
  }
}

function line(name, r) {
  const t = `${D}${r.ms}ms${X}`;
  if (r.error) return `    ${R}✗${X} ${name.padEnd(14)} ${R}${r.error}${X} ${t}`;
  const b = r.body ?? {};
  if (b.ok && b.candles?.length)
    return `    ${G}✓${X} ${name.padEnd(14)} ${b.candles.length} candle(s) ${D}${b.source ?? "?"}${b.pool ? ` pool ${String(b.pool).slice(0, 10)}…` : ""} ${r.ms}ms${X}`;
  // ⚠️ "It answered with nothing" and "it could not be asked" are different
  // facts, and the route already keeps them apart in the sentence it returns —
  // so this prints the sentence rather than inventing a verdict over it.
  // ⚠️ "This token has no market here" is an ANSWER, and colouring it red would
  // report a healthy box as broken — the false red this script's sample list is
  // chosen to avoid in the first place. Only "we could not ask" is a ✗.
  const soft = /no candles|no pool|no pair|does not carry|not asked|nothing to chart/i.test(b.why ?? "");
  return `    ${soft ? `${Y}·${X}` : `${R}✗${X}`} ${name.padEnd(14)} ${soft ? Y : R}${b.why ?? "no answer"}${X} ${t}`;
}

const drew = (r) => Boolean(!r.error && r.body?.ok && r.body?.candles?.length);

async function main() {
  console.log(`\nCan this box draw a chart?   ${D}checkout ${stamp()} · server ${BASE}${X}\n`);
  console.log(
    `  ${Y}⚠ DexScreener publishes no documented OHLCV endpoint — its request shape is a guess.${X}\n` +
      `    ${D}A red DexScreener line is a .env fix, not a deploy:${X}\n` +
      `    ${D}  DS_CHART_API pins a base · DS_CHART_PATH rewrites the path${X}\n` +
      `    ${D}  DS_CHART_QUERY rewrites the query ({from} {to} {res} {limit})${X}\n` +
      `    ${D}  DS_CHART_HEADERS replaces the headers ("Name: v|Name: v")${X}\n` +
      `    ${D}  DS_CHART_BARS_KEY names the envelope key · DS_CHART=0 switches it off${X}\n`,
  );
  // ⚠️ HOW TO FIND THE REAL SHAPE. A status alone is not actionable: 403 means
  // the host refused us, 400 means it is TALKING to us and refusing the
  // parameters, and only the second is fixable from here. The endpoint is the
  // one DexScreener's own chart calls, so the operator's own browser is the
  // authoritative source for its shape — and a browser is exactly what this
  // box is not. Saying so is the difference between a diagnosis and a shrug.
  console.log(
    `    ${D}A 400 means the host ANSWERED and refused the parameters. Read the real shape${X}\n` +
      `    ${D}off dexscreener.com in your own browser — DevTools → Network → filter "bars"${X}\n` +
      `    ${D}— then paste its query into DS_CHART_QUERY and its path into DS_CHART_PATH.${X}\n`,
  );

  let gtOk = 0;
  let dsOk = 0;
  let anyDrawn = 0;
  let serverBuild = null;

  for (const t of targets) {
    console.log(`  ${t.label}   ${D}${t.chain}/${t.address.slice(0, 12)}…${X}`);
    // Sequential, not concurrent: this spends the very quota it is measuring,
    // and two sources × three tokens arriving as one burst is how a check
    // manufactures the 429 it then reports.
    const gt = await ask(t.chain, t.address, "geckoterminal");
    console.log(line("GeckoTerminal", gt));
    const ds = await ask(t.chain, t.address, "dexscreener");
    console.log(line("DexScreener", ds));
    serverBuild = gt.body?.build ?? ds.body?.build ?? serverBuild;
    if (drew(gt)) gtOk++;
    if (drew(ds)) dsOk++;
    if (drew(gt) || drew(ds)) anyDrawn++;
    console.log("");
  }

  // ⚠️ A RUN THAT MEASURED NOTHING IS AN ERROR, NEVER A QUIET GREEN. An empty
  // recording reported as a pass is this whole feature's defect in miniature.
  if (!targets.length) {
    console.log(`${R}Nothing was probed — that is a broken check, not a green one.${X}\n`);
    process.exit(1);
  }
  if (serverBuild == null) {
    console.log(
      `${R}✗ The server at ${BASE} did not answer at all.${X}\n` +
        `  Start it (\`npm run build && npm start\`), or point BASE_URL at the right port —\n` +
        `  dexvra.io runs on 3005 under pm2. Nothing above is a statement about the upstreams.\n`,
    );
    process.exit(1);
  }

  const cut = String(serverBuild).replace(/\+dirty$/, "");
  if (cut !== "unknown" && !stamp().startsWith(cut)) {
    // The deploy is the remaining hole and it is not code: the server only ever
    // pulls `main`, so a fix on a branch is not deployed however many times
    // `git pull` runs — and from outside that is indistinguishable from a fix
    // that did not work.
    console.log(
      `  ${Y}⚠ The server is running build ${serverBuild}, this checkout is ${stamp()}.${X}\n` +
        `    ${D}Everything above is a statement about the OLD code.${X}\n`,
    );
  }
  console.log(`  ${D}drew from GeckoTerminal: ${gtOk}/${targets.length} · from DexScreener: ${dsOk}/${targets.length}${X}`);

  // ⚠️ EVERY SAMPLE, FROM EVERY SOURCE — not "each source worked once".
  //
  // This gate was `gtOk && dsOk`, testing two COUNTS for truthiness while only
  // `anyDrawn` was compared against the sample size. So one DexScreener success
  // out of three satisfied it: the script printed two red DexScreener lines and
  // then `Both sources answer from this box`, and exited 0. Reproduced against
  // a stub. That is the exact shape this repo keeps paying for — green meaning
  // "it answered somewhere" rather than "the charts are safe" — and the ⚠ tier
  // below already existed to carry the in-between.
  if (gtOk === targets.length && dsOk === targets.length) {
    console.log(`\n${G}Both sources answer for every sample. A GeckoTerminal cooldown no longer blanks the charts.${X}\n`);
    return;
  }
  if (anyDrawn === targets.length) {
    // One source down is the state this feature exists to survive — and it is
    // exactly the state that becomes an outage the day the other one blinks,
    // unnoticed, because the charts still draw.
    // Every sample drew from SOMETHING, but at least one source missed at least
    // one of them — so those tokens have no fallback, and they are in exactly
    // the state this whole feature exists to end. Named per source with counts,
    // because "one source is down" and "one source is patchy" need different
    // reactions and a bare ⚠ gives them the same one.
    const gaps = [];
    if (gtOk < targets.length) gaps.push(`GeckoTerminal answered for ${gtOk}/${targets.length}`);
    if (dsOk < targets.length) gaps.push(`DexScreener answered for ${dsOk}/${targets.length}`);
    console.log(
      `\n${Y}⚠ Every sample drew, but not from both sources — ${gaps.join(", ")}.${X}\n` +
        `  Those tokens have NO fallback: one cooldown and their charts go blank.\n` +
        (gtOk < targets.length
          ? `  GeckoTerminal: check the quota — GECKOTERMINAL_API_KEY in the repo-root .env raises the ceiling\n` +
            `  rather than dividing it, and the bot suite on this box shares the same per-IP allowance.\n`
          : ``) +
        (dsOk < targets.length
          ? `  DexScreener: the request shape is a guess, and it interpolates the AMM per pair — a miss on\n` +
            `  some chains and not others is the expected shape of a wrong path. Fix it without a deploy:\n` +
            `  DS_CHART_API / DS_CHART_PATH / DS_CHART_BARS_KEY, then restart.\n`
          : ``),
    );
    return;
  }
  console.log(
    `\n${R}✗ ${targets.length - anyDrawn}/${targets.length} sample(s) could not be charted from EITHER source.${X}\n` +
      `  That is the reported state: "Chart unavailable right now".\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n${R}chart:check itself failed: ${err?.stack || err}${X}\n`);
  process.exit(1);
});
