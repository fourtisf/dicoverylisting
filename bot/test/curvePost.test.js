// "mengapa ketika listing price mc tba pdahal sudah ada price dan mc" — a paid
// Xpress listing for $WROTE (Wallet Route, Robinhood Chain) went out reading
// "Market cap: TBA · Price: TBA" while ponsfamily.com showed $0.000004 on a
// $4,494.71 cap in the same minute.
//
// The round before had already made the post's market read DexScreener-first,
// and that fixed a different cause. This token is 1% along a PONS BONDING
// CURVE: it has no pool at all, so neither indexer can price it however cheaply
// they are asked, and the launchpad leg below them asks Pons over HTTP on a
// host and a path this repo has never verified — the operator's own
// `launchpads:check` reports it unreachable.
//
// The one source that cannot be unreachable is the curve contract, and it was
// wired into the LISTING FORM (`discovery.fetchTokenInfoX`) and nowhere else —
// so the form autofilled a name and a ticker off the chain and the post
// announcing that very token printed TBA on both figures.
//
// ⚠️ THESE ARE POSITIVE TESTS. A wiring that does nothing refuses beautifully:
// a suite that only drove the failure cases would pass on the unwired code.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-curvepost-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");
const ponsChain = require("../src/ponsChain");
const fulfil = require("../src/fulfillment");

const WROTE = "0xfCd4CdEabe055315b1036A189eA54ca627Df390a";

/** What /api/pons answers for a live Pons curve — the shape the route returns. */
const LAUNCH = {
  launch: {
    address: WROTE,
    name: "Wallet Route",
    symbol: "WROTE",
    phase: "NotGraduated",
    graduated: false,
    logo: "ipfs://bafkreiwalletroute",
    priceUsd: 0.000004,
    mcapUsd: 4494.71,
    progressPct: 1,
    socials: {},
  },
};

/**
 * Classify every request by WHO is being asked, so a test can assert that a
 * source was reached — or that it never was.
 *
 * Anything that is not one of the three known hosts is a launchpad's own HTTP
 * API, and it FAILS: that is the operator's box, where the Pons pad's guessed
 * host is unreachable, and it is the state the chain leg exists for.
 */
function stubFetch(router) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    const who = u.includes("/api/pons")
      ? "chain"
      : u.includes("geckoterminal")
        ? "gt"
        : u.includes("dexscreener")
          ? "ds"
          : "pad";
    asked.push(who);
    const body = router(who, u);
    if (body === undefined) throw new Error("ENOTFOUND (the pad host is a guess)");
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    // `{ __status: 503 }` — a non-2xx that is not an answer about the token.
    if (body && body.__status) return { ok: false, status: body.__status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { asked, restore: () => (global.fetch = orig) };
}

const POST_NEED = ["priceUsd", "mcap", "liq"];
const cheap = { cheap: true, need: POST_NEED };

// The launchpad registry caches a pad's answer per token and benches a pad
// after three transport failures — both persist across tests in one process,
// and a benched pad is SKIPPED, which reads exactly like a pad leg that was
// never wired. Stated, never inherited: the scar the auto-trend panel helper
// already carries.
const lpRegistry = require("../../shared/launchpads");
test.beforeEach(() => {
  ponsChain._reset();
  lpRegistry.reload();
});

