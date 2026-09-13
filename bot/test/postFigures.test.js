// "mengapa mc dan price tba" — and the only detector was a person opening the
// channel.
//
// Everything in `postMarket.test.js` beside this pins the CAUSE that was found
// (a GT-first read queued behind every timer job). This pins the DETECTOR, on
// the reasoning that finally settled the trending board after six rounds: the
// causes keep changing and the symptom does not, so what is watched is the
// promise — a paid announcement publishes its real market figures.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-figures-"));

const test = require("node:test");
const assert = require("node:assert");
const pf = require("../src/postFigures");

const FULL = { priceUsd: 0.001004, mcap: 950200, liq: 131200 };
const args = (over = {}) => ({
  kind: "listing", chain: "bsc", address: "0xabc", sym: "HACHIKO",
  name: "Hachiko Inu", tier: "XPRESS", live: FULL, why: null, ...over,
});

test("missing is measured with the RENDERER's predicate, not a second idea of it", () => {
  // channels/format.js prints TBA for `!(p > 0)` — so 0 and null are holes, and
  // that is what the reader sees whatever we think of the number.
  assert.deepEqual(pf.missingFigures(FULL), []);
  assert.deepEqual(pf.missingFigures({ ...FULL, priceUsd: 0 }), ["price"]);
  assert.deepEqual(pf.missingFigures({ ...FULL, mcap: null }), ["market cap"]);
  assert.deepEqual(pf.missingFigures(null), ["price", "market cap", "liquidity"]);
});

test("a post that published every figure pages NOBODY", () => {
  // A line per healthy order buries the ones that matter — the rule the
  // trending watch and the upstream sweep both had to arrive at.
  assert.equal(pf.figureAlert(args()), null);
});

test("a missing LIQUIDITY alone is not an alert — a curve has no pool depth", () => {
  // launchpads.js returns `liquidityUsd: null` on purpose (a 0 there reads as a
  // rug), so paging on it would be permanently red on every pre-migration
  // listing — the state chart:preview sat in for weeks.
  assert.equal(pf.figureAlert(args({ live: { ...FULL, liq: null } })), null);
});

test("a missing price or market cap IS an alert, and it names every hole", () => {
  const html = pf.figureAlert(args({ live: { ...FULL, priceUsd: null, mcap: null, liq: null } }));
  assert.ok(html, "price + market cap missing must page");
  assert.match(html, /price/);
  assert.match(html, /market cap/);
  // Three holes and one hole are different pictures, so the liquidity is named
  // even though it could never have fired on its own.
  assert.match(html, /liquidity/);
  assert.match(html, /\$HACHIKO/);
  assert.match(html, /0xabc/);
});

test("the three silences get three different sentences", () => {
  // ⚠️ "We could not ask" and "nothing is there" are different facts and only
  // the first is ours — and `fetchMarket` collapses BOTH into one null, which
  // is why the reason has to be captured at the read rather than inferred here.
  const timedOut = pf.figureAlert(args({ live: null, why: "the market read passed 8000ms — the shared GeckoTerminal queue" }));
  const nothing = pf.figureAlert(args({ live: null, why: null }));
  const answered = pf.figureAlert(args({ live: { ...FULL, priceUsd: null, mcap: null }, why: null }));

  assert.match(timedOut, /passed 8000ms/);
  assert.match(nothing, /neither DexScreener nor GeckoTerminal/);
  assert.match(answered, /an indexer answered/);
  // They must not read the same, or the operator is sent to the same place for
  // three different problems.
  assert.notEqual(timedOut, nothing);
  assert.notEqual(nothing, answered);
  assert.notEqual(timedOut, answered);
});

test("the alert names the script that separates the causes ON THE BOX", () => {
  // A diagnosis with no hands attached is a bug report the code files against
  // its owner. Whether an indexer answers this server is a property of its
  // egress today.
  const html = pf.figureAlert(args({ live: null }));
  assert.match(html, /market:check -- bsc/);
  // market:check probes the two INDEXERS and reports a Pons curve token as
  // "honest" — the wrong layer for a token priced off the chain. On a chain
  // the Pons reader covers, the remedy names the check that can see it too.
  assert.ok(!/pons:check/.test(html), "an indexer chain names the indexer check only");
  const pons = pf.figureAlert(args({ live: null, chain: "robinhood" }));
  assert.match(pons, /market:check -- robinhood/);
  assert.match(pons, /pons:check/, "a Pons chain also names the curve + ladder check");
});

test("a trending slot is a purchase too", () => {
  const html = pf.figureAlert(args({ kind: "trending", live: null }));
  assert.match(html, /Trending slot/);
});

