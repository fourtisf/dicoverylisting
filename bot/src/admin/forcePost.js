// Force-publish a REAL channel post on demand, from @dexvraadminbot.
//
// WHY: every post type (listing, listing+trending, trending, rank-up, pump,
// banner ad) only fires on a real event — a paid order, a rank change, a pump.
// Verifying a template or a freshly uploaded clip meant waiting for one to
// happen, so nobody could see the finished post before the audience did.
//
// This runs the SAME code the real events run — fmt.* for the caption,
// fulfillment.postMedia() for the artwork/clip, channels/post for delivery — so
// what it publishes IS the production post, not a mock-up. It is therefore a
// genuinely public action: the caller must confirm, and every run is logged.
//
// Sample token: the newest APPROVED listing (so the post carries a real logo,
// price and socials). With no listings at all it falls back to a built-in
// example, which keeps the feature usable on a fresh install.
const { CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { chainOf } = require("../config/chains");
const { fetchMarket } = require("../marketdata");
const fmt = require("../channels/format");
const post = require("../channels/post");
const tokenEmoji = require("../tokenEmoji");
const { postMedia } = require("../fulfillment");
const log = require("../helpers/logger");

const tmeLink = (channel, msgId) => `https://t.me/${String(channel).replace(/^@/, "")}/${msgId}`;

// Built-in example — only used when the store has no approved listing yet.
const FALLBACK_ROW = {
  name: "Bonk",
  sym: "BONK",
  chain: "solana",
  address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  tier: "DIAMOND",
  website: "https://bonkcoin.com",
  twitter: "https://x.com/bonk_inu",
  telegram: "https://t.me/bonkinu",
  logoUrl: "",
};

/** The token every forced post is built from: newest approved listing, else the
 *  built-in example. `preferFeatured` picks a currently-trending one when there
 *  is one, so a trending/rank-up test reads like the real thing. */
async function sampleRow({ preferFeatured = false } = {}) {
  let rows = [];
  try {
    rows = (await api.getListings()) || [];
  } catch (e) {
    log.warn(`[forcepost] getListings failed (${e.message}) — using the built-in example token`);
  }
  const approved = rows.filter((r) => r.status === "approved");
  const featured = approved.filter((r) => r.trendingRank != null);
  const pick = (preferFeatured && featured[0]) || approved[approved.length - 1] || null;
  return pick || FALLBACK_ROW;
}

/** Row → the coin shape every fmt.* formatter expects, with live market data
 *  when it's available (a forced post shows real numbers, not placeholders). */
async function coinOf(row) {
  const m = await fetchMarket(row.chain, row.address).catch(() => null);
  return {
    name: row.name,
    symbol: row.sym || row.symbol,
    chain: row.chain,
    address: row.address,
    tier: row.tier,
    price: m && m.priceUsd,
    mcap: m && m.mcap,
    liq: m && m.liq,
    change24h: m && m.change24h,
    links: { website: row.website, twitter: row.twitter, telegram: row.telegram },
    siteUrl: `${SITE_URL}/token/${row.chain}/${row.address}`,
  };
}

/** The banner-artwork coin shape (postMedia composites these onto the clip). */
function bannerCoinOf(coin) {
  return {
    symbol: coin.symbol,
    name: coin.name,
    chain: String(chainOf(coin.chain) ? chainOf(coin.chain).label : coin.chain).toUpperCase(),
    price: coin.price ? `$${Number(coin.price).toPrecision(4)}` : "TBA",
    mcap: coin.mcap ? `$${Math.round(coin.mcap).toLocaleString("en-US")}` : null,
    links: coin.links,
  };
}

// Every kind: which channels it really posts to, and how it builds its post.
// `channels` is only for the confirmation screen — send() is the truth.
const KINDS = {
  listing: {
    label: "🚨 Xpress listing",
    channels: () => [CHANNELS.listing],
    async send(row) {
      const coin = await coinOf({ ...row, tier: "XPRESS" });
      await ensureEmoji(coin, row);
      const media = await mediaFor("listing", coin, row);
      return [await deliver(CHANNELS.listing, media, fmt.listingPost(coin), { pin: true })];
    },
  },
  listing_trending: {
    label: "💎 Listing + Trending",
    channels: () => [CHANNELS.listing, CHANNELS.announce, CHANNELS.trending],
    async send(row) {
      const coin = await coinOf({ ...row, tier: row.tier && row.tier !== "XPRESS" ? row.tier : "DIAMOND" });
      await ensureEmoji(coin, row);
      const listMedia = await mediaFor("listing", coin, row);
      const trendMedia = await mediaFor("trending", coin, row);
      const out = [await deliver(CHANNELS.listing, listMedia, fmt.listingPost(coin), { pin: true })];
      out.push(await deliver(CHANNELS.announce, listMedia, fmt.listingPost(coin), { pin: true }));
      out.push(await deliver(CHANNELS.trending, trendMedia, fmt.trendingPost(coin)));
      return out;
    },
  },
  trending: {
    label: "🔥 Trending",
    channels: () => [CHANNELS.trending],
    async send(row) {
      const coin = await coinOf(row);
      await ensureEmoji(coin, row);
      const media = await mediaFor("trending", coin, row);
      return [await deliver(CHANNELS.trending, media, fmt.trendingPost(coin))];
    },
  },
  rankup: {
    label: "🚀 Rank-up alert",
    channels: () => [CHANNELS.trending],
    async send(row) {
      const coin = await coinOf(row);
      // Same shape a real alert uses: a top-3 position and a believable 24h gain
      // (the live one when the token really is up).
      const change = coin.change24h > 0 ? coin.change24h : 42;
      const media = await mediaFor("rankup", coin, row, { rank: 1, change });
      return [await deliver(CHANNELS.trending, media, fmt.rankupPost(coin, 1, change))];
    },
  },
  pump: {
    label: "📈 Pump alert",
    channels: () => [CHANNELS.listing],
    async send(row) {
      const coin = await coinOf(row);
      const mc = Number(coin.mcap) || 1_000_000;
      const media = await mediaFor("pump", coin, row);
      // A real pump alert REPLIES to the token's listing post; a forced one has
      // no thread to reply to, so it posts stand-alone. That's the one way this
      // differs from production — the caption itself is identical.
      return [await deliver(CHANNELS.listing, media, fmt.pumpPost(coin, 100, mc / 2, mc))];
    },
  },
  banner: {
    label: "📢 Banner ad",
    channels: () => [CHANNELS.announce],
    async send() {
      const booking = {
        title: "Nine Hood",
        slot: "Wide Banner",
        linkUrl: SITE_URL,
        description:
          "Nine Hood is a community-owned meme ecosystem on Solana — staking, a merch drop and a creator fund, all governed by holders.",
        address: "9hoodXk3vM2r8sQ2yTt1cUj7pLwq5FhN4dRzB6aKpump",
        twitter: "https://x.com/dexvraio",
        telegram: "https://t.me/dexvraio",
      };
      const media = await postMedia("banner", { symbol: "", name: booking.title, chain: "" }, null, null, null, null).catch(
        () => null,
      );
      return [await deliver(CHANNELS.announce, media, fmt.bannerPost(booking))];
    },
  },
};

/** Create the token's animated custom emoji before a card is rendered.
 *  fmt.*Post() reads the pack id synchronously, so without this a forced post
 *  shows the plain fallback char where the token's logo belongs — the paid
 *  listing path has always done it, this one hadn't. */
async function ensureEmoji(coin, row) {
  await tokenEmoji
    .ensureFromUrl({ chain: coin.chain, address: coin.address, symbol: coin.symbol }, row.logoUrl)
    .catch((e) => log.debug(`[forcepost] token emoji: ${e.message}`));
}

async function mediaFor(kind, coin, row, opts = {}) {
  return postMedia(kind, bannerCoinOf(coin), null, null, row.logoUrl || "", null, opts).catch((e) => {
    log.warn(`[forcepost] ${kind} media failed (${e.message}) — posting text-only`);
    return null;
  });
}

async function deliver(channel, media, payload, { pin = false } = {}) {
  const msg = await post.sendMedia(channel, media, payload, { pin });
  // The one choke-point every force-post kind goes through, so mirroring here
  // covers Xpress AND Listing+Trending without either remembering to. Only the
  // listing post is mirrored: the group wants new listings, not a second copy
  // of the same card from the announce and trending channels.
  if (channel === CHANNELS.listing) await post.mirrorToGroup(channel, msg, { label: "force-post listing" });
  return { channel, ok: !!msg, messageId: msg && msg.message_id, url: msg ? tmeLink(channel, msg.message_id) : null };
}

// ── Not a POST: refresh the pinned trending board in place ──────────────────
//
// It lives in this table because the table is already the adminbot→main-bot job
// channel (forcepost/store + forcePostRunner): only the main process owns the
// board message and the GramJS session. It is HIDDEN from the Force-post menu,
// whose every other entry publishes a new public post — this one edits the board
// that is already there, and a confirm screen warning "subscribers will see it"
// would be false.
//
// WHY IT EXISTS: the board refreshes on a 5-minute interval, so an operator who
// had just set a rank badge saw nothing change and had no way to tell a slow
// interval from a setting that never took. That was reported as
// "sudah di set sesuai yang saya mau tapi bot tidak memakai emoji premium".
KINDS.board_refresh = {
  label: "🔄 Trending board — refresh now",
  hidden: true,
  noRow: true,
  channels: () => [CHANNELS.trending],
  async send() {
    const poster = require("../services/trendingPoster");
    const tg = post.telegram();
    if (!tg) throw new Error("the main bot has no Telegram attached yet — is dexvra-bot running?");
    const r = (await poster.runOnce(tg)) || { how: "unknown" };
    // Carried through the job file to the admin chat verbatim: `how` says
    // whether the channel changed, `mode` whether it went out animated.
    return [{ channel: CHANNELS.trending, ok: r.how !== "failed" && r.how !== "empty", board: r }];
  },
};

/** The kinds the Force-post menu offers. `hidden` ones are still runnable by id
 *  — they are jobs this table carries, not posts an operator browses to. */
const kindIds = () => Object.keys(KINDS).filter((k) => !KINDS[k].hidden);
const labelOf = (kind) => (KINDS[kind] ? KINDS[kind].label : kind);
const channelsOf = (kind) => (KINDS[kind] ? KINDS[kind].channels() : []);

/** Publish `kind` for real. Returns [{channel, ok, messageId, url}]. Throws only
 *  on an unknown kind — a failed send comes back as ok:false so the admin sees
 *  exactly which channel refused it. */
async function forcePost(kind, { by = "admin" } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown post kind "${kind}"`);
  // A kind that publishes nothing about a TOKEN needs no sample token, and
  // fetching one would be a listings API call per refresh for a value nobody
  // reads.
  const row = k.noRow ? null : await sampleRow({ preferFeatured: kind === "trending" || kind === "rankup" });
  log.info(`[forcepost] ${kind} → ${channelsOf(kind).join(", ")}${row ? ` using ${row.sym || row.symbol || "?"}` : ""} (by ${by})`);
  const results = await k.send(row);
  for (const r of results) {
    if (r.ok) log.info(`[forcepost] ${kind} posted → ${r.url}`);
    else log.warn(`[forcepost] ${kind} FAILED to post in ${r.channel}`);
  }
  return results;
}

module.exports = { forcePost, kindIds, labelOf, channelsOf, KINDS, _sampleRow: sampleRow, _coinOf: coinOf };