test("a bonding-curve token is PRICED FROM THE CHAIN when no indexer and no pad can", async () => {
  const { asked, restore } = stubFetch((who) => (who === "chain" ? LAUNCH : who === "pad" ? undefined : null));
  try {
    const m = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.ok(m, "the read must not come back null — this is the TBA that shipped");
    assert.strictEqual(m.priceUsd, 0.000004, "the price the pad's own page shows");
    assert.strictEqual(m.mcap, 4494.71, "the market cap the pad's own page shows");
    assert.ok(asked.includes("chain"), `the contract must be asked: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test("…and the curve's state travels with it, so the card can say it is still bonding", async () => {
  const { restore } = stubFetch((who) => (who === "chain" ? LAUNCH : who === "pad" ? undefined : null));
  try {
    const m = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.strictEqual(m.onCurve, true);
    assert.strictEqual(m.progressPct, 1);
    // ⚠️ No pool is the whole point. Inventing one here would send a chart link
    // somewhere that 404s.
    assert.strictEqual(m.poolAddress, null);
  } finally {
    restore();
  }
});

test("⚠️ an indexed token pays ONE chain request EVER, then none", async () => {
  // The concurrency above is not free and this is the price, bounded.
  //
  // The read is started alongside the indexers because read serially it is
  // fourth in a queue inside the post's 8s ceiling and would never get asked —
  // so an indexed Robinhood token now spends one localhost request whose answer
  // is thrown away. What keeps that from being a per-poll cost across nine
  // background pipelines is the memo: `fetchPonsLaunch` resolves BY ADDRESS off
  // the factory, so "Pons never launched this" is permanent, and every
  // subsequent read short-circuits with no request at all.
  const ds = {
    pairs: [
      {
        chainId: "robinhood",
        priceUsd: "1.5",
        marketCap: 1000,
        liquidity: { usd: 2000 },
        volume: { h24: 10 },
        priceChange: { h24: 1 },
        pairAddress: "0xpair",
        baseToken: { name: "Graduated", symbol: "GRAD" },
      },
    ],
  };
  const { asked, restore } = stubFetch((who) => (who === "ds" ? ds : null));
  try {
    const first = await market.fetchMarket("robinhood", "0xdead", cheap);
    assert.strictEqual(first.priceUsd, 1.5, "the indexer prices it, as it always did");
    assert.strictEqual(asked.filter((w) => w === "chain").length, 1, "one, concurrently");

    const before = asked.length;
    const again = await market.fetchMarket("robinhood", "0xdead", cheap);
    assert.strictEqual(again.priceUsd, 1.5);
    assert.ok(
      !asked.slice(before).includes("chain"),
      `the second read must not ask again: ${asked.slice(before).join(", ")}`,
    );
  } finally {
    restore();
  }
});

test("⚠️ a read that FAILED is never memoed as 'Pons never launched this'", async () => {
  // The fail-safe direction, and the one that matters: writing a transport
  // failure into the memo would mark a live curve as "never launched" for the
  // life of the process — this section's own TBA, made permanent, and immune to
  // the park expiring because the memo is checked above it.
  //
  // ⚠️ IT IS ASSERTED ON THE ANSWER, NOT BY DRIVING TWICE AND LOOKING AT THE
  // REQUEST COUNT. The first cut called `_reset()` between the two calls — which
  // clears the memo, i.e. exactly the thing under test — so memoing the failure
  // survived the mutation run untouched. A park and a memo both suppress the
  // second request; only `{ok, why}` tells them apart, and that distinction is
  // the whole rule: ok:false is "we could not ask", ok:true is a fact about the
  // token.
  const { restore } = stubFetch((who) => (who === "chain" ? undefined : null));
  try {
    const first = await ponsChain.fetchTokenInfoX("robinhood", WROTE);
    assert.strictEqual(first.ok, false, "a transport failure is not an answer");
  } finally {
    restore();
  }

  const second = await ponsChain.fetchTokenInfoX("robinhood", WROTE);
  assert.strictEqual(second.ok, false, "still 'we could not ask' — parked, never memoed");
  assert.match(second.why, /parked/, `a failure must not become a verdict: ${second.why}`);
});

test("…and a real 'not a Pons launch' IS remembered, with no second request", async () => {
  // The other half, and the reason the concurrent read is affordable at all.
  const { asked, restore } = stubFetch(() => null);
  try {
    const first = await ponsChain.fetchTokenInfoX("robinhood", "0xgraduated");
    assert.strictEqual(first.ok, true, "the factory answered: it never launched this");
    const before = asked.length;
    const second = await ponsChain.fetchTokenInfoX("robinhood", "0xgraduated");
    assert.strictEqual(second.ok, true);
    assert.strictEqual(asked.length, before, "and it is never asked again");
  } finally {
    restore();
  }
});

test("⚠️ a LIVE POOL READING still beats the curve's copy of the same number", async () => {
  // The rule the rest of marketdata.js is built on: the chain leg FILLS HOLES
  // and may never overwrite an indexer that answered.
  //
  // ⚠️ THE FIXTURE HAS TO REACH THE MERGE. The first cut gave GeckoTerminal a
  // complete record — which closes the `!out.priceUsd || !out.mcap` gate above,
  // so the chain leg never ran and inverting the merge's precedence left this
  // test green. It was asserting the GATE while claiming to assert the RULE.
  // A partial indexer answer is the only shape that opens the gate with a
  // reading already in hand: GT prices it, nobody publishes a cap, and the
  // chain has both.
  const gt = {
    data: {
      attributes: { price_usd: "9.99", market_cap_usd: null, total_reserve_in_usd: "500" },
      relationships: {},
    },
    included: [],
  };
  const { asked, restore } = stubFetch((who) =>
    who === "gt" ? gt : who === "chain" ? LAUNCH : who === "pad" ? undefined : null,
  );
  try {
    const m = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.ok(asked.includes("chain"), "precondition: the gate opened and the chain WAS asked");
    assert.strictEqual(m.priceUsd, 9.99, "the pool reading wins — not the curve's 0.000004");
    assert.strictEqual(m.mcap, 4494.71, "…and the hole it left is filled from the curve");
  } finally {
    restore();
  }
});

test("a chain that Pons does not cover is never asked at all", async () => {
  const { asked, restore } = stubFetch(() => null);
  try {
    await market.fetchMarket("bsc", "0xabc", cheap);
    assert.ok(!asked.includes("chain"), `solana/bsc must not reach /api/pons: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test('"Pons never launched this token" costs nothing and is not an error', async () => {
  // A 404 from the route is an ANSWER about the token — the graduated-long-ago
  // case — and must leave the record exactly as the indexers left it.
  const { restore } = stubFetch((who) => (who === "pad" ? undefined : null));
  try {
    const m = await market.fetchMarket("robinhood", "0xnotpons", cheap);
    assert.strictEqual(m, null, "no source had it, and nothing was invented");
  } finally {
    restore();
  }
});

// ── THE GECKOTERMINAL STAGE MAY NOT EAT THE WHOLE BUDGET ─────────────────────
//
// `$GG`, a pump.fun Solana token, published `price · market cap · liquidity as
// TBA` on a box where pump.fun answers fine and the pad is `verified: true`.
// DexScreener misses a bonding curve, the GT read then queues on
// gtSlot(PRIO_BACKGROUND) — which has NO DEADLINE OF ITS OWN — and it spent the
// caller's entire 8s, so `fillFromLaunchpad` two lines below was never reached.
//
// The chain leg was fixed for exactly this one round earlier. The pad leg one
// line above it was left serial: a lesson applied to one branch is a lesson
// half-learnt.

// ⚠️ A REAL MINT, NOT A LABEL. The first cut used `"GGmint"`, and the launchpad
// registry refuses an address that cannot be a Solana mint before it makes any
// request — so the test reported the pad as never asked while the code was
// working perfectly. A test measuring its own fake, which is why this is the
// address off the operator's own screenshot.
const GG = "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump";

/** A pump.fun-shaped answer from the launchpad registry's HTTP pad. */
const PUMP = {
  mint: GG,
  name: "Green God",
  symbol: "GG",
  image_uri: "https://ipfs.io/ipfs/bafyGG",
  usd_market_cap: 61234,
  price_usd: 0.0000612,
  real_token_reserves: 500000000000000,
};

test("⚠️ a slow GT does not cost the LAUNCHPAD its turn", async () => {
  // ⚠️ DRIVEN THROUGH `_readPostMarket`, THE REAL CALLER, and that is what makes
  // this test mean anything. The first cut called `fetchMarket` directly and
  // only asserted the pad was EVENTUALLY asked — which is true of the broken
  // code too, because `fetchGT` has an 8s timeout of its own and the pad is
  // reached after it, just far too late. All three mutants survived. What the
  // post actually cares about is whether a price arrives INSIDE
  // MARKET_BUDGET_MS, so the bound has to be in the test.
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("geckoterminal")) {
      asked.push("gt");
      // The reported state: the shared queue, never arriving inside the budget.
      //
      // ⚠️ UNREF'd, and that is the opposite of the rule `bounded` states — for
      // the opposite reason. Nothing is waiting on this once the caller's bound
      // fires, so a reffed timer just holds the file's event loop open for its
      // full duration after the test has passed. `node --test` waits for that,
      // and the suite pays it. The scar this file's own header names, pointing
      // the other way.
      await new Promise((r) => {
        const t = setTimeout(r, 30_000);
        if (typeof t.unref === "function") t.unref();
      });
      return { ok: false, status: 504, json: async () => ({}) };
    }
    if (u.includes("dexscreener")) {
      asked.push("ds");
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) }; // no pair on a curve
    }
    if (u.includes("pump.fun")) {
      asked.push("pad");
      return { ok: true, status: 200, json: async () => PUMP };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const { live } = await fulfil._readPostMarket("solana", GG, "test");
    assert.ok(asked.includes("pad"), `the launchpad must be asked: ${asked.join(", ")}`);
    assert.ok(live, "the post must get a market — this is the TBA that shipped");
    assert.strictEqual(live.priceUsd, 0.0000612);
    assert.strictEqual(live.mcap, 61234);
  } finally {
    global.fetch = orig;
  }
});

test("…and a caller with NO budget still waits on GT exactly as it always did", async () => {
  // The nine background pipelines pass no budget and must keep their behaviour.
  // GT answers here at 5s — comfortably past the slice a post would impose, and
  // fine for a timer job — so a slice applied unconditionally would throw this
  // answer away and re-ask the pads on every poll of every listing.
  const orig = global.fetch;
  let gtAsked = false;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("geckoterminal")) {
      gtAsked = true;
      // Reffed on purpose: this one IS awaited to completion — the assertion
      // below is that GT's answer survives, so the answer has to arrive.
      await new Promise((r) => setTimeout(r, 5000));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            attributes: { price_usd: "3", market_cap_usd: "300", total_reserve_in_usd: "30" },
            relationships: {},
          },
          included: [],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const m = await market.fetchMarket("solana", GG, { cheap: true, need: POST_NEED });
    assert.ok(gtAsked);
    assert.ok(m, "an unbounded caller must still get GT's answer");
    assert.strictEqual(m.priceUsd, 3, "…and it is GT's, not a pad's");
  } finally {
    global.fetch = orig;
  }
});

