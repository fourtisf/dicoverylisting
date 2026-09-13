// Discovery — merging DexScreener and pools.trade into the two functions the
// auto-lister calls.
//
// Two properties are worth pinning here, and both are about a source that is
// NOT DexScreener getting a fair share of a budget it never used to compete
// for:
//
//  1. INTERLEAVING. The caller prices only the first N candidates per scan
//     (maxLookupsPerRun, 40 by default). Concatenating would bury every
//     pools.trade launch behind ~40 DexScreener entries, and Robinhood Chain
//     would stay exactly as invisible to auto-listing as it was before this
//     module existed — with every feed perfectly healthy.
//
//  2. FAIL-OPEN. One source down must cost only that source's candidates. The
//     auto-lister treats an empty candidate list as a blocker and pages the
//     operator, so a pools.trade outage must not be able to manufacture one
//     while DexScreener is fine.
const test = require("node:test");
const assert = require("node:assert");

const ds = require("../src/dexscreener");
const ps = require("../src/poolstrade");
const discovery = require("../src/discovery");

// The modules are required by object, and their functions are looked up at call
// time, so replacing a property here is enough to stand a source in.
//
// ⚠️ AND IT MUST REPLACE THE SEAM THE CODE ACTUALLY CALLS. `discovery` reads
// DexScreener through the `X` pair now — the shape that can say "we could not
// ask" as opposed to "it answered with nothing" — so a helper that swapped only
// `fetchDiscovery`/`fetchTokenInfo` would leave every test below talking to the
// real api.dexscreener.com, i.e. passing or failing on somebody's network
// rather than on the code. Tests still declare the LEGACY shape, because that
// is the readable one; this is the single place that translates, so a stub can
// never again be installed on a seam nothing calls.
//
// A legacy stub is translated as `ok: true`: a test handing back rows, or null,
// is asserting that the source ANSWERED. A test that needs a refusal passes the
// X shape explicitly.
function withSources({ dex, pools }, fn) {
  const real = {
    dd: ds.fetchDiscovery,
    ddx: ds.fetchDiscoveryX,
    di: ds.fetchTokenInfo,
    dix: ds.fetchTokenInfoX,
    pd: ps.fetchDiscovery,
    pdx: ps.fetchDiscoveryX,
    pi: ps.fetchTokenInfo,
  };
  if (dex) {
    Object.assign(ds, dex);
    if (dex.fetchDiscovery && !dex.fetchDiscoveryX) {
      ds.fetchDiscoveryX = async (...a) => ({ items: (await dex.fetchDiscovery(...a)) || [], ok: true, why: null, feeds: [] });
    }
    if (dex.fetchTokenInfo && !dex.fetchTokenInfoX) {
      ds.fetchTokenInfoX = async (...a) => ({ info: await dex.fetchTokenInfo(...a), ok: true, why: null });
    }
  }
  if (pools) {
    Object.assign(ps, pools);
    // Same translation as the dex side above, and for the same reason: pools.trade
    // now reports WHY it is empty, so `discovery` reads `fetchDiscoveryX` and a
    // helper that swapped only `fetchDiscovery` would leave these tests talking
    // to the real launchpad.
    if (pools.fetchDiscovery && !pools.fetchDiscoveryX) {
      ps.fetchDiscoveryX = async (...a) => ({ items: (await pools.fetchDiscovery(...a)) || [], ok: true, why: null });
    }
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      ds.fetchDiscovery = real.dd;
      ds.fetchDiscoveryX = real.ddx;
      ds.fetchTokenInfo = real.di;
      ds.fetchTokenInfoX = real.dix;
      ps.fetchDiscovery = real.pd;
      ps.fetchDiscoveryX = real.pdx;
      ps.fetchTokenInfo = real.pi;
    }
  })();
}

const evm = (n) => "0x" + String(n).padStart(40, "0");

