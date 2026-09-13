// The RPC endpoint registry: configuration, read-side fallback, and the one
// rule that must never be relaxed — a SEND does not fall back.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-rpc-"));

const test = require("node:test");
const assert = require("node:assert");
const rpc = require("../src/config/rpc");

const ENV_KEYS = ["RPC_BSC", "RPC_BSC_URLS", "RPC_SOLANA", "RPC_SOLANA_URLS"];
let saved;
test.beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  rpc._reset();
});
test.afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rpc._reset();
});

// ── Configuration ────────────────────────────────────────────────────────────

test("RPC_<CHAIN> leads and the public defaults stay behind it as backup", () => {
  process.env.RPC_BSC = "https://my-node.example";
  const urls = rpc.rpcUrls("bsc");
  assert.strictEqual(urls[0], "https://my-node.example");
  assert.ok(urls.length > 1, "the defaults are still there to fall back to");
  assert.strictEqual(rpc.rpcUrl("bsc"), "https://my-node.example");
});

test("RPC_<CHAIN>_URLS replaces the list entirely", () => {
  // An operator who names their endpoints does not want a public node quietly
  // appended as a fourth choice, carrying their traffic somewhere they did not
  // pick.
  process.env.RPC_BSC_URLS = "https://a.example, https://b.example";
  assert.deepStrictEqual(rpc.rpcUrls("bsc"), ["https://a.example", "https://b.example"]);
});

test("the same endpoint named twice is only tried once", () => {
  process.env.RPC_BSC = "https://bsc-rpc.publicnode.com"; // also the first default
  const urls = rpc.rpcUrls("bsc");
  assert.strictEqual(new Set(urls).size, urls.length);
});

test("an unknown chain has no endpoints, and says so rather than guessing", () => {
  assert.deepStrictEqual(rpc.rpcUrls("some-new-l2"), []);
  assert.strictEqual(rpc.rpcUrl("some-new-l2"), "");
});

test("every chain the buy bot reads holdings on has an endpoint", () => {
  // The regression this registry exists to fix: ten of these chains had no RPC
  // at all, so whale detection on them did not fail — it silently never found
  // a whale.
  const { EVM_FAMILY } = require("../src/group/walletHoldings");
  for (const chain of [...EVM_FAMILY, "solana"]) {
    assert.ok(rpc.rpcUrls(chain).length > 0, `${chain} has no RPC endpoint configured`);
  }
});

test("constants.RPC is the primary of each list — the shape the sweeps read", () => {
  const { RPC } = require("../src/config/constants");
  for (const chain of rpc.RPC_CHAINS) {
    assert.strictEqual(RPC[chain], rpc.rpcUrls(chain)[0], chain);
  }
});