// ── "tidak ada logo": the chain record's logo and its REASON reach the post ──
//
// A Pons curve token's artwork lives in its contract's logo() and nowhere an
// index can see; the market read already carried it (mergeCurve) and the post
// never looked. And when the site's ETH/USD ladder has no answer, the record
// says so — "we could not price it" is not "nobody prices it".
const WROTE_LOGO = "ipfs://bafybeibk74wtpsgccfehq4zatxgorv5pwfmtpy7qo7hj6kbvko5nmvokba";
const LADDER_WHY = "no USD reference for ETH — coinbase: Coinbase 503; dexscreener: DexScreener 403; geckoterminal: rate limited";
const curveLaunch = (over = {}) => ({
  launch: {
    address: WROTE, name: "Wallet Route", symbol: "WROTE", phase: "NotGraduated", graduated: false,
    priceUsd: null, mcapUsd: null, priceQuote: 0.0000012, logo: WROTE_LOGO, marketWhy: LADDER_WHY, progressPct: 1.2,
    ...over,
  },
});

test("the chain's logo rides the market record, and the ladder's refusal is the read's WHY", async () => {
  const { asked, restore } = stubFetch((who) => (who === "chain" ? curveLaunch() : who === "ds" ? { pairs: [] } : who === "gt" ? null : undefined));
  try {
    const { live, why } = await fulfil._readPostMarket("robinhood", WROTE, "test");
    assert.ok(asked.includes("chain"), `the chain must be asked: ${asked.join(", ")}`);
    assert.ok(live, "the chain answered — a record exists even without USD figures");
    assert.strictEqual(live.priceUsd, null);
    assert.match(String(live.logoUrl), /^https:\/\/[^/]+\/ipfs\/bafybeibk74/, "the contract's ipfs:// logo must reach the record as a gateway url");
    assert.match(String(why), /no USD reference for ETH/, `the read must carry the ladder's refusals, got: ${why}`);
    assert.match(String(why), /coinbase|dexscreener|geckoterminal/);
  } finally {
    restore();
  }
});

