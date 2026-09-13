// Offline unit tests for the Pons v2 provider. No network: a fake JSON-RPC
// node answers every eth_call / eth_getLogs, so the ABI codec, the curve and
// Uniswap V4 price math and the rolling trade window are all exercised for
// real. Run: npm run test:pons
import { registerHooks } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolve } from "./ts-alias-hooks.mjs";

registerHooks({ resolve });

// The announce markers persist to DATA_DIR — point it at a throwaway directory
// before anything reads it, so the tests never touch a real store.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "pons-test-"));

const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= Math.abs(b) * tolerance + 1e-12;

// ── ABI helpers (independent of the implementation under test) ────────────
const word = (v) => {
  let n = BigInt(v);
  if (n < 0n) n += 1n << 256n;
  return n.toString(16).padStart(64, "0");
};
const addrWord = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const stringReturn = (s) => {
  const bytes = Buffer.from(s, "utf8").toString("hex");
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
  return `0x${word(32)}${word(s.length)}${padded}`;
};
const hexResult = (words) => `0x${words.join("")}`;
// five dynamic strings: five offset words, then each length + bytes
const fiveStrings = (values) => {
  const heads = [];
  let tail = "";
  let cursor = 5 * 32;
  for (const v of values) {
    heads.push(word(cursor));
    const bytes = Buffer.from(v, "utf8").toString("hex");
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
    tail += word(v.length) + padded;
    cursor += 32 + padded.length / 2;
  }
  return `0x${heads.join("")}${tail}`;
};

// ── keccak / selector vectors ─────────────────────────────────────────────
const { keccak256Hex } = await import("../src/lib/evm/keccak.ts");
const abi = await import("../src/lib/evm/abi.ts");

check(
  "keccak256 of the empty string",
  keccak256Hex("") === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
);
check(
  'keccak256 of "abc"',
  keccak256Hex("abc") === "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
);
check("ERC-20 transfer selector", abi.selector("transfer(address,uint256)") === "0xa9059cbb");
check(
  "ERC-20 Transfer topic",
  abi.topic0("Transfer(address,address,uint256)") ===
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
);

// ── ABI decoding ──────────────────────────────────────────────────────────
check(
  "decodes a negative int24 (tickSpacing)",
  abi.decodeReturn(["int24"], hexResult([word(-60)]))[0] === -60n,
);
check("decodes a string return", abi.decodeReturn(["string"], stringReturn("PONSY"))[0] === "PONSY");
check(
  "decodes a mixed static tuple",
  JSON.stringify(
    abi.decodeReturn(["address", "bool", "uint16"], hexResult([addrWord("0xabc0000000000000000000000000000000000001"), word(1), word(250)])),
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  ) === '["0xabc0000000000000000000000000000000000001",true,"250"]',
);
check("fromUnits keeps 18-decimal precision", near(abi.fromUnits(1_500_000_000_000_000_000n, 18), 1.5));

// ── Fake Pons deployment ──────────────────────────────────────────────────
const { PONS } = await import("../src/config/pons.ts");

const TOKEN = "0x1111111111111111111111111111111111111111";
const CURVE = "0x2222222222222222222222222222222222222222";
const GRAD_TOKEN = "0x3333333333333333333333333333333333333333";
const GRAD_CURVE = "0x4444444444444444444444444444444444444444";
const POOL_MANAGER = "0x5555555555555555555555555555555555555555";
const MEME_HOOK = "0x6666666666666666666666666666666666666666";
const ZERO = "0x0000000000000000000000000000000000000000";
const ETH_USD = 4000;

const HEAD_BLOCK = 20_000_000;
const HEAD_TS = Math.floor(Date.now() / 1000);
const BLOCK_SECONDS = 0.25;

const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const TOKENS = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

// on-curve launch: 10 ETH phantom + 2 ETH raised against 800M tokens left
const CURVE_QUOTE = ETH(12);
const CURVE_TOKENS = TOKENS(800_000_000);
const CURVE_REAL_QUOTE = ETH(2);
const TOTAL_SUPPLY = TOKENS(1_000_000_000);
const THRESHOLD = ETH(10);

// graduated launch: 1 token = 0.000002 ETH in a full-range V4 position
const GRAD_PRICE_ETH = 0.000002;
const SQRT_PRICE_X96 = BigInt(Math.floor(Math.sqrt(1 / GRAD_PRICE_ETH) * 2 ** 96));
const POOL_LIQUIDITY = 10n ** 21n;

const launchRecord = ({ token, curve, phase, sweptQuote = 0n }) =>
  hexResult([
    addrWord(token), addrWord(curve), addrWord("0x7777777777777777777777777777777777777777"),
    addrWord("0x8888888888888888888888888888888888888888"), addrWord(ZERO),
    word(THRESHOLD), word(3000), word(60), word(100), word(1), word(phase),
    word(sweptQuote), word(0), word(0), word(1),
  ]);

const trades = [
  { block: HEAD_BLOCK - 40, kind: "buy", quote: ETH(0.5), tokens: TOKENS(40_000_000) },
  { block: HEAD_BLOCK - 20, kind: "buy", quote: ETH(0.25), tokens: TOKENS(18_000_000) },
  { block: HEAD_BLOCK - 10, kind: "sell", quote: ETH(0.1), tokens: TOKENS(6_000_000) },
];