test("every default endpoint is https", () => {
  // These carry wallet addresses and, on the sweep path, signed transactions.
  for (const [chain, urls] of Object.entries(rpc.DEFAULTS)) {
    for (const u of urls) assert.match(u, /^https:\/\//, `${chain}: ${u}`);
  }
});

// ── Read-side fallback ───────────────────────────────────────────────────────

test("a read walks to the next endpoint when one is unreachable", async () => {
  process.env.RPC_BSC_URLS = "https://dead.example,https://alive.example";
  const tried = [];
  const { value, url } = await rpc.rpcRead("bsc", async (u) => {
    tried.push(u);
    if (u === "https://dead.example") throw new Error("ECONNREFUSED");
    return 42;
  });
  assert.deepStrictEqual(tried, ["https://dead.example", "https://alive.example"]);
  assert.strictEqual(value, 42);
  assert.strictEqual(url, "https://alive.example", "the caller is told WHICH node answered");
});

test("when every endpoint fails the read THROWS — it never resolves a default", async () => {
  // This is the whole point. An unreadable balance is UNKNOWN, not zero:
  // returning 0 reports a paid order as unpaid and the buyer is told their
  // payment timed out.
  process.env.RPC_BSC_URLS = "https://a.example,https://b.example";
  await assert.rejects(
    () => rpc.rpcRead("bsc", async () => { throw new Error("ETIMEDOUT"); }),
    /ETIMEDOUT/,
  );
});

test("a non-transport error stops the walk instead of repeating itself", async () => {
  // A revert, a bad address or a malformed request fails identically on every
  // node. Walking four endpoints turns one fast error into a slow one.
  process.env.RPC_BSC_URLS = "https://a.example,https://b.example,https://c.example";
  let calls = 0;
  await assert.rejects(
    () => rpc.rpcRead("bsc", async () => { calls++; throw new Error("execution reverted"); }),
    /execution reverted/,
  );
  assert.strictEqual(calls, 1);
});

test("a chain with no endpoints refuses rather than falling through to another", async () => {
  await assert.rejects(() => rpc.rpcRead("some-new-l2", async () => 1), /no RPC configured/i);
});

test("an endpoint that just failed goes to the back — and is not dropped", async () => {
  process.env.RPC_BSC_URLS = "https://flaky.example,https://good.example";
  await rpc.rpcRead("bsc", async (u) => {
    if (u === "https://flaky.example") throw new Error("ECONNRESET");
    return 1;
  });
  assert.deepStrictEqual(rpc.rankedUrls("bsc"), ["https://good.example", "https://flaky.example"]);
  // Still present: a demotion is an opinion about the last minute, and the list
  // is all that stands between the bot and a chain it cannot read at all.
  assert.ok(rpc.isCooling("https://flaky.example"));
});

test("a healthy answer clears an earlier demotion", async () => {
  process.env.RPC_BSC_URLS = "https://a.example,https://b.example";
  rpc.noteBad("https://a.example");
  assert.ok(rpc.isCooling("https://a.example"));
  await rpc.rpcRead("bsc", async () => 1); // b answers, a stays cooling
  rpc.noteGood("https://a.example");
  assert.deepStrictEqual(rpc.rankedUrls("bsc"), ["https://a.example", "https://b.example"]);
});

test("a slow endpoint is abandoned at the timeout, not waited out", async () => {
  process.env.RPC_BSC_URLS = "https://slow.example,https://fast.example";
  const { value } = await rpc.rpcRead(
    "bsc",
    (u) => (u === "https://slow.example" ? new Promise(() => {}) : Promise.resolve("ok")),
    { timeoutMs: 40, budgetMs: 500 },
  );
  assert.strictEqual(value, "ok");
});

test("the walk stops at the budget — a caller is waiting on this", async () => {
  process.env.RPC_BSC_URLS = "https://a.example,https://b.example,https://c.example,https://d.example";
  const tried = [];
  await assert.rejects(
    () =>
      rpc.rpcRead("bsc", (u) => { tried.push(u); return new Promise(() => {}); }, { timeoutMs: 30, budgetMs: 45 }),
    /timeout/,
  );
  assert.ok(tried.length < 4, `walked all ${tried.length} endpoints past the budget`);
});

test("429 and 5xx are transport failures; a revert is not", () => {
  for (const m of ["429 Too Many Requests", "503 Service Unavailable", "SERVER_ERROR", "socket hang up", "fetch failed", "ETIMEDOUT"]) {
    assert.ok(rpc.isTransportError(new Error(m)), m);
  }
  for (const m of ["execution reverted", "invalid address", "could not decode result data"]) {
    assert.ok(!rpc.isTransportError(new Error(m)), m);
  }
});

// ── The send rule ────────────────────────────────────────────────────────────

const ADAPTERS = [
  "../src/payments/chains/evm.js",
  "../src/payments/chains/solana.js",
  "../src/payments/chains/tron.js",
  "../src/payments/chains/ton.js",
];

test("a sweep resolves its endpoint ONCE — OUTSIDE the retry loop", () => {
  // A transfer that failed at the transport layer may still have reached the
  // network, so it is never re-sent to a second node. Resolving the endpoint
  // per ATTEMPT breaks exactly that: attempt 1 broadcasts on node A and throws
  // at confirmation; attempt 2's balance read gets a 429 from A, falls through
  // to node B, which has not caught up and reports the pre-transfer balance; a
  // second transfer is signed and broadcast. On Solana, which has no nonce to
  // collapse duplicates, both can land. solanaSweep.test.js reproduces that end
  // to end; this is the cheap structural half, across every adapter.
  for (const file of ADAPTERS) {
    const src = fss.readFileSync(path.join(__dirname, file), "utf8");
    const body = src.slice(src.indexOf("async function sweep("));
    const loopAt = body.indexOf("for (let attempt");
    const resolveAt = body.indexOf("rpcRead(");
    assert.ok(loopAt > 0, `${file}: sweep has no attempts loop?`);
    assert.ok(resolveAt > 0, `${file}: sweep must resolve its endpoint through rpcRead`);
    assert.ok(
      resolveAt < loopAt,
      `${file}: endpoint resolved INSIDE the retry loop — a retry can broadcast from a node that never saw the first attempt`,
    );
    assert.strictEqual(
      (body.match(/rpcRead\(/g) || []).length,
      1,
      `${file}: sweep must resolve its endpoint exactly once`,
    );
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

test("a dead endpoint leaves nothing spinning behind it", () => {
  // An ethers JsonRpcProvider pointed at an unreachable node retries network
  // detection once a second FOREVER and holds the event loop open doing it. One
  // left behind per failed lookup is a permanent background request loop — and
  // any CLI pass that touches these modules never exits, which is how this is
  // observable at all: the child below simply must terminate on its own.
  const { execFileSync } = require("node:child_process");
  const script = `
    process.env.RPC_BSC_URLS = "https://a.invalid,https://b.invalid";
    process.env.RPC_SOLANA_URLS = "https://a.invalid,https://b.invalid";
    Promise.allSettled([
      require("./src/group/walletHoldings").holdingOf("bsc", "0x" + "1".repeat(40), "0x" + "2".repeat(40)),
      require("./src/payments/chains/evm").getBalance("bsc", "0x" + "1".repeat(40)),
    ]).then(() => console.log("done"));
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    timeout: 30000, // throws ETIMEDOUT if a provider is still holding the loop
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, BOT_DATA_DIR: process.env.BOT_DATA_DIR },
  });
  assert.match(out, /done/);
});

test("the balance read that decides 'has the customer paid' walks every endpoint", () => {
  // Every adapter, not only the two that were obvious. A chain whose getBalance
  // is pinned to one node reports "not paid yet" for the whole five-minute poll
  // when that node is down — while treasury/rpc:check cheerfully list its
  // fallbacks, so the operator has no reason to look. TRON and TON were exactly
  // that: advertised a second endpoint they never consulted.
  for (const file of ADAPTERS) {
    const src = fss.readFileSync(path.join(__dirname, file), "utf8");
    const at = src.indexOf("function getBalance");
    assert.ok(at > 0, `${file}: no getBalance?`);
    assert.match(src.slice(at, at + 600), /rpcRead\(/, `${file}: getBalance must not be pinned to one node`);
  }
});