test("a PRICED chain record carries no marketWhy — a stale sentence beside a real number is a contradiction", async () => {
  const { restore } = stubFetch((who) => (who === "chain" ? curveLaunch({ priceUsd: 0.0000048, mcapUsd: 4494.71, marketWhy: null, quoteUsdSource: "coinbase" }) : who === "ds" ? { pairs: [] } : who === "gt" ? null : undefined));
  try {
    const { live, why } = await fulfil._readPostMarket("robinhood", WROTE, "test");
    assert.strictEqual(live.priceUsd, 0.0000048);
    assert.strictEqual(live.mcap, 4494.71);
    assert.strictEqual(why, null);
    assert.strictEqual(live.marketWhy, null);
  } finally {
    restore();
  }
});

test("⚠️ …and the ladder's refusal is DROPPED when an INDEXER priced the token", async () => {
  // The case the fixture above cannot see: the site's ETH/USD ladder failed
  // (the chain record carries marketWhy and no USD figure) while DexScreener
  // priced the same token — a graduated Pons token, or one DS indexes on its
  // curve. mergeCurve fills HOLES from the chain record; the refusal must not
  // ride along beside a price somebody else answered. A mutant carrying
  // `lp.marketWhy` unconditionally was behaviour-neutral on every priced-chain
  // fixture, which is why this one prices from the OTHER source.
  // A price and NO cap, so the merge (mergeCurve) is the path taken — a fully
  // priced DS answer never reaches it.
  const ds = {
    pairs: [
      {
        chainId: "robinhood", priceUsd: "0.0000051", liquidity: { usd: 2000 },
        volume: { h24: 10 }, priceChange: { h24: 1 }, pairAddress: "0xpair",
        baseToken: { address: WROTE, name: "Wallet Route", symbol: "WROTE" },
      },
    ],
  };
  const { restore } = stubFetch((who) => (who === "chain" ? curveLaunch() : who === "ds" ? ds : who === "gt" ? null : undefined));
  try {
    const { live, why } = await fulfil._readPostMarket("robinhood", WROTE, "test");
    assert.strictEqual(live.priceUsd, 0.0000051, "the indexer's price wins");
    assert.strictEqual(live.mcap, null, "nobody published a cap");
    assert.strictEqual(why, null, `a priced read has no why: ${why}`);
    assert.strictEqual(live.marketWhy, null, `the ladder's refusal must not travel beside a real price: ${live.marketWhy}`);
    // …while the chain still fills the holes the indexer leaves.
    assert.match(String(live.logoUrl), /^https:\/\/[^/]+\/ipfs\/bafybeibk74/, "the contract's logo still fills the blank");
  } finally {
    restore();
  }
});

