"use strict";
/**
 * DID THE POST GO OUT WITH ITS REAL MARKET FIGURES? — the promise, watched.
 *
 * ⚠️ "Market cap: TBA · Price: TBA" REACHED 12,528 SUBSCRIBERS over a token
 * dexvra.io was pricing at $0.001004 on a $950.2K cap in the same minute, and
 * the only thing anywhere that noticed was a person opening the channel and
 * screenshotting it. That is the shape this file keeps paying for — the
 * trending board's blank percentage, the free-listing feed going quiet, a
 * chain of $0 rows — and every time the answer has been the same one: WATCH
 * THE PROMISE, because the causes keep changing.
 *
 * The cause that day was the GeckoTerminal queue and it is fixed (`POST_MARKET`
 * in fulfillment.js reads DexScreener first). The causes still available all
 * render IDENTICALLY: both indexers refusing this box, a chain neither covers,
 * a token with genuinely no pool, the shared budget spent, an upstream renaming
 * a field. So what is measured here is the RENDER — what the buyer's
 * announcement actually said — and never a cause.
 *
 * ⚠️ IT MEASURES WITH THE RENDERER'S OWN PREDICATE. `channels/format.js` prints
 * TBA for `!(p > 0)`, so that is the test here too: a watch with its own idea
 * of "missing" eventually disagrees with the post it is watching, which is how
 * `fonts:check` printed nine green ticks over a banner publishing boxes.
 *
 * ⚠️ AND THE ARTWORK IS THE OTHER HALF OF THE SAME PROMISE. The round that
 * built this watched the FIGURES and stopped there — so the very next paid post
 * went out with TBA on both figures AND the Dexvra mark where $WROTE's own logo
 * belongs, and only the second half reached nobody: the banner renders a
 * missing logo as a deliberate-looking fallback, so a lost one is INVISIBLE by
 * design. A watch on half a promise is how the other half keeps being found by
 * screenshot. One post, one alert — never a second message, because they are
 * one order and one fault to act on.
 */
const log = require("./helpers/logger");
const ponsChain = require("./ponsChain");
const { ticker } = require("./helpers/format");

/** Renders as a figure, rather than as TBA / — (`priceStr`, `mcStr`, `liqStr`). */
const rendered = (v) => Number(v) > 0;

const FIGURES = [
  ["price", (m) => rendered(m && m.priceUsd)],
  ["market cap", (m) => rendered(m && m.mcap)],
  ["liquidity", (m) => rendered(m && m.liq)],
];

/**
 * ⚠️ LIQUIDITY ALONE IS NOT AN ALERT, and that is a judgement rather than an
 * oversight. A token still on a bonding curve has no pool depth to report —
 * `launchpads.js` returns `liquidityUsd: null` deliberately, because a 0 there
 * reads as a rug — so a missing liquidity line is routinely a FACT ABOUT THE
 * TOKEN. Paging on it would make this permanently red on every pre-migration
 * listing, which is the state `chart:preview` sat in for weeks. Price and
 * market cap are the two the buyer's post cannot do without, and they are the
 * two that were reported. A missing liquidity is still NAMED whenever one of
 * those fires, because three holes and one hole are different pictures.
 */
const KEY_FIGURES = new Set(["price", "market cap"]);

/**
 * Did the post draw the token's OWN artwork, or the fallback mark?
 *
 * ⚠️ "THE PROJECT GAVE US NO LOGO" AND "WE COULD NOT FETCH THE ONE THEY GAVE
 * US" ARE DIFFERENT FACTS, and the banner renders them identically — as the
 * Dexvra mark, which is the DESIGN for a logoless token and not a degraded
 * card. So only the second is a red mark. Paging on the first would make this
 * permanently red on every listing whose owner uploaded nothing, which is the
 * state `chart:preview` sat in for weeks; it is the same line `pons:check` §6
 * draws between a creator who filled nothing in and an app that dropped it.
 *
 * `got` is read from the BUFFER the renderer was actually handed, never
 * re-derived from the url — a watch that re-fetched would be asking a different
 * question from the one the banner asked, and could answer yes over a post that
 * drew the mark.
 */