const BUY_TOPIC = abi.topic0("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const SELL_TOPIC = abi.topic0("CurveSell(address,address,uint256,uint256,uint256,uint256)");

const tradeLog = (trade, index) => ({
  address: CURVE,
  topics: [
    trade.kind === "buy" ? BUY_TOPIC : SELL_TOPIC,
    `0x${addrWord("0x9999999999999999999999999999999999999999")}`,
    `0x${addrWord("0x9999999999999999999999999999999999999999")}`,
  ],
  // fee and tax are zero here, so the AMM leg equals the raw amounts
  data: hexResult(
    trade.kind === "buy"
      ? [word(trade.quote), word(trade.tokens), word(0), word(0)]
      : [word(trade.tokens), word(trade.quote), word(0), word(0)],
  ),
  blockNumber: `0x${trade.block.toString(16)}`,
  transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
  logIndex: `0x${index.toString(16)}`,
});

const LAUNCHED_TOPIC = abi.topic0("TokenLaunched(address,address,address,address,uint256,uint256)");

const launches = [
  { block: HEAD_BLOCK - 30, token: TOKEN, curve: CURVE },
  { block: HEAD_BLOCK - 2000, token: GRAD_TOKEN, curve: GRAD_CURVE },
];

const launchLog = (launch, index) => ({
  address: PONS.factoryV2,
  topics: [
    LAUNCHED_TOPIC,
    `0x${addrWord(launch.token)}`,
    `0x${addrWord(launch.curve)}`,
    `0x${addrWord("0x7777777777777777777777777777777777777777")}`,
  ],
  data: hexResult([addrWord(ZERO), word(1), word(THRESHOLD)]),
  blockNumber: `0x${launch.block.toString(16)}`,
  transactionHash: `0x${(index + 100).toString(16).padStart(64, "0")}`,
  logIndex: `0x${index.toString(16)}`,
});

const SEL = (sig) => abi.selector(sig);

function ethCallResult(to, data) {
  const target = to.toLowerCase();
  const sel = data.slice(0, 10);

  if (target === PONS.factoryV2) {
    if (sel === SEL("getLaunchedToken(address)")) {
      const argument = `0x${data.slice(10 + 24, 10 + 64)}`;
      if (argument.toLowerCase() === TOKEN) return launchRecord({ token: TOKEN, curve: CURVE, phase: 0 });
      if (argument.toLowerCase() === GRAD_TOKEN)
        return launchRecord({ token: GRAD_TOKEN, curve: GRAD_CURVE, phase: 2, sweptQuote: THRESHOLD });
      return hexResult(Array.from({ length: 15 }, () => word(0)));
    }
    if (sel === SEL("poolManager()")) return hexResult([addrWord(POOL_MANAGER)]);
    if (sel === SEL("memeHook()")) return hexResult([addrWord(MEME_HOOK)]);
  }

  if (target === CURVE || target === GRAD_CURVE) {
    const live = target === CURVE;
    if (sel === SEL("getReserves()"))
      return hexResult(live ? [word(CURVE_QUOTE), word(CURVE_TOKENS)] : [word(0), word(0)]);
    if (sel === SEL("realQuoteReserve()")) return hexResult([word(live ? CURVE_REAL_QUOTE : 0n)]);
    if (sel === SEL("sellableTokens()")) return hexResult([word(live ? CURVE_TOKENS : 0n)]);
    if (sel === SEL("graduated()")) return hexResult([word(live ? 0 : 1)]);
    if (sel === SEL("token()")) return hexResult([addrWord(live ? TOKEN : GRAD_TOKEN)]);
  }

  if (target === TOKEN || target === GRAD_TOKEN) {
    if (sel === SEL("decimals()")) { decimalsAsks++; return hexResult([word(18)]); }
    if (sel === SEL("totalSupply()")) return hexResult([word(TOTAL_SUPPLY)]);
    if (sel === SEL("symbol()")) return stringReturn("PONSY");
    if (sel === SEL("name()")) return stringReturn("Pons Yield");
    if (sel === SEL("logo()")) return stringReturn("https://cdn.example/ponsy.png");
    if (sel === SEL("socials()")) return fiveStrings(["https://x.com/ponsy", "https://t.me/ponsy", "", "https://ponsy.example", "  "]);
    if (sel === SEL("description()")) return stringReturn("A potato that drips. Community-run, fixed supply, liquidity locked at graduation.");
  }

  if (target === POOL_MANAGER && sel === SEL("extsload(bytes32)")) {
    // Two slots are read per pool: slot0 then slot0 + LIQUIDITY_OFFSET. We
    // don't re-derive the slot here — the first read gets the packed Slot0,
    // any second read gets the liquidity.
    extsloadCalls++;
    return extsloadCalls % 2 === 1
      ? hexResult([word(SQRT_PRICE_X96)])
      : hexResult([word(POOL_LIQUIDITY)]);
  }

  throw new Error(`unstubbed eth_call ${target} ${sel}`);
}

let extsloadCalls = 0;
// How many times the chain was asked for a token's decimals — the only way to
// see whether a REFUSED read was written into the "it never changes" cache.
let decimalsAsks = 0;
let rpcRequests = 0;

function handle({ method, params }) {
  if (method === "eth_call") return ethCallResult(params[0].to, params[0].data);
  if (method === "eth_getBlockByNumber") {
    const tag = params[0];
    const number = tag === "latest" ? HEAD_BLOCK : Number(BigInt(tag));
    return {
      number: `0x${number.toString(16)}`,
      timestamp: `0x${Math.round(HEAD_TS - (HEAD_BLOCK - number) * BLOCK_SECONDS).toString(16)}`,
    };
  }
  if (method === "eth_getLogs") {
    const { address, fromBlock, toBlock } = params[0];
    const from = Number(BigInt(fromBlock));
    const to = Number(BigInt(toBlock));
    const target = String(address).toLowerCase();
    if (target === CURVE) {
      return trades.filter((t) => t.block >= from && t.block <= to).map(tradeLog);
    }
    if (target === PONS.factoryV2) {
      return launches.filter((l) => l.block >= from && l.block <= to).map(launchLog);
    }
    return [];
  }
  throw new Error(`unstubbed method ${method}`);
}

// Which rung of the ETH/USD ladder (providers/pons/quoteUsd.ts) answers.
// "coinbase" is the shipped happy path; "gt" refuses the two free rungs so
// GeckoTerminal has to answer; "none" refuses all three, which is the state
// that used to publish TBA over a curve price the chain had just answered.
let quoteMode = "coinbase";
// When set, every RPC batch carrying an eth_getLogs never answers.
let hangLogs = false;
// "ok" · "refuse-curve" (HTTP 429 to any eth_call aimed at the curve or the
// token — the launch RECORD still answers) · "refuse-all" (429 to everything).
let rpcMode = "ok";
let refusedRpc = 0;
// "revert-logo": token.logo() REVERTS — the contract answering "no logo".
// "limit-meta": the node answers the batch 200 but the symbol/name/logo
// ITEMS carry `-32005 rate limit exceeded` (some public nodes do this per
// call) while decimals/totalSupply and the curve answer. `singleRetries`
// counts the refused selectors re-asked ONE AT A TIME afterwards — the
// hammering — and must stay 0.
let singleRetries = 0;
const META_SELS = () => [SEL("symbol()"), SEL("name()"), SEL("logo()")];

const refused = () => new Response("busy", { status: 503, headers: { "content-type": "text/plain" } });

globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes("api.coinbase.com")) {
    if (quoteMode !== "coinbase") return refused();
    return new Response(JSON.stringify({ data: { base: "ETH", currency: "USD", amount: String(ETH_USD) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (href.includes("api.dexscreener.com")) {
    // Never answers in this harness: the rung is the same reader the board
    // uses (fetchDsMarket), and its parser has its own tests. What is under
    // test here is that a refusal FALLS THROUGH and is NAMED.
    return refused();
  }
  if (href.includes("api.geckoterminal.com")) {
    if (quoteMode === "none") return refused();
    return new Response(
      JSON.stringify({
        data: { attributes: { token_prices: { [PONS.nativeUsdRef.address]: String(ETH_USD) } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (href === PONS.rpcUrl) {
    rpcRequests++;
    const body = JSON.parse(init.body);
    // A node that takes its TIME over a log walk — the histories are the only
    // Pons read that uses eth_getLogs, so this stalls exactly the side read
    // `fetchPonsLaunch` bounds, and nothing else.
    if (hangLogs && (Array.isArray(body) ? body : [body]).some((e) => e && e.method === "eth_getLogs")) {
      return new Promise(() => {});
    }
    const entries = Array.isArray(body) ? body : [body];
    const aimedAt = (e) => String(e?.params?.[0]?.to || "").toLowerCase();
    // "refuse-pool": the poolManager's extsload reads answer 429 while the
    // launch record and the curve answer perfectly — a GRADUATED launch prices
    // off its POOL, so this is the same fact as a refused curve read one
    // function up.
    // "refuse-decimals": token() answers and decimals() is refused, which is
    // the one shape that reaches the cache write.
    const isDecimalsRead = (e) =>
      e && e.method === "eth_call" && String(e?.params?.[0]?.data || "").startsWith(SEL("decimals()"));
    const isPoolRead = (e) =>
      e && e.method === "eth_call" && aimedAt(e) === POOL_MANAGER &&
      String(e?.params?.[0]?.data || "").startsWith(SEL("extsload(bytes32)"));
    if (rpcMode === "refuse-decimals" && entries.some(isDecimalsRead)) {
      refusedRpc++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }
    if (rpcMode === "refuse-pool" && entries.some(isPoolRead)) {
      refusedRpc++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }
    if (rpcMode === "refuse-all" || (rpcMode === "refuse-curve" && entries.some((e) => e && e.method === "eth_call" && [CURVE, TOKEN].includes(aimedAt(e))))) {
      refusedRpc++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }
    const respond = (entry) => {
      const sel = String(entry?.params?.[0]?.data || "").slice(0, 10);
      if (entry?.method === "eth_call" && aimedAt(entry) === TOKEN && META_SELS().includes(sel)) {
        if (rpcMode === "limit-meta") {
          if (!Array.isArray(body)) singleRetries++;
          return { jsonrpc: "2.0", id: entry.id, error: { code: -32005, message: "rate limit exceeded" } };
        }
        if (rpcMode === "revert-logo" && sel === SEL("logo()")) {
          return { jsonrpc: "2.0", id: entry.id, error: { code: 3, message: "execution reverted" } };
        }
      }
      try {
        return { jsonrpc: "2.0", id: entry.id, result: handle(entry) };
      } catch (err) {
        return { jsonrpc: "2.0", id: entry.id, error: { message: String(err.message) } };
      }
    };
    const payload = Array.isArray(body) ? body.map(respond) : respond(body);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch ${href}`);
};

// ── Provider behaviour ────────────────────────────────────────────────────
const pons = await import("../src/lib/providers/pons/index.ts");
const { __resetHistories } = await import("../src/lib/providers/pons/trades.ts");

__resetHistories();
const market = await pons.fetchPonsMarket([TOKEN]);
const live = market.get(TOKEN);

check("on-curve launch produces a market", Boolean(live));
if (live) {
  const expectedPrice = (12 / 800_000_000) * ETH_USD;
  check("curve spot price", near(live.priceUsd, expectedPrice, 1e-9), `${live.priceUsd} vs ${expectedPrice}`);
  check("market cap is price × fixed supply", near(live.mcap, expectedPrice * 1e9, 1e-9), String(live.mcap));
  check("liquidity is the real quote backing", near(live.liq, 2 * ETH_USD, 1e-9), String(live.liq));
  check("pool address is the bonding curve", live.poolAddress.toLowerCase() === CURVE);
  check("logo comes from the token contract", live.logoUrl === "https://cdn.example/ponsy.png");
  check(
    "5m txns counted from curve logs",
    live.txns["5m"].buys === 2 && live.txns["5m"].sells === 1,
    JSON.stringify(live.txns["5m"]),
  );
  check(
    "5m volume is the AMM-leg notional in USD",
    near(live.vol["5m"], 0.85 * ETH_USD, 1e-9),
    String(live.vol["5m"]),
  );
  // spot 12/800M ETH against the window's opening trade at 0.5/40M ETH
  check(
    "5m price change measured against the window's opening trade",
    near(live.chg["5m"], 20, 1e-9),
    String(live.chg["5m"]),
  );
  check(
    "coverage is reported and short of a day on a cold start",
    live.statsCoverageMinutes > 0 && live.statsCoverageMinutes < 1440,
    String(live.statsCoverageMinutes),
  );
}

// A graduated launch prices off the locked Uniswap V4 position.
__resetHistories();
const graduated = (await pons.fetchPonsMarket([GRAD_TOKEN])).get(GRAD_TOKEN);
check("graduated launch produces a market", Boolean(graduated));
if (graduated) {
  check(
    "V4 pool spot price round-trips",
    near(graduated.priceUsd, GRAD_PRICE_ETH * ETH_USD, 1e-6),
    `${graduated.priceUsd} vs ${GRAD_PRICE_ETH * ETH_USD}`,
  );
  const sqrtP = Number(SQRT_PRICE_X96) / 2 ** 96;
  check(
    "V4 pool liquidity counted both sides",
    near(graduated.liq, (1e21 / sqrtP / 1e18) * 2 * ETH_USD, 1e-6),
    String(graduated.liq),
  );
}

// Periods the window can't back yet must not be published as complete —
// providers/index.ts keeps the listing's own figure for those.
const { coveredPeriods } = await import("../src/lib/providers/market.ts");
if (live) {
  const covered = coveredPeriods(live);
  check(
    "short periods are covered, a full day is not",
    covered.has("5m") && covered.has("1h") && !covered.has("24h"),
    [...covered].join(","),
  );
  check(
    "a provider without a coverage claim covers every period",
    coveredPeriods({ ...live, statsCoverageMinutes: undefined }).size === 4,
  );
}

// Unknown addresses must not fabricate a market.
const unknown = await pons.fetchPonsMarket(["0xdead00000000000000000000000000000000dead"]);
check("unknown token yields no market", unknown.size === 0);

// An unreachable endpoint must not read as "not a Pons launch".
const workingFetch = globalThis.fetch;
globalThis.fetch = async (url, init) =>
  String(url) === PONS.rpcUrl ? Promise.reject(new Error("connection refused")) : workingFetch(url, init);
let rpcDownThrew = false;
try {
  await pons.fetchPonsLaunch(TOKEN);
} catch {
  rpcDownThrew = true;
}
check("an unreachable RPC surfaces as an error, not a missing launch", rpcDownThrew);
globalThis.fetch = workingFetch;

// The scanner reads launch facts rather than heuristics.
const safety = await pons.scanPonsToken(TOKEN);
check("scanner recognises the launch", Boolean(safety) && safety.chain === "robinhood");
if (safety) {
  const labels = safety.fps.map((f) => f.flag.label);
  check("scanner reports the locked-liquidity story", labels.includes("Liquidity"));
  check("scanner reports the creator tax", safety.fps.some((f) => f.flag.label === "Creator tax" && f.flag.value === "1.0%"));
  check("scanner reports curve progress", labels.includes("Curve progress"));
}

// Trades surface in the app's shape, newest first.
__resetHistories();
const feed = await pons.fetchPonsTrades(CURVE);
check("trade feed is populated", feed.length === 3, `len=${feed.length}`);
check("trade feed is newest first", feed.length === 3 && feed[0].ts >= feed[2].ts);
check("trade usd value uses the ETH reference price", feed.length > 0 && near(feed[0].usd, 0.1 * ETH_USD, 1e-9));

check("the fake node was actually driven", rpcRequests > 0, `${rpcRequests} requests`);

// ── Launch feed (the discovery feed and the listing bot's input) ──────────
const { __resetLaunchFeed } = await import("../src/lib/providers/pons/launches.ts");
__resetHistories();
__resetLaunchFeed();
extsloadCalls = 0;

const feedResult = await pons.fetchPonsLaunchFeed(10);
check("launch feed finds both TokenLaunched events", feedResult.items.length === 2, `n=${feedResult.items.length}`);
if (feedResult.items.length === 2) {
  const [newest, older] = feedResult.items;
  check("launch feed is newest first", newest.address.toLowerCase() === TOKEN);
  check("launch feed reads the on-chain ticker", newest.symbol === "PONSY");
  check("launch feed dates the launch from the head", newest.ageMinutes >= 0 && newest.ageMinutes < 5, String(newest.ageMinutes));
  check(
    "launch feed reports curve progress (2 of 10 ETH raised)",
    near(newest.progressPct, 20, 1e-9),
    String(newest.progressPct),
  );
  check("launch feed prices the launch", near(newest.priceUsd, (12 / 800_000_000) * ETH_USD, 1e-9));
  check("launch feed flags a graduated launch", older.graduated === true && older.phase === "PoolCreated");
  check("launch feed links out to Pons", newest.ponsUrl.startsWith(PONS.app));
}

// ── Channel posts ─────────────────────────────────────────────────────────
const messages = await import("../src/lib/notify/messages.ts");
const hostile = {
  address: TOKEN,
  chain: "robinhood",
  symbol: "EVIL",
  name: '<script>alert("xss")</script> & friends',
  logo: null,
  launchedAt: HEAD_TS,
  ageMinutes: 3,
  phase: "NotGraduated",
  graduated: false,
  nativeQuote: true,
  creatorTaxBps: 100,
  progressPct: 42,
  priceUsd: 0.00006,
  mcapUsd: 60000,
  liquidityUsd: 8000,
  ponsUrl: `${PONS.app}/token/${TOKEN}`,
  explorerUrl: `${PONS.explorer}/token/${TOKEN}`,
};
const launchPost = messages.launchAnnouncement(hostile);
check("launch post names the token", launchPost.includes("$EVIL"));
check("launch post shows curve progress", launchPost.includes("bonding curve 42%"));
check("launch post says it is not a listing", launchPost.includes("not a Dexvra listing"));
check(
  "launch post escapes on-chain metadata",
  !launchPost.includes("<script>") && launchPost.includes("&lt;script&gt;"),
);

// ── The board's last-resort source ────────────────────────────────────────
// This runs on every market cycle, so the only behaviour that matters is that
// it can never throw and never keep trying a chain this box cannot reach.
const { __resetPonsCooldown } = pons;
__resetHistories();
__resetLaunchFeed();
__resetPonsCooldown();

const goodFetch = globalThis.fetch;
let rpcAttempts = 0;
globalThis.fetch = async (url, init) => {
  if (String(url) === PONS.rpcUrl) {
    rpcAttempts++;
    throw new Error("connection refused");
  }
  return goodFetch(url, init);
};

const downResult = await pons.fetchPonsFallbackMarket("robinhood", [TOKEN]);
check("a dead RPC returns null rather than throwing", downResult === null);
const attemptsAfterFirst = rpcAttempts;
check("the failing read actually reached the network", attemptsAfterFirst > 0);

await pons.fetchPonsFallbackMarket("robinhood", [TOKEN]);
check(
  "a failure parks the reader — the next cycle costs nothing",
  rpcAttempts === attemptsAfterFirst,
  `${rpcAttempts} vs ${attemptsAfterFirst}`,
);

globalThis.fetch = goodFetch;
__resetPonsCooldown();
check(
  "a chain with no launchpad is never read at all",
  (await pons.fetchPonsFallbackMarket("solana", [TOKEN])) === null,
);

__resetHistories();
__resetPonsCooldown();
const recovered = await pons.fetchPonsFallbackMarket("robinhood", [TOKEN]);
check("it answers again once the chain is reachable", recovered !== null && recovered.size === 1);

// ── The creator's socials, straight off the token ─────────────────────────
// This is what the listing form autofills from: an indexer has nothing for a
// token still on its curve, and the launchpad's HTTP paths are a guess.
__resetHistories();
const detail = await pons.fetchPonsLaunch(TOKEN);
check("the launch detail reads the socials", Boolean(detail?.socials));
check("and the creator's description", (detail?.description || "").startsWith("A potato that drips"));
if (detail?.socials) {
  check("a set social comes through", detail.socials.twitter === "https://x.com/ponsy");
  check("website too", detail.socials.website === "https://ponsy.example");
  check("an EMPTY field is null, never an empty string", detail.socials.discord === null);
  check("so is a whitespace-only one", detail.socials.farcaster === null, JSON.stringify(detail.socials.farcaster));
}

// bot/ owns the "now live" announcement, so this repo must not carry a second
// copy of it — and the poster must not be able to reach the bot's channel.
const telegram = await import("../src/lib/notify/telegram.ts");
check("the web app announcer has no listing message", messages.listingAnnouncement === undefined);
process.env.TELEGRAM_BOT_TOKEN = "bot-suite-token";
process.env.TELEGRAM_CHAT_ID = "@botsuitechannel";
check(
  "the bot suite's credentials do not configure this announcer",
  telegram.telegramConfigured() === false,
);
process.env.PONS_ANNOUNCE_BOT_TOKEN = "own-token";
process.env.PONS_ANNOUNCE_CHAT_ID = "@ownchannel";
check("its own credentials do", telegram.telegramConfigured() === true);
delete process.env.PONS_ANNOUNCE_BOT_TOKEN;
delete process.env.PONS_ANNOUNCE_CHAT_ID;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

// ── A batch whose ITEMS fail is not a batch that failed ───────────────────
// The node answers a well-formed array and puts the refusal inside each entry,
// so the whole-payload fallback never fires. Every caller here GROUPS its
// reads, so one lost item empties a whole row — which reads exactly like a
// token with no data.
{
  const { rpcBatch } = await import("../src/lib/evm/rpc.ts");
  const url = "https://fake.rpc.test/";
  let batches = 0;
  let singles = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    if (String(target) !== url) return previous(target, init);
    const body = JSON.parse(init.body);
    const answer = (entry, index) =>
      // the node serves items 0 and 3 and refuses the rest of the batch
      index === 0 || index === 3
        ? { jsonrpc: "2.0", id: entry.id, result: `0x${(index + 1).toString(16).padStart(64, "0")}` }
        : { jsonrpc: "2.0", id: entry.id, error: { message: "batch limit exceeded" } };
    if (Array.isArray(body)) {
      batches++;
      return new Response(JSON.stringify(body.map(answer)), { status: 200 });
    }
    singles++;
    // one at a time, the same node answers perfectly
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"ab".padStart(64, "0")}` }),
      { status: 200 },
    );
  };

  const calls = Array.from({ length: 6 }, (_, i) => ({ method: "eth_call", params: [{ to: "0x0", data: `0x0${i}` }, "latest"] }));
  const out = await rpcBatch(url, calls, 2000);
  globalThis.fetch = previous;

  check("a partly-refused batch still answers every call", out.every((o) => o.ok), out.map((o) => o.ok).join(","));
  check("the batch is sent once", batches === 1, `${batches} batch(es)`);
  check(
    "only the LOST items are retried individually",
    singles === 4,
    `${singles} single call(s), expected 4 of 6`,
  );
  check(
    "an item the batch served is not re-asked",
    out[0].value === `0x${(1).toString(16).padStart(64, "0")}`,
    String(out[0].value).slice(0, 12),
  );
}

// ── The check script carries a PORT of the deployment constants ───────────
// Production runs Node 18, so scripts/pons-check.mjs cannot import
// src/config/pons.ts. A drifted default there makes the diagnostic report a
// healthy box as broken — or point at the wrong factory entirely.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./pons-check.mjs", import.meta.url), "utf8");
  const portOf = (name) => {
    const m = new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*"([^"]+)"`).exec(src);
    return m ? m[1] : null;
  };
  check(
    "the check script's RPC default equals the app's",
    portOf("PONS_RPC_URL") === PONS.rpcUrl,
    `${portOf("PONS_RPC_URL")} vs ${PONS.rpcUrl}`,
  );
  check(
    "the check script's factory default equals the app's",
    (portOf("PONS_FACTORY") || "").toLowerCase() === PONS.factoryV2,
    `${portOf("PONS_FACTORY")} vs ${PONS.factoryV2}`,
  );
  check("the check script names the chain id the app uses", src.includes(`CHAIN_ID = ${PONS.chainId}`));
}

// ── The ETH/USD reference is a LADDER, and a curve price survives losing it ─
// "bagaimana kalo token listing di pons v2 dan bot kita tidak bisa baca price
// dan marketcap masih tba" — the USD figure used to hang on GeckoTerminal
// alone, the one metered source on the box, and `describe()` nulled the
// curve's own spot price along with it. Driven through the real
// fetchPonsLaunch, which is what /api/pons and therefore the bot reads.
{
  const viaCoinbase = await (async () => {
    quoteMode = "coinbase";
    pons.__resetNativeUsd();
    __resetHistories();
    return pons.fetchPonsLaunch(TOKEN);
  })();
  check("the shipped ladder prices ETH off Coinbase first", viaCoinbase?.quoteUsdSource === "coinbase", String(viaCoinbase?.quoteUsdSource));
  check("…and a priced record carries no marketWhy", viaCoinbase != null && viaCoinbase.marketWhy === null, String(viaCoinbase?.marketWhy));
  check("…with a USD price", viaCoinbase != null && viaCoinbase.priceUsd > 0, String(viaCoinbase?.priceUsd));

  quoteMode = "gt";
  pons.__resetNativeUsd();
  __resetHistories();
  const viaGt = await pons.fetchPonsLaunch(TOKEN);
  check("two free rungs refusing falls through to GeckoTerminal", viaGt?.quoteUsdSource === "geckoterminal", String(viaGt?.quoteUsdSource));
  check(
    "…at the same USD price",
    viaGt != null && viaCoinbase != null && near(viaGt.priceUsd, viaCoinbase.priceUsd, 1e-9),
    `${viaGt?.priceUsd} vs ${viaCoinbase?.priceUsd}`,
  );

  quoteMode = "none";
  pons.__resetNativeUsd();
  __resetHistories();
  const noRef = await pons.fetchPonsLaunch(TOKEN);
  check("no USD reference → USD price is null, never a fabricated number", noRef != null && noRef.priceUsd === null && noRef.mcapUsd === null, `${noRef?.priceUsd} / ${noRef?.mcapUsd}`);
  // ⚠️ The chain's own answer is a FACT and must not be nulled with the USD
  // figure — that is exactly what `describe()` used to do.
  check(
    "…but the curve's spot price in ETH survives",
    noRef != null && viaCoinbase != null && noRef.priceQuote > 0 && near(noRef.priceQuote, viaCoinbase.priceQuote, 1e-12),
    `${noRef?.priceQuote} vs ${viaCoinbase?.priceQuote}`,
  );
  check(
    "…and marketWhy names every rung that refused",
    ["coinbase", "dexscreener", "geckoterminal"].every((r) => String(noRef?.marketWhy || "").includes(r)),
    String(noRef?.marketWhy),
  );
  check("…with no source claimed", noRef != null && noRef.quoteUsdSource === null, String(noRef?.quoteUsdSource));

  // The route shortens its cache on exactly this record, and decides it from
  // the record's own fields — never from the sentence.
  check("unpricedByUs: a native-quoted launch with an ETH price and no USD price is OURS", pons.unpricedByUs(noRef) === true);
  check("…a priced record is not", pons.unpricedByUs(viaCoinbase) === false);
  check("…an ERC-20-quoted launch is the token's fact, not ours", pons.unpricedByUs({ priceUsd: null, priceQuote: 2e-9, quoteSymbol: null }) === false);
  check("…and a launch whose curve answered no price is not ours either", pons.unpricedByUs({ priceUsd: null, priceQuote: null, quoteSymbol: "ETH" }) === false);

  // ⚠️ THE BOARD'S FALLBACK MUST NOT PARK OVER A USD REFERENCE. It used to
  // `await nativeUsd()` uncaught, so a ladder with no rung standing threw,
  // and pons/index.ts read the throw as a dead chain and parked the reader
  // for five minutes over snapshots it had just read. An empty map, the
  // reason logged, and the next cycle asks again.
  pons.__resetPonsCooldown();
  __resetHistories();
  const rpcBefore = rpcRequests;
  let fallback = null;
  let fallbackThrew = false;
  try {
    fallback = await pons.fetchPonsFallbackMarket("robinhood", [TOKEN]);
  } catch {
    fallbackThrew = true;
  }
  check("the board fallback does not throw when the ETH/USD ladder has no rung standing", !fallbackThrew);
  check("…it answers an EMPTY map — no dollar figure is no row, never a fabricated one", fallback instanceof Map && fallback.size === 0, String(fallback));
  const rpcMid = rpcRequests;
  await pons.fetchPonsFallbackMarket("robinhood", [TOKEN]);
  check("…and the reader is NOT parked — the next cycle still reads the chain", rpcRequests > rpcMid, `${rpcMid} → ${rpcRequests} (first read cost ${rpcMid - rpcBefore})`);

  quoteMode = "coinbase";
  pons.__resetNativeUsd();
}

// ── The side reads are BOUNDED, so a slow log walk cannot hold the price ───
// The bot reads /api/pons on a 5s clock for a paid post's figures. The curve
// histories feed only the period stats; a public RPC taking its time over six
// log chunks used to hold the WHOLE record past that deadline — a TBA by a
// longer road, over a price the snapshot had already answered. Measured with
// a node that never answers a log walk: the record still comes out, priced,
// inside SIDE_MS plus a margin.
{
  const { SIDE_MS } = await import("../src/lib/providers/pons/market.ts");
  check("SIDE_MS is exported, so this measures the real bound", Number.isFinite(SIDE_MS) && SIDE_MS > 0, String(SIDE_MS));
  __resetHistories();
  pons.__resetNativeUsd();
  hangLogs = true;
  const t0 = performance.now();
  const slow = await pons.fetchPonsLaunch(TOKEN);
  const elapsed = performance.now() - t0;
  hangLogs = false;
  check("a launch is still described while its log walk hangs", slow != null && slow.priceUsd > 0, String(slow?.priceUsd));
  check("…inside the side-read bound", elapsed < SIDE_MS + 1500, `${Math.round(elapsed)}ms against ${SIDE_MS}ms`);
  check("…and the walk was genuinely stalled, not skipped", elapsed >= SIDE_MS - 50, `${Math.round(elapsed)}ms`);
  __resetHistories();
}

// ── A node that REFUSES is named — never rendered as a token with nothing in it ─
// The box: the public Robinhood RPC answered HTTP 429, the app's curve/meta
// batch failed, and the record went out with name, symbol, logo and price all
// null and the sentence "the curve and the pool answered no price" — read by
// the check as "the creator filled nothing in" and by the post as TBA. Driven
// through the real fetchPonsLaunch against a node that refuses.
{
  const { __resetRpc } = await import("../src/lib/evm/rpc.ts");
  __resetRpc();
  __resetHistories();
  pons.__resetNativeUsd();
  quoteMode = "coinbase";
  rpcMode = "refuse-curve";
  refusedRpc = 0;
  const degraded = await pons.fetchPonsLaunch(TOKEN);
  check("a launch whose CURVE the node refused still answers — the record read worked", degraded != null);
  check("…and carries the node's reason", /429/.test(String(degraded?.readWhy)), String(degraded?.readWhy));
  check("…marketWhy names the READ, not the ladder", /could not read the curve — .*429/.test(String(degraded?.marketWhy)), String(degraded?.marketWhy));
  check("…name is null WITH a reason — never 'the creator filled nothing in'", degraded?.name === null && degraded?.readWhy != null);
  check("…and the route would not cache it for the full TTL", pons.unpricedByUs(degraded) === true);
  check("…the refusing host was asked once per batch — never one call at a time", refusedRpc <= 2, `${refusedRpc} refused request(s)`);
  __resetRpc();

  rpcMode = "refuse-all";
  refusedRpc = 0;
  let threw = null;
  try { await pons.fetchPonsLaunch(TOKEN); } catch (e) { threw = e; }
  check("a launch RECORD the node refused THROWS (a 503 the bot parks on) — never null (a 404 the bot memos as 'never launched')", threw != null && /429/.test(String(threw?.message)), String(threw?.message));
  check("…again without hammering", refusedRpc <= 2, `${refusedRpc} refused request(s)`);
  __resetRpc();

  // ⚠️ A REVERT IS THE CONTRACT ANSWERING, NOT THE NODE REFUSING. The first
  // cut took the first FAILED outcome of the nine as "the node did not
  // answer" — so a token whose logo() reverts (no such function, an older
  // token) would carry readWhy "execution reverted", be re-keyed under the
  // 3s TTL for ever by unpricedByUs, and send the check to blame the node.
  rpcMode = "revert-logo";
  __resetHistories();
  pons.__resetNativeUsd();
  const reverted = await pons.fetchPonsLaunch(TOKEN);
  check("a logo() that REVERTS is the token's answer — readWhy stays null", reverted != null && reverted.readWhy === null, String(reverted?.readWhy));
  check("…the record is otherwise whole (name, price)", reverted?.name === "Pons Yield" && reverted?.logo === null && Number(reverted?.priceUsd) > 0, `${reverted?.name} ${reverted?.logo} ${reverted?.priceUsd}`);
  check("…and it is NOT re-keyed under the short TTL", pons.unpricedByUs(reverted) === false);
  __resetRpc();

  // ⚠️ AND A PARTIAL REFUSAL IS STILL OUR REASON. Decimals and totalSupply
  // answer (so `meta` decodes), the curve answers (so there is a price), and
  // symbol/name/logo come back `-32005 rate limit exceeded` per item. The
  // old rule — readWhy only when curve or meta failed to decode — left this
  // record with readWhy null, name "" and a full TTL: "the creator filled
  // nothing in", cached, over a node saying no.
  rpcMode = "limit-meta";
  singleRetries = 0;
  __resetHistories();
  pons.__resetNativeUsd();
  const partial = await pons.fetchPonsLaunch(TOKEN);
  check("a per-ITEM rate limit on name/symbol carries the node's reason", /rate limit/.test(String(partial?.readWhy)), String(partial?.readWhy));
  check("…with the reads that answered kept (decimals, price)", partial?.decimals === 18 && Number(partial?.priceUsd) > 0, `${partial?.decimals} ${partial?.priceUsd}`);
  check("…name is null WITH a reason", partial?.name === null && partial?.readWhy != null);
  check("…the record is re-keyed under the short TTL", pons.unpricedByUs(partial) === true);
  check("…and the refused items were NOT re-asked one at a time", singleRetries === 0, `${singleRetries} single retries`);
  __resetRpc();

  // ⚠️ A GRADUATED LAUNCH PRICES OFF ITS POOL, and a refused pool read was the
  // one path still rendering as "the curve and the pool answered no price" —
  // readWhy null, the record cached for the full TTL, and the check sent to
  // the ETH/USD ladder over a node that was rate-limiting the box.
  rpcMode = "refuse-pool";
  __resetHistories();
  pons.__resetNativeUsd();
  const gradRefused = await pons.fetchPonsLaunch(GRAD_TOKEN);
  check("a refused POOL read carries the node's reason", /429|rate limit/.test(String(gradRefused?.readWhy)), String(gradRefused?.readWhy));
  check("…marketWhy names the READ, not the curve", /could not read the curve/.test(String(gradRefused?.marketWhy)), String(gradRefused?.marketWhy));
  check("…and it is re-keyed under the short TTL", pons.unpricedByUs(gradRefused) === true);
  __resetRpc();

  // ⚠️ OUR OWN BENCH MAY NOT BECOME A FIVE-MINUTE OUTAGE. The RPC client parks
  // a refusing host for 1–10s; that throw reaching the board's fallback used
  // to park the whole on-chain reader for five minutes, so one rate-limited
  // minute cost five of them.
  rpcMode = "refuse-all";
  __resetHistories();
  pons.__resetNativeUsd();
  const parked = await pons.fetchPonsFallbackMarket(PONS.chain, [TOKEN]);
  check("a refused cycle answers nothing rather than throwing", parked === null);
  __resetRpc();
  rpcMode = "ok";
  __resetHistories();
  pons.__resetNativeUsd();
  const after = await pons.fetchPonsFallbackMarket(PONS.chain, [TOKEN]);
  check("…and the very next cycle reads the chain — the reader is NOT parked", after != null && after.size === 1, String(after && after.size));

  // ⚠️ "IT NEVER CHANGES" IS TRUE OF THE TOKEN'S DECIMALS AND FALSE OF A READ
  // THE NODE REFUSED. 18 remembered for a 6-decimal token is every price off
  // by a million for the life of the process, so only an ANSWER is cached —
  // measured by whether the chain is asked a second time.
  {
    const { readCurveTokenDecimals, __resetDecimalsCache } = await import("../src/lib/providers/pons/contracts.ts");
    // The histories read this earlier in the run; a cached value would answer
    // for the code under test.
    __resetDecimalsCache();
    rpcMode = "refuse-decimals";
    decimalsAsks = 0;
    const fallback = await readCurveTokenDecimals(CURVE);
    check("a refused decimals() read falls back to 18", fallback === 18, String(fallback));
    __resetRpc();
    rpcMode = "ok";
    // A refused read never reaches the fixture, so the counter measures the
    // ANSWERED ones: one here means the next call went back to the chain, and
    // zero would mean the refusal had been written into the cache.
    const real = await readCurveTokenDecimals(CURVE);
    check("…and is ASKED AGAIN rather than remembered", real === 18 && decimalsAsks === 1, `${decimalsAsks} answered read(s)`);
    const again = await readCurveTokenDecimals(CURVE);
    check("…while the ANSWER is cached", again === 18 && decimalsAsks === 1, `${decimalsAsks} answered read(s)`);
  }

  rpcMode = "ok";
  __resetHistories();
}

// ── Report ────────────────────────────────────────────────────────────────
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