test("⚠️ a record DexScreener priced IN FULL still takes the contract's logo — for the post, and only the post", async () => {
  // DS indexes some pads' curves as ordinary pairs (Pons on Robinhood among
  // them) and has no picture for a token minutes old. The merge is never
  // reached on a fully priced answer, so the chain read that carries the logo
  // was thrown away — and the row was born blank on exactly the path that
  // looked healthiest. The read is already in flight; the post waits for it.
  const ds = {
    pairs: [
      {
        chainId: "robinhood", priceUsd: "0.0000051", marketCap: 5100, liquidity: { usd: 2000 },
        volume: { h24: 10 }, priceChange: { h24: 1 }, pairAddress: "0xpair",
        baseToken: { address: WROTE, name: "Wallet Route", symbol: "WROTE" },
      },
    ],
  };
  const { asked, restore } = stubFetch((who) => (who === "chain" ? curveLaunch() : who === "ds" ? ds : who === "gt" ? null : undefined));
  try {
    const { live, why } = await fulfil._readPostMarket("robinhood", WROTE, "test");
    assert.strictEqual(live.priceUsd, 0.0000051);
    assert.strictEqual(live.mcap, 5100);
    assert.strictEqual(why, null);
    assert.match(String(live.logoUrl), /^https:\/\/[^/]+\/ipfs\/bafybeibk74/, `the post's read must carry the contract's logo, got ${live.logoUrl}`);
    assert.strictEqual(asked.filter((w) => w === "chain").length, 1, "…from the ONE read already in flight, never a second request");

    // A DS logo is an ANSWER and is never replaced by the chain's.
    const withArt = { pairs: [{ ...ds.pairs[0], info: { imageUrl: "https://cdn.dexscreener.com/wrote.png" } }] };
    restore();
    const second = stubFetch((who) => (who === "chain" ? curveLaunch() : who === "ds" ? withArt : who === "gt" ? null : undefined));
    try {
      const r = await fulfil._readPostMarket("robinhood", WROTE, "test");
      assert.strictEqual(r.live.logoUrl, "https://cdn.dexscreener.com/wrote.png");
    } finally {
      second.restore();
    }
  } finally {
    restore();
  }
});

// ── the artwork had ONE source on the door that looked healthiest ────────────
//
// `$ORCHFLOWS` (Pons, Robinhood) reached 12,514 subscribers drawing the Dexvra
// mark, with its own logo on ponsfamily.com and the banner's market cap
// CORRECT — DexScreener priced it in full, so the read left by the first door,
// and the single chain read behind that door had nothing to give. The chain leg
// was added to these doors precisely because the pad leg below them is
// unreachable once an indexer answers everything; asking only the chain is that
// lesson half-learnt, one source over.
//
// ⚠️ POSITIVE TESTS. A second source wired to nothing refuses beautifully.
const ORCH = "0x36B44a8034Fe0eEddb8819dA82128bD6959161A6";
const DS_FULL = {
  pairs: [{
    chainId: "robinhood", baseToken: { address: ORCH, name: "orchflows", symbol: "ORCHFLOWS" },
    priceUsd: "0.00000474", marketCap: 4741.81, liquidity: { usd: 3100 },
    volume: { h24: 900 }, priceChange: { h24: -21.15 }, pairAddress: "0xpair",
  }],
};
/** What the pad's own API answers — artwork pinned on IPFS, as pads do. */
const PAD_BODY = { address: ORCH, name: "orchflows", symbol: "ORCHFLOWS", image: "ipfs://bafkorch" };