/**
 * WHICH KIND of artwork failure — pure, ONE owner shared by the ops alert and
 * post:check, because two copies of this classification would drift into two
 * plausible-looking sentences.
 *
 * The classes matter because they send an operator to different places, and
 * the proxy's `x-logo-why` (built from gateway outcomes) is what separates
 * them. A 429 from a gateway is that gateway refusing THIS SERVER, not missing
 * content; `served text/html` is a directory CID no pin can help; "no answer"
 * from every gateway is the cold-cache flip that a pin ENDS.
 */
function artFailure({ reached, status, why } = {}) {
  const w = String(why || "");
  if (!reached) {
    return { cls: "web-app", sentence: "/api/logo did not answer — is dexvra mid-deploy? This is about the web app, not the artwork." };
  }
  if (/served text\/html/i.test(w)) {
    return { cls: "not-an-image", sentence: "a gateway served HTML, not an image — this is a directory CID; the stored url needs a different logo, a pin cannot help." };
  }
  if (/HTTP (401|403|429)\b/.test(w)) {
    return { cls: "gateway-refusing", sentence: "a gateway is refusing THIS SERVER (401/403/429) — not missing content; it may clear, or IPFS_GATEWAYS needs a different first entry." };
  }
  if (status === 400 && !w) {
    return { cls: "refused-by-us", sentence: "our own proxy refused the url (allowlist or redirect guard) — deterministic; the stored url is the problem." };
  }
  if (w) {
    return { cls: "no-gateway-had-it", sentence: "no gateway had it inside the budget — this flips with gateway cache state and is not a regression; pin it so no post asks a gateway again." };
  }
  if (status >= 500 || (status > 0 && status !== 404)) {
    return { cls: "web-app", sentence: `/api/logo answered ${status} with no reason — a non-logo response; check the web app.` };
  }
  return { cls: "no-gateway-had-it", sentence: "no gateway served it as an image — pin it so no post asks a gateway again." };
}

/** The one-command remedy for a flaky class, with REAL values from the order. */
function artRemedy(cls, chain, address) {
  // The row has NO url, so `logos:check` (which pulls the row's own logo
  // through /api/logo) has nothing to pull and would report "nobody has given
  // this token artwork" — the very claim that is in question. The layer that
  // failed is the curve read.
  if (cls === "unread") return `npm run pons:check`;
  if (cls === "no-gateway-had-it" || cls === "gateway-refusing") {
    return `npm run post:check -- ${chain} ${address} --pin`;
  }
  return `npm run logos:check -- ${chain} ${address}`;
}

function artworkLost(art) {
  return !!(art && art.wanted && !art.got);
}

/**
 * THE THIRD ARTWORK STATE: the row is BLANK because we could not ask.
 *
 * ⚠️ `$ORCHFLOWS` (Pons, Robinhood) went out to 12,514 subscribers drawing the
 * Dexvra mark while its own logo rendered on ponsfamily.com in the same minute
 * — and this watch was silent, because `wanted` is false for a blank row and a
 * blank row is what a creator who uploaded nothing leaves. That silence is
 * correct for a creator's choice and is a LIE when the source was refused: the
 * banner renders both identically, so the operator was the detector again.
 *
 * `absentWhy` is set only where the CHAIN — the source that cannot be
 * unreachable — could not answer (marketdata `logoFromCurve`). A benched pad
 * never sets it, or this would page on every Robinhood listing whose owner
 * published no artwork, which is the permanently-red state `chart:preview` sat
 * in for weeks.
 */
function artworkUnread(art) {
  return !!(art && !art.wanted && art.absentWhy);
}

/** Which of the post's three market figures will publish as a hole. */
function missingFigures(live) {
  return FIGURES.filter(([, ok]) => !ok(live)).map(([name]) => name);
}

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The ops alert for a paid post that published a hole — or null when it did not.
 *
 * PURE, so the test CALLS it. "Never pages on a healthy post" and "says which
 * of the two silences it was" are behavioural rules, and a source scan cannot
 * tell a rule from a comment about one — the `logoWrite.ts` contract.
 */
