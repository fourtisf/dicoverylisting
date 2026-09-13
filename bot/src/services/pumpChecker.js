// Pump alerts: polls each approved listing's live price and announces every ROUND
// MILESTONE it passes — +100%, +200%, +300% … up to the ceiling — measured from
// the baseline (the price first observed by the bot ≈ listing time). One alert per
// step, each posted as a REPLY to the original listing post and tweeted as a quote
// of the listing tweet; carries the admin's pump GIF/video clip when one is set.
// The window (default 100%–2000%) is admin-configurable; see the milestone block
// below for why the number announced is a step and not the raw gain. Baseline and
// the per-step latch persist across restarts.
const { PUMP_CHECK_MS, CHANNELS, SITE_URL, X_POST_TIMEOUT_MS } = require("../config/constants");
const api = require("../api/dexvra");
// ⚠️ `fetchPrice`, NOT `fetchMarket`. This loop prices EVERY approved listing
// every three minutes and reads two fields off the answer — the price and the
// market cap — so on the heavy read it was, by itself, most of a
// thirty-requests-a-minute GeckoTerminal ceiling that is counted per IP and
// shared with the website's candlestick charts on the same box. DexScreener
// publishes both numbers and costs us none of that budget; GT is still asked
// for the chains and the tokens DexScreener cannot answer. See marketdata.js.
const { fetchPrice } = require("../marketdata");
const postids = require("../channels/postids");
const fmt = require("../channels/format");
const post = require("../channels/post");
const bannerTemplate = require("../bannerTemplate");
const x = require("../twitter");
const { fmtPrice, formatNumber } = require("../helpers/format");
const { DedupSet, loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

// Alert window (min%/max%) is admin-configurable via pumpConfig — read fresh
// each poll so an @dexvraadminbot change applies next cycle. Above the ceiling
// is almost always bad market data (thin liquidity / a bad tick), so it's
// skipped rather than posted.
const pumpConfig = require("./pumpConfig");
const BASE_FILE = "pumpbase.json";
let baseline = loadJSONSync(BASE_FILE, {});
const latch = new DedupSet("pumplatch.json");
const keyOf = (r) => `${r.chain}:${String(r.address).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- milestones
//
// A pump alert announces a ROUND STEP — +100%, +200%, +300% … up to the ceiling —
// and announces one EVERY time the token reaches a new step.
//
// It used to fire exactly once per token, at whatever the raw gain happened to be
// on the poll that caught it. That is why a token up 282% announced "+282%": not a
// threshold anybody chose, just the number the 30-second poll landed on. A token
// that then went on to 10x said nothing more about it.
//
// Two rules keep the ladder from becoming noise:
//   • a step is announced at most once, ever (latched per token AND per step);
//   • a token that JUMPS several steps between polls — 90% straight to 450% —
//     announces ONCE, at the highest step it reached, and the steps it skipped are
//     marked consumed rather than posted. Four alerts in one second for one price
//     move is spam, not information.
const MILESTONE_STEP = Math.max(1, Math.round(Number(process.env.PUMP_MILESTONE_STEP) || 100));

/** The step this gain has reached, or null if it has not reached one.
 *  Floored, so +282% is "+200%" — the milestone actually passed, never rounded up
 *  to one the token has not reached. */
function milestoneFor(pct, minPct, maxPct) {
  if (!(pct >= minPct)) return null;
  const m = Math.floor(pct / MILESTONE_STEP) * MILESTONE_STEP;
  return m >= minPct && m <= maxPct ? m : null;
}
/** Latch keys for every step from the floor up to and including `milestone`. */
function stepKeys(key, milestone, minPct, maxPct) {
  const out = [];
  const first = Math.ceil(minPct / MILESTONE_STEP) * MILESTONE_STEP;
  for (let m = first; m <= milestone && m <= maxPct; m += MILESTONE_STEP) out.push(`${key}@${m}`);
  return out;
}

/** Retire a pre-ladder token onto the ladder, ONCE.
 *
 *  Before the ladder a token latched under its BARE key, so on the first poll
 *  after the upgrade it is already standing above steps it never announced.
 *  Those steps are consumed rather than posted, or deploying would have dumped an
 *  alert for every previously-pumped listing into the channel at once.
 *
 *  Dropping the legacy marker is the other half, and leaving it out is a bug that
 *  looks exactly like success: the marker made `latch.has(key)` true FOREVER, so
 *  every later step took this same silent branch and the token could never alert
 *  again. It went unnoticed because nothing is logged and nothing is posted —
 *  the only trace was consumed step keys in the latch file with no matching
 *  alert. Absorb once, drop the marker, and the very next step posts normally. */
async function absorbLegacy(latchSet, key, milestone, minPct, maxPct) {
  await latchSet.addAll(stepKeys(key, milestone, minPct, maxPct));
  await latchSet.delete(key);
  return true;
}

/** What this poll should do with a token standing at `milestone`:
 *    'retire' — a pre-ladder token: consume its history, drop the legacy marker,
 *               post nothing;
 *    'skip'   — this step has already been announced;
 *    'post'   — announce it.
 *
 *  ORDER MATTERS, and getting it wrong is subtle enough to have shipped twice.
 *  The legacy marker is checked FIRST. Checking the step latch first looks
 *  equivalent and is not: a token already carrying a consumed step key for where
 *  it currently stands would 'skip' every poll, so the marker survived until the
 *  token reached a NEW step — and the migration branch then ate that step too,
 *  because retiring never posts. Retiring on the very next poll costs the token
 *  nothing it had not already lost, and it alerts normally from then on. */
function decide(latchSet, key, milestone) {
  if (latchSet.has(key)) return "retire";
  if (latchSet.has(`${key}@${milestone}`)) return "skip";
  return "post";
}

function coinOf(r, price, mcap) {
  return {
    name: r.name,
    symbol: r.sym,
    chain: r.chain,
    address: r.address,
    tier: r.tier,
    price,
    mcap,
    links: { website: r.website, twitter: r.twitter, telegram: r.telegram },
    siteUrl: `${SITE_URL}/token/${r.chain}/${r.address}`,
  };
}

/** Fetch a token logo into a Buffer (relative /api/media/… → public SITE_URL). */
async function fetchLogoBuffer(logoUrl) {
  if (!logoUrl) return null;
  const url = logoUrl.startsWith("http") ? logoUrl : `${SITE_URL}${logoUrl}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** Build the pump-alert media. When the admin has set a pump GIF/video, the
 *  token overlay (▲ +N% · old→new price · MCAP pill · logo ring · cyan $ticker)
 *  is composited onto it — the same auto-fill the listing/trending banners get,
 *  but with pump's DISTINCT layout. Falls back to the raw clip on any failure,
 *  and null when no clip is set (caller then posts a plain text reply). */
async function pumpMedia(r, base, m, pct) {
  const media = bannerTemplate.mediaOverride("pump"); // admin GIF/video (null → text reply)
  if (!media) return null;
  try {
    const logoBuffer = await fetchLogoBuffer(r.logoUrl);
    const filled = await bannerTemplate.composeOntoClip("pump", media, logoBuffer, {
      symbol: r.sym,
      name: r.name,
      chain: r.chain,
      change: `+${Math.round(pct)}%`,
      priceFrom: fmtPrice(base.price),
      priceTo: fmtPrice(m.priceUsd),
      price: fmtPrice(m.priceUsd),
      mcap: m.mcap ? "$" + formatNumber(m.mcap) : null,
    });
    if (filled) {
      log.info(`[pump] ${r.sym} media: admin clip + pump overlay ✔`);
      return filled;
    }
    log.warn(`[pump] ${r.sym} media: overlay composite failed — sending clip as-is`);
  } catch (e) {
    log.warn(`[pump] ${r.sym} overlay: ${e.message}`);
  }
  // Raw clip: a .gif has to become an MP4 or Telegram posts it as a file card
  // instead of playing it (see bannerTemplate.toInlineClip).
  return bannerTemplate.toInlineClip(media);
}

/**
 * Where a pump alert is allowed to appear for this token: ONLY a channel where
 * it HAS a listing post to reply to. That is the whole rule, and it is a
 * business rule, not just a Telegram one:
 *
 *   Xpress Listing            → @dexvralisting only. An Xpress buyer gets no
 *                               @dexvraio announcement, so there is nothing to
 *                               reply to there and no pump alert there either.
 *   Listing & Trending (top   → both channels, each replying to ITS OWN post.
 *   tiers, which do announce)
 *
 * An empty list means NO alert. A pump alert must never be posted stand-alone:
 * out of thread it reads as an ad for a token the channel never listed.
 */
function pumpTargets(ids = {}) {
  const out = [];
  if (ids.listingMsgId) out.push({ channel: CHANNELS.listing, replyTo: ids.listingMsgId });
  if (ids.annMsgId) out.push({ channel: CHANNELS.announce, replyTo: ids.annMsgId });
  return out;
}

function start(tg) {
  const run = async () => {
    let listings;
    try {
      listings = await api.getListings();
    } catch {
      return;
    }
    const now = Date.now();
    for (const r of listings) {
      if (r.status !== "approved") continue;
      const key = keyOf(r);
      const m = await fetchPrice(r.chain, r.address).catch(() => null);
      await sleep(300); // be polite to the indexers — mostly DexScreener now
      if (!m || !m.priceUsd) continue;

      if (!baseline[key]) {
        baseline[key] = { price: m.priceUsd, mcap: m.mcap || null, at: now };
        await saveJSON(BASE_FILE, baseline).catch(() => {});
        continue; // no alert on first observation
      }
      const base = baseline[key];
      if (!base.price || m.priceUsd < base.price) continue;
      const pct = ((m.priceUsd - base.price) / base.price) * 100;
      const { minPct, maxPct } = pumpConfig.get(); // admin-set window (default 100%–2000%)
      if (pct < minPct || pct > maxPct) continue;

      // Announce the STEP reached, not the raw gain this poll happened to catch.
      const milestone = milestoneFor(pct, minPct, maxPct);
      if (milestone == null) continue;
      // retire / skip / post — see decide(). MIGRATION off the old once-per-token
      // latch happens first: before the ladder a token latched under its BARE key,
      // and every one of those already stands above steps it never announced, so
      // announcing them would dump an alert for every previously-pumped listing
      // into a channel with twelve thousand subscribers the moment this deploys.
      const action = decide(latch, key, milestone);
      if (action === "skip") continue; // this step already went out
      if (action === "retire") {
        await absorbLegacy(latch, key, milestone, minPct, maxPct);
        log.event(
          `📈 Pump: ${r.sym || r.address} pre-ladder — steps ≤ ${milestone}% absorbed, next alert at +${milestone + MILESTONE_STEP}%`,
        );
        continue;
      }

      const ids = postids.get(r.chain, r.address);
      const targets = pumpTargets(ids);
      if (!targets.length) {
        // Nothing to reply to — usually a token listed before post ids were
        // recorded, or one whose listing post failed. No latch: if the id shows
        // up later the pump can still be announced.
        log.debug(`[pump] ${r.sym || r.address}: no listing post to reply to — skipped`);
        continue;
      }
      const coin = coinOf(r, m.priceUsd, m.mcap);
      const media = await pumpMedia(r, base, m, milestone); // admin pump clip + overlay (null → text reply)
      // A pump tweet MUST quote the token's own listing tweet — the same rule
      // pumpTargets enforces on Telegram, for the same reason: standing alone on
      // the listing feed, "+240% since listing" is indistinguishable from a shill
      // post for a token that account never announced. The quoted listing card is
      // what makes it a follow-up. No known listing tweet → no tweet at all
      // (the Telegram alert still goes out, and the card's X line drops itself).
      //
      // Fired BEFORE the card is BUILT, not after it is sent: the card carries an
      // "Announce On X" line, and a tweet made afterwards can never reach it.
      // Timeboxed and best-effort — the alert still posts if X is slow or off.
      let pumpTweetId = null;
      if (ids.listingTweetId) {
        pumpTweetId = await Promise.race([
          x.postPump(coin, milestone, base.mcap || 0, m.mcap || 0, ids.listingTweetId, media).catch(() => null),
          new Promise((res) => setTimeout(res, X_POST_TIMEOUT_MS, null)),
        ]);
      } else if (x.enabled()) {
        log.debug(`[pump] ${r.sym || r.address}: no listing tweet to quote — Telegram only`);
      }
      if (pumpTweetId) coin.xUrl = `https://x.com/i/status/${pumpTweetId}`;
      const card = fmt.pumpPost(coin, milestone, base.mcap || 0, m.mcap || 0);
      // "Did the alert post?" means ANY target took it, not specifically the
      // listing channel. Counting only CHANNELS.listing left a token that has an
      // @dexvraio announcement but no listing-channel post (the listing post
      // failed, or an admin force-posted only the announcement) posting to
      // @dexvraio successfully, never latching, and re-firing on EVERY poll —
      // duplicate announcements forever, and now a duplicate tweet with them.
      let posted = null;
      try {
        for (const t of targets) {
          const msg = await post.sendMedia(t.channel, media, card, { replyTo: t.replyTo });
          if (msg) posted = posted || msg;
        }
      } catch (e) {
        log.warn(`[pump] post: ${e.message}`);
      }
      // Latch only AFTER the alert really posted. Spending the once-per-token
      // budget at DETECTION time meant a failed post burned it forever and the
      // token could never alert again.
      if (!posted) {
        log.warn(`[pump] ${r.sym || r.address}: +${milestone}% alert did not post — not latching, will retry next cycle`);
        continue;
      }
      // Consume the step just announced AND every step below it, so a jump that
      // cleared several at once cannot backfill them as separate alerts later.
      await latch.addAll(stepKeys(key, milestone, minPct, maxPct));
      log.event(`📈 Pump: ${r.sym} +${milestone}% since listing (${r.chain}, actual +${Math.round(pct)}%)`);
    }
  };
  const iv = setInterval(run, PUMP_CHECK_MS);
  const kick = setTimeout(run, 15000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, pumpTargets, milestoneFor, stepKeys, absorbLegacy, decide, MILESTONE_STEP };