test("⚠️ a DS-PRICED curve token whose chain read has no logo takes the PAD'S", async () => {
  const { asked, restore } = stubFetch((who, u) => {
    if (who === "ds") return DS_FULL;
    if (who === "chain") return { launch: { address: ORCH, name: "orchflows", symbol: "ORCHFLOWS", logo: null, priceUsd: null, socials: {} } };
    return /ponsfamily/.test(u) ? PAD_BODY : undefined;
  });
  try {
    const m = await market.fetchMarket("robinhood", ORCH, { ...cheap, budgetMs: 8000 });
    assert.ok(m.logoUrl, `the banner drew the Dexvra mark: asked ${asked.join(", ")}`);
    // ⚠️ AND IT IS RENDERABLE. A pad pins on IPFS, and `adoptChainLogo` takes
    // https only because the site's LOGO_RE refuses everything else — a raw
    // `ipfs://` here would be a source wired to a rule that throws it away.
    assert.match(m.logoUrl, /^https:\/\//, "the pad's ipfs:// URI reached the row verbatim");
    assert.match(m.logoUrl, /bafkorch/);
    assert.ok(asked.includes("pad"), "the pad was never asked on the door the reported token takes");
  } finally {
    restore();
  }
});

test("…and the CHAIN still wins: the pad is asked only when the contract had none", async () => {
  const { asked, restore } = stubFetch((who, u) => {
    if (who === "ds") return DS_FULL;
    if (who === "chain") return { launch: { address: ORCH, name: "orchflows", symbol: "ORCHFLOWS", logo: "ipfs://bafkchain", socials: {} } };
    return /ponsfamily/.test(u) ? PAD_BODY : undefined;
  });
  try {
    const m = await market.fetchMarket("robinhood", ORCH, { ...cheap, budgetMs: 8000 });
    assert.match(m.logoUrl, /bafkchain/, "the pad outranked the contract");
    assert.ok(!asked.includes("pad"), "a pad request was spent on a question the contract had answered");
  } finally {
    restore();
  }
});

test("…while a BACKGROUND caller pays no pad request for a field it does not render", async () => {
  const { asked, restore } = stubFetch((who, u) => {
    if (who === "ds") return DS_FULL;
    if (who === "chain") return { launch: { address: ORCH, symbol: "ORCHFLOWS", logo: null, socials: {} } };
    return /ponsfamily/.test(u) ? PAD_BODY : undefined;
  });
  try {
    const m = await market.fetchMarket("robinhood", ORCH, cheap);   // no budgetMs
    assert.ok(!m.logoUrl);
    assert.ok(!asked.includes("pad"), "nine background pipelines just grew a launchpad round trip each");
  } finally {
    restore();
  }
});

test("⚠️ a BLANK the sources could not be ASKED for carries its reason", async () => {
  // The banner renders "the creator published nothing" and "the node refused
  // us" identically, and the post watch is silent on the first by design. That
  // silence is only honest while the sources answered.
  const { restore } = stubFetch((who, u) => {
    if (who === "ds") return DS_FULL;
    if (who === "chain") return { __status: 503 };
    return /ponsfamily/.test(u) ? null : undefined;   // the pad answers: no such token
  });
  try {
    const m = await market.fetchMarket("robinhood", ORCH, { ...cheap, budgetMs: 8000 });
    assert.ok(!m.logoUrl);
    assert.ok(m.logoWhy, "a refused chain read was reported as a project with no artwork");
    assert.match(String(m.logoWhy), /503|failed|park/i);
  } finally {
    restore();
  }
});

test("…and a chain that ANSWERED with no logo makes NO such claim", async () => {
  const { restore } = stubFetch((who, u) => {
    if (who === "ds") return DS_FULL;
    if (who === "chain") return { launch: { address: ORCH, symbol: "ORCHFLOWS", logo: null, socials: {} } };
    return /ponsfamily/.test(u) ? null : undefined;
  });
  try {
    const m = await market.fetchMarket("robinhood", ORCH, { ...cheap, budgetMs: 8000 });
    assert.ok(!m.logoUrl);
    // Every source answered. This project published no artwork, the Dexvra mark
    // is the design for that, and paging on it would be permanently red.
    assert.ok(!m.logoWhy, `a creator's own choice was reported as a fault: ${m.logoWhy}`);
  } finally {
    restore();
  }
});

test("⚠️ every exit of fetchMarket goes through logoFromCurve — a priced answer leaves by three doors", () => {
  // The first cut put the fill after the LAST door only; the DS-priced record
  // (the one the reported token takes) left through the first and never saw
  // it. Comment-stripped: the helper's own header quotes the rule.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "marketdata.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const start = src.indexOf("async function fetchMarket(");
  const end = src.indexOf("\n}\n", start);
  // ⚠️ A GUARD THAT PINS A LINE BREAK IS A GUARD ABOUT FORMATTING. The first
  // cut required `if (…) return …;` on ONE line, so wrapping a long call went
  // red over code that keeps the rule perfectly — this repo's own recurring
  // defect (the four-way pool TTL, the `{ ok: true,` build stamp). The
  // continuation is joined before the doors are counted.
  const body = src.slice(start, end).replace(/\)\s*\n\s*return\b/g, ") return");
  const after = body.slice(body.indexOf("const chainP = startChainRead("));
  // The function's OWN exits: two-space indentation. A nested callback's
  // `return null` (the GT slice's timeout) is not a door out of fetchMarket.
  const returns = after.match(/^  (?:if \([^\n]*\) )?return\b[^;]*;/gm) || [];
  assert.ok(returns.length >= 3, `three doors, found ${returns.length}`);
  for (const r of returns) assert.match(r, /return logoFromCurve\(/, `an exit bypasses the curve's logo: ${r}`);
});

test("…while a background caller with NO budget does not wait on the chain for a logo it does not render", async () => {
  const ds = {
    pairs: [
      {
        chainId: "robinhood", priceUsd: "0.0000051", marketCap: 5100, liquidity: { usd: 2000 },
        volume: { h24: 10 }, priceChange: { h24: 1 }, pairAddress: "0xpair",
        baseToken: { address: WROTE, name: "Wallet Route", symbol: "WROTE" },
      },
    ],
  };
  // The chain answers only after the record has already been returned: a
  // caller that waited would see the logo, one that did not sees the blank.
  let releaseChain;
  const chainGate = new Promise((res) => (releaseChain = res));
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/pons")) {
      asked.push("chain");
      await chainGate;
      return { ok: true, status: 200, json: async () => curveLaunch() };
    }
    if (u.includes("dexscreener")) return { ok: true, status: 200, json: async () => ds };
    if (u.includes("geckoterminal")) return { ok: false, status: 404, json: async () => ({}) };
    throw new Error("ENOTFOUND");
  };
  try {
    const out = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.strictEqual(out.priceUsd, 0.0000051);
    assert.strictEqual(out.logoUrl, null, "no budget → no wait → the blank the indexer left");
    assert.strictEqual(asked.length, 1, "the read was started (concurrently) exactly as before");
  } finally {
    releaseChain();
    global.fetch = orig;
  }
});