function figureAlert({ kind, chain, address, sym, name, tier, live, why, siteUrl, art } = {}) {
  const missing = missingFigures(live);
  const lostArt = artworkLost(art);
  const unreadArt = artworkUnread(art);
  // Either half of the promise is enough to page. A missing LIQUIDITY still is
  // not — see KEY_FIGURES — but it is named below whenever something else fires.
  if (!missing.some((f) => KEY_FIGURES.has(f)) && !lostArt && !unreadArt) return null;
  const holes = lostArt || unreadArt ? [...missing, "its own artwork"] : missing;

  // ⚠️ "WE COULD NOT ASK" AND "NOTHING IS THERE" ARE DIFFERENT FACTS, and only
  // the first is ours to fix. They are also the only two states the operator
  // can act on differently: one is a budget or an outage, the other is a token
  // no indexer covers yet, and sending them the same sentence is how three
  // rounds of this went to the wrong setting.
  const keyMissing = missing.filter((f) => KEY_FIGURES.has(f));
  const cause = why
    ? esc(why)
    : live
      ? "an indexer answered and publishes no " + keyMissing.join(" or ") + " for it"
      : "neither DexScreener nor GeckoTerminal returned anything — either both refused this box, or the token has no indexed pool yet";

  const label = kind === "trending" ? "Trending slot" : "Listing";
  const head = `⚠️ <b>${label} published without ${holes.map(esc).join(" · ")}</b>`;
  return [
    head,
    `<b>${esc(ticker(sym))}</b>${name ? ` — ${esc(name)}` : ""} · ${esc(String(chain).toUpperCase())}${tier ? ` · ${esc(tier)}` : ""}`,
    // Only when a figure is actually missing: this sentence is about the market
    // read, and printing it over a post whose only hole was the picture would
    // send the operator to the wrong layer.
    keyMissing.length ? `Why: ${cause}` : "",
    // The artwork gets its own sentence and its own script, because a logo that
    // would not load and an indexer that would not answer are different layers.
    lostArt
      ? `Artwork: this listing HAS a logo and it could not be fetched — the banner drew the Dexvra mark instead.${art.url ? ` <code>${esc(art.url)}</code>` : ""}`
      : "",
    // The proxy's own verdict and its CLASS — never one sentence for every
    // refusal. Built from upstream hostnames and content types, so escaped.
    lostArt && (art.status || art.why)
      ? `/api/logo answered ${esc(art.status || "?")}${art.why ? `: ${esc(art.why)}` : ""}`
      : "",
    lostArt ? esc(artFailure(art).sentence) : "",
    // The blank that is OURS. It names the read's own reason, because "the RPC
    // refused us" and "this project published no logo" send an operator to
    // completely different places and the banner draws them identically.
    unreadArt
      ? `Artwork: the row is blank because the CURVE READ could not answer — ${esc(art.absentWhy)}. This is not the project publishing no logo; the banner drew the Dexvra mark.`
      : "",
    `<code>${esc(address)}</code>`,
    siteUrl ? esc(siteUrl) : "",
    // A count is not a diagnosis. These are the scripts that separate the causes
    // ON THE BOX, which is the only place they can be told apart — whether an
    // indexer or a CDN answers this server is a property of its egress today,
    // not of this code.
    // …and on a chain whose tokens can be priced OFF THE CHAIN, the check that
    // can see it: market:check probes the two indexers and reports a Pons
    // curve token as "honest", which is the wrong layer for a curve.
    keyMissing.length
      ? `Run <code>npm run market:check -- ${esc(chain)}</code>${ponsChain.covers(chain) ? ` and <code>npm run pons:check</code> (the curve and the ETH/USD ladder)` : ""} on the box.`
      : "",
    lostArt ? `Run <code>${esc(artRemedy(artFailure(art).cls, chain, address))}</code> on the box.` : "",
    !lostArt && unreadArt ? `Run <code>${esc(artRemedy("unread", chain, address))}</code> on the box.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Send it, if there is one.
 *
 * ⚠️ THE POST IS ALREADY OUT BY THE TIME THIS RUNS, so a throw here would turn
 * a degraded announcement into a FAILED ORDER — the rule the free-listing
 * report already states one service over. Never deduped: each of these is a
 * separate paying customer, and collapsing two would hide one of them.
 */
function reportFigures(args) {
  try {
    const html = figureAlert(args);
    if (html) log.alert(html);
    return html;
  } catch (e) {
    log.warn(`[fulfil] figure watch: ${e.message}`);
    return null;
  }
}

module.exports = { missingFigures, artworkLost, artworkUnread, artFailure, artRemedy, figureAlert, reportFigures, KEY_FIGURES };
