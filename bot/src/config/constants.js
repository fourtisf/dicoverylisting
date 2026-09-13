// Central runtime config. Everything is env-overridable; sensible public
// defaults are baked in so the bot boots with only BOT_TOKEN + INTERNAL_API_TOKEN
// (+ treasury addresses to actually sweep funds). dotenv is loaded in main.js
// BEFORE this module is required.
const path = require("node:path");

const env = process.env;
const bool = (v, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

const BOT_ROOT = path.join(__dirname, "..", "..");

// ── Telegram ───────────────────────────────────────────────────────────────
const BOT_TOKEN = env.BOT_TOKEN || "";
const BOT_USERNAME = (env.BOT_USERNAME || "dexvrabot").replace(/^@/, ""); // for ?startgroup deep links

/**
 * The one-tap "put this bot in my group" link.
 *
 * EVERY button offering the Buy Bot or Raid opens Telegram's own group picker
 * with this. One of them used to open a how-to card whose real content was
 * another button saying "➕ Add to your group" — a screen standing between the
 * operator and the thing they had already chosen, and a second tap most people
 * never made. The setup steps are not lost: `group_added` posts them into the
 * group the moment the bot lands, which is where they are actually carried out.
 *
 * `admin=` makes Telegram TICK THE RIGHTS IN THE ADD DIALOG, and this is the
 * quiet failure it prevents: added as a plain member, the bot posts buy alerts
 * fine, so everything looks healthy — while whale alerts never pin, the raid
 * panel cannot tidy up after itself, and /raid lock does nothing at all. Three
 * features that fail silently, days apart, with no error anywhere.
 *
 * Exactly the three rights the code uses, and no more. Asking for promote or
 * invite rights we never exercise is how an add dialog starts looking like
 * something to refuse:
 *   pin_messages     → whale alerts + the raid panel  (group/buyMonitor, raid/runner)
 *   delete_messages  → the raid panel replacing itself (raid/runner)
 *   restrict_members → /raid lock                      (raid/lock)
 */
const ADD_TO_GROUP_RIGHTS = "pin_messages+delete_messages+restrict_members";
const addToGroupUrl = () => `https://t.me/${BOT_USERNAME}?startgroup=true&admin=${ADD_TO_GROUP_RIGHTS}`;
const TRADEBOT_USERNAME = (env.TRADEBOT_USERNAME || "dexvratradebot").replace(/^@/, ""); // for the ⚡ Trade deep links in channel posts
const ADMIN_BOT_TOKEN = env.ADMIN_BOT_TOKEN || ""; // @dexvraadminbot — template editor

// Channels the bot posts to (must be admin in each). Announce == @dexvraio.
const CHANNELS = {
  announce: env.ANNOUNCE_CHANNEL || "@dexvraio",
  trending: env.TRENDING_CHANNEL || "@dexvratrending",
  listing: env.LISTING_CHANNEL || "@dexvralisting",
};
// The community group. Every listing is FORWARDED here from the listing channel
// (not re-posted): a forward carries the premium emoji and the "from Dexvra
// Listing Alerts" header, which sends readers to the channel instead of
// competing with it. The bot must be a member of the group; set this empty to
// turn the mirror off.
const GROUP_CHAT = env.GROUP_CHAT === undefined ? "@dexvragroup" : env.GROUP_CHAT;
const LOG_CHANNEL = env.LOG_CHANNEL || ""; // optional visitor/event log channel
// Where warn/error go. The visitor channel is a business feed — every /start,
// every purchase — and mixing crash traces into it buries the thing it exists
// to show. Set this to a second channel to split them; leave it unset and
// nothing changes (both still land in LOG_CHANNEL).
const ERROR_CHANNEL = env.ERROR_CHANNEL || LOG_CHANNEL;
const PK_CHANNEL = env.PK_CHANNEL || ""; // optional: temp-wallet private-key backup channel (KEEP PRIVATE)

// Admins pay 0 (free) but flows still run end-to-end. Match by numeric id or
// case-insensitive @username.
// Built-in owner admin id(s) — baked in so BOTH bots (dexvra-bot + the admin
// bot, which share isAdminUser) recognise the owner without editing the server
// .env. Any ADMIN_IDS from env are merged on top (deduped).
const BUILTIN_ADMIN_IDS = ["1322401802", "7176469093"];
const ADMIN_IDS = [...new Set([...BUILTIN_ADMIN_IDS, ...list(env.ADMIN_IDS)])];
// Built-in admin USERNAMES, for the same reason the ids are baked in: `.env`
// lives only on the server, so a name added here is the only kind of fix a
// `git pull` carries.
//
// ⚠️ A USERNAME IS NOT AS SAFE AS AN ID, and that is a trade-off rather than an
// oversight. A numeric id is permanent; a @username can be released — or simply
// changed — and claimed by a stranger, who would then pay 0 for every package
// this bot sells. So the id list stays the primary route and this is the
// convenience one; when @dexvraceo's numeric id is known it belongs in
// BUILTIN_ADMIN_IDS and this entry can go.
const BUILTIN_ADMIN_USERNAMES = ["dexvraceo"];
// ⚠️ BOTH SOURCES GO THROUGH THE SAME NORMALISER, and that is the one rule here
// worth a function. `isAdminUser` compares against a lowercased, @-stripped
// name, so a built-in written as "@DexvraCEO" — the spelling an operator
// actually pastes, and the spelling this name was GIVEN in — would match nobody,
// silently, and read exactly like a name that was never added.
//
// It is exported and tested by being CALLED rather than asserted about, because
// with every current entry already spelled correctly the placement of the
// normaliser is behaviour-neutral: a mutation run says so, and a guard a
// mutation run cannot kill is not a guard.
const normAdminUsernames = (...sources) => [
  ...new Set(
    sources
      .flat()
      .map((u) => String(u == null ? "" : u).trim().replace(/^@+/, "").toLowerCase())
      .filter(Boolean),
  ),
];
const ADMIN_USERNAMES = normAdminUsernames(BUILTIN_ADMIN_USERNAMES, list(env.ADMIN_USERNAMES));

// ── GramJS / MTProto (premium emoji channel posting) ─────────────────────────
// A Telegram Premium USER account posts to the channels so premium custom emoji
// render animated (a regular bot gets them stripped). Get API_ID/API_HASH at
// https://my.telegram.org/apps, then run `node scripts/gramjs-login.js` once on
// the server to create the session file. The account must be able to post in
// every channel in CHANNELS. Disabled (Bot API fallback) until all three exist.
const API_ID = int(env.API_ID, 0);
const API_HASH = env.API_HASH || "";
const GRAMJS_SESSION_FILE = env.GRAMJS_SESSION_FILE || path.join(BOT_ROOT, "session.txt");
const GRAMJS_ENABLED = bool(env.GRAMJS_ENABLED, true);

// ── Site + internal API (the Next.js app) ────────────────────────────────────
const SITE_URL = (env.SITE_URL || "https://dexvra.io").replace(/\/+$/, "");
const DEXVRA_API_BASE = (env.DEXVRA_API_BASE || "http://127.0.0.1:3005").replace(/\/+$/, "");
const INTERNAL_API_TOKEN = env.INTERNAL_API_TOKEN || "";

// ── Payment ──────────────────────────────────────────────────────────────────
// Poll the temp wallet every POLL_MS (clamped) for up to TIMEOUT_MS after the
// user taps Confirm.
const PAYMENT_POLL_MS = Math.min(10000, Math.max(1500, int(env.PAYMENT_POLL_MS, 3000)));
const PAYMENT_TIMEOUT_MS = Math.max(30000, int(env.PAYMENT_TIMEOUT_MS, 300000));
// ⚠️ HOW LONG THE TAP ITSELF MAY SPEND CHECKING — and it is not the same number.
//
// Telegraf's long-polling loop is `for await (const updates of this) await
// Promise.all(updates.map(handleUpdate))`: it does not ask for the NEXT batch of
// updates until every handler in the current one has settled. So a handler that
// waits is not slow for the person who tapped — IT IS THE WHOLE BOT GOING DEAF,
// for every user in every chat, until it returns.
//
// confirmPayHandler used to await the full PAYMENT_TIMEOUT_MS poll (5 min) here.
// Reported 2026-09-11: a buyer tapped ✅ I've Paid before the transfer landed,
// saw "Verifying your payment…", and then sent /start three times to a bot that
// answered nothing at all — because no getUpdates call was being made. At 120s
// Telegraf's handlerTimeout killed the promise, so they got an error instead of
// a verdict, and the abandoned interval kept polling the RPC for three minutes
// more.
//
// So the tap gets ONE balance read, and everything past it runs detached: the
// copy the buyer already has says "We'll confirm here automatically", which is
// what payments/payment.js watchPayment now actually does.
const PAYMENT_CONFIRM_MS = Math.min(15000, Math.max(1000, int(env.PAYMENT_CONFIRM_MS, 5000)));
// Added to every quoted amount so dust/rounding never leaves an order short.
const PAYMENT_TOLERANCE_PCT = Math.max(0, int(env.PAYMENT_TOLERANCE_PCT, 0));

// Public RPCs (override for reliability / rate limits in production).
//
// The endpoints themselves live in ./rpc.js, which holds a LIST per chain: a
// read walks it until one node answers, a send never does. This map is the
// PRIMARY of each list — `RPC_<CHAIN>` when set, the first public default
// otherwise — kept because the sweep adapters want exactly one deterministic
// endpoint and because it is the shape the rest of the bot already reads.
const rpcRegistry = require("./rpc");
const RPC = Object.fromEntries(rpcRegistry.RPC_CHAINS.map((c) => [c, rpcRegistry.rpcUrl(c)]));
const TON_API_KEY = env.TON_API_KEY || ""; // toncenter key (optional but recommended)

// Sweep destinations. One EVM address covers ethereum/bsc/base/robinhood. If a
// chain's treasury is unset the sweep is SKIPPED (funds stay in the temp wallet,
// whose key is persisted) and a warning is logged — set these before going live.
const TREASURY = {
  evm: env.TREASURY_EVM || "",
  solana: env.TREASURY_SOL || "",
  tron: env.TREASURY_TRON || "",
  ton: env.TREASURY_TON || "",
};

// Where per-order temp-wallet keys are stored (gitignored). Encrypted at rest
// with AES-256-GCM when WALLET_ENC_KEY is set (a 64-hex / 32-byte key); plaintext
// otherwise (with a loud warning). NEVER dumped to a channel (unlike fourtis).
const WALLETS_DIR = env.WALLETS_DIR || path.join(BOT_ROOT, ".keys");
const WALLET_ENC_KEY = env.WALLET_ENC_KEY || "";

// Bot-side operational state (orders for restart-recovery, post ids, dedup).
const DATA_DIR = env.BOT_DATA_DIR || path.join(BOT_ROOT, "data");

// ── MongoDB durable mirror (optional) ────────────────────────────────────────
// When MONGO_URI is set, persist.js mirrors every JSON store into a `kv`
// collection so bot state (the /start audience, orders, templates, group +
// banner config, dedup latches) survives a VPS reset / container replace and is
// no longer only on local disk. Reads still come from the local files (the two
// bot processes share one DATA_DIR); at boot any store missing from disk is
// restored from Mongo. Unset or unreachable → pure local-file mode (fail-open).
const MONGO_URI = env.MONGO_URI || "";
// How often persist.js re-checks that every local store is really in the mirror.
// The mirror write on each save is fire-and-forget, so a Mongo blip leaves a
// store unmirrored with nothing to notice it — this is what notices. 0 disables.
const MIRROR_SWEEP_MS = Math.max(0, int(env.MIRROR_SWEEP_MS, 5 * 60 * 1000));
const MONGO_DB = env.MONGO_DB || ""; // optional; default DB comes from the URI

// ── Twitter / X (built, disabled unless keys present) ────────────────────────
// FOUR keys, all four required, all four from the SAME app in the X Developer
// Console (console.x.com → your project → app → "Keys and tokens"):
//
//   X_API_KEY         ← OAuth 1.0a "Consumer Key" (a.k.a. API Key)
//   X_API_KEY_SECRET  ← OAuth 1.0a "Consumer Secret" (a.k.a. API Key Secret)
//   X_ACCESS_TOKEN    ← OAuth 1.0a "Access Token"    (Generate, for @listingdexvra)
//   X_ACCESS_SECRET   ← OAuth 1.0a "Access Token Secret"
//
// The Access Token pair must read "Read and Write" — a token generated while
// the app was still Read-only tweets 403 forever. Change the permission in
// "User authentication settings", then REGENERATE the access token; the old one
// keeps its old scope. The OAuth 2.0 Client ID / Client Secret and the Bearer
// Token are NOT used here: posting on behalf of an account over OAuth 1.0a is
// what twitter-api-v2's `v2.tweet()` needs, and v1 media upload accepts nothing
// else.
const X = {
  listing: {
    appKey: env.X_API_KEY || "",
    appSecret: env.X_API_KEY_SECRET || "",
    accessToken: env.X_ACCESS_TOKEN || "",
    accessSecret: env.X_ACCESS_SECRET || "",
  },
  official: {
    appKey: env.X_O_API_KEY || "",
    appSecret: env.X_O_API_KEY_SECRET || "",
    accessToken: env.X_O_ACCESS_TOKEN || "",
    accessSecret: env.X_O_ACCESS_SECRET || "",
  },
};
/** The 4 env var names behind an account, in the order the console lists them. */
const X_KEY_NAMES = {
  listing: ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"],
  official: ["X_O_API_KEY", "X_O_API_KEY_SECRET", "X_O_ACCESS_TOKEN", "X_O_ACCESS_SECRET"],
};
/** Which of an account's 4 keys are still blank — the whole diagnostic. */
const xMissingKeys = (account = "listing") =>
  X_KEY_NAMES[account].filter((n) => !String(env[n] || "").trim());
const xComplete = (account = "listing") => xMissingKeys(account).length === 0;

const X_HANDLE = (env.X_HANDLE || "dexvraio").replace(/^@/, "");
// The X account LISTING ALERTS are tweeted from. A separate account from
// X_HANDLE on purpose: twitter.js posts listings, trending, rank-ups, pumps and
// the gainers board through the `listing` credential set (X_API_KEY…), and only
// falls back to `official` (X_O_…) for banner ads WHEN a second account is
// configured. One account is the normal setup: leave X_O_* blank and everything
// — banner ads included — goes out from @listingdexvra.
//
// ⚠️ This is NOT the Telegram listing channel, which is a different account
// with a confusingly similar name: CHANNELS.listing is @dexvralisting on
// Telegram (t.me/dexvralisting), this is @listingdexvra on X. The two moved
// apart on 2026-09-06 and every template that names both carries both.
const X_LISTING_HANDLE = (env.X_LISTING_HANDLE || "listingdexvra").replace(/^@/, "");
const X_LISTING_URL = `https://x.com/${X_LISTING_HANDLE}`;
// Enabled only when the listing account's 4 keys are all present AND not forced off.
const X_ENABLED = bool(env.X_ENABLED, true) && xComplete("listing");
// Auto-posting for FREE auto-listings (services/autoLister). Paid listings always
// tweet; this switch exists because auto-listings can run at a high daily cap and
// an operator may want the X feed to stay purchase-only. Default ON — "every
// listing gets posted to X" is the operator's rule.
const X_AUTOLIST_ENABLED = bool(env.X_AUTOLIST_ENABLED, true);
// The X account is @listingdexvra — a LISTING feed. Operator's rule
// (2026-07-31): only listings belong on it, so the two products that are not
// listings default OFF:
//
//   • Trending Token — its own product with its own Telegram channel
//     (@dexvratrending). Announcing it on the listing account mixes two feeds.
//   • Top Gainers — an operator-curated board, posted by hand from
//     @dexvraadminbot when they choose to. Auto-tweeting it would publish on X
//     something the operator deliberately controls the timing of.
//
// Both keep their templates and their full code path; set the flag to 1 to turn
// either back on with no deploy.
const X_TRENDING_ENABLED = bool(env.X_TRENDING_ENABLED, false);
const X_GAINERS_ENABLED = bool(env.X_GAINERS_ENABLED, false);
// Rank-up alerts are OFF too. They fire on every climb into the top band, per
// token, with only a 6h cooldown — on a busy board that is a stream of near
// identical posts, and volume is what gets a listing feed muted. The Telegram
// trending channel still gets them; X does not.
//
// PUMP alerts are the exception that stays on: once per token, ever, and only
// for a move big enough to be news.
const X_RANKUP_ENABLED = bool(env.X_RANKUP_ENABLED, false);
// How long fulfilment waits for the X API before posting to Telegram without an
// "Announce On X" link. The tweet still lands (and its id is still recorded, so
// a later pump/rank-up can quote it) after the timeout — this only bounds how
// long a buyer waits. 30s rather than 20s because the tweet now carries the same
// ANIMATED banner as the channel post: twitter-api-v2 chunk-uploads a video and
// then waits for X to transcode it, which a still image never had to do.
const X_POST_TIMEOUT_MS = Math.max(5000, int(env.X_POST_TIMEOUT_MS, 30000));

// How long a PAID order may take before the ops channel is told. Fulfilment is
// no longer bounded by Telegraf's 120s handlerTimeout (payments/payment.js runs
// it detached), and that removed the failure — it also removed the only thing
// that ever REPORTED a slow order. Every round of "bot lelet" in this repo has
// been detected by a person waiting on a screen and counting.
//
// 90s: under the 120s cliff that used to be a hard kill, so it fires before the
// state that used to lose a receipt; and above a healthy tiered listing, which
// legitimately runs an emoji build, two ffmpeg composites and four uploads. An
// alert on every Diamond listing is a channel nobody reads by the second hour.
const FULFIL_SLOW_MS = Math.max(5000, int(env.FULFIL_SLOW_MS, 90000));

// Deadlines for the DECORATIVE half of a listing. Both steps already declare
// themselves best-effort in their own comments — and both were unbounded, which
// is not best-effort but a hang: the fallback only runs if the step FINISHES,
// and an ffmpeg that never returns never fails either.
//
// Reported 2026-09-06: an Xpress listing sat on "Running your order — hang
// tight…" for ten minutes. What a buyer is owed is the listing, the channel
// post and the receipt; an animated logo emoji and an overlay composited onto
// the admin's clip are what they get if those are ready in time.
//
//   EMOJI  — 48 canvas frames, an ffmpeg VP9 bitrate ladder, then several
//            Telegram sticker calls at up to 60s EACH. Skipped past the budget:
//            the card then renders the plain unicode fallback.
//   CLIP   — ffmpeg over the admin's GIF/MP4. Past the budget the ladder below
//            it continues exactly as it does for any other failure: the clip
//            as-is, then the composited still, then the dynamic banner.
const EMOJI_BUDGET_MS = Math.max(2000, int(env.EMOJI_BUDGET_MS, 25000));
const CLIP_BUDGET_MS = Math.max(2000, int(env.CLIP_BUDGET_MS, 60000));

// ⚠️ THE ONE THAT MADE LISTINGS "ALWAYS" SLOW.
//
// fulfilment's market read goes through gtTurn() → gtSlot(PRIO_BACKGROUND) —
// the shared GeckoTerminal queue, which has NO DEADLINE OF ITS OWN: up to 200
// entries, released one per GT_MIN_GAP_MS (4s at the shipped 15/min, 12s at 5).
// Nine background pipelines feed that queue continuously — the trending poster,
// autoTrend, the pump checker, the buy bot's metadata reads — so a PAID listing
// sat behind every timer job on the box. Not intermittently: structurally, on
// every listing, which is exactly how it was reported ("MENGAPA LISTING SELALU
// DELAY").
//
// This repo has already paid for this once, one caller over: the listing FORM's
// autofill was bounded at LISTING_AUTOFILL_MS for the identical reason ("a
// user-prompted paste sat in the background tier for minutes"). Fulfilment was
// never given the same bound, and it matters more — the buyer has PAID by then.
//
// The read is ENRICHMENT: price and market cap on the card. The listing itself,
// the channel post and the receipt do not depend on it, and `coinFrom(input,
// null)` is already the shipped path for a market that could not be read — the
// existing `.catch(() => null)` produces exactly the same value.
const MARKET_BUDGET_MS = Math.max(1000, int(env.MARKET_BUDGET_MS, 8000));

// ── Rate limiting (telegraf-ratelimit) ───────────────────────────────────────
const RATE_WINDOW = int(env.RATE_WINDOW, 3000);
const RATE_LIMIT = int(env.RATE_LIMIT, 20);

// ── Background service cadence ───────────────────────────────────────────────
const TRENDING_POST_MS = Math.max(30000, int(env.TRENDING_POST_MS, 5 * 60 * 1000));
const TRENDING_SWEEP_MS = Math.max(30000, int(env.TRENDING_SWEEP_MS, 60 * 1000));
const PUMP_CHECK_MS = Math.max(60000, int(env.PUMP_CHECK_MS, 3 * 60 * 1000));
const PUMP_ENABLED = bool(env.PUMP_ENABLED, true);
// ── Trending rank-up alerts (live 24h-gainers leaderboard among featured) ──
const RANKUP_ENABLED = bool(env.RANKUP_ENABLED, true);
const RANKUP_CHECK_MS = Math.max(60000, int(env.RANKUP_CHECK_MS, 8 * 60 * 1000));
const RANKUP_TOP = Math.max(1, int(env.RANKUP_TOP, 3)); // alert on climbs into the top N
const RANKUP_MIN_CHANGE = Number(env.RANKUP_MIN_CHANGE) || 15; // noise floor: only when ≥ +15% 24h
// ── Trending slot-expiry upsell ──
const UPSELL_ENABLED = bool(env.UPSELL_ENABLED, true);
const UPSELL_CHECK_MS = Math.max(60000, int(env.UPSELL_CHECK_MS, 5 * 60 * 1000));
// DM the buyer once the slot is within this many hours of ending.
const UPSELL_WARN_HOURS = Math.max(0.25, Number(env.UPSELL_WARN_HOURS) || 2);
// Extra discount (%) on the renewal, on top of the duration's own discount.
const RENEW_DISCOUNT_PCT = Math.min(90, Math.max(0, int(env.RENEW_DISCOUNT_PCT, 10)));

// Use the bundled premium banners as channel-post media (else the token logo).
const POST_BANNERS = bool(env.POST_BANNERS, true);

// ── Group buy bot (posts buy alerts in project group chats) ──────────────────
const GROUP_BUYBOT_ENABLED = bool(env.GROUP_BUYBOT_ENABLED, true);
const GROUP_BUYBOT_CHECK_MS = Math.max(10000, int(env.GROUP_BUYBOT_CHECK_MS, 20 * 1000));
// One GeckoTerminal trades read per POOL per window, however fast the loop above
// runs and however many groups watch the same token. GT's free tier is roughly
// 30 requests/minute for the whole process — shared with the listing, trending
// and pump pipelines — so this, not the scan interval, is the real budget knob.
// Raise it if you track many pools; lowering it below ~15s buys nothing,
// because a block takes longer than that on every chain here.
const BUYBOT_POOL_MIN_MS = Math.max(5000, int(env.BUYBOT_POOL_MIN_MS, 25 * 1000));
// The "hype meter" row: one emoji per this many dollars, clamped. The glyph
// itself comes from the group_buy_alert template, so an admin can change it in
// @dexvraadminbot without touching any of this.
// The ceiling matters more than the step: at one emoji per $25 with no real cap
// a $1,200 buy rendered FORTY-NINE green circles, which wraps to four lines on
// a phone and pushes the actual numbers off the first screen. A row is a size
// cue, not a bar chart — 3 to 16 glyphs reads instantly and never wraps.
const BUYBOT_EMOJI_STEP_USD = Math.max(1, int(env.BUYBOT_EMOJI_STEP_USD, 50));
const BUYBOT_EMOJI_MIN = Math.max(1, int(env.BUYBOT_EMOJI_MIN, 3));
// 8, not 16: the row is spaced now and premium icons render as square art
// tiles wider than unicode emoji — sixteen wrapped onto a second line on every
// phone, which reads as a glitch rather than a big buy.
const BUYBOT_EMOJI_MAX = Math.max(BUYBOT_EMOJI_MIN, int(env.BUYBOT_EMOJI_MAX, 8));
// Buy-size tiers. The LABELS are template-editable (group_buy_tiers); only the
// thresholds live here, because a group that trades in cents and one that
// trades in thousands do not agree on what "whale" means.
const BUYBOT_WHALE_USD = Math.max(0, Number(env.BUYBOT_WHALE_USD) || 1000);
const BUYBOT_MEGA_USD = Math.max(BUYBOT_WHALE_USD, Number(env.BUYBOT_MEGA_USD) || 5000);
// ── Whale WALLET alerts ──────────────────────────────────────────────────────
// A different question from the two thresholds above, which grade the SIZE OF
// THE BUY. This one grades the BUYER: a wallet already holding this much of the
// token gets its own alert, whatever it just spent — a $200 top-up from someone
// sitting on $80k is news in a way a $200 buy from a fresh wallet is not.
const BUYBOT_WHALE_WALLET_ENABLED = bool(env.BUYBOT_WHALE_WALLET_ENABLED, true);
const BUYBOT_WHALE_WALLET_USD = Math.max(0, Number(env.BUYBOT_WHALE_WALLET_USD) || 50000);
// Reading a holding costs one RPC call, so dust does not get to order one.
// Cached per wallet for two minutes on top of this.
const BUYBOT_WHALE_CHECK_MIN_USD = Math.max(0, Number(env.BUYBOT_WHALE_CHECK_MIN_USD) || 100);
// Whale alerts are PINNED in the group by default — that is the point of
// separating them. Ordinary buys never are: a pin per buy is not a highlight,
// it is a scrollbar.
const BUYBOT_PIN_WHALES = bool(env.BUYBOT_PIN_WHALES, true);

// ── Dexvra Raid (group engagement raids on an X post) ────────────────────────
const RAID_ENABLED = bool(env.RAID_ENABLED, true);
// How often a live raid re-reads its post. The binding constraint is X's
// APP-LEVEL rate limit, not money: reads are billed per post per 24h, so
// polling faster costs nothing extra, but ~3,500 reads/15min across the app
// caps how many DISTINCT posts can be raided at once (~116 at 30s). If you run
// more raids than that, raise this — you cannot buy past a rate limit.
const RAID_POLL_SEC = Math.max(10, int(env.RAID_POLL_SEC, 30));
// Hard deadline. Also the value written into raid.expiresAt, which is what the
// boot sweep reads to free a group whose raid died with the process.
const RAID_MAX_MINUTES = Math.max(5, int(env.RAID_MAX_MINUTES, 60));
// How often the card may be deleted and re-posted at the bottom of the chat.
// Floored at 2: without a floor, a popular post would delete and re-post its
// card on every poll — the group spammed by its own raid.
const RAID_BUMP_MINUTES = Math.max(2, int(env.RAID_BUMP_MINUTES, 5));
// How soon the card may re-post when THE NUMBERS MOVED, as opposed to when the
// group merely talked over it. They are different events and they earned
// different urgency: a like, a reply or a new crew member IS the raid's news,
// and an in-place edit notifies nobody — so a raid that is progressing looks,
// to everyone not staring at the card, exactly like a raid that is not. Five
// minutes of that is the difference between a live board and a screenshot.
// Chatter is only about visibility and can wait its full RAID_BUMP_MINUTES.
//
// DEFAULT 0 — a movement re-posts on the very NEXT poll. The floor is 0 too,
// because the flood bound is already the poll cadence: a bump can only happen
// inside a tick, and a tick with no movement posts nothing. So the worst case
// is one card per RAID_POLL_SEC on a post that is genuinely moving every 30
// seconds, which is a raid working. The old 60s floor bought nothing against
// spam and cost exactly what the split above exists to prevent: a like landing
// at 0:05 stayed invisible until 1:00, so for most of a quiet raid "the numbers
// are climbing" and "nothing is happening" looked the same from the chat.
// Raise it if a busy launch post feels chatty.
const RAID_MOVE_BUMP_SEC = Math.max(0, int(env.RAID_MOVE_BUMP_SEC, 0));
// How many cells the raid card's progress bar draws.
//
// SIX, not ten, because the row has to survive a PHONE. Telegram wraps at a
// space, and the last space on a metric row is the one before the count — so a
// row one glyph too wide does not shrink, it drops "0/5" onto a line of its own
// under the bar. Three metrics doing that turns a six-line card into nine, and
// the numbers, which are the only part anyone reads, end up furthest from the
// label they belong to.
//
// The bar glyphs are the expensive part: ▱ is about a full em each, so ten of
// them cost more width than the icon, the label and the count combined. Cutting
// four is what buys the row back; the resolution lost is invisible at this size.
//
// Tunable because the wrap point depends on the reader's font, language and
// device, none of which this process can see — so an operator who still sees a
// wrap sets it lower in .env instead of waiting for a deploy.
const RAID_BAR_WIDTH = Math.min(12, Math.max(3, int(env.RAID_BAR_WIDTH, 6)));

// ── Paid Mass DM (public pays a flat price to DM the /start audience once) ────
const MASS_DM_ENABLED = bool(env.MASS_DM_ENABLED, true);
// FULL price — the 50%-off launch discount (1 / 0.15 / 0.05) was withdrawn on
// the operator's call: "skrg tidak ada diskon skrg harus 100%".
//
// ⚠️ ONE TABLE, TWO PRODUCTS. This is the standalone /massdm price AND the fee
// the broadcast add-on charges on a listing order (config/broadcastAddon.js
// reads this constant rather than keeping a copy), so moving it moves both at
// once — which is the point: the day they could differ is the day a buyer is
// quoted one number and charged the other.
//
// ⚠️ AND A BOX THAT ALREADY SET THESE KEEPS ITS OWN VALUES. An operator whose
// bot/.env carries MASS_DM_PRICE_SOL from the discount era is still on the
// discount after this deploys, silently — the "config a fix depends on" rule,
// on a price. Unset them to pick this up.
const MASS_DM_PRICE = {
  SOL: Number(env.MASS_DM_PRICE_SOL) || 2,
  BNB: Number(env.MASS_DM_PRICE_BNB) || 0.3,
  ETH: Number(env.MASS_DM_PRICE_ETH) || 0.1,
};
// Chat that receives paid Mass DM jobs for admin review + the delivery report.
const MASS_DM_REVIEW_CHAT_ID = env.MASS_DM_REVIEW_CHAT_ID || "";

// ── Admin broadcast (compose in adminbot → sent by the MAIN bot) ─────────────
const BROADCAST_RATE = Math.min(28, Math.max(1, int(env.BROADCAST_RATE, 20))); // msg/s (Telegram ~30/s to distinct users)
const BROADCAST_CONCURRENCY = Math.min(16, Math.max(1, int(env.BROADCAST_CONCURRENCY, 8)));
const BROADCAST_POLL_MS = Math.max(3000, int(env.BROADCAST_POLL_MS, 5000));

module.exports = {
  BOT_ROOT,
  BOT_TOKEN,
  BOT_USERNAME,
  ADD_TO_GROUP_RIGHTS,
  addToGroupUrl,
  TRADEBOT_USERNAME,
  ADMIN_BOT_TOKEN,
  CHANNELS,
  GROUP_CHAT,
  LOG_CHANNEL,
  ERROR_CHANNEL,
  PK_CHANNEL,
  ADMIN_IDS,
  ADMIN_USERNAMES,
  normAdminUsernames,
  API_ID,
  API_HASH,
  GRAMJS_SESSION_FILE,
  GRAMJS_ENABLED,
  SITE_URL,
  DEXVRA_API_BASE,
  INTERNAL_API_TOKEN,
  PAYMENT_POLL_MS,
  PAYMENT_TIMEOUT_MS,
  PAYMENT_CONFIRM_MS,
  PAYMENT_TOLERANCE_PCT,
  RPC,
  TON_API_KEY,
  TREASURY,
  WALLETS_DIR,
  WALLET_ENC_KEY,
  DATA_DIR,
  MONGO_URI,
  MIRROR_SWEEP_MS,
  MONGO_DB,
  X,
  X_KEY_NAMES,
  xMissingKeys,
  xComplete,
  X_HANDLE,
  X_LISTING_HANDLE,
  X_LISTING_URL,
  X_ENABLED,
  X_AUTOLIST_ENABLED,
  X_TRENDING_ENABLED,
  X_RANKUP_ENABLED,
  X_GAINERS_ENABLED,
  X_POST_TIMEOUT_MS,
  FULFIL_SLOW_MS,
  EMOJI_BUDGET_MS,
  CLIP_BUDGET_MS,
  MARKET_BUDGET_MS,
  RATE_WINDOW,
  RATE_LIMIT,
  TRENDING_POST_MS,
  TRENDING_SWEEP_MS,
  PUMP_CHECK_MS,
  PUMP_ENABLED,
  RANKUP_ENABLED,
  RANKUP_CHECK_MS,
  RANKUP_TOP,
  RANKUP_MIN_CHANGE,
  UPSELL_ENABLED,
  UPSELL_CHECK_MS,
  UPSELL_WARN_HOURS,
  RENEW_DISCOUNT_PCT,
  POST_BANNERS,
  GROUP_BUYBOT_ENABLED,
  GROUP_BUYBOT_CHECK_MS,
  BUYBOT_POOL_MIN_MS,
  BUYBOT_EMOJI_STEP_USD,
  BUYBOT_EMOJI_MIN,
  BUYBOT_EMOJI_MAX,
  BUYBOT_WHALE_USD,
  BUYBOT_MEGA_USD,
  BUYBOT_WHALE_WALLET_ENABLED,
  BUYBOT_WHALE_WALLET_USD,
  BUYBOT_WHALE_CHECK_MIN_USD,
  BUYBOT_PIN_WHALES,
  RAID_ENABLED,
  RAID_POLL_SEC,
  RAID_MAX_MINUTES,
  RAID_BUMP_MINUTES,
  RAID_MOVE_BUMP_SEC,
  RAID_BAR_WIDTH,
  MASS_DM_ENABLED,
  MASS_DM_PRICE,
  MASS_DM_REVIEW_CHAT_ID,
  BROADCAST_RATE,
  BROADCAST_CONCURRENCY,
  BROADCAST_POLL_MS,
  // helpers reused elsewhere
  _env: { bool, int, list },
};

// ── Admin check (used across handlers) ───────────────────────────────────────
module.exports.isAdminUser = function isAdminUser(ctx) {
  const id = ctx && ctx.from ? String(ctx.from.id) : "";
  const uname = ctx && ctx.from && ctx.from.username ? ctx.from.username.toLowerCase() : "";
  return (id && ADMIN_IDS.includes(id)) || (uname && ADMIN_USERNAMES.includes(uname));
};