test("adoptChainLogo fills a BLANK only, https only — the buyer's own logo is their decision", () => {
  const adopt = fulfil._adoptChainLogo;
  const gw = "https://ipfs.io/ipfs/bafybeibk74wtpsgccfehq4zatxgorv5pwfmtpy7qo7hj6kbvko5nmvokba";
  const blank = { logoUrl: "" };
  assert.strictEqual(adopt(blank, { logoUrl: gw }), true);
  assert.strictEqual(blank.logoUrl, gw);
  const uploaded = { logoUrl: "/api/media/0123456789abcdef01234567.png" };
  assert.strictEqual(adopt(uploaded, { logoUrl: gw }), false, "an uploaded logo is the buyer's decision");
  assert.strictEqual(uploaded.logoUrl, "/api/media/0123456789abcdef01234567.png");
  const raw = { logoUrl: "" };
  assert.strictEqual(adopt(raw, { logoUrl: WROTE_LOGO }), false, "ipfs:// would fail the site's LOGO_RE and cost the whole listing");
  assert.strictEqual(raw.logoUrl, "");
  assert.strictEqual(adopt({ logoUrl: "" }, null), false);
  assert.strictEqual(adopt({ logoUrl: "" }, { logoUrl: null }), false);
});

test("⚠️ DRIVEN: the row handed to the site carries the chain's logo — a disabled adoption passes the source scan below", async () => {
  // The scan beneath this pins ORDER and went green on `if (false && adopt…)`:
  // the call was still on the page. So the create is intercepted and the
  // input it was handed is the assertion. Everything before the create is
  // real — the bounded market read, the merge, the adoption; the create itself
  // throws so nothing downstream (posts, tweets, emoji) has to be stood up.
  const api = require("../src/api/dexvra");
  const origCreate = api.createListing;
  let handed = null;
  api.createListing = async (input) => {
    handed = { ...input };
    throw new Error("stop at create — the test has what it needs");
  };
  const { restore } = stubFetch((who) => (who === "chain" ? curveLaunch() : who === "ds" ? { pairs: [] } : who === "gt" ? null : undefined));
  try {
    const order = {
      payload: {
        listingInput: { chain: "robinhood", address: WROTE, sym: "WROTE", name: "Wallet Route", tier: "XPRESS", logoUrl: "" },
        trendHours: 0,
      },
    };
    await assert.rejects(fulfil.fulfillListing({ telegram: {} }, order), /stop at create/);
    assert.ok(handed, "the create was reached");
    assert.match(String(handed.logoUrl), /^https:\/\/[^/]+\/ipfs\/bafybeibk74/, `the row must be BORN with the contract's logo, got: ${JSON.stringify(handed.logoUrl)}`);
  } finally {
    api.createListing = origCreate;
    restore();
  }
});

test("…and a logo the BUYER supplied is never replaced by the chain's", async () => {
  const api = require("../src/api/dexvra");
  const origCreate = api.createListing;
  let handed = null;
  api.createListing = async (input) => {
    handed = { ...input };
    throw new Error("stop at create");
  };
  const { restore } = stubFetch((who) => (who === "chain" ? curveLaunch() : who === "ds" ? { pairs: [] } : who === "gt" ? null : undefined));
  try {
    const theirs = "https://cdn.example/their-logo.png";
    const order = { payload: { listingInput: { chain: "robinhood", address: WROTE, sym: "WROTE", name: "Wallet Route", tier: "XPRESS", logoUrl: theirs }, trendHours: 0 } };
    await assert.rejects(fulfil.fulfillListing({ telegram: {} }, order), /stop at create/);
    assert.strictEqual(handed && handed.logoUrl, theirs);
  } finally {
    api.createListing = origCreate;
    restore();
  }
});