test("the post is already out, so the watch can never throw", () => {
  // A throw here would turn a degraded announcement into a FAILED ORDER.
  assert.doesNotThrow(() => pf.reportFigures(undefined));
  // The catch is proved by a value that throws while it is being MEASURED —
  // `doesNotThrow` over a healthy argument would pass on a version with no
  // try/catch at all, which is the vacuous half of this assertion.
  assert.equal(pf.reportFigures({ live: { get priceUsd() { throw new Error("boom"); } } }), null);
});

test("markup in a token's own name cannot break the alert", () => {
  // The name and the ticker are whatever the buyer typed, and this is sent with
  // parse_mode HTML — where one stray < makes Telegram reject the WHOLE
  // message with a 400, which is not retried. An alert that vanishes is the
  // silence being fixed.
  const html = pf.figureAlert(args({ live: null, sym: "<b>X", name: "a & <i>b" }));
  assert.ok(!/<b>X/.test(html), "the ticker's own markup must be escaped");
  assert.match(html, /&lt;b&gt;X/);
  assert.match(html, /a &amp; &lt;i&gt;b/);
});

test("BOTH fulfilment paths read through readPostMarket AND report", () => {
  // ⚠️ A rule applied to one of two siblings is a rule half-made — this file's
  // own scar, and the reason the listing and the trending read were merged into
  // one helper in the first place. Comments are stripped: the header above the
  // helper quotes the very call it replaced.
  const src = fss
    .readFileSync(path.join(__dirname, "..", "src", "fulfillment.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal((src.match(/readPostMarket\(/g) || []).length, 3, "one definition, two callers");
  assert.equal((src.match(/postFigures\.reportFigures\(/g) || []).length, 2, "listing AND trending");
  // The bounded read is the one owner now; a second inline copy is how the two
  // paths drift apart again.
  assert.equal((src.match(/market\.fetchMarket\(/g) || []).length, 1, "one market read for both posts");
  assert.ok(/POST_MARKET/.test(src), "and it is still the DexScreener-first order");
});

// ── THE ARTWORK IS THE OTHER HALF OF THE SAME PROMISE ────────────────────────
//
// The round that built this watch covered the FIGURES and stopped. The very
// next paid post went out with TBA on both figures AND the Dexvra mark where
// $WROTE's own logo belongs — and only the second half reached nobody, because
// the banner renders a missing logo as a deliberate-looking fallback. A lost
// logo is INVISIBLE BY DESIGN, which is exactly why it needs the watch more
// than the figures do.

const artArgs = (art) => args({ art });

test("a logo the listing HAS and we could not fetch is an alert on its own", () => {
  // Every figure published. The picture did not, and nothing else would say so.
  const html = pf.figureAlert(artArgs({ wanted: true, got: false, url: "https://ipfs.io/ipfs/bafk" }));
  assert.ok(html, "a healthy-figures post with lost artwork must still page");
  assert.match(html, /its own artwork/);
  assert.match(html, /Dexvra mark/);
  assert.match(html, /bafk/, "the url that would not load is the diagnosis");
});

test("⚠️ …but a listing that never had a logo pages NOBODY", () => {
  // The Dexvra mark is the DESIGN for a logoless token, not a degraded card.
  // Paging here would be permanently red on every listing whose owner uploaded
  // nothing — the state `chart:preview` sat in for weeks.
  assert.equal(pf.figureAlert(artArgs({ wanted: false, got: false, url: null })), null);
  assert.equal(pf.figureAlert(artArgs(undefined)), null, "a caller that does not know must not page");
  assert.equal(pf.artworkLost(undefined), false);
  assert.equal(pf.artworkLost({ wanted: false, got: false }), false);
  assert.equal(pf.artworkLost({ wanted: true, got: true }), false);
  assert.equal(pf.artworkLost({ wanted: true, got: false }), true);
});

// ── the third artwork state ─────────────────────────────────────────────────
//
// `$ORCHFLOWS` (Pons, Robinhood) reached 12,514 subscribers drawing the Dexvra
// mark, and this watch said nothing: `wanted` is false for a blank row, and a
// blank row is what a creator who uploaded nothing leaves. Correct for a
// creator's choice, and a LIE when the source was refused — the banner renders
// both identically, so the operator was the detector for a third time.
test("⚠️ a blank the CURVE READ could not fill is a fault, not a creator's choice", () => {
  const html = pf.figureAlert(artArgs({ wanted: false, got: false, url: null, absentWhy: "rpc 429 (rate limited)" }));
  assert.ok(html, "a refused curve read published the fallback mark and paged nobody");
  assert.match(html, /its own artwork/);
  assert.match(html, /CURVE READ/);
  assert.match(html, /rpc 429/, "the read's own reason is the diagnosis");
  assert.match(html, /not the project publishing no logo/);
});

test("…and it names the layer that failed, never the row's own url", () => {
  // `logos:check` pulls the ROW's logo through /api/logo, and the row has none
  // — it would report "nobody has given this token artwork", which is the very
  // claim in question. The layer that failed is the curve read.
  const html = pf.figureAlert(artArgs({ wanted: false, got: false, url: null, absentWhy: "the chain read failed" }));
  assert.match(html, /pons:check/);
  assert.ok(!/logos:check/.test(html), `the wrong layer:\n${html}`);
  assert.equal(pf.artRemedy("unread", "robinhood", "0xabc"), "npm run pons:check");
});

test("⚠️ …and a genuinely blank row still pages NOBODY", () => {
  // Without this the alert is permanently red on every listing whose owner
  // published no artwork, which is most of them — the `chart:preview` state.
  assert.equal(pf.figureAlert(artArgs({ wanted: false, got: false, url: null, absentWhy: null })), null);
  assert.equal(pf.artworkUnread(undefined), false);
  assert.equal(pf.artworkUnread({ wanted: false }), false);
  assert.equal(pf.artworkUnread({ wanted: false, absentWhy: "x" }), true);
  // A row that HAS a logo is the other state and keeps the other sentence.
  assert.equal(pf.artworkUnread({ wanted: true, got: true, absentWhy: "x" }), false);
});

test("BOTH fulfilment paths carry the blank's reason — a rule on one sibling is half-made", () => {
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const reports = src.match(/reportFigures\(\{[\s\S]*?\n  \}\);/g) || [];
  assert.equal(reports.length, 2, "a listing and a trending slot");
  for (const r of reports) {
    const art = /art: \{([\s\S]*?)\n    \}/.exec(r) || /art: \{([\s\S]*?)\}/.exec(r);
    assert.ok(art, "an art block");
    assert.match(art[1], /absentWhy: live && live\.logoWhy/, `the sibling cannot report a blank it could not fill:\n${r}`);
  }
});

test("⚠️ the ticker carries exactly ONE $ — the store's sym already has it", () => {
  // `post:check` printed `$$ORCHFLOWS` on the line whose whole job is naming
  // the token, and this alert did the same: both wrote `$` + a `sym` the
  // listing store already spells `$ORCHFLOWS`. The `From $1,000,0…` defect, on
  // the two surfaces an operator reads while deciding what is wrong.
  const withDollar = pf.figureAlert(args({ sym: "$ORCHFLOWS", live: null }));
  assert.ok(!/\$\$/.test(withDollar), `two dollar signs:\n${withDollar}`);
  assert.match(withDollar, /<b>\$ORCHFLOWS<\/b>/);
  // …and a sym stored WITHOUT one still gets it. Both spellings are in the
  // wild, which is why six other places in this repo strip before prepending.
  assert.match(pf.figureAlert(args({ sym: "ORCHFLOWS", live: null })), /<b>\$ORCHFLOWS<\/b>/);
});

test("one post is ONE alert, naming both halves and both scripts", () => {
  const html = pf.figureAlert(args({
    live: null,
    art: { wanted: true, got: false, url: "https://ipfs.io/ipfs/bafk" },
  }));
  assert.match(html, /without price · market cap · liquidity · its own artwork/);
  // Different layers, different scripts — a logo that will not load and an
  // indexer that will not answer send an operator to different places.
  assert.match(html, /market:check/);
  assert.match(html, /logos:check/);
  assert.equal(html.split("\n").filter((l) => /Run <code>/.test(l)).length, 2);
});

test("⚠️ a post whose ONLY hole is the picture does not blame the market read", () => {
  // "Why: neither DexScreener nor GeckoTerminal returned anything" over a post
  // that published a price and a cap sends the operator to the wrong layer.
  const html = pf.figureAlert(artArgs({ wanted: true, got: false, url: "https://x/y.png" }));
  assert.ok(!/^Why:/m.test(html), `the market sentence must not appear:\n${html}`);
  assert.ok(!/market:check/.test(html), "nor the market script");
});

test("BOTH fulfilment paths report the artwork, from the buffer the banner gets", () => {
  // A source scan, because the alternative is booting the whole order flow —
  // and the defect this guards is a call site that quietly stops passing `art`.
  const src = require("node:fs").readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const reports = src.match(/reportFigures\(\{[\s\S]*?\n  \}\);/g) || [];
  assert.equal(reports.length, 2, "a listing and a trending slot");
  for (const r of reports) {
    assert.match(r, /art: \{/, `every report carries the artwork:\n${r}`);
    assert.match(r, /got: !!logoBuffer/, "…read off the buffer, never re-fetched from the url");
    // …and the facts the fetch returned, so the alert can say WHICH refusal.
    // ⚠️ INSIDE THE `art:` SUB-BLOCK. Matched against the whole call this was
    // satisfied by the figures' own `why: marketWhy` — a mutant that dropped the
    // artwork's why survived while the test claimed to cover it.
    const art = /art: \{([\s\S]*?)\}/.exec(r);
    assert.ok(art, "an art block");
    assert.match(art[1], /reached:/, "the proxy's reached rides with the artwork");
    assert.match(art[1], /why:/, "…and its why, or the alert cannot say which refusal");
  }
  // ⚠️ AND THE TRENDING FETCH MUST SIT ABOVE ITS WATCH. It used to be below,
  // and a watch cannot report artwork it has not seen yet.
  // The X form now — the fetch that also carries reached/status/why.
  // ⚠️ Pinned to the PROPERTY, not a spelling: this used to match the literal
  // `fetchLogoUrlX(row.logoUrl)` and went red the day the trending path
  // started adopting a curve token's contract logo (`fetchLogoUrlX(logoUrl)`)
  // — over code that keeps the rule perfectly. The rule is that the trending
  // section's LAST fetch sits above its watch, whatever url it is handed.
  const watchAt = src.indexOf('kind: "trending", chain: p.chain');
  assert.ok(watchAt > 0, "the trending watch exists");
  const fetchAt = src.lastIndexOf("await fetchLogoUrlX(", watchAt);
  const listingWatchAt = src.indexOf('kind: "listing", chain:');
  assert.ok(fetchAt > 0, "a trending logo fetch exists");
  assert.ok(fetchAt > listingWatchAt, "…and it is the TRENDING section's fetch, not the listing's");
  assert.ok(fetchAt < watchAt, "the trending logo is fetched BEFORE the watch reads it");
});


// ── artFailure: ONE owner of the class, shared by the alert and the check ────
//
// The classes send an operator to different places, and the proxy's
// x-logo-why is what separates them. Tested by CALLING it.

test("artFailure classes a refusal by what the proxy actually said", () => {
  assert.equal(pf.artFailure({ reached: false }).cls, "web-app");
  assert.equal(pf.artFailure({ reached: true, status: 404, why: "ipfs.io: served text/html after 900ms" }).cls, "not-an-image");
  // ⚠️ A 429 is a gateway refusing THIS SERVER — not cold content. Classing it
  // as "no gateway had it" sends the operator to pin something a pin cannot fix.
  assert.equal(pf.artFailure({ reached: true, status: 404, why: "ipfs.io: no answer after 5000ms; gateway.pinata.cloud: HTTP 429 after 310ms" }).cls, "gateway-refusing");
  assert.equal(pf.artFailure({ reached: true, status: 400, why: null }).cls, "refused-by-us");
  assert.equal(pf.artFailure({ reached: true, status: 404, why: "ipfs.io: no answer after 5000ms; dweb.link: no answer after 4800ms" }).cls, "no-gateway-had-it");
  assert.equal(pf.artFailure({ reached: true, status: 502, why: null }).cls, "web-app");
});

test("artRemedy names the ONE command per class, with real values", () => {
  assert.equal(pf.artRemedy("no-gateway-had-it", "solana", "BzAt"), "npm run post:check -- solana BzAt --pin");
  assert.equal(pf.artRemedy("gateway-refusing", "solana", "BzAt"), "npm run post:check -- solana BzAt --pin");
  assert.equal(pf.artRemedy("not-an-image", "solana", "BzAt"), "npm run logos:check -- solana BzAt");
  assert.equal(pf.artRemedy("refused-by-us", "solana", "BzAt"), "npm run logos:check -- solana BzAt");
});

test("⚠️ the alert carries the proxy's verdict, the class sentence and the --pin line", () => {
  const html = pf.figureAlert(args({
    art: { wanted: true, got: false, url: "https://ipfs.io/ipfs/bafk", reached: true, status: 404, why: "ipfs.io: no answer after 5000ms; dweb.link: no answer after 4800ms" },
  }));
  assert.match(html, /\/api\/logo answered 404: ipfs\.io: no answer after 5000ms/);
  assert.match(html, /flips with gateway cache state/, "the class sentence, from the one owner");
  assert.match(html, /npm run post:check -- bsc 0xabc --pin/, "the remedy carries the order's real values");
  assert.ok(!/logos:check/.test(html), "not the deterministic remedy for a flaky class");
});

test("…and a healthy post with pinned artwork still pages nobody", () => {
  assert.equal(pf.figureAlert(args({ art: { wanted: true, got: true, url: "/api/media/0123456789abcdef01234567.png", reached: true, status: 200, why: null } })), null);
});