test("candidates from both sources are interleaved, not concatenated", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => [1, 2, 3].map((i) => ({ chain: "base", address: evm(i) })) },
      pools: { fetchDiscovery: async () => [7, 8].map((i) => ({ chain: "robinhood", address: evm(i) })) },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.deepEqual(
        out.map((c) => c.chain),
        ["base", "robinhood", "base", "robinhood", "base"],
        "sources must alternate so a lookup budget reaches both",
      );
      // The concrete consequence: with a budget of only 2 lookups, a pools.trade
      // token is still one of them.
      assert.ok(out.slice(0, 2).some((c) => c.chain === "robinhood"));
    },
  );
});

test("a pools.trade outage leaves DexScreener candidates intact", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => [{ chain: "base", address: evm(1) }] },
      pools: {
        fetchDiscovery: async () => {
          throw new Error("pools.trade unreachable");
        },
      },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1, "the scan carries on with the source that answered");
      assert.equal(out[0].chain, "base");
    },
  );
});

test("a DexScreener outage leaves pools.trade candidates intact", async () => {
  await withSources(
    {
      dex: {
        fetchDiscovery: async () => {
          throw new Error("dexscreener unreachable");
        },
      },
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: evm(9) }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1);
      assert.equal(out[0].chain, "robinhood");
    },
  );
});

test("both sources down yields an empty list, which the caller reports as a blocker", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => { throw new Error("down"); } },
      pools: { fetchDiscovery: async () => { throw new Error("down"); } },
    },
    async () => {
      assert.deepEqual(await discovery.fetchDiscovery(), []);
    },
  );
});

test("the same token from both sources appears once", async () => {
  const dup = { chain: "robinhood", address: evm(5) };
  await withSources(
    {
      dex: { fetchDiscovery: async () => [dup] },
      // Same address, different case — de-duplication is case-insensitive or a
      // token gets priced (and possibly listed) twice.
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: dup.address.toUpperCase().replace("0X", "0x") }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1);
    },
  );
});

test("malformed candidates are dropped rather than passed on", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => [{ chain: "base" }, { address: evm(1) }, null] },
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: evm(2) }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.deepEqual(out, [{ chain: "robinhood", address: evm(2) }]);
    },
  );
});

test("a non-array from a source is treated as empty, not spread", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => null },
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: evm(3) }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1);
    },
  );
});

test("pricing MERGES the indexer with pools.trade on its own chain, and asks only the indexer elsewhere", async () => {
  const calls = [];
  await withSources(
    {
      dex: {
        fetchTokenInfo: async (c) => {
          calls.push("ds:" + c);
          return { name: "from-dexscreener", symbol: "DS" };
        },
      },
      pools: {
        fetchTokenInfo: async (c) => {
          calls.push("ps:" + c);
          return c === "robinhood" ? { name: "from-poolstrade", symbol: "PS" } : null;
        },
      },
    },
    async () => {
      const rh = await discovery.fetchTokenInfo("robinhood", evm(1));
      // ⚠️ THIS TEST USED TO PIN THE OPPOSITE, and the rule it pinned expired.
      // pools.trade WAS the only source for Robinhood Chain, so returning its
      // record and never asking the indexer was right. DexScreener added the
      // chain in July 2026 (config/chains.js DEXSCREENER_SLUG), and from that
      // day the override meant every Robinhood token was judged on a
      // bonding-curve envelope whose unpublished fields coerce to 0 — so
      // `rejectReason` answered `thin liquidity ($0)` for the whole chain, on
      // every scan, including graduated tokens with real depth. The indexer's
      // live numbers win now; the pad fills the holes it is actually good for.
      assert.equal(rh.name, "from-dexscreener", "the indexer's live reading outranks the launchpad envelope");
      assert.deepEqual(calls.sort(), ["ds:robinhood", "ps:robinhood"], "both are asked, concurrently");

      calls.length = 0;
      const base = await discovery.fetchTokenInfo("base", evm(1));
      assert.equal(base.name, "from-dexscreener");
      assert.deepEqual(calls, ["ds:base"], "pools.trade is never asked about another chain");
    },
  );
});