test("⚠️ the listing is CREATED after the market read, with the chain's logo adopted — and the trending sibling renders from it too", () => {
  // A source guard, because driving fulfillListing needs a Telegram context, a
  // site and a payment. ORDER is the rule: the read used to sit after the
  // post's logo step, so the row was born blank and stayed blank.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "fulfillment.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const listing = src.slice(src.indexOf("async function fulfillListing("), src.indexOf("async function fulfillTrending("));
  const start = listing.indexOf("const marketP = readPostMarket(");
  const awaited = listing.indexOf("await marketP");
  const adopt = listing.indexOf("adoptChainLogo(input, live)");
  const create = listing.indexOf("api.createListing(input)");
  assert.ok(start > 0 && awaited > 0 && adopt > 0 && create > 0, "the four sites must exist");
  assert.ok(start < awaited && awaited < create, "the market read must be awaited BEFORE the row is created");
  assert.ok(adopt < create, "the chain's logo must be adopted BEFORE the row is created, or the row is born blank");
  assert.strictEqual((listing.match(/readPostMarket\(/g) || []).length, 1, "one read per listing — the post must render from the same record the row was created with");
  const trending = src.slice(src.indexOf("async function fulfillTrending("));
  assert.ok(trending.indexOf("adoptChainLogo(chainLogo, live)") > 0 && trending.indexOf("adoptChainLogo(chainLogo, live)") < trending.indexOf("fetchLogoUrlX(logoUrl)"), "the trending sibling must adopt the chain's logo before fetching");
});

// ── The pad leg is a SLICE of what is left, or the chain is never reached ───
//
// Found by the diagnose pass and reproduced through the real caller: with the
// post's 8s budget, DexScreener misses (a curve has no pair), the GT slice
// spends 4.4s, and the pad leg — a host `launchpads:check` reports unreachable,
// costing LAUNCHPAD_TIMEOUT_MS (6s) per read until its breaker benches it —
// ends at t≈10.4s. The chain read answered at t≈0 and sat one line below,
// un-consulted, while the post's bound fired and printed TBA. The pad keeps
// precedence when it answers in time; a pad that overruns its slice is
// inconclusive, and the chain fills what it left.
test("⚠️ a hanging pad behind a hung GT cannot spend the budget the chain's answer needed", async () => {
  const { MARKET_BUDGET_MS } = require("../src/config/constants");
  // ⚠️ The pad's breaker LEAKS BETWEEN TESTS: three transport failures above
  // benched it, and a benched pad is skipped — which would let this test pass
  // on the unsliced code (no pad wait at all) while claiming to cover the wait.
  // Stated, never inherited.
  require("../src/launchpads").reload();
  const hang = () => new Promise(() => {});
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/pons")) { asked.push("chain"); return { ok: true, status: 200, json: async () => curveLaunch({ priceUsd: 0.0000048, mcapUsd: 4494.71, marketWhy: null, quoteUsdSource: "coinbase" }) }; }
    if (u.includes("dexscreener")) { asked.push("ds"); return { ok: true, status: 200, json: async () => ({ pairs: [] }) }; }
    if (u.includes("geckoterminal")) { asked.push("gt"); return hang(); }
    asked.push("pad");
    return hang();
  };
  const t0 = Date.now();
  try {
    const { live, why } = await fulfil._readPostMarket("robinhood", WROTE, "test");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < MARKET_BUDGET_MS, `the read must finish inside the post's budget, took ${elapsed}ms`);
    assert.ok(live && live.priceUsd === 0.0000048, `the chain's answer must reach the post, got ${JSON.stringify(live)}`);
    assert.strictEqual(why, null, `a priced read has no why: ${why}`);
    assert.ok(asked.includes("pad"), "the pad was still asked — precedence is unchanged, only the WAIT is bounded");
  } finally {
    global.fetch = orig;
  }
});

// ── A chain read that could not be MADE names itself in the post's why ──────
//
// Its `ok:false` reasons stopped at log.debug, so a post publishing TBA over
// a parked reader was reported as "neither indexer returned anything" — a
// failure of ours rendered as a fact about the token.
test("⚠️ the post's why carries a chain read that failed — 'site answered 503' is not 'nothing anywhere knows this token'", async () => {
  const { restore } = stubFetch((who) => (who === "chain" ? { __status: 503 } : who === "ds" ? { pairs: [] } : who === "gt" ? null : undefined));
  try {
    const { live, why } = await fulfil._readPostMarket("robinhood", WROTE, "test");
    assert.strictEqual(live, null, "nothing priced it");
    // The read that failed set the park itself, so the sentence may already
    // carry the park — what matters is that the 503 is NAMED.
    assert.match(String(why), /the chain read failed — .*site answered 503/, `got: ${why}`);
    // …and the park it set is named on the NEXT read, with the reason that set it.
    const again = await fulfil._readPostMarket("robinhood", WROTE, "test");
    assert.match(String(again.why), /parked after a recent failure — site answered 503/, `got: ${again.why}`);
  } finally {
    restore();
  }
});