test("the launchpad still fills the holes the indexer leaves — socials, logo, curve state", async () => {
  await withSources(
    {
      dex: { fetchTokenInfo: async () => ({ name: "Real", symbol: "RL", mcap: 2e6, liq: 90_000, vol24: 120_000 }) },
      pools: { fetchTokenInfo: async () => ({ name: "Pad", symbol: "PAD", liq: 0, vol24: 0, twitter: "https://x.com/p", logoUrl: "https://cdn/p.png" }) },
    },
    async () => {
      const info = await discovery.fetchTokenInfo("robinhood", evm(1));
      // The gates read these three, and they must come from the source that
      // measured a market — a pad zero standing in for them is what made the
      // whole chain read as "thin liquidity ($0)".
      assert.equal(info.liq, 90_000);
      assert.equal(info.vol24, 120_000);
      assert.equal(info.mcap, 2e6);
      // …and the pad still supplies what the indexer has no idea about.
      assert.equal(info.twitter, "https://x.com/p");
      assert.equal(info.logoUrl, "https://cdn/p.png");
    },
  );
});

test("a Robinhood token pools.trade does not know still falls through to DexScreener", async () => {
  // A token deployed on Robinhood Chain outside the launchpad. Returning null
  // here — instead of falling through — would make it permanently unlistable.
  await withSources(
    {
      dex: { fetchTokenInfo: async () => ({ name: "indexed elsewhere", symbol: "ELSE" }) },
      pools: { fetchTokenInfo: async () => null },
    },
    async () => {
      const info = await discovery.fetchTokenInfo("robinhood", evm(1));
      assert.equal(info.name, "indexed elsewhere");
    },
  );
});

test("a pools.trade error during pricing falls through instead of failing the token", async () => {
  await withSources(
    {
      dex: { fetchTokenInfo: async () => ({ name: "fallback", symbol: "FB" }) },
      pools: { fetchTokenInfo: async () => { throw new Error("boom"); } },
    },
    async () => {
      const info = await discovery.fetchTokenInfo("robinhood", evm(1));
      assert.equal(info.name, "fallback");
    },
  );
});

test("⚠️ a LAUNCHPAD RECORD DOES NOT MAKE A REFUSAL INTO AN ANSWER", async () => {
  // The rule was asserted in a comment and nowhere in a test, and it is
  // invisible in the direction that matters: with ok:true the scan's `unpriced`
  // counter stays 0, so the "could not price a single one of N" blocker never
  // fires — and every token is instead judged on a pad-only record whose `liq`
  // and `vol24` are 0 and rejected as `thin liquidity ($0)`. The panel then
  // accuses the operator's candidates of having no depth, about tokens with
  // real six-figure liquidity, and sends them to lower minLiq over an upstream
  // outage.
  const real = { ix: ds.fetchTokenInfoX, pi: ps.fetchTokenInfo };
  ds.fetchTokenInfoX = async () => ({ info: null, ok: false, why: "DexScreener HTTP 403" });
  ps.fetchTokenInfo = async () => ({ name: "Pad", symbol: "PAD", liq: 0, vol24: 0, twitter: "https://x.com/p" });
  try {
    const r = await discovery.fetchTokenInfoX("robinhood", evm(1));
    assert.strictEqual(r.ok, false, "the indexer could not be asked — the pad record does not change that");
    assert.match(r.why, /403/);
    // …and the pad's data still travels, for the display the card needs.
    assert.strictEqual(r.info.twitter, "https://x.com/p");
  } finally {
    ds.fetchTokenInfoX = real.ix;
    ps.fetchTokenInfo = real.pi;
  }
});

test("⚠️ an unreachable pools.trade is NOT a quiet launchpad", async () => {
  // It returned the same `[]` for both, at debug level — so `listing:check`
  // printed `pools.trade → 0 candidate(s)` on the operator's box with nothing
  // able to say whether the host was retired, the feed switched off, or simply
  // nothing new had launched. Three different answers, one rendering.
  const real = ps.fetchDiscoveryX;
  ps.fetchDiscoveryX = async () => ({ items: [], ok: false, why: "HTTP 404" });
  try {
    const d = await discovery.fetchDiscoveryX();
    const src = d.sources.find((x) => x.name === "poolstrade");
    assert.strictEqual(src.ok, false);
    assert.match(src.why, /404/);
  } finally {
    ps.fetchDiscoveryX = real;
  }
});
