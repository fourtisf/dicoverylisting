// @dexvraadminbot — admin-only template editor. Lets admins edit every bot
// message + channel-post layout (via src/templates.js) and upload the /start
// banner image, all at runtime (main bot auto-refreshes within ~30s, no redeploy).
// Runs as its own process/token, separate from the main bot.
const { Telegraf, Markup, session } = require("telegraf");
const { promises: fs } = require("node:fs");
const fss = require("node:fs");
const path = require("node:path");
const { isAdminUser, ADMIN_BOT_TOKEN, CHANNELS, X_LISTING_URL, X_LISTING_HANDLE } = require("../config/constants");
const { getMediaFileId, payloadArgs } = require("../helpers/message");
const { escapeHtml, fmtPrice, fmtCap, parseCap } = require("../helpers/format");
const { DATA_DIR } = require("../helpers/persist");
const bcStore = require("../broadcast/store");
const bannerTpl = require("../bannerTemplate");
const pumpConfig = require("../services/pumpConfig");
const whaleConfig = require("../services/whaleConfig");
const trendingBoard = require("../services/trendingBoard");
const autoTrend = require("../services/autoTrend");
const autoLister = require("../services/autoLister");
const forcePost = require("./forcePost");
const fpStore = require("../forcepost/store");
const gainersMenu = require("./gainersMenu");
const gramjs = require("../gramjs");
const { toSendBuffer } = require("../helpers/encodeImage");
const tpl = require("../templates");
const log = require("../helpers/logger");

// Template groups are DYNAMIC — every group that appears in templates.js META
// gets its own menu button, so new families (Mass DM, Group Buy Bot, …) show up
// automatically without touching this file. A stable slug id keys the callback.
const GROUP_ICON = {
  "Bot Messages": "📝",
  "Channel Posts": "📢",
  "Mass DM": "📣",
  "Group Buy Bot": "🤖",
  "Group Setup": "⚙️",
  "Dexvra Raid": "🚀",
  // Was falling through to the generic 📄 — every other category had a chosen
  // glyph, so the X row read as the odd one out in the editor's menu.
  "X Posts": "𝕏",
};
const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "") || "grp";
const groupNames = () => Object.keys(tpl.groups());
const nameFromSlug = (slug) => groupNames().find((n) => slugOf(n) === slug) || null;
const groupIdOf = (key) => slugOf(tpl.meta(key).group);
const HTML = { parse_mode: "HTML", disable_web_page_preview: true };

// A group's template list is paginated. A large family (Bot Messages ships 37
// templates) as one flat keyboard is 38 single-button rows — Telegram rejects a
// keyboard that tall on editMessageText, so tapping the group silently did
// nothing (the edit AND its reply fallback both carried the same oversize
// keyboard). Pages of GROUP_PAGE keep every keyboard small and navigable.
const GROUP_PAGE = 10;
const pageCount = (n) => Math.max(1, Math.ceil(n / GROUP_PAGE));
const clampPage = (p, pages) => Math.max(0, Math.min(Number(p) || 0, pages - 1));

function guard(ctx) {
  const ok = !(ctx.chat && ctx.chat.type !== "private") && isAdminUser(ctx);
  // ⚠️ A REFUSED TAP IS ANSWERED, and that is the whole change. Every handler
  // guarded here returns on false without touching the callback query, so a
  // non-admin — or anyone who reached this keyboard outside a private chat —
  // taps and the button spins for ever, with no message anywhere and no log
  // line. That is indistinguishable from a handler that does not exist, i.e.
  // literally "tidak bekerja", and it is true of every button on every admin
  // panel. Answering here rather than in each handler is the one-owner fix; a
  // guard the 40th handler has to remember is one the 40th handler forgets.
  if (!ok && ctx.callbackQuery) ctx.answerCbQuery("⛔ Admins only, in a private chat.", { show_alert: true }).catch(() => {});
  return ok;
}

// ── Keyboards ────────────────────────────────────────────────────────────────
function mainKb() {
  const groupRows = groupNames().map((name) => [
    Markup.button.callback(`${GROUP_ICON[name] || "📄"} ${name}`, `grp:${slugOf(name)}`),
  ]);
  return Markup.inlineKeyboard([
    ...groupRows,
    // Above the per-group list on purpose: restyling the bot's icons is the
    // thing an operator comes here to do most, and doing it one template at a
    // time was thirty-nine taps for a single glyph.
    [Markup.button.callback("🎨 Emoji buy alert + raid (ganti sekaligus)", "aem:0")],
    [Markup.button.callback("🔍 Preview all templates", "audit")],
    [Markup.button.callback("♻️ Reset ALL templates to default", "resetall")],
    [Markup.button.callback("🖼 Banner Image", "banner")],
    [Markup.button.callback("🎨 Gambar Banner Channel", "bt")],
    [Markup.button.callback("🚀 Force post to channel (test live)", "fp")],
    [Markup.button.callback("📊 Banner Top Gainers (live 24h movers)", "gn")],
    [Markup.button.callback("🔥 Trending board (chain logos · ranks 1–10)", "tb")],
    [Markup.button.callback("🤖 Auto Trending (auto-fill slots)", "at")],
    [Markup.button.callback("🆓 Auto Listing (free, $1M+ projects)", "al")],
    [Markup.button.callback("📣 Broadcast", "bc")],
  ]);
}

// Audit EVERY template at once: clean rendered text, grouped, ✏️=custom / •
// =default. `arg` = a group slug for fuller previews of just that group, or ""
// for a short snippet of all. Messages chunked under Telegram's 4096 limit.
// Shared by the /preview command and the "🔍 Preview all templates" button.
// Realistic sample values so the audit renders every template the way a real
// user/channel sees it — not the {placeholder} skeleton.
const SAMPLE_VARS = {
  native: "SOL", chain: "Solana", symbol: "$BULLCAT", name: "The Bull Cat",
  address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
  price: "$0.001266", mcap: "$1.3M", liq: "$183.5K",
  siteUrl: "https://dexvra.io/token/solana/G9j8", coinUrl: "https://dexvra.io/token/solana/G9j8",
  logo: "✅ set", overview: "A community-driven memecoin on Solana.",
  // The pre-migration notice on the review card. Sampled in its NON-empty form
  // on purpose: an admin previewing the template needs to see the line they may
  // be about to edit away, and it renders as "" for a token that has migrated.
  bonding: "\n\n🚀 **Still bonding** on pump.fun — **49%** to graduation\n_No DEX pool yet, so charts and liquidity stay empty until it migrates._",
  website: "https://bullcat.io", twitter: "https://x.com/bullcat", telegram: "https://t.me/bullcat",
  label: "Diamond Listing — $BULLCAT on Solana", amount: "1", order: "k3n8_a1b2",
  // The pay card names the network because two ETH options share one 0x shape.
  network: "Robinhood Chain",
  // The pasted-CA confirmation card. `current` is a WHOLE row (the "this
  // replaces …" warning), so the preview shows the swap case — the one an
  // operator needs to read carefully — rather than the empty first-setup one.
  requester: "@alfa",
  current: "⚠️ This **replaces** the token this group is watching now — **$ALON**.\n\n",
  // The socials row, prebuilt — it is a rendered fragment in the real callers
  // (group/setup.js builds it from DexScreener), so an empty string here left
  // every template that carries it previewing a gap where a row belongs.
  links: "🌐 [Website](https://bullcat.io) · 𝕏 [X](https://x.com/bullcat) · 💬 [Telegram](https://t.me/bullcat)",
  hours: "48", size: "728×90", slot: "Wide Banner", duration: "3 Days", usd: "670",
  endsAt: "Jul 22, 14:00 UTC", discount: "20", field: "name",
  postLinks: "🚨 Listing post: https://t.me/dexvralisting/6\n📢 Announcement: https://t.me/dexvraio/9",
  announceX: "🐦 [Announce on X 𝕏](https://x.com/i/status/1)",
  site: "https://dexvra.io", listing: "https://t.me/dexvralisting",
  trending: "https://t.me/dexvratrending", announce: "https://t.me/dexvraio",
  sol: "1 SOL", bnb: "0.15 BNB", eth: "0.05 ETH", ref: "MDX-4821", reached: "8,214",
  kind: "Photo", caption: "Your text is kept as its caption.", len: "1,842", limit: "1024",
  // The broadcast add-on's line on the pay card — sampled at the shipped fee so
  // an operator previewing it reads the sentence a buyer actually gets.
  fee: "2 SOL",
  // The delivery receipt's two lines. Sampled as the HEALTHY run an admin is
  // editing for — massdm/sender.js owns the other two states ("Delivered to
  // nobody", "the run did not finish") and a preview of one of those would show
  // a card nobody is trying to write.
  reach: "📬 **Sent to all Dexvra users**",
  fail: "\n🚫 **Couldn't reach (blocked/inactive):** 418",
  // The broadcast add-on's fee, always a full "<amount> <coin>" — it is charged
  // in the order's OWN currency, so an operator previewing the card must see a
  // coin beside the number rather than a bare figure.
  emoji: "🟢🟢🟢", count: "3", buysWord: "buys", tokenAmt: "1.2M", bot: "https://t.me/dexvrabot", botName: "@dexvrabot",
  // Group buy alerts (verified path)
  tier: "Whale Buy", impact: "0.42%", change: "+18.4%",
  verify: "🔗 Txn · 👤 0x1f4b…9ac2",
  // 🐋 WHALE WALLET card. {whaleBar} is the bar the wallet cleared — the group's
  // own /setwhale, else the global one in ⚙ Batas whale.
  holds: "1,980,000", holdsUsd: "$95,523", position: "+3.82%", whaleBar: "$50,000",
  wallet: "💼 Position: 1,980,000 $BULLCAT · $95,523 (+3.82%)",
  tradeUrl: "https://t.me/dexvratradebot?start=ca_solana_G9j8",
  // Dexvra Raid. {progress} is GENERATED at render time, so the preview shows a
  // representative block rather than a placeholder — an admin editing the card
  // needs to see how much room those rows take up.
  seq: "#7", percent: "62", left: "38m", crew: "14",
  roster: "@ana, @bo, @cy +11 more",
  handle: "dexvraio",
  // The auto-raid status lines. `when` reads as an age ("3min ago"), because
  // every line that uses it is reporting how long ago something happened.
  when: "just now",
  min: "40",
  // The auto-raid block, and the HEALTHY state of it: a preview is for judging
  // layout, and previewing the "the bot can't see X" branch would put an alarm
  // in front of an operator who has nothing wrong. Its own builder, like
  // {progress} below and for the same reason.
  get autoraid() {
    try {
      return require("../raid/panel").autoRaidStatus({
        autoRaid: { handle: "dexvraio", on: true, lastCheckedAt: Date.now(), lastOkAt: Date.now(), lastSeenTweetId: "1" },
      });
    } catch {
      return "🤖 Auto-raid: on — watching @dexvraio";
    }
  },
  // The refusal quoted back inside the group notice. A REAL one, not "an error":
  // this template's whole job is to hand an admin something they can act on, and
  // that reads differently with a real sentence in it.
  reason: "No goals are set — tap 🤝 Crew on /raid and pick one.",
  // THE RAID'S OWN BUILDER, on sample numbers — never a hand-written lookalike.
  //
  // It used to be a literal string with ❤️ 💬 🤝 ▰ ▱ typed into it, so the
  // preview showed those five icons PLAIN no matter what the operator had set.
  // They swapped them for premium, opened the preview, saw bare glyphs and
  // reported the swap as broken — twice — when the swap had worked and the
  // preview was the thing lying. Same rule the buy card already follows: the
  // preview is rendered by the card's own renderer, because a second renderer
  // agrees with the real one right up until the day it does not.
  get progress() {
    try {
      return require("../raid/card").buildProgressBlock(PREVIEW_RAID);
    } catch {
      return "❤️ Likes   ▰▰▰▰▰▰▱▱▱▱  209/215"; // the raid module is optional to this screen
    }
  },
  url: "https://x.com/i/status/1", post: "gm — like + reply and we're there 🚀",
  updated: "12:33:57", note: "",
  // ── Everything else a template advertises ────────────────────────────────
  // These were simply absent, and a missing var renders as nothing: the
  // /settoken receipt previewed "Every buy from ** up" — two orphaned bold
  // markers where the floor belongs. Harmless in the old one-line audit, but
  // the preview button now shows an operator the whole card and asks them to
  // judge it, so a blank here reads as a template they broke.
  //
  // A test pins this list against every meta.ph in templates.js, so a new
  // placeholder cannot go blank in the preview unnoticed.
  nameRow: "📃 **The Bull Cat** $BULLCAT", chainEmoji: "🟣", logoEmoji: "🐶", tierEmoji: "💎",
  intro: "🚨 **NEW BUY ALERT** ", introWhale: "🐋 **WHALE ALERT** ",
  poweredBy: " | Powered by @dexvralisting", listingChannel: "@dexvralisting",
  bar: "▰▰▰▰▰▰▱▱▱▱", buyer: "0x1f4b…9ac2", txn: " · [Txn](https://solscan.io/tx/5xTx)",
  minBuy: "$50", whale: "$50,000", pool: "resolved ✓", pin: "on", state: "🟢 ON",
  chains: "solana, bsc, ethereum, base", unsupported: "", lock: "off",
  walletUrl: "https://solscan.io/account/AFqu1M", chartUrl: "https://dexscreener.com/solana/G9j8",
  coinUrlLabel: "dexvra.io/token/solana/G9j8", xUrl: "https://x.com/i/status/1",
  // {xlisting} and {handle} are DEXVRA's own X account, so they are READ from
  // the config rather than typed here: the typed pair had already gone stale —
  // xlisting named @dexvraio, which is not the account any listing is tweeted
  // from — so an operator editing an X template previewed the wrong feed.
  xlisting: X_LISTING_URL, handle: `@${X_LISTING_HANDLE}`, mention: " @bullcat",
  listingUrl: "https://t.me/dexvralisting/6", trendingUrl: "https://t.me/dexvratrending/3",
  announceUrl: "https://t.me/dexvraio/9", linkUrl: "https://bullcat.io",
  title: "The Bull Cat", description: "A community-driven memecoin on Solana.",
  size2x: "1456×180", queueNote: "", startsAt: "Jul 19, 14:00 UTC", date: "Aug 10",
  rank: "2", gain: "+42%", multiple: "2×", firstMc: "$310K", lastMc: "$1.3M",
  list: "1. $BULLCAT +42%\n2. $DEX +18%", tag: "BULLCAT",
  goals: "❤️ Likes — +15\n💬 Replies — +5\n🤝 Crew — +10", maxMinutes: "30",
  record: "Best so far: 312 likes", sources: "likes + replies via X API",
  started: "3", completed: "1",
};

const SAMPLE_COIN = {
  name: "The Bull Cat", symbol: "$BULLCAT", chain: "solana", tier: "DIAMOND",
  address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
  price: 0.001266, mcap: 1300000, liq: 183475,
  links: { website: "https://bullcat.io", twitter: "https://x.com/bullcat", telegram: "https://t.me/bullcat" },
  siteUrl: "https://dexvra.io/token/solana/G9j8", overview: "A community-driven memecoin on Solana.",
  xUrl: "https://x.com/i/status/1",
};

/**
 * The templates that are NOT simple var-substitution.
 *
 * Channel posts are assembled by format.js, so rendering the raw template would
 * show something the channel never sends. Module scope, not a local inside the
 * audit, because the preview needs the same map — and a second copy would be a
 * second sample coin to keep in step.
 */
const SPECIAL_RENDER = {
  // /ca renders with dropEmpty and with its OWN {label} — the shared sample bag
  // spells that "Diamond Listing — $BULLCAT on Solana", because {label} is the
  // ad-slot name everywhere else. Previewing it from the generic bag showed a
  // card no group will ever receive, which is worse than showing nothing.
  group_ca: () =>
    tpl.render(
      "group_ca",
      {
        ...SAMPLE_VARS,
        label: "**The Bull Cat** $BULLCAT",
        links: "🌐 [Website](https://bullcat.io) · 𝕏 [X](https://x.com/bullcat) · 💬 [Telegram](https://t.me/bullcat)",
      },
      { dropEmpty: true },
    ),
  post_listing_xpress: () => require("../channels/format").listingPost({ ...SAMPLE_COIN, tier: "XPRESS" }),
  post_listing_tiered: () => require("../channels/format").listingPost(SAMPLE_COIN),
  post_trending: () => require("../channels/format").trendingPost(SAMPLE_COIN),
  post_pump: () => require("../channels/format").pumpPost(SAMPLE_COIN, 137.6, 310000, 1300000),
  post_rankup: () => require("../channels/format").rankupPost(SAMPLE_COIN, 2, 82),
  post_banner: () =>
    require("../channels/format").bannerPost(
      {
        title: "The Bull Cat",
        slot: "Wide Banner",
        linkUrl: "https://bullcat.io",
        description: "The Bull Cat is a community-driven memecoin on Solana with a deflationary burn on every trade.",
        address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
        twitter: "https://x.com/bullcat",
        telegram: "https://t.me/bullcat",
      },
      "https://x.com/i/status/1",
    ),
};

/** Any template, rendered on sample values, as a sendable payload. */
function renderSample(key) {
  return SPECIAL_RENDER[key] ? SPECIAL_RENDER[key]() : tpl.render(key, SAMPLE_VARS);
}

async function sendTemplateAudit(ctx, arg = "") {
  const cleanOf = (k) => {
    try {
      const r = renderSample(k);
      return String((r && r.text) || "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, " · ").trim();
    } catch {
      return "(render error)";
    }
  };
  const groups = tpl.groups();
  const names = arg ? groupNames().filter((n) => slugOf(n) === arg) : groupNames();
  if (!names.length) {
    return ctx
      .reply(`No group '${escapeHtml(arg)}'. Try: ${groupNames().map((n) => `<code>/preview ${slugOf(n)}</code>`).join(", ")}`, HTML)
      .catch(() => {});
  }
  const cap = arg ? 480 : 130;
  for (const name of names) {
    let msg = `📋 <b>${escapeHtml(name)}</b> — ${groups[name].length} templates\n\n`;
    for (const k of groups[name]) {
      const text = cleanOf(k);
      const snip = text.length > cap ? `${text.slice(0, cap)}…` : text;
      const row = `${tpl.isCustom(k) ? "✏️" : "•"} <b>${escapeHtml(tpl.meta(k).label)}</b>\n<i>${escapeHtml(snip)}</i>\n\n`;
      if (msg.length + row.length > 3900) {
        await ctx.reply(msg, HTML).catch(() => {});
        msg = "";
      }
      msg += row;
    }
    if (msg.trim()) await ctx.reply(msg, HTML).catch(() => {});
  }
  if (!arg) {
    await ctx
      .reply(
        `Tip: <code>/preview botmessages</code> (or any group) shows fuller text. ✏️ = edited · • = default. Tap a category on /start to edit any of them.`,
        HTML,
      )
      .catch(() => {});
  }
}
function groupKb(slug, page = 0) {
  const name = nameFromSlug(slug);
  const g = (name && tpl.groups()[name]) || [];
  const pages = pageCount(g.length);
  const p = clampPage(page, pages);
  const slice = g.slice(p * GROUP_PAGE, p * GROUP_PAGE + GROUP_PAGE);
  const rows = slice.map((k) => [
    Markup.button.callback(`${tpl.isCustom(k) ? "✏️ " : ""}${tpl.meta(k).label}`, `v:${k}`),
  ]);
  if (pages > 1) {
    rows.push([
      Markup.button.callback(p > 0 ? "◀ Prev" : "·", p > 0 ? `grp:${slug}:${p - 1}` : "noop"),
      Markup.button.callback(`Page ${p + 1}/${pages}`, "noop"),
      Markup.button.callback(p < pages - 1 ? "Next ▶" : "·", p < pages - 1 ? `grp:${slug}:${p + 1}` : "noop"),
    ]);
  }
  rows.push([Markup.button.callback("⬅ Back", "home")]);
  return Markup.inlineKeyboard(rows);
}
function groupText(name, p, pages) {
  const head = pages > 1 ? ` <i>(page ${p + 1}/${pages})</i>` : "";
  return `<b>${escapeHtml(name)}</b>${head}\n\nPick a template:`;
}
/**
 * The caveat that stops an operator wasting an evening.
 *
 * A premium emoji only renders animated when a Telegram PREMIUM USER ACCOUNT
 * sends it — that is what GramJS is for, and it is how the channel posts go
 * out. Everything named `group_*` is posted into a customer's group by the
 * ORDINARY BOT, and Telegram silently strips custom-emoji entities from a
 * regular bot, leaving the fallback character. So the swap is accepted, saved
 * and then invisible, which is the worst way for a setting to fail.
 *
 * Said here rather than in a doc nobody opens, because this is the exact screen
 * where somebody is about to paste one.
 */
// The rule, verbatim from the Bot API formatting docs: "Custom emoji entities
// can only be used by bots that purchased additional usernames on Fragment or
// in the messages directly sent by the bot to private, group and supergroup
// chats if the owner of the bot has a Telegram Premium subscription." Channels
// are NOT in that list — channel posts still need the GramJS premium account.
// So the one thing standing between a 💎 swap and an animated group card is
// WHO OWNS THE BOT in BotFather — say so, or the operator reads the fallback
// char as "premium gagal" and files it as a bug (which happened).
const GROUP_PREMIUM_NOTE =
  "\n\n⚠️ <b>Premium emoji di kartu yang DIKIRIM BOT (DM, grup, supergrup) menyala kalau akun PEMILIK bot ber-Telegram Premium.</b> " +
  "Aturan Telegram: bot boleh mengirim custom emoji ke private/grup/supergrup hanya jika akun pemilik bot (di @BotFather) " +
  "sedang berlangganan Premium — kalau tidak, yang tampil emoji cadangannya. " +
  "Pindahkan kepemilikan bot ke akun Premium Anda lewat @BotFather → Bot Settings → Transfer Ownership, " +
  "dan 💎 langsung menyala di kartu buy/whale, kartu bayar, dan resi broadcast.";
// A CHANNEL is in neither half of Telegram's rule, which is the whole reason
// src/gramjs.js exists. Saying "akun pemilik bot" over a channel post would
// send an operator to @BotFather for a setting that cannot help there.
const CHANNEL_PREMIUM_NOTE =
  "\n\n💎 <b>Post channel keluar lewat akun GramJS premium</b>, bukan lewat bot — " +
  "emoji premium di sini menyala selama akun itu tersambung dan masih berlangganan (cek 💎 Premium status).";
// ⚠️ AND ONE SURFACE CAN NEVER ANIMATE ONE. X has no custom emoji at all, so a
// 💎 swap on an x_* template publishes its FALLBACK character to a public tweet
// and nothing else — a setting that is accepted, saved, and then invisible,
// which is the exact failure GROUP_PREMIUM_NOTE was written about. Those
// templates are kept off the 🎨 all-emoji screen entirely; this note is for the
// per-template swap, which can still reach them.
const X_PREMIUM_NOTE =
  "\n\n⚠️ <b>X (Twitter) tidak punya custom emoji.</b> Ikon di template X terbit sebagai karakter cadangannya — " +
  "swap premium di sini tidak akan pernah menyala di tweet.";

/**
 * WHERE a template's icons end up, which decides which caveat is true of it.
 *
 * ⚠️ `tpl.meta()` SYNTHESISES `{group:"Other"}` for a key it does not know, so
 * an unknown key resolves to "telegram" — the direction that SHOWS a caveat
 * rather than hiding one. That is the FALLTHROUGH below doing the work, not the
 * try/catch: a mutation run proved the catch unreachable today (meta answers
 * for every string), so it is belt-and-braces for the day meta starts throwing
 * and NOT a guard any test can claim to cover.
 */
function premiumSurface(key) {
  let group = "";
  try {
    group = tpl.meta(key).group;
  } catch {
    /* unreachable today — see above; the fallthrough is what decides */
  }
  if (group === "X Posts") return "x";
  if (group === "Channel Posts") return "channel";
  return "telegram";
}

/**
 * The caveats true of THESE keys, in one string — the ONE OWNER of that
 * question.
 *
 * It used to be `isGroupPosted(key) ? GROUP_PREMIUM_NOTE : ""`, a prefix test
 * over `group_`/`buybot_` — right while the picker only ever pointed at those,
 * and silent the moment it could reach a pay card, a broadcast receipt or a
 * tweet. A slot can span several surfaces at once, so every caveat that applies
 * is appended rather than the first one winning.
 */
function premiumNoteFor(keys) {
  const seen = new Set([].concat(keys).map(premiumSurface));
  return (
    (seen.has("telegram") ? GROUP_PREMIUM_NOTE : "") +
    (seen.has("channel") ? CHANNEL_PREMIUM_NOTE : "") +
    (seen.has("x") ? X_PREMIUM_NOTE : "")
  );
}

/*
 * ── The buy card's emoji, all on one screen ─────────────────────────────────
 *
 * Restyling the buy alert used to mean visiting EIGHT templates. The banner
 * lives in group_buy_intro, the size icons in group_buy_style, the buyer row in
 * group_buyer_row, the Position tick in group_position_row, the network mark in
 * chain_emojis, and the 💲🪙📊💧 column in group_buy_alert — with group_whale_alert
 * carrying its own copy of that same column. Eight screens, each with its own
 * "😀 Swap emoji", and no way to see the card's palette as one thing.
 *
 * So: one screen, every icon on it, and NO template text is ever rewritten.
 *
 * IDENTICAL ICONS ARE ONE SLOT. 💲 appears on both the buy card and the whale
 * card; swapping it here changes both. That is not a shortcut — the two cards
 * are deliberately one grammar, they land in the same chat minutes apart, and a
 * feed that mixes two palettes reads as a bug in the bot. Every previous drift
 * between these two cards happened because one of them was edited alone.
 *
 * CHAIN MARKS ARE NOT DEDUPED, and that is why they are a separate section:
 * `plasma = 🟢` collides with the 🟢 buy-size icon, and folding those together
 * would repaint every small buy the day somebody rebranded Plasma.
 */
const BUY_CARD_EMOJI_KEYS = [
  "group_buy_intro",
  "group_whale_intro",
  "group_buy_style",
  "group_name_row",
  "group_buyer_row",
  "group_position_row",
  "group_buy_alert",
  "group_whale_alert",
];

/*
 * ── The buy card's and the raid's icons, on one screen ──────────────────────
 *
 * Restyling the buy alert used to mean visiting eight templates; the raid card
 * spreads its icons over twenty more. An operator changing one glyph was
 * opening a template, tapping "😀 Swap emoji", choosing, going back, and doing
 * it again — once per template, with no way to know they had finished. "saya
 * capek set ulang 1/1" is the design brief.
 *
 * SCOPED TO THE TWO SURFACES A PROJECT ACTUALLY SEES, on the operator's own
 * instruction: these are the cards that land in a customer's group all day. The
 * receipts, prompts and error lines are already styled and must not be dragged
 * along by a swap aimed at a buy alert — a screen that changes everything is a
 * screen you cannot use once you are happy with most of it.
 *
 * IDENTICAL GLYPHS ARE ONE SLOT, exactly as on the buy-card screen and for the
 * same reason: an operator thinks in ICONS, not in template rows. The ✅ on the
 * position row and the ✅ on the raid card are one decision, and a bot whose ✅
 * changed in some places and not others reads as broken rather than styled.
 *
 * The button says how many places it covers, because one tap here moves all of
 * them and that is not something to discover afterwards.
 *
 * chain_emojis is DELIBERATELY excluded — same carve-out the buy screen makes.
 * Those are per-network marks the bot picks by itself, `plasma = 🟢` collides
 * with the buy-size 🟢, and folding them in would repaint every small buy the
 * day somebody rebranded a chain.
 */
const ALL_EMOJI_PER_PAGE = 21;
/**
 * ⚠️ SCOPED, AND THE SCOPE IS AN OPERATOR INSTRUCTION ON THE RECORD — "khusus
 * buy alert dan raid, yang lainnya ga usah, jangan diubah apapun", pinned by
 * allEmojiScreen.test.js ("a swap aimed at a buy alert must not drag a receipt
 * or a prompt along with it").
 *
 * "saya ingin semua template kaya tdi broadcast sama payment ini bisa di edit
 * pakai emoji premium" is NOT a request to widen this: every template is
 * already editable with premium emoji two ways — paste a message carrying them
 * (stored verbatim as {text, entities}) or 😀 Swap emoji on the template
 * itself. What was missing is that this screen's own copy read as though the
 * rest could not be styled at all, and that the swap prompt said nothing true
 * about a DM or a tweet. Widening it instead would make one ✅ swap repaint a
 * receipt, a prompt and a buy card together — the exact harm the instruction
 * above names, and unaimable once a bot has 156 templates.
 */
const ALL_EMOJI_GROUPS = ["Group Buy Bot", "Dexvra Raid"];

/**
 * Names for the icons whose DERIVED hint is useless.
 *
 * emojiHint reads the first word after the icon, which is exactly right on a
 * data row — "💲 {usd}{native}" → usd, "📈 Chart" → Chart — and worthless in a
 * sentence: "❌ That isn't an X post link" → "That", "🎉 Every goal cleared" →
 * "Every", and BOTH "⌛ RAID EXPIRED" and "🛑 RAID STOPPED" → "RAID", which put
 * two different icons on the screen under one meaningless name.
 *
 * Keyed on the glyph the CODE SHIPS, so it survives every swap — the operator
 * who changed ⌛ for something else still sees "expired". English, to match the
 * derived hints beside them (Crew, Chart, Likes); a half-translated screen
 * reads worse than a consistent one.
 *
 * Only the ones the heuristic gets WRONG are listed. Anything absent keeps its
 * derived hint, which stays true when an operator rewords the row.
 */
const EMOJI_NAMES = {
  "❌": "bad link",
  "🎉": "raid done",
  "⌛": "expired",
  "🛑": "stopped",
  "👥": "group only",
  "⏳": "launching",
  "⏱": "clock",
  "🔗": "post link",
  "🔒": "lock chat",
  "🔥": "listing",
  "➕": "add to group",
  "🗑": "remove CA",
  "🚨": "buy banner",
  // 🟢 and 🤖 both derived to "buy" — the size row and the Buy Bot button, two
  // unrelated icons under one name, which is the same failure as ⌛/🛑.
  "🐋": "whale",
  "🟢": "buy bar",
  "🤖": "buy bot",
  // These three are SHARED between the buy card and the raid card, and the hint
  // is derived from whichever template the screen reads first — which is always
  // a buy one. So an operator hunting for the raid's "12% complete" icon found a
  // button labelled "price", the raid's "Record" line found "Chart", and the
  // completed-raid banner found "Position". The icon was editable the whole
  // time and unfindable by the person looking for it, which from where they were
  // standing is the same thing.
  //
  // Each one EXTENDS the word it used to derive, keeping its case, rather than
  // replacing it: whoever already knows the button as "Chart" must still find it
  // by that word. Naming both uses is also the warning — a swap here changes the
  // other card too.
  "📊": "price & raid %",
  "📈": "Chart & record",
  "✅": "Position & done",
  // The auto-raid block. 👤 and 🤖 are shared with the buy card and the main
  // menu, so they derive a name from those and said nothing about the raid —
  // which is how "where do I edit 👤 and 🤖" got asked with both sitting on this
  // screen. Extended, not replaced, so the buy meaning survives.
  "👤": "buyer & X account",
  "🤖": "buy bot & auto-raid",
  // These three derive their name from the first word of a SENTENCE, which is
  // worthless: "🚫 the bot hasn't been able to see X" → "the".
  "🚫": "auto-raid blind",
  "⏸": "raid queued",
  "⚠️": "warning",
};

/** The keys this screen owns: the buy card's own eight, plus every template in
 *  the buy-bot and raid groups. Derived from the registry rather than listed,
 *  so a raid template added tomorrow is on the screen the same day. */
function allEmojiKeys() {
  const keys = new Set(BUY_CARD_EMOJI_KEYS);
  for (const key of tpl.keys()) {
    if (key === "chain_emojis") continue;
    let group = "";
    try {
      group = tpl.meta(key).group;
    } catch {
      continue;
    }
    if (ALL_EMOJI_GROUPS.includes(group)) keys.add(key);
  }
  return [...keys];
}

/** Every icon on those two surfaces, deduped by the glyph the CODE ships —
 *  never by the glyph it currently wears, or two unrelated rows whose swaps
 *  happen to share a fallback char would merge into one button. */
function allEmojiSlots() {
  const bySlot = new Map();
  for (const key of allEmojiKeys()) {
    let list = [];
    try {
      list = tpl.listEmojis(key);
    } catch {
      continue; // a template that will not parse must not take the screen down
    }
    for (const e of list) {
      const identity = e.baseChar || e.char;
      const slot = bySlot.get(identity) || { char: e.char, id: e.id, label: "", spots: [] };
      if (!slot.id && e.id) slot.id = e.id;
      // The curated name wins where the heuristic is wrong; everywhere else the
      // derived hint stays, so a reworded row still names itself correctly.
      if (!slot.label) slot.label = EMOJI_NAMES[identity] || emojiHint(key, e);
      slot.spots.push({ key, i: e.i });
      bySlot.set(identity, slot);
    }
  }
  // Most-used first: the icons worth changing are the ones the reader sees
  // everywhere, and they should not be on page four.
  return [...bySlot.values()].sort((a, b) => b.spots.length - a.spots.length);
}

function allEmojiPages() {
  return Math.max(1, Math.ceil(allEmojiSlots().length / ALL_EMOJI_PER_PAGE));
}

function allEmojiKb(page = 0) {
  const cb = Markup.button.callback;
  const slots = allEmojiSlots();
  const pages = Math.max(1, Math.ceil(slots.length / ALL_EMOJI_PER_PAGE));
  const p = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const rows = [];
  const shown = slots.slice(p * ALL_EMOJI_PER_PAGE, (p + 1) * ALL_EMOJI_PER_PAGE);
  const btns = shown.map((s) => {
    // The index is into the FULL list, so a button keeps meaning the same slot
    // whichever page it was drawn on.
    const n = slots.indexOf(s);
    // THE NAME, not just the glyph. A button showing only the current char
    // becomes unfindable the moment it is swapped: change 🤝 for a premium
    // emoji whose fallback is ⚡ and the row reads "💎⚡ ×6", so an operator
    // hunting for Crew cannot see it and reports it as missing. The name comes
    // from the template itself — the same hint the per-template picker shows —
    // so it stays true when a row is reworded.
    const name = s.label ? ` ${s.label}` : "";
    return cb(`${s.id ? "💎" : ""}${s.char}${name}${s.spots.length > 1 ? ` ×${s.spots.length}` : ""}`, `aemx:${n}`);
  });
  // Two per row, not three: the label needs the width, and a truncated name is
  // no more findable than no name at all.
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  if (pages > 1) {
    rows.push([
      cb("◀ Prev", `aem:${(p - 1 + pages) % pages}`),
      cb(`Page ${p + 1}/${pages}`, "noop"),
      cb("Next ▶", `aem:${(p + 1) % pages}`),
    ]);
  }
  // An icon on a button is not the card. The hint beside it names the ROW the
  // icon sits on, which is enough to pick the right button and nowhere near
  // enough to judge the result — whether the new glyph is wider than the one it
  // replaced, whether it still reads under the row above it. Both surfaces this
  // screen owns, sent as a group would receive them.
  rows.push([cb("👁 Lihat hasilnya (buy + raid)", `aemp:${p}`)]);
  rows.push([cb("⬅ Kembali", "home")]);
  return Markup.inlineKeyboard(rows);
}

function allEmojiText(page = 0) {
  const slots = allEmojiSlots();
  const places = slots.reduce((n, s) => n + s.spots.length, 0);
  const nPrem = slots.filter((s) => s.id).length;
  return (
    `🎨 <b>Emoji buy alert + raid</b>\n\n` +
    `${slots.length} ikon, dipakai di ${places} tempat pada kartu <b>buy/whale</b> dan <b>raid</b>. ` +
    `Tekan satu ikon, kirim penggantinya — <b>semua tempat yang memakai ikon itu ikut berubah sekaligus</b>.\n\n` +
    `Angka <b>×N</b> di tombol adalah berapa tempat yang ikut berubah, jadi Anda tahu dampaknya sebelum menekan. ` +
    `Diurutkan dari yang paling sering dipakai.\n\n` +
    `<b>Teksnya tidak disentuh sama sekali</b> — hanya ikonnya.\n\n` +
    `ℹ️ Hanya dua kartu ini yang tersentuh: struk, prompt dan pesan lain <b>tidak ikut berubah</b>, ` +
    `supaya satu swap tidak menyeret kartu yang sudah pas.\n` +
    `ℹ️ Tapi mereka <b>tetap bisa pakai emoji premium</b> — satu per satu dari menu utama: ` +
    `pilih grupnya (<b>Bot Messages</b> untuk kartu bayar, <b>Mass DM</b> untuk resi broadcast) → ` +
    `pilih templatenya → <b>😀 Swap emoji</b>, atau <b>✏️ Edit</b> lalu kirim ulang teksnya ` +
    `lengkap dengan emoji premiumnya.\n` +
    `ℹ️ Lambang jaringan juga tidak ada di sini: bot memilihnya sendiri sesuai chain token. ` +
    `Aturnya di <b>Channel Posts → Chain emoji</b>.` +
    (nPrem ? `\n\n💎 ${nPrem} ikon sudah premium.` : "")
  );
}

/** A template's BASE text, whether stored as prose or as {text, entities}.
 *  Base, not the overlaid value: listEmojis() hands out BASE offsets (that is
 *  what keeps a swapped slot editable and the buttons aligned), so the hints
 *  read out of this text have to be sliced with the same coordinates. */
function rawText(key) {
  const val = tpl.getBaseValue(key);
  return val && typeof val === "object" && val.text != null ? val.text : String(val || "");
}

/** For a `key = emoji` template, the key belonging to each emoji in reading
 *  order (empty array for ordinary prose templates). */
function mapKeyLabels(key) {
  const text = rawText(key);
  const lines = text.split("\n").filter((l) => /^[^=\n]+=/.test(l));
  // Only treat it as a map when EVERY non-empty line is `key = value`.
  if (!lines.length || lines.length !== text.split("\n").filter((l) => l.trim()).length) return [];
  return lines.map((l) => l.split("=")[0].trim());
}

// Pipe-separated lists have no words to read a hint from — the fields ARE the
// meaning, positionally. Spelled out here because "🟢|🐋" tells an operator
// nothing about which circle is the ordinary buy.
const PIPE_FIELD_LABELS = {
  group_buy_style: ["buy", "whale"],
  group_buy_tiers: ["buy", "whale", "mega"],
};

/**
 * What this icon is FOR, in one word, read out of the template itself.
 *
 * Derived rather than hand-written, so it stays true when an operator rewords a
 * row: the hint is the first word (or placeholder name) that follows the emoji
 * on its own line. "💲 {usd}{native}" → usd. "📈 Chart" → Chart. A hand-written
 * table would be a second copy of the card's layout, and would start lying the
 * first time somebody edited a row.
 */
function emojiHint(key, e) {
  const labels = mapKeyLabels(key);
  if (labels.length) return labels[e.i] || "";
  const text = rawText(key);
  const fields = PIPE_FIELD_LABELS[key];
  if (fields) return fields[text.slice(0, e.start).split("|").length - 1] || "";
  const nl = text.indexOf("\n", e.end);
  const after = text.slice(e.end, nl === -1 ? undefined : nl);
  const word = after.match(/[A-Za-z]{2,}/);
  return word ? word[0].slice(0, 12) : "";
}

/**
 * Every icon the buy card shows, as tappable slots.
 *
 * @returns {{char: string, id: string|null, label: string, chain: boolean,
 *            spots: {key: string, i: number}[]}[]}
 */
function buyEmojiSlots() {
  const bySlot = new Map();
  for (const key of BUY_CARD_EMOJI_KEYS) {
    for (const e of tpl.listEmojis(key)) {
      // Grouped on the SHIPPED glyph, never the current one. Identical shipped
      // icons are one slot on purpose (💲 buy + 💲 whale move together) — but
      // grouping on the current char let SWAPS merge unrelated rows: price
      // swapped to a custom emoji with a 📈 fallback swallowed the Chart
      // button, whose spots then moved with every "price" edit. Buttons
      // disappeared into each other, which read as "the setting is gone".
      const identity = e.baseChar || e.char;
      const slot = bySlot.get(identity) || { char: e.char, id: e.id, label: emojiHint(key, e), chain: false, spots: [] };
      // A premium id anywhere in the group marks the slot premium: the operator
      // needs to see 💎 on the button whichever card carries it.
      if (!slot.id && e.id) slot.id = e.id;
      if (!slot.label) slot.label = emojiHint(key, e);
      slot.spots.push({ key, i: e.i });
      bySlot.set(identity, slot);
    }
  }
  const chains = tpl.listEmojis("chain_emojis").map((e) => ({
    char: e.char,
    id: e.id,
    label: emojiHint("chain_emojis", e),
    chain: true,
    spots: [{ key: "chain_emojis", i: e.i }],
  }));
  return [...bySlot.values(), ...chains];
}

/*
 * ── Seeing the card before a real buy does ──────────────────────────────────
 *
 * An emoji on a button is not the card. 💧 next to 🔵 in a keyboard grid tells
 * you nothing about whether the 💧 row reads well under the 🪙 row, and the only
 * way to find out used to be to wait for somebody to buy the token — which on a
 * quiet contract is hours, in a customer's group, in public.
 *
 * So the preview is rendered by THE ALERT'S OWN RENDERER on sample values, not
 * by a lookalike built here. A second renderer would agree with the real one
 * right up until the day it did not, and the whole point of looking is to trust
 * what you see.
 *
 * It is also the honest answer to "does premium survive in a group?". This
 * preview is sent BY THE ADMIN BOT — a regular bot, exactly like the one that
 * posts into groups — so whatever the operator sees here is what the group gets.
 * If the 💎 shows up animated, it works; if it falls back, it falls back. No
 * documentation to argue with.
 */
/*
 * THE SAMPLE MUST READ AS A SAMPLE. These were a real third-party token's real
 * addresses, which is wrong twice over: every operator's preview screen
 * advertised somebody else's coin with live links to it, and — the reason it
 * was changed — an operator who found that same contract configured in their
 * group could not tell the two facts apart. They spent an evening certain the
 * bot shipped a hardcoded default CA. It never did: this object is render-only
 * (buyPreview.test.js pins that previewing writes nothing), and their group's
 * token had been set two days earlier by a pasted address arming itself.
 *
 * A made-up address costs the preview its working chart link and nothing else,
 * because what the screen is for is judging LAYOUT and ICONS. Do not "fix" this
 * back to a real contract.
 */
/** Sample numbers for the raid preview, in the shape renderCard reads. Field
 *  names match raid/card.js exactly — `target`/`baseline`/`current`, not a
 *  paraphrase — or buildProgressBlock returns "No goals set." and the preview
 *  quietly shows nothing at all. */
const PREVIEW_RAID = {
  seq: 7,
  status: "running",
  target: { likes: 215, replies: 15 },
  baseline: { likes: 0, replies: 0 },
  current: { likes: 209, replies: 14 },
  crewTarget: 20,
  crew: Array.from({ length: 14 }, (_, i) => `u${i}`),
};

const PREVIEW_GROUP = {
  chatId: "-100",
  chain: "solana",
  address: "DexvraPreviewToken11111111111111111111111111",
  pairAddress: "DexvraPreviewPair11111111111111111111111111",
  sym: "ALON",
  name: "alon",
  minBuyUsd: 0,
};
const PREVIEW_POOL = { priceUsd: 0.00004823, mcap: 15511897, liquidity: 183475, change24h: 18.42, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
const PREVIEW_BUY = {
  txHash: "5xTxPreviewaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  buyer: "AFqu1MaaaaaaaaaaaaaaaaaaaaaaaaaaajcBb",
  usd: 804.72,
  tokenAmount: 16684015.34,
  spentAmount: 4.2318,
  spentToken: "SoNATIVE",
};
const PREVIEW_POS = { held: 41210338.5, holdsUsd: 1987.57, position: "+68.2%" };
const PREVIEW_WHALE = { ...PREVIEW_POS, held: 902445190.0, holdsUsd: 43521.9, position: "+2.1%", threshold: 50000 };

/** The two cards as they would really be posted. Lazily required: buyMonitor
 *  pulls in the chain readers, and the admin bot has no business loading those
 *  until somebody actually asks to look at a card. `only` ("buy"/"whale")
 *  narrows to one card; `kind` is also the clip slot the real alert plays. */
function buyPreviews(only) {
  const mon = require("../group/buyMonitor");
  return [
    { kind: "buy", label: "Buy alert", payload: mon.renderRealAlert(PREVIEW_GROUP, PREVIEW_BUY, PREVIEW_POOL, PREVIEW_POS) },
    { kind: "whale", label: "Whale alert", payload: mon.renderWhaleAlert(PREVIEW_GROUP, PREVIEW_BUY, PREVIEW_POOL, PREVIEW_WHALE) },
  ].filter((c) => !only || c.kind === only);
}

// Which of the two cards a template actually feeds. A card's OWN pieces (its
// intro, its body) preview that card alone — an operator restyling the buy
// header has no use for a whale card underneath it repeating the shared rows.
// Keys absent here (the money column, buyer row, position row, chain marks)
// feed both cards and preview both, because a swap there moves both.
const CARD_OF_KEY = {
  group_buy_intro: "buy",
  group_buy_alert: "buy",
  group_whale_intro: "whale",
  group_whale_alert: "whale",
};

/**
 * The card(s), sent exactly as a group would receive them — through the alert's
 * OWN sender, so the uploaded GIF/video plays above the text with the card as
 * its caption, precisely like a real alert. A preview that arrives as bare text
 * while every real alert arrives under a clip is answering a question nobody
 * asked; whether the swapped icon reads well is a question about the message
 * the group gets, clip included.
 *
 * `only` narrows to one card — the whale template previews the whale card, not
 * both. Each card is its OWN message with no HTML wrapper: a preview wrapped in
 * a "here is your preview" card renders the entity offsets against the wrong
 * string and slides every premium emoji onto the wrong character.
 */
async function sendBuyPreview(ctx, only) {
  const mon = require("../group/buyMonitor");
  for (const { kind, label, payload } of buyPreviews(only)) {
    const { text, extra } = payloadArgs(payload);
    await ctx.reply(`👁 <b>${label}</b> — contoh`, HTML).catch(() => {});
    // A refused CLIP is reported too, not just a refused card. sendAlert falls
    // back to plain text when Telegram rejects the clip+caption (a card longer
    // than the 1024-char caption limit, most likely) — in a group that is the
    // right instinct, but here it renders indistinguishable from "no clip
    // uploaded", and a preview that hides the one misconfiguration it could
    // have caught is not a preview.
    const clipRefused = (e) =>
      ctx.reply(
        `⚠️ <b>Klipnya ditolak Telegram</b> dengan kartu ini sebagai caption — grup juga akan menerima teks polos tanpa klip: <code>${escapeHtml(String(e && e.message))}</code>` +
          (text.length > 1024 ? `\n\nKartunya ${text.length} karakter — melebihi batas caption 1024. Pendekkan templatenya supaya klipnya ikut.` : ""),
        HTML,
      ).catch(() => {});
    await mon.sendAlert(ctx.telegram, ctx.chat.id, text, extra, kind, clipRefused).catch((e) => {
      // A card that Telegram REFUSES is the single most useful thing this
      // screen can report — it is the failure a real group would have hit
      // silently, hours later, with nobody watching.
      ctx.reply(`⚠️ Telegram menolak kartu ini: <code>${escapeHtml(String(e && e.message))}</code>`, HTML).catch(() => {});
    });
  }
}

/**
 * ANY template, rendered, right after it was changed.
 *
 * An emoji on a button is not the message. Whether 💧 sits well under 🪙, or
 * whether a swapped glyph is wider than the one it replaced and pushes a row
 * onto two lines, is only visible in the assembled card — and until now the
 * only way to see one was to make the bot send it for real: wait for a buy,
 * post to the channel, or trigger the flow by hand.
 *
 * The pieces of the buy card get the WHOLE card instead of their own fragment.
 * Previewing `group_position_row` on its own shows one line out of context,
 * which answers nothing about the thing that was actually edited. But only the
 * card the key FEEDS: the buy template previews the buy card, the whale
 * template the whale card, and just the shared rows show both.
 *
 * Sent unwrapped, with entities: a "here is your preview" header would count
 * the entity offsets against the wrong string and slide every link and every
 * premium emoji onto the wrong character.
 */
async function sendTemplatePreview(ctx, key) {
  if (BUY_CARD_EMOJI_KEYS.includes(key) || key === "chain_emojis") return sendBuyPreview(ctx, CARD_OF_KEY[key]);
  let payload;
  try {
    payload = renderSample(key);
  } catch (e) {
    return ctx.reply(`⚠️ Template ini gagal dirender: <code>${escapeHtml(String(e && e.message))}</code>`, HTML).catch(() => {});
  }
  const { text, extra } = payloadArgs(payload);
  if (!text || !text.trim()) return; // a template an operator emptied on purpose
  await ctx.reply(`👁 <b>${escapeHtml(tpl.meta(key).label)}</b> — contoh`, HTML).catch(() => {});
  await ctx.reply(text, extra).catch((e) => {
    // The most useful thing this screen can report. A card Telegram refuses
    // is a message that would have failed silently, later, in a customer's
    // group or a channel, with nothing but a log line to say why.
    ctx.reply(`⚠️ Telegram menolak pesan ini: <code>${escapeHtml(String(e && e.message))}</code>`, HTML).catch(() => {});
  });
}

function buyEmojiKb() {
  const cb = Markup.button.callback;
  const slots = buyEmojiSlots();
  const rows = [];
  // The card's own icons and the network marks are laid out as two blocks, in
  // that order, because they answer different questions and the chain block is
  // long enough to bury the four rows somebody actually came to restyle.
  for (const chain of [false, true]) {
    const btns = slots
      .map((s, n) => ({ s, n }))
      .filter(({ s }) => s.chain === chain)
      .map(({ s, n }) => cb(`${s.id ? "💎" : ""}${s.char}${s.label ? ` ${s.label}` : ""}`, `bemx:${n}`));
    for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  }
  rows.push([cb("👁 Lihat kartunya", "bemp")]);
  rows.push([cb("⬅ Kembali", "v:group_buy_alert")]);
  return Markup.inlineKeyboard(rows);
}

function buyEmojiText() {
  const slots = buyEmojiSlots();
  const nPrem = slots.filter((s) => s.id).length;
  return (
    `😀 <b>Emoji kartu buy alert</b>\n\n` +
    `Tekan emoji yang mau diganti, lalu kirim emoji penggantinya. ` +
    `<b>Teksnya tidak disentuh sama sekali</b> — hanya emoji itu yang berubah, jadi tata letak kartu tetap.\n\n` +
    `Emoji yang sama dipakai kartu <b>buy dan whale</b> sekaligus, jadi sekali ganti keduanya ikut — ` +
    `dua kartu ini memang harus seragam.\n\n` +
    `Blok kedua adalah <b>lambang jaringan</b>: bot memilih sendiri sesuai chain token, ` +
    `tidak perlu diatur per grup.` +
    (nPrem ? `\n\n💎 ${nPrem} emoji sudah premium.` : "") +
    GROUP_PREMIUM_NOTE
  );
}

function viewKb(key) {
  const rows = [[Markup.button.callback("✏️ Edit", `e:${key}`), Markup.button.callback("♻️ Reset default", `r:${key}`)]];
  // Offered ONLY when this template still carries a saved layout that no longer
  // matches the shipped one. It is the answer to "I pulled, I restarted, the
  // card is unchanged": the saved copy is what the group receives, and this is
  // the one action that takes the new layout WITHOUT throwing away the icons.
  if (tpl.layoutDiffers(key)) {
    rows.push([Markup.button.callback("🔄 Layout terbaru, emoji tetap", `adopt:${key}`)]);
  }
  // Only offer the emoji swap when there is something to swap.
  if (tpl.listEmojis(key).length) rows.push([Markup.button.callback("😀 Swap emoji", `tem:${key}`)]);
  // The message as it will actually be sent, from the controls card too — the
  // text above it is the RAW template, {placeholders} and all, which is what an
  // operator edits but not what anybody receives.
  rows.push([Markup.button.callback("👁 Lihat hasilnya", `temp:${key}`)]);
  // …and on any template those two cards are built from, the way in to ALL of
  // their icons at once. Offered from every piece rather than one blessed
  // screen: whichever one an operator happens to open, the whole palette is one
  // tap away instead of a dozen screens away.
  //
  // TWO SCREENS, and each template is offered the one that can actually restyle
  // it. `bem` is scoped to the buy card; `aem` covers the buy card AND the raid.
  // A raid template used to be offered NEITHER — the gate was the buy card's
  // eight keys — so an admin who opened raid_card looking for 📊 got that one
  // template's icons and no route to the rest, which is indistinguishable from
  // raid icons not being editable at all. That is how it was reported.
  //
  // A raid template must NOT be sent to `bem`: that screen holds no raid icon,
  // so the button would open a wall of buy-card glyphs and look like the wrong
  // one was pressed. The label names the screen it opens, for the same reason.
  if (BUY_CARD_EMOJI_KEYS.includes(key) || key === "chain_emojis") {
    rows.push([Markup.button.callback("🎨 Semua emoji kartu buy", "bem")]);
  } else if (allEmojiKeys().includes(key)) {
    rows.push([Markup.button.callback("🎨 Semua emoji kartu buy + raid", "aem:0")]);
  }
  rows.push([Markup.button.callback("⬅ Back", `grp:${groupIdOf(key)}`)]);
  return Markup.inlineKeyboard(rows);
}
function bannerKb() {
  const has = bannerExists();
  return Markup.inlineKeyboard([
    [Markup.button.callback(has ? "🔄 Replace banner" : "⬆ Upload banner", "bup")],
    ...(has ? [[Markup.button.callback("🗑 Remove banner", "brm")]] : []),
    [Markup.button.callback("⬅ Back", "home")],
  ]);
}

function bannerExists() {
  try {
    return fss.existsSync(tpl.BANNER_PATH) && fss.statSync(tpl.BANNER_PATH).size > 0;
  } catch {
    return false;
  }
}

// ── Channel banner artwork (fourtis-style template compositor) ───────────────
const BT_KINDS = {
  listing: "📄 Listing",
  trending: "🔥 Trending",
  banner: "📢 Banner Ads",
  pump: "📈 Pump alert",
  rankup: "🚀 Rank up",
  buy: "🟢 Buy Bot",
  whale: "🐋 Whale Alert",
  // The one FALLBACK slot, used by any group-alert kind whose own slot is empty
  // (see buyMonitor.buyClip). Kinds still never borrow from EACH OTHER — only
  // from here — so an operator who wants one house clip everywhere uploads it
  // once, and one who wants a whale to look different still can.
  default: "⭐ GIF Default",
};
// Media (GIF/video) is allowed for every kind incl. pump; artwork compositing
// only for the three still-image kinds.
const BT_ARTWORK_KINDS = new Set(["listing", "trending", "banner"]);
// Token banners whose animated clip is auto-filled with the token's logo/$ticker/price.
// Pump is a fill kind too, but with its OWN layout (▲ +N% · old→new price · MCAP).
const BT_FILL_KINDS = new Set(["listing", "trending", "pump"]);
// Kinds whose animated clip gets something composited onto every frame. Banner
// Ads joins the fill kinds here but with a different payload: not token data,
// the ADVERTISER'S CREATIVE, dropped into the frame's slot. Without this a
// banner clip played as pure decoration and the ad the buyer paid for never
// appeared in it at all.
const BT_CLIP_FILL_KINDS = new Set([...BT_FILL_KINDS, "banner"]);
// Kinds whose media may be a STILL PHOTO as well as a clip. Only the group-alert
// slots, where the media is sent as-is above a caption and a house image is a
// real choice. The compositing kinds are excluded on purpose: their still image
// is the ⬆ Upload artwork slot, which gets DRAWN ON — a photo dropped into the
// media slot there would silently replace the composited banner with a flat one.
const BT_PHOTO_KINDS = new Set(["buy", "whale", "default"]);
const btMediaWord = (kind) => (BT_PHOTO_KINDS.has(kind) ? "GIF/Video/Foto" : "GIF/Video");

/** "✅ ada Foto sendiri" / "✅ ada GIF/video sendiri" / the empty-slot fallback.
 *  Naming the type matters: an operator who uploaded a JPG and reads "GIF/video"
 *  has no way to tell whether the right file is live. */
function btSlotState(kind, empty) {
  const m = bannerTpl.mediaOverride(kind);
  if (!m) return empty;
  return `✅ ada ${m.type === "photo" ? "Foto" : "GIF/video"} sendiri`;
}

function btHomeText() {
  const st = (k) => (bannerTpl.hasUploaded(k) ? "✅ punya sendiri" : bannerTpl.hasTemplate(k) ? "💎 bawaan" : "— belum ada");
  const on = bannerTpl.postingEnabled();
  const hasDefault = !!bannerTpl.mediaOverride("default");
  // What an EMPTY buy/whale slot actually does depends on whether a default is
  // uploaded — so the line says which, instead of always claiming "teks biasa".
  const fb = hasDefault ? "↩️ pakai GIF Default" : "— teks biasa";
  return (
    `🎨 <b>Gambar Banner Channel</b>\n\n` +
    `Setiap layanan punya gambar sendiri. Bot menempelkan <b>logo</b> token ` +
    `(atau <b>gambar client</b> untuk Banner Ads) ke dalam kotak di gambar itu, ` +
    `plus tulisan <b>$TICKER + nama</b> kalau diaktifkan.\n\n` +
    `Kirim banner: <b>${on ? "🟢 AKTIF" : "🔴 MATI — post channel cuma pakai logo token polos!"}</b>\n\n` +
    `📄 Listing: ${st("listing")}\n🔥 Trending: ${st("trending")}\n📢 Banner Ads: ${st("banner")}\n` +
    `⭐ GIF Default: ${hasDefault ? "✅ ada — dipakai kalau slot di bawah kosong" : "— belum ada"}\n` +
    `🟢 Buy Bot: ${btSlotState("buy", fb)}\n` +
    `🐋 Whale Alert: ${btSlotState("whale", fb)}\n\n` +
    `Pilih layanan yang mau diatur:`
  );
}
function btHomeKb() {
  const on = bannerTpl.postingEnabled();
  return Markup.inlineKeyboard([
    [Markup.button.callback(on ? "🟢 Kirim banner: AKTIF — tekan untuk matikan" : "🔴 Kirim banner: MATI — tekan untuk nyalakan", `bt_on:${on ? 0 : 1}`)],
    [Markup.button.callback(BT_KINDS.listing, "btk:listing"), Markup.button.callback(BT_KINDS.trending, "btk:trending")],
    [Markup.button.callback(BT_KINDS.banner, "btk:banner"), Markup.button.callback(BT_KINDS.pump, "btk:pump")],
    [Markup.button.callback(BT_KINDS.rankup, "btk:rankup"), Markup.button.callback(BT_KINDS.default, "btk:default")],
    [Markup.button.callback(BT_KINDS.buy, "btk:buy"), Markup.button.callback(BT_KINDS.whale, "btk:whale")],
    [Markup.button.callback("⬅ Kembali", "home")],
  ]);
}
function btKindText(kind) {
  const clip = bannerTpl.mediaOverride(kind);
  // Name what is actually in the slot. "GIF/Video: sudah ada" over an uploaded
  // JPG reads as the wrong file being live, which is the one thing this screen
  // exists to make certain of.
  const what = clip && clip.type === "photo" ? "Foto" : clip && clip.type === "video" ? "Video" : "GIF";
  const clipLine = clip
    ? `🎞 ${what}: <b>sudah ada — dipakai menggantikan gambar diam</b>\n`
    : `🎞 ${btMediaWord(kind)}: <b>— belum ada</b>\n`;
  if (!BT_ARTWORK_KINDS.has(kind)) {
    // media-only kinds (pump alert = text card; rank-up = auto dynamic banner). A clip
    // plays above / overrides the default.
    // What an EMPTY buy/whale slot falls back to — the ⭐ GIF Default when one is
    // uploaded, plain text otherwise. Stated live rather than in the abstract, so
    // the screen never promises artwork that isn't there.
    const dflt = bannerTpl.mediaOverride("default");
    const emptyMeans = dflt
      ? `Kalau slot ini kosong, alert otomatis pakai <b>⭐ GIF Default</b> (sudah ada).`
      : `Kalau slot ini kosong dan <b>⭐ GIF Default</b> juga kosong, alert dikirim sebagai <b>teks biasa</b> (tetap jalan normal).`;
    const note =
      kind === "rankup"
        ? `\nAlert naik peringkat memakai <b>banner otomatis</b> (medali peringkat + % kenaikan). GIF/video di sini <b>menggantikannya</b> dan diputar di atas setiap post naik peringkat.`
        : kind === "default"
          ? `\nGIF/video <b>cadangan</b> untuk alert grup: dipakai kalau slot 🟢 Buy Bot atau 🐋 Whale Alert <b>kosong</b>.\n\n` +
            `Cocok kalau Anda mau <b>satu GIF untuk semuanya</b> — upload sekali di sini, selesai. ` +
            `Mau whale kelihatan beda? Upload GIF sendiri di slot 🐋 Whale Alert, dan itu yang menang.\n\n` +
            `⚠️ 🟢 Buy Bot dan 🐋 Whale Alert <b>tidak pernah saling pinjam</b> GIF — keduanya cuma bisa jatuh ke slot ini.`
        : kind === "whale"
          ? `\nGIF/video KHUSUS alert 🐋 <b>WHALE WALLET</b> — pembelian dari dompet yang sudah pegang banyak token itu, dan alertnya <b>di-pin</b> di grup.\n\n` +
            `⚠️ Ini <b>terpisah</b> dari GIF 🟢 Buy Bot dan <b>tidak saling pinjam</b>: whale cuma pakai GIF ini, beli biasa cuma pakai GIF itu.\n\n` +
            emptyMeans
          : kind === "buy"
          ? `\nGIF/video ini dipakai <b>SEMUA grup</b> yang pakai buy bot — diputar di atas setiap alert pembelian, dengan detail transaksi jadi captionnya.\n\n` +
            emptyMeans
          : `\nUpload GIF atau MP4 pendek untuk diputar di atas setiap post ${BT_KINDS[kind].replace(/^\S+\s/, "")}. Detail token tetap di teks caption.`;
    return `🎨 <b>${BT_KINDS[kind]}</b>\n\n` + clipLine + note;
  }
  const s = bannerTpl.getSettings(kind);
  const src = bannerTpl.hasUploaded(kind) ? "✅ upload sendiri" : bannerTpl.hasTemplate(kind) ? "💎 bawaan" : "— belum ada (pakai banner otomatis)";
  const slot =
    s.slotShape === "rect"
      ? `kotak <b>${s.slotW}×${s.slotH}px</b> di (${s.logoX}, ${s.logoY})`
      : `logo <b>${s.logoSize}px</b> di (${s.logoX}, ${s.logoY})`;
  return (
    `🎨 <b>Gambar ${BT_KINDS[kind]}</b>\n\n` +
    `Gambar: ${src}\n` +
    clipLine +
    `Kotak gambar: ${slot}\n` +
    `Tulisan otomatis: <b>${s.showText ? "aktif" : "mati"}</b> (${s.tickerFontSize}px di ${s.tickerX}, ${s.tickerY})\n\n` +
    `Setelan terpisah untuk tiap layanan. Kalau GIF/video diisi, itu yang dipakai — bukan gambar diamnya.`
  );
}
function btKindKb(kind) {
  const clipRow = [Markup.button.callback(`🎞 Upload ${btMediaWord(kind)}`, `bt_med:${kind}`)];
  if (bannerTpl.mediaOverride(kind)) clipRow.push(Markup.button.callback(`🗑 Hapus ${btMediaWord(kind)}`, `bt_medrm:${kind}`));
  if (!BT_ARTWORK_KINDS.has(kind)) {
    const rows = [clipRow];
    if (bannerTpl.mediaOverride(kind)) {
      // Pump (a fill kind) auto-fills the clip, so it gets the full layout editor
      // + auto-text toggle just like listing/trending — its own ▲%/price/MCAP.
      if (BT_FILL_KINDS.has(kind)) {
        const textOn = bannerTpl.getSettings(kind).showText !== false;
        rows.push([Markup.button.callback("🎛 Atur tata letak — ukuran · posisi", `bxo:${kind}`)]);
        rows.push([Markup.button.callback(textOn ? "🔤 Tulisan otomatis: AKTIF — tekan untuk sembunyikan" : "🔤 Tulisan otomatis: MATI — logo saja", `bt_txt:${kind}`)]);
      }
      rows.push([Markup.button.callback("👁 Lihat hasil", `bt_prev:${kind}`)]);
    }
    // Pump alert trigger window (min%/max%) — configurable, applies to the alert
    // logic regardless of whether a clip is set.
    if (kind === "pump") {
      const { minPct, maxPct } = pumpConfig.get();
      rows.push([Markup.button.callback(`⚙ Alert window · ${minPct}%–${maxPct}%`, "pth")]);
    }
    // Same idea for whales: the bar that DECIDES the alert lives next to the
    // artwork that dresses it, so an operator tuning one can see the other.
    if (kind === "whale") {
      const w = whaleConfig.get();
      rows.push([Markup.button.callback(`⚙ Batas whale · $${w.walletUsd.toLocaleString("en-US")}`, "wth")]);
    }
    rows.push([Markup.button.callback("⬅ Menu gambar", "bt")]);
    return Markup.inlineKeyboard(rows);
  }
  const textOn = bannerTpl.getSettings(kind).showText !== false;
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬆ Upload gambar", `bt_up:${kind}`)],
    clipRow,
    [Markup.button.callback("🎛 Atur tata letak — ukuran · posisi", `bxo:${kind}`)],
    [Markup.button.callback(textOn ? "🔤 Tulisan otomatis: AKTIF — tekan untuk sembunyikan" : "🔤 Tulisan otomatis: MATI — logo saja", `bt_txt:${kind}`)],
    [Markup.button.callback("👁 Lihat hasil", `bt_prev:${kind}`), Markup.button.callback("🗑 Hapus gambar", `bt_rm:${kind}`)],
    [Markup.button.callback("⬅ Menu gambar", "bt")],
  ]);
}

// ── Pump alert window editor (min% / max%) ──────────────────────────────────
// A token fires a pump alert only when it's up between min% and max% from its
// baseline. Adjustable here so the operator tunes sensitivity without a redeploy.
function pthText() {
  const { minPct, maxPct } = pumpConfig.get();
  const mid = Math.round((minPct + maxPct) / 2);
  return (
    `⚙ <b>Pump alert window</b>\n\n` +
    `A token fires a 📈 <b>Pump alert</b> when it's up between <b>${minPct}%</b> and <b>${maxPct}%</b> ` +
    `from its baseline (the first price the bot saw ≈ listing time).\n\n` +
    `• Below <b>${minPct}%</b> → too small, no alert\n` +
    `• Above <b>${maxPct}%</b> → almost always bad market data, skipped\n\n` +
    `Tap to adjust, or ⌨ type both exactly. Applies on the next check (~no restart).\n\n` +
    `👁 <b>Preview</b> the alert at <b>${minPct}%</b> (min) · <b>${mid}%</b> · <b>${maxPct}%</b> (max), or a custom %.`
  );
}
function pthKb() {
  const cb = Markup.button.callback;
  const { minPct, maxPct } = pumpConfig.get();
  const mid = Math.round((minPct + maxPct) / 2);
  return Markup.inlineKeyboard([
    [cb("Min ➖25", "pwmin:-25"), cb("➖5", "pwmin:-5"), cb("➕5", "pwmin:5"), cb("➕25", "pwmin:25")],
    [cb("Max ➖250", "pwmax:-250"), cb("➖50", "pwmax:-50"), cb("➕50", "pwmax:50"), cb("➕250", "pwmax:250")],
    [cb("⌨ Type min,max", "pwset")],
    [cb(`👁 ${minPct}%`, `pwpv:${minPct}`), cb(`👁 ${mid}%`, `pwpv:${mid}`), cb(`👁 ${maxPct}%`, `pwpv:${maxPct}`)],
    [cb("👁 Preview @ custom %", "pwpvc")],
    [cb(`↩️ Reset (${pumpConfig.DEFAULT_MIN}–${pumpConfig.DEFAULT_MAX})`, "pwrst"), cb("⬅ Back", "btk:pump")],
  ]);
}

// ── Whale WALLET bar editor ─────────────────────────────────────────────────
// A buy is a 🐋 WHALE WALLET alert when the BUYER ALREADY HOLDS at least
// `walletUsd` of that token — not when the buy itself is big. Tunable here so
// the operator can move the bar without a redeploy; a project that ran
// /setwhale in its own group still overrides it there.
const usdLabel = (n) => "$" + Number(n).toLocaleString("en-US");
/** "5–8", or just "5" when the operator pinned both ends to one number. */
const tgtRange = (c) => (c.perChainMax > c.perChainMin ? `${c.perChainMin}–${c.perChainMax}` : `${c.perChainMin}`);
/** The middle of the range — for anything that estimates throughput, where the
 *  two ends would give two different answers to one question. */
const avgTarget = (c) => (c.perChainMin + c.perChainMax) / 2;
/** How many cycles the market filler needs to close a full-width gap. */
const fillCycles = (c) => Math.max(1, Math.ceil(c.perChainMax / Math.max(1, c.fillMaxPerCycle)));
function wthText() {
  const w = whaleConfig.get();
  const d = whaleConfig.defaults();
  return (
    `⚙ <b>Batas Whale Wallet</b>\n\n` +
    `Alert 🐋 <b>WHALE WALLET</b> keluar kalau pembelinya <b>sudah memegang</b> minimal ` +
    `<b>${usdLabel(w.walletUsd)}</b> token itu — bukan karena belinya besar. Alertnya <b>di-pin</b> di grup.\n\n` +
    `• 💰 <b>Batas saldo dompet:</b> ${usdLabel(w.walletUsd)}\n` +
    `• 🔎 <b>Beli minimal dicek:</b> ${usdLabel(w.minBuyUsd)} — di bawah ini saldonya tidak dicek sama sekali (hemat panggilan RPC)\n` +
    `• 🐋 <b>Status:</b> ${w.enabled ? "🟢 aktif" : "🔴 mati"}\n\n` +
    `⚠️ Status di atas mengatur <b>pembacaan saldo dompet</b> — jadi kalau dimatikan, baris ` +
    `💼 <b>Position</b> di alert pembelian biasa <b>ikut hilang</b>. Satu pembacaan on-chain memberi dua-duanya, jadi satu saklar.\n\n` +
    `ℹ️ Ini nilai <b>global</b>. Grup yang menjalankan <code>/setwhale 50000</code> sendiri tetap pakai angkanya sendiri.\n\n` +
    `Berlaku di alert berikutnya — tanpa restart. Bawaan: ${usdLabel(d.walletUsd)}.`
  );
}
function wthKb() {
  const cb = Markup.button.callback;
  const w = whaleConfig.get();
  const d = whaleConfig.defaults();
  return Markup.inlineKeyboard([
    [cb("Saldo ➖25K", "wwal:-25000"), cb("➖5K", "wwal:-5000"), cb("➕5K", "wwal:5000"), cb("➕25K", "wwal:25000")],
    [cb("Min beli ➖100", "wmin:-100"), cb("➖25", "wmin:-25"), cb("➕25", "wmin:25"), cb("➕100", "wmin:100")],
    [cb("⌨ Ketik batas saldo", "wwset")],
    [cb(w.enabled ? "🐋 Whale alert: AKTIF — tekan untuk matikan" : "🔴 Whale alert: MATI — tekan untuk nyalakan", `wwon:${w.enabled ? 0 : 1}`)],
    [cb(`↩️ Reset (${usdLabel(d.walletUsd)})`, "wwrst"), cb("⬅ Kembali", "btk:whale")],
  ]);
}

// ── Trending board editor (pinned @dexvratrending message look) ─────────────
// The chain logo emoji + rank badges 1–10 shown on the live trending board.
// Editor marker: ✅ = the operator has set a custom emoji here, ▫️ = still the
// built-in default (answers "which have I already given a premium emoji?").
const TB_SET = "✅";
const TB_DEFAULT = "▫️";
// Turn the admin's emoji message into a storable fragment. A PREMIUM (custom)
// emoji arrives as a fallback char + a custom_emoji entity → store it as markup
// "[fallback](emoji/ID)" so the board renders it premium (GramJS). A plain emoji
// → just the first token. UTF-16 offsets (what Telegram gives) index JS strings.
function emojiFragment(msg) {
  const raw = String((msg && msg.text) || "");
  const ce = ((msg && msg.entities) || []).find((e) => e.type === "custom_emoji");
  if (ce && ce.custom_emoji_id) {
    // The fallback char is what non-premium viewers see; strip markup chars from
    // it so it can't break out of the [char](emoji/id) fragment it goes into.
    const fallback = raw.substring(ce.offset, ce.offset + ce.length).replace(/[[\]()`*]/g, "").trim();
    if (fallback) return `[${fallback}](emoji/${ce.custom_emoji_id})`;
  }
  // Plain emoji: first token only, markup characters removed — this value is
  // spliced straight into the channel post's markup.
  return (raw.trim().split(/\s+/)[0] || "").replace(/[[\]()`*]/g, "");
}
const TB_PREMIUM = "💎"; // YOUR premium emoji — animated, and yours
const TB_PREMIUM_STOCK = "🔹"; // premium, but the one that ships built in

// Per-slot marker, and it must answer TWO questions at once: will this slot
// animate, and is it MINE?
//
// It used to answer only the first — `premium ? 💎 : custom ? ✅ : ▫️` — so a
// slot carrying the built-in premium badge and a slot carrying the operator's
// own premium badge both rendered 💎, identically. Ranks 1–9 and the major
// chains ship premium, so the panel showed a wall of 💎 whether or not a single
// setting had been saved, and "sudah di set tapi bot tidak memakai" was
// unanswerable from the one screen built to answer it. Same defect as the green
// fonts:check over a broken banner: the reassuring reading was available and it
// was not a statement about the thing being asked.
const tbMark = (premium, custom) =>
  premium ? (custom ? TB_PREMIUM : TB_PREMIUM_STOCK) : custom ? TB_SET : TB_DEFAULT;
const TB_LEGEND =
  `<i>${TB_PREMIUM} = YOUR premium emoji (animated) · ${TB_PREMIUM_STOCK} = built-in premium · ` +
  `${TB_SET} = your plain emoji · ${TB_DEFAULT} = built-in default</i>`;
function tbText() {
  const n = trendingBoard.RANK_SLOTS;
  const badges = trendingBoard
    .rankEmojis()
    .map((e, i) => `${tbMark(trendingBoard.isRankPremium(i + 1), trendingBoard.isRankCustom(i + 1))}${i + 1} ${trendingBoard.displayEmoji(e)}`)
    .join("   ");
  // Coverage = how many board slots carry a premium emoji. Ranks 1–9 and the
  // major chains ship premium BUILT-IN, so this is high with no setup; the
  // remaining slots are ones with no verified id (rank 10, newer L2s). Shown in
  // BOTH states — "how much is premium" and "is it actually rendering" are
  // different questions and the operator needs both answers at once.
  const cov = trendingBoard.premiumCoverage();
  const covLine = `${cov.premium}/${cov.total} slots premium (ranks ${cov.ranksPremium}/${cov.ranksTotal} · chains ${cov.chainsPremium}/${cov.chainsTotal})`;
  const premLine = gramjs.available()
    ? `💎 Premium emoji: <b>🟢 account connected</b> — ${covLine}.`
    : `💎 Premium emoji: <b>🔴 NOT rendering</b> — ${covLine}, but the premium account isn't connected so the board posts plain fallbacks. Run <code>node scripts/gramjs-login.js</code>, then tap <b>💎 Premium status</b>.`;
  return (
    `🔥 <b>Trending board</b>\n\n` +
    `The pinned <b>Dexvra Trending</b> board in the channel: a live, tier-ranked list per chain ` +
    `(top-tier buyers first), up to <b>${n}</b> tokens each, auto-updated.\n\n` +
    `<b>Title emoji:</b> ${tbMark(trendingBoard.isTitlePremium(), trendingBoard.isTitleCustom())} ` +
    `${trendingBoard.displayEmoji(trendingBoard.titleEmoji())} <i>Dexvra Trending — live featured slots</i>\n\n` +
    `<b>New-entry marker:</b> ${tbMark(trendingBoard.isNewPremium(), trendingBoard.isNewCustom())} ` +
    `${trendingBoard.displayEmoji(trendingBoard.newEmoji())} — shown beside any token whose trending slot ` +
    `started in the last <b>${trendingBoard.newHours()}h</b>, with a one-line legend under the board.\n\n` +
    `<b>Rank badges 1–${n}:</b>\n${badges}\n\n` +
    `${TB_LEGEND}\n` +
    `${premLine}\n` +
    `<i>Note: premium emoji only animate for Telegram Premium viewers — everyone else sees the fallback emoji. That's normal.</i>\n\n` +
    `Tap a rank to change its badge, or <b>🔗 Chain logos</b> to set each chain's emoji. ` +
    `Send a <b>premium</b> emoji to make that slot premium.\n\n` +
    `The board republishes on its own every few minutes; <b>🔄 Refresh board now</b> does it immediately ` +
    `and reports whether your emoji actually went out animated or fell back to plain.`
  );
}
function tbKb() {
  const cb = Markup.button.callback;
  const badges = trendingBoard.rankEmojis();
  const rankBtns = badges.map((e, i) => {
    const mark = tbMark(trendingBoard.isRankPremium(i + 1), trendingBoard.isRankCustom(i + 1));
    return cb(`${mark} ${i + 1} ${trendingBoard.displayEmoji(e)}`, `tbr:${i + 1}`);
  });
  // Five per row so 1–10 fits two clean rows (grows automatically with RANK_SLOTS).
  const rows = [];
  for (let i = 0; i < rankBtns.length; i += 5) rows.push(rankBtns.slice(i, i + 5));
  rows.push([
    cb(
      `${tbMark(trendingBoard.isTitlePremium(), trendingBoard.isTitleCustom())} Title emoji ${trendingBoard.displayEmoji(trendingBoard.titleEmoji())}`,
      "tbt",
    ),
  ]);
  rows.push([
    cb(
      `${tbMark(trendingBoard.isNewPremium(), trendingBoard.isNewCustom())} New marker ${trendingBoard.displayEmoji(trendingBoard.newEmoji())}`,
      "tbn",
    ),
    cb(`⏱ ${trendingBoard.newHours()}h window`, "tbnh"),
  ]);
  rows.push([cb("🔗 Chain logos", "tbc")]);
  rows.push([cb("🔄 Refresh board now", "tbref"), cb("💎 Premium status", "tbdiag")]);
  rows.push([cb("↩️ Restore premium defaults", "tbrst"), cb("⬅ Back", "home")]);
  return Markup.inlineKeyboard(rows);
}
// What the MAIN bot reported after a forced board refresh. The whole point is
// that "the board went out animated" and "the board went out plain" are
// indistinguishable in the channel to anyone without Telegram Premium — so an
// operator who just set a badge has to be TOLD which one happened.
function tbRefreshText(job) {
  const r = (job && job.results && job.results[0] && job.results[0].board) || null;
  if (!r) return `⚠️ <b>No answer from the main bot</b>\n\n<code>${escapeHtml((job && job.error) || "unknown")}</code>`;
  const head = `🔄 <b>Trending board</b>\n`;
  if (r.how === "failed") return `${head}\n❌ The refresh FAILED.\n<code>${escapeHtml(r.why || "")}</code>`;
  if (r.how === "empty")
    return `${head}\nℹ️ No token is trending right now, so there is no board to publish. Sell a trending slot (or force one) and refresh again.`;
  const where = r.messageId ? ` → <code>#${r.messageId}</code>` : "";
  if (r.mode === "premium")
    return (
      `${head}\n✅ <b>Published with your premium emoji</b> — ${r.premium} custom emoji went out ` +
      `animated via the premium account${where}.\n\n` +
      (r.how === "unchanged"
        ? `<i>Telegram reported the board as already identical — your emoji were already live.</i>`
        : `<i>Open the channel: the pinned board carries them now.</i>`) +
      `\n\n<i>Only Telegram Premium viewers see them animated — everyone else sees the fallback emoji. That is normal.</i>`
    );
  // PLAIN is the answer this button exists for.
  return (
    `${head}\n⚠️ <b>Published, but PLAIN</b>${where} — the custom emoji did NOT go out.\n\n` +
    `Reason: <b>${escapeHtml(r.why || "unknown")}</b>\n\n` +
    `Your saved emoji are fine; the problem is the transport. Tap <b>💎 Premium status</b> for the exact fix.`
  );
}
function tbChainsText() {
  return (
    `🔗 <b>Chain logos</b>\n\n` +
    `The emoji shown before each chain's header on the trending board ` +
    `(e.g. <code>🔶 BSC - Trending</code>).\n\n` +
    `${TB_LEGEND}\n\n` +
    `Solana / BSC / Ethereum / Base / Tron / Plasma / Sui ship a premium logo built in. ` +
    `Tap a chain, then send the emoji you want to change it. ⬅ Back to the board.`
  );
}
function tbChainsKb() {
  const cb = Markup.button.callback;
  const chains = trendingBoard.chainList();
  const rows = [];
  for (let i = 0; i < chains.length; i += 2) {
    rows.push(
      chains
        .slice(i, i + 2)
        .map((c) => cb(`${tbMark(c.premium, c.custom)} ${trendingBoard.displayEmoji(c.logo)} ${c.label}`, `tbcl:${c.id}`)),
    );
  }
  rows.push([cb("⬅ Back", "tb")]);
  return Markup.inlineKeyboard(rows);
}

// ── Premium-emoji readiness report ──────────────────────────────────────────
// "The board still shows plain emoji" has several causes that are identical from
// the channel side: GramJS off, no session, revoked session, the account isn't
// Telegram Premium, or Telegram refused the emoji. This names the actual one.
//
// Config is checked locally; live facts come from what the MAIN bot recorded on
// its last connect/post (gramjs.diagnose() never opens its own MTProto client —
// a second client on the same session would risk revoking the login).
const AGO = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}min ago`;
  return `${Math.round(s / 3600)}h ago`;
};
async function premiumReportText() {
  const cov = trendingBoard.premiumCoverage();
  const d = gramjs.diagnose();
  const L = [`💎 <b>Premium emoji status</b>\n`];
  const fail = (why, fix) => L.push(`\n❌ <b>${why}</b>\n${fix}`);

  L.push(
    `Board slots premium: <b>${cov.premium}/${cov.total}</b> (ranks ${cov.ranksPremium}/${cov.ranksTotal} · chains ${cov.chainsPremium}/${cov.chainsTotal})`,
  );

  const last = d.last;
  if (!d.enabled) fail("GramJS is disabled", "Set <code>GRAMJS_ENABLED=1</code> in <code>.env</code> and restart both bots.");
  else if (!d.apiCreds)
    fail(
      "API_ID / API_HASH missing",
      'Create them at <a href="https://my.telegram.org/apps">my.telegram.org/apps</a> with the premium account, put them in <code>.env</code>, restart.',
    );
  else if (!d.libInstalled) fail("The <code>telegram</code> package isn't installed", "Run <code>npm install</code> in the bot directory, then restart.");
  else if (!d.sessionPresent)
    fail(
      "No premium-account session",
      `Run <code>node scripts/gramjs-login.js</code> on the server and log in with the <b>Telegram Premium</b> account, then <code>pm2 restart dexvra-bot</code>.`,
    );
  else if (!last)
    L.push(
      `\n⏳ <b>Session present, not used yet.</b>\nThe main bot reports here the first time it posts a channel message (≤5 min). Re-check then.`,
    );
  else if (last.ok === false)
    fail(
      `Last connection FAILED (${AGO(last.at)})`,
      `<code>${escapeHtml(last.error || "unknown error")}</code>\nIf it mentions unauthorized/revoked, re-run <code>node scripts/gramjs-login.js</code> and restart the bot.`,
    );
  else {
    L.push(`\n✅ Connected as <b>${escapeHtml(last.account || "?")}</b> <i>(${AGO(last.at)})</i>`);
    if (last.postError) {
      // A connected, Premium account still posts nothing if it can't WRITE to
      // the channel. Being an admin there is a property of this USER account —
      // the bot already being an admin doesn't help it.
      fail(
        "The account could not post to a channel",
        `<code>${escapeHtml(last.postError)}</code>\nOpen that channel → <b>Administrators</b> → add <b>${escapeHtml(last.account || "the account")}</b> with <b>Post Messages</b> (and Delete/Pin so it can maintain the board). Until then the board falls back to the Bot API and looks unchanged.`,
      );
    }
    if (last.emojiRefused) {
      fail(
        "Telegram REFUSED the custom emoji",
        `<code>${escapeHtml(last.emojiError || "")}</code>\nAlmost always: the account is not Telegram <b>Premium</b>. The board keeps posting with the plain fallback and retries automatically every 30 min.`,
      );
    } else if (last.premium === false) {
      fail(
        "That account does NOT have Telegram Premium",
        "Telegram only lets <b>Premium</b> accounts send custom emoji — without it every badge posts as its plain fallback. Buy Premium for this account, or log in with one that has it (<code>node scripts/gramjs-login.js</code>).",
      );
    } else if (last.premium) {
      L.push(`💎 Telegram Premium: <b>yes</b> — custom emoji render animated.`);
      if (!last.postError) L.push(`📢 Last channel post: <b>OK</b>.`);
    }
  }
  if (d.cooldownSec) L.push(`\n⏳ Post cooldown active in this process: ${d.cooldownSec}s (after a recent failure).`);
  L.push(`\n<i>Non-premium viewers always see the plain fallback emoji — that is Telegram's behaviour, not a bug.</i>`);
  return L.join("\n");
}

// ── Force post ──────────────────────────────────────────────────────────────
// Publish any post type on demand, so a template or a freshly uploaded clip can
// be SEEN in its real channel without waiting for a paid order / rank change /
// pump. It runs the production code path, so this posts PUBLICLY — always
// behind a confirm that names the exact channels.
function fpText() {
  return (
    `🚀 <b>Force post to channel</b>\n\n` +
    `Publishes a <b>real</b> post of the type you pick, right now, into its normal channel — ` +
    `same template, same banner/clip, same layout as the live event would produce.\n\n` +
    `Use it to check a template or a new clip end-to-end instead of waiting for an order, ` +
    `a rank change or a pump.\n\n` +
    `It builds the post from your <b>newest approved listing</b> (real logo, price and links).\n\n` +
    `⚠️ <b>This is a public post</b> — subscribers see it. Delete it afterwards if it was only a test.`
  );
}
function fpKb() {
  const cb = Markup.button.callback;
  const rows = forcePost.kindIds().map((id) => [cb(forcePost.labelOf(id), `fpk:${id}`)]);
  rows.push([cb("⬅ Back", "home")]);
  return Markup.inlineKeyboard(rows);
}
function fpConfirmText(kind) {
  const chans = forcePost.channelsOf(kind);
  return (
    `🚀 <b>Post ${escapeHtml(forcePost.labelOf(kind))} now?</b>\n\n` +
    `It will be published to:\n${chans.map((c) => `• <code>${escapeHtml(c)}</code>`).join("\n")}\n\n` +
    `⚠️ Real, public post — subscribers will see it.`
  );
}
// Wait for the main bot to report back (it polls every ~3s). Bounded — if it
// never answers the operator gets a "still working" card with a re-check button
// instead of a spinner that lies.
async function waitForJob(id, { tries = 12, gapMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, gapMs));
    const job = fpStore.get(id);
    if (job && job.status !== "pending" && job.status !== "running") return job;
  }
  return fpStore.get(id);
}
function fpResultText(kind, job) {
  const label = escapeHtml(forcePost.labelOf(kind));
  if (job.status === "expired") {
    return `⚠️ <b>${label} expired</b>\n\nThe main bot never picked it up. Check <code>pm2 ls</code> — <code>dexvra-bot</code> must be running.`;
  }
  if (job.error) return `⚠️ <b>${label} failed</b>\n\n<code>${escapeHtml(job.error)}</code>`;
  const lines = (job.results || []).map((r) =>
    r.ok
      ? `✅ <a href="${r.url}">${escapeHtml(r.channel)} #${r.messageId}</a>`
      : `❌ <code>${escapeHtml(r.channel)}</code> — not posted (see <code>pm2 logs dexvra-bot</code>)`,
  );
  return (
    `🚀 <b>${label}</b>\n\n${lines.join("\n") || "No channel accepted the post."}\n\n` +
    `<i>Tap a link to open it. Delete it in the channel if it was only a test.</i>`
  );
}
function fpResultKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Post another", "fp"), Markup.button.callback("⬅ Menu", "home")],
  ]);
}

// ── Auto-Trending editor (auto-fill trending slots with random duration/timing) ─
// The panel used to be six steppers crammed onto two rows, which Telegram
// truncated to "🕐 Mi…" and "Max 1…" — settings nobody could read, let alone
// change with confidence. And it showed the config without ever showing the
// BOARD, so "why is Robinhood still empty" had no answer on screen.
//
// One setting per row (three buttons fit; six do not), and a live per-chain
// readout above them.

/** The board, per chain, as the operator needs to read it: how many are
 *  featured against the target, and — when it is short — whether anything is
 *  left to promote. A chain with no listings can never be filled, and that is a
 *  different problem from a chain the loop has not reached yet. */
function atBoardLines(c, counts = _atCounts) {
  const rows = [];
  for (const id of c.chains) {
    const meta = trendingBoard.chainList().find((x) => x.id === id);
    const label = meta ? meta.label : id;
    const glyph = meta ? trendingBoard.displayEmoji(meta.logo) : "•";
    const n = (counts[id] && counts[id].featured) || 0;
    const spare = (counts[id] && counts[id].eligible) || 0;
    let mark = "✅";
    let note = "";
    if (n < c.perChainMin) {
      if (spare > 0) {
        mark = "⏳";
        note = ` · ${spare} ready to promote`;
      } else {
        mark = "🔴";
        note = ` · <i>no listings left on this chain</i>`;
      }
    }
    // "5/5–8", not "5/5": the target is a RANGE rolled per chain, and printing
    // one end of it would make a chain sitting at 7 look over target.
    rows.push(`${mark} ${glyph} <b>${label}</b> — ${n}/${tgtRange(c)}${note}`);
  }
  return rows.join("\n");
}

/** Can the current settings actually post everything the board promotes? The
 *  policy is "every trending token gets its post", and two numbers can quietly
 *  make that impossible — a daily cap below the churn, or a gap so wide the day
 *  runs out. Silence there looks exactly like a broken announcer. */
function atThroughputNote(c) {
  const churn = Math.round((avgTarget(c) * c.chains.length * 24) / ((c.minHours + c.maxHours) / 2));
  const byGap = Math.floor((24 * 60) / Math.max(1, c.announceGapMin));
  const ceiling = Math.min(c.announcePerDay, byGap);
  if (ceiling >= churn) return `\n<i>≈${churn} promotions a day, and up to ${ceiling} can post — every one gets through.</i>`;
  const blame = c.announcePerDay < byGap ? `the <b>${c.announcePerDay}/day</b> cap` : `the <b>${c.announceGapMin} min</b> gap`;
  return (
    `\n⚠️ <i>≈${churn} promotions a day but only <b>${ceiling}</b> can post — ${blame} is the limit. ` +
    `The rest wait in the queue and their slots expire first. Raise it below.</i>`
  );
}

/** A floor's label. `0` is OFF, and it must READ as off: `$0` on a button
 *  labelled "min cap" says the floor is set to nothing, which is the opposite
 *  of what it means. The `—` the board uses for an absent number would be worse
 *  still; this row has a state, and the state is that the filter is not on. */
const floorLabel = (n) => (Number(n) > 0 ? fmtCap(Number(n)) : "OFF");
/** The same value on a BUTTON, where "+" means "or more". It has to be inside
 *  this helper rather than appended at the call site: `cap OFF+` is what that
 *  produces the moment somebody switches a floor off, and a row that reads as
 *  nonsense on its off state is a row nobody trusts in either state. */
const floorBtn = (n) => (Number(n) > 0 ? `${fmtCap(Number(n))}+` : "OFF");

/** The one sentence describing what the floors do, so `atText` and the typed
 *  reply cannot drift into two accounts of the same rule. */
function atFloorsLine(c) {
  if (!(c.minMcapUsd > 0) && !(c.minVol24hUsd > 0)) {
    return (
      `🏦 <b>Quality floors: OFF</b> — every listed token is promotable, including ones with no ` +
      `trading at all. That is what put <code>VOL $0.05</code> on the board.`
    );
  }
  // The panel spells the floors in its own, fuller voice ("market cap ≥ …"),
  // but it applies the SAME rule the engine does: a floor of 0 is not named,
  // because it refused nothing. `autoTrend.floorsPhrase` is the terse form the
  // log lines, the alert, the filler and the check all share.
  const parts = [];
  if (c.minMcapUsd > 0) parts.push(`market cap ≥ <b>${fmtCap(c.minMcapUsd)}</b>`);
  if (c.minVol24hUsd > 0) parts.push(`24h volume ≥ <b>${fmtCap(c.minVol24hUsd)}</b>`);
  // ⚠️ WHAT HAPPENS NEXT DEPENDS ON A TOGGLE FOUR PARAGRAPHS DOWN. The first
  // cut promised "goes to 🧲 Fill from market" unconditionally, so with the
  // filler OFF one message said the gap would be filled and then, lower down,
  // that a chain with no spare listings "stays short until somebody lists
  // tokens on it". A panel contradicting itself in two places is the buy card's
  // two ideas of "whale", on a screen an operator tunes from.
  const next = c.fillFromMarket
    ? `A chain whose spares all fail this goes to 🧲 Fill from market instead of publishing a dead row.`
    : `⚠️ With 🧲 Fill from market OFF, a chain whose spares all fail this publishes a SHORT board — nothing replaces them.`;
  return (
    `🏦 <b>Quality floors</b> — a free slot needs ${parts.join(" and ")}. ` +
    `Applies to every slot this bot books, ⚡ Run now included; paid slots are never filtered. ` +
    `<i>${next} Set either to 0 to switch it off.</i>`
  );
}

function atText() {
  const c = autoTrend.get();
  const short = c.chains.filter((id) => ((_atCounts[id] && _atCounts[id].featured) || 0) < c.perChainMin);
  const blocked = short.filter((id) => !((_atCounts[id] && _atCounts[id].eligible) || 0));
  return (
    `🤖 <b>Auto Trending</b> — ${c.enabled ? "🟢 ON" : "🔴 OFF"}\n\n` +
    `Fills the Trending board between paid slots with the <b>top gainers</b> — the biggest 24h ` +
    `movers among listed tokens, any package — for a random ${c.minHours}–${c.maxHours}h, every ` +
    `${c.minGapMin}–${c.maxGapMin} min. Above the per-chain minimum only tokens up <b>${c.minGainPct}%</b> ` +
    `or more are picked; <b>below the minimum the best available go on even if they are down</b>, because a ` +
    `board short of the number you set is worse than a flat token — never one down more than 15%. ` +
    `Paid tiers still sort above auto ones.\n\n` +
    atFloorsLine(c) +
    `\n\n` +
    `📊 <b>Board right now</b> — target <b>${tgtRange(c)}</b> per chain, rolled at random\n` +
    atBoardLines(c) +
    `\n\n` +
    (short.length === 0
      ? `✅ <i>Every chain is at target. Nothing to do until a slot expires.</i>`
      : blocked.length
        ? c.fillFromMarket
          ? `🧲 <i>${blocked.length} chain(s) have no spare listings — the next cycle lists that chain's ` +
            `biggest tokens (market cap ≥ ${fmtCap(c.fillMinMcap)}) to fill them, ` +
            `${c.fillMaxPerCycle} per chain <b>each cycle</b> until it is at target.</i>`
          : `ℹ️ <i>${blocked.length} chain(s) cannot be filled — they have no spare listings, and ` +
            `<b>🧲 Fill from market</b> is off. Turn it on, or list tokens there yourself.</i>`
        : `⏳ <i>${short.length} chain(s) below target; the next cycle tops them up. ` +
          `Tap a chain below to do it now.</i>`) +
    `\n\n` +
    `📣 Announce in channel: <b>${c.announce ? "🟢 ON" : "🔴 OFF"}</b>` +
    (c.announce && _atPending > 0 ? ` · <b>${_atPending}</b> waiting to post` : "") +
    (c.announce ? ` — every promotion is posted, one per <b>${c.announceGapMin} min</b>` : "") +
    (c.announce ? atThroughputNote(c) : "") +
    `\n<i>Auto posts use the SAME card as a paid Trending purchase — never pinned, never @dexvraio.</i>\n\n` +
    `🧲 <b>Fill from market:</b> <b>${c.fillFromMarket ? "🟢 ON" : "🔴 OFF"}</b>` +
    (c.fillFromMarket
      ? ` — when a chain runs out of listings to promote, its biggest tokens (cap ≥ ` +
        `${fmtCap(c.fillMinMcap)}, liquidity ≥ ${fmtCap(c.fillMinLiq)}) are listed automatically.\n` +
        // ⚠️ A RATE, NOT A CAP, and the first thing it was asked was "so max 3
        // projects per chain?". The target above is what the board holds; this
        // is only how fast the gap is closed, so it is stated as a speed and
        // then worked out loud against the live target.
        `<i>🧲 <b>${c.fillMaxPerCycle} new listings per chain per cycle</b> — a speed, not a limit on the board. ` +
        `The board still holds <b>${tgtRange(c)}</b> per chain (🎯 above); a chain that is ${c.perChainMax} short ` +
        `reaches it in ${fillCycles(c)} cycle(s), ` +
        `i.e. about ${c.minGapMin}–${fillCycles(c) * c.maxGapMin} min.</i>`
      : ` — a chain with no spare listings stays short until somebody lists tokens on it.`) +
    `\n\n` +
    `⚡ <b>Run now</b> — tap a chain to place its best 24h mover there immediately, even while this is off.`
  );
}

function atKb() {
  const cb = Markup.button.callback;
  const c = autoTrend.get();
  // THREE buttons per row. Six fit in the code and not on a phone: the label is
  // the first thing Telegram drops, so the row that needs reading most is the
  // one that becomes "Mi…".
  return Markup.inlineKeyboard([
    [cb(c.enabled ? "⏸ Disable" : "▶️ Enable", "aten")],
    [cb("➖", "attgt:-1"), cb(`🎯 min ${c.perChainMin}/chain`, "atnop"), cb("➕", "attgt:1")],
    [cb("➖", "attgx:-1"), cb(`🎯 max ${c.perChainMax}/chain`, "atnop"), cb("➕", "attgx:1")],
    [cb("➖", "atgain:-5"), cb(`📈 min +${c.minGainPct}% 24h`, "atnop"), cb("➕", "atgain:5")],
    // ✏️ TYPED, not stepped, and the reason is arithmetic. A market-cap floor
    // moves in millions and a volume floor in thousands, so one step size fits
    // neither: at ±$1M a $10K volume floor is unreachable, and at ±$10K a $5M
    // cap floor is five hundred taps. "angkanya bisa di ketik biar cpt" was
    // reported about a row that stepped in ±$100,000; these two are worse.
    // The ➖/➕ are kept for a nudge and sized per row.
    [cb("➖", "atmcap:-50000"), cb(`🏦 cap ${floorBtn(c.minMcapUsd)}`, "atset:minMcapUsd"), cb("➕", "atmcap:50000")],
    [cb("➖", "atvol:-5000"), cb(`📊 vol ${floorBtn(c.minVol24hUsd)}`, "atset:minVol24hUsd"), cb("➕", "atvol:5000")],
    [cb(`🧲 Fill from market: ${c.fillFromMarket ? "ON" : "OFF"}`, "atfill")],
    ...(c.fillFromMarket
      ? [
          [cb("➖", "atfmc:-1000000"), cb(`🏦 big = ${fmtCap(c.fillMinMcap)}+`, "atnop"), cb("➕", "atfmc:1000000")],
          [cb("➖", "atfmax:-1"), cb(`🧲 ${c.fillMaxPerCycle}/chain/cycle`, "atnop"), cb("➕", "atfmax:1")],
        ]
      : []),
    [cb("➖", "athmin:-1"), cb(`⏱ Min ${c.minHours}h`, "atnop"), cb("➕", "athmin:1")],
    [cb("➖", "athmax:-1"), cb(`⏱ Max ${c.maxHours}h`, "atnop"), cb("➕", "athmax:1")],
    [cb("➖", "atgmin:-10"), cb(`🔁 Every ${c.minGapMin}m`, "atnop"), cb("➕", "atgmin:10")],
    [cb("➖", "atgmax:-10"), cb(`🔁 to ${c.maxGapMin}m`, "atnop"), cb("➕", "atgmax:10")],
    [cb(`📣 Announce: ${c.announce ? "ON" : "OFF"}`, "atann")],
    ...(c.announce
      ? [
          [cb("➖", "atapd:-10"), cb(`📣 max ${c.announcePerDay}/day`, "atnop"), cb("➕", "atapd:10")],
          [cb("➖", "atagap:-5"), cb(`📣 1 per ${c.announceGapMin}m`, "atnop"), cb("➕", "atagap:5")],
        ]
      : []),
    ...atChainRows(cb),
    // The ON/OFF row, under ⚡ Run now because the two answer different
    // questions about the same chain: "put one there now" and "should this
    // network be on the board at all".
    [cb("🌐 Chains on the board — tap to switch", "atnop")],
    ...atChainToggleRows(cb),
    [cb("🔄 Refresh", "atref"), cb("↩️ Reset", "atrst"), cb("⬅ Back", "home")],
  ]);
}

// ── Auto-Listing editor (free listings for projects crossing the threshold) ──
const usd = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
function alText() {
  const c = autoLister.get();
  const s = autoLister.stats();
  const recent = autoLister
    .history(5)
    .map((h) => `• <b>${h.sym || h.key}</b> at ${usd(h.mcap)}`)
    .join("\n");
  return (
    `🆓 <b>Auto Listing</b>\n\n` +
    `Watches DexScreener across every supported chain and lists a project for ` +
    `<b>free</b> once it climbs past its own trigger. Each token's trigger is a ` +
    `different number inside the band below — so listings land at ${usd(1_100_000)}, ` +
    `${usd(1_370_000)}, ${usd(1_420_000)}… instead of every single one at a ` +
    `suspiciously round ${usd(1_000_000)}.\n\n` +
    `Status: <b>${c.enabled ? "🟢 ON" : "🔴 OFF"}</b>\n` +
    `🎯 Trigger band: <b>${usd(c.minMcap)} – ${usd(c.maxMcap)}</b>\n` +
    // The band top past half-the-floor governs nothing (see triggerJitterSpan):
    // an operator who widened it to $100M was reading it as "list up to $100M",
    // and the draw then starved the feed to zero for two days. When the stored
    // band is wider than the draw, the panel does the arithmetic out loud so
    // the number that actually governs is the one on screen.
    (c.maxMcap - c.minMcap > autoLister.triggerJitterSpan(c)
      ? `   <i>triggers land in ${usd(c.minMcap)}–${usd(c.minMcap + autoLister.triggerJitterSpan(c))} — a token past its trigger lists at any size up to the ${usd(c.maxMcapHard)} ceiling</i>\n`
      : "") +
    `🚫 Ignore above: <b>${usd(c.maxMcapHard)}</b>\n` +
    `💧 Min liquidity: <b>${usd(c.minLiq)}</b> · 📊 min 24h vol: <b>${usd(c.minVol24)}</b>\n` +
    `🕒 Min age: <b>${c.minAgeHours}h</b>\n` +
    alPaceLine(c) +
    // `x/scan` is dropped while pacing is on rather than shown greyed: a paced
    // scan lists at most one, so printing 3 would be a row the engine ignores.
    `🔢 Max <b>${c.maxPerDay}</b>/day` +
    (c.paceListings ? `` : `, <b>${c.maxPerRun}</b>/scan`) +
    ` · scans every <b>${c.minGapMin}–${c.maxGapMin} min</b> (random)\n` +
    `🌐 Chains: <b>${alChainScope(c)}</b>` +
    (c.chains.length
      ? ` <i>(the whole scan budget goes to ${c.chains.length === 1 ? "this chain" : "these chains"})</i>`
      : "") +
    `\n` +
    `📦 Packages: <b>${c.pkgs.map((k) => autoLister.pkgOf(k).label).join(" → ")}</b>` +
    // With more than one enabled the useful fact is not "which package" but
    // "which one is next" — that is the whole point of a rotation, and it is the
    // question an operator watching the feed actually has.
    (c.pkgs.length > 1
      ? ` <i>(taking turns — next: ${autoLister.pkgOf(autoLister.nextPkg().key).label})</i>`
      : "") +
    `\n` +
    (alTrendOn(c) ? `🔥 Board slot: <b>${c.trendHours}h</b> · tier drawn per token: <b>${autoLister.TREND_TIERS.join(" / ")}</b>\n` : "") +
    `📣 Channel post: <b>${c.postChannel ? "🟢 ON" : "🔴 OFF"}</b> <i>(off = listed on the site only)</i>\n` +
    // Only the "Listing & Trending" package can reach @dexvraio, so the line is
    // only shown when it is one of the enabled ones — otherwise it would state a
    // setting that has nothing to act on.
    (alTrendOn(c)
      ? `🔔 Announce in ${CHANNELS.announce}: <b>${c.announceChannel ? "🟢 ON" : "🔴 OFF"}</b>` +
        (c.announceChannel && !c.postChannel ? ` <i>(waiting on channel post)</i>` : ``) +
        `\n`
      : "") +
    `\n` +
    `<i>✏️ Tap any value to type it — <code>3.2M</code>, <code>25k</code>, <code>2h30m</code>.</i>\n\n` +
    `Listed so far: <b>${s.total}</b> (today: ${s.today})\n` +
    (recent ? `${recent}\n\n` : "\n") +
    // "Listed so far" alone cannot distinguish a quiet market from a service
    // that has been broken for days — the counter simply stops moving either
    // way. This is the line that tells them apart.
    alScanLine(autoLister.lastScan(), c) +
    `🔒 <b>Never re-listed:</b> ${s.everListed} contracts — everything that has ever ` +
    `been on the site, so a token that was listed before (including a paid one that ` +
    `was later deleted) can never come back as a free auto listing.\n\n` +
    `<b>Free listing</b> carries a Free badge and no tier. <b>Xpress</b> carries the ` +
    `Xpress tier. <b>Listing &amp; Trending</b> draws a real paid tier per token ` +
    `(${autoLister.TREND_TIERS.join(" / ")}) — it sorts with paid slots on the board, ` +
    `and Diamond/Gold also carry the verified badge on the site.\n\n` +
    `Only <b>Listing &amp; Trending</b> reaches ${CHANNELS.announce}; a paid listing ` +
    `gets there on tier #1–#3.`
  );
}
/**
 * The listing pace, with the arithmetic it implies done out loud.
 *
 * "one every 2h–3h" and "max 12/day" are two numbers governing one feed, and
 * which of them binds is not obvious from either. The trending panel's
 * "🧲 max 3/chain" was read as a cap on the board when it was a speed, and the
 * very first question it drew is the one this line answers before it is asked.
 */
function alPaceLine(c) {
  if (!c.paceListings) {
    return (
      `⏳ <b>Listing pace: 🔴 OFF</b> — up to <b>${c.maxPerRun}</b> listings per scan, back to ` +
      `back <i>(only the ${c.maxPerDay}/day cap spaces them out)</i>\n`
    );
  }
  const p = autoLister.pace(c);
  const gap = autoLister.fmtGap;
  const pinned = c.maxListGapMin === c.minListGapMin;
  // ⚠️ Both ends of the rate are FLOORED integers, so both go to 0 the moment a
  // gap passes 24h — and the band then rendered "≈ up to 0 a day" for a feed
  // that lists perfectly well, once every day and a half. Zero is a claim, not
  // an approximation. `hi === null` is the other end of the same problem: a
  // floor of 0 has no fastest rate to state at all.
  const lo = c.maxListGapMin > 0 ? Math.floor(1440 / c.maxListGapMin) : null;
  const hi = c.minListGapMin > 0 ? Math.floor(1440 / c.minListGapMin) : null;
  // What ELSE bounds the feed, whatever the band says. Pacing forces one
  // listing per scan, and scans are their own band — so `maxPerDay` is never
  // "the only bound", and saying it was is the 🧲 label defect again.
  const perScan = `still one per scan, and scans are ${c.minGapMin}–${c.maxGapMin} min apart`;
  let reach;
  if (hi == null) {
    reach = `no minimum spacing at the fast end — ${perScan}, under your <b>${c.maxPerDay}</b>/day cap`;
  } else if (hi === 0) {
    // Slower than one a day at BOTH ends: the pace is the bound, and the cap
    // cannot be what stops it.
    reach = `slower than <b>one a day</b>, so your <b>${c.maxPerDay}</b>/day cap never binds`;
  } else {
    // ⚠️ Never a bare "&lt;" or "<" here: a literal `<` makes Telegram reject the
    // whole message (parse_mode HTML), and the panel then silently stops
    // updating — the exact failure a panel line exists to report.
    const band = lo === 0 ? `up to <b>${hi}</b>` : lo === hi ? `<b>${lo}</b>` : `<b>${lo}–${hi}</b>`;
    reach =
      hi > c.maxPerDay
        ? `≈ ${band} a day, so your <b>${c.maxPerDay}</b>/day cap is what stops it`
        : `≈ ${band} a day, inside your <b>${c.maxPerDay}</b>/day cap`;
  }
  // ⚠️ `pace()` knows only about its own clock, and TWO gates run before it in
  // runOnce: the service being off, and today's cap. A green "the next scan may
  // list one" under either of those is a ready line contradicting the screen it
  // is on — the auto-raid panel had to learn to DROP its ready line rather than
  // reword it, for the same reason.
  const today = autoLister.stats().today;
  const scan = autoLister.lastScan();
  const loopDead = autoLister.lastHalt() || !scan || Date.now() - scan.at > 2 * c.maxGapMin * 60_000 + 600_000;
  let next;
  // The CERTAIN facts first — a switch the operator set and a cap they set are
  // known, where "the scanner has not reported" is an inference.
  if (!c.enabled) next = `<b>held</b> — the service is 🔴 OFF`;
  else if (today >= c.maxPerDay) next = `<b>held</b> — today's <b>${today}/${c.maxPerDay}</b> cap is reached`;
  // ⚠️ …and then DROPPED, never reworded. "the next scan may list one" printed
  // twelve lines under "the loop has stopped" is a panel contradicting itself
  // with the reassuring half first — the rule the auto-raid panel had to learn.
  else if (loopDead) next = `<b>held</b> — the scanner has not reported; the loop may not be running`;
  else if (p.skewed) next = `<b>due now</b> — the stored clock reads in the future and was discarded`;
  else if (p.waitMs > 0) next = `next one due <b>in ${gap(p.waitMs / 60000)}</b>`;
  // ⚠️ "nothing listed yet" is a claim about the FEED and this is a claim about
  // the CLOCK. `lastListAt` is a new field, so it is null on every install that
  // upgrades — which on deploy day is all of them, printing "nothing listed
  // yet" directly above their own "Listed so far: 84".
  else next = p.lastAt ? `<b>due now</b> — the next scan may list one` : `<b>due now</b> — no listing on the clock yet`;
  // ⚠️ A pinned band (min = max) IS a fixed heartbeat: `paceGapMs` returns the
  // floor for every roll. Two ➕ taps from the shipped default, and the line
  // would have gone on denying exactly what it was doing.
  const how = pinned
    ? `<i>(a fixed wait — widen the band to vary it)</i>`
    : `<i>(rolled fresh after each one, never a fixed heartbeat)</i>`;
  return (
    `⏳ <b>Listing pace: 🟢 one free listing every ${autoLister.paceRange(c)}</b> ${how}\n` +
    `   ${reach} · ${next}\n` +
    // Three services list through the same door and only this one is paced.
    // Without this line, an extra listing landing between two paced ones is a
    // bug report — and it is the market filler doing exactly its job.
    (autoTrend.get().fillFromMarket
      ? `   <i>Covers this scan only — 🧲 Fill from market (Auto Trending) still lists when a ` +
        `chain's board is short.</i>\n`
      : "")
  );
}


/**
 * Every Auto-Listing value that can be TYPED instead of tapped.
 *
 * The panel steps in ±$100,000, so moving the trigger ceiling from $1M to $3.2M
 * is twenty-two taps — the operator's report was simply "biar cepat". The label
 * button beside each ➖/➕ pair used to be a no-op; it opens a typed input now,
 * which costs no new row on a keyboard that is already tall.
 *
 * ONE TABLE, so a row added later cannot grow its own idea of what a valid
 * value is. `kind` picks the parser, and each parser returns null rather than a
 * default on anything it cannot read — the rule the gainers settings paid for
 * when `500k` was silently stored as $1M under a ✅.
 */
const AL_TYPED = {
  minMcap: { kind: "cap", label: "Trigger from", eg: "1M · 1.2m · 1,200,000" },
  maxMcap: { kind: "cap", label: "Trigger to", eg: "3.2M · 3200k" },
  minLiq: { kind: "cap", label: "Min liquidity", eg: "25k · 25000" },
  minVol24: { kind: "cap", label: "Min 24h volume", eg: "30k · 30000" },
  maxPerDay: { kind: "int", label: "Max per day", eg: "5 · 12" },
  trendHours: { kind: "int", label: "Board slot (hours)", eg: "12 · 24" },
  minListGapMin: { kind: "gap", label: "Pace — every", eg: "2h · 90m · 2h30m" },
  maxListGapMin: { kind: "gap", label: "Pace — up to", eg: "4h · 3h30m" },
};

/**
 * The same table for 🤖 Auto Trending's two quality floors.
 *
 * A SEPARATE table rather than two more rows in AL_TYPED, because the key is
 * what the reply is applied to and the two panels write to different stores —
 * `minVol24` (Auto Listing) and `minVol24hUsd` (Auto Trending) are different
 * settings with nearly the same name, and one shared table keyed by a bare
 * string is how a reply meant for one lands in the other. The `kind` vocabulary
 * and the parsers are shared; only the destination differs.
 */
const AT_TYPED = {
  minMcapUsd: { kind: "cap", label: "Min market cap for a free slot", eg: "100k · 250k · 1M" },
  minVol24hUsd: { kind: "cap", label: "Min 24h volume for a free slot", eg: "10k · 50k · 250k" },
};
/** One value, spelled the way its row spells it. */
const alShow = (key, v) =>
  AL_TYPED[key].kind === "gap" ? autoLister.fmtGap(v) : AL_TYPED[key].kind === "int" ? String(v) : usd(v);

/** Is "Listing & Trending" one of the enabled packages? Drives the rows that
 *  only make sense when a board slot is on the table. */
const alTrendOn = (c) => c.pkgs.includes("trending");

/** The chain scope, in the operator's words. Empty = the service's original
 *  behaviour, so it reads ALL rather than an empty list. */
function alChainScope(c) {
  if (!c.chains.length) return "ALL";
  const meta = new Map(trendingBoard.chainList().map((x) => [x.id, x.label]));
  return c.chains.map((id) => meta.get(id) || id).join(" · ");
}

/** The chain picker — same multi-select grammar as the packages row: any
 *  combination, and clearing the last one falls back to ALL rather than
 *  refusing (an empty scope MEANS something here — every chain — unlike an
 *  empty package list, which is a setting nobody chose). */
function alchText() {
  const c = autoLister.get();
  return (
    `🌐 <b>Auto Listing — chain scope</b>\n\n` +
    `Which chains the auto-lister may list on. <b>ALL</b> is the default and ` +
    `what it has always done; picking one or more chains focuses the WHOLE ` +
    `scan budget there — e.g. pick Base and every scan's lookups go to Base ` +
    `candidates instead of being spent on the market's loudest chain.\n\n` +
    `Current: <b>${alChainScope(c)}</b>\n\n` +
    `<i>Discovery still depends on the sources: a chain DexScreener barely ` +
    `covers will stay thin however focused the scan is — the scan report on ` +
    `the panel says what was actually seen.</i>`
  );
}
function alchKb() {
  // `cb` is per-function in this file, not a module global — alKb, atKb and
  // every other builder define their own. Leaving it out here compiled fine
  // and threw at TAP time, inside bot.catch, so the button answered and did
  // nothing: the exact "tombol tidak menjawab" the operator reported.
  const cb = Markup.button.callback;
  const c = autoLister.get();
  const rows = [[cb(`${c.chains.length ? "▫️" : "🟢"} ALL chains`, "alchall")]];
  const btns = trendingBoard
    .chainList()
    .map((m) =>
      cb(`${c.chains.includes(m.id) ? "🟢" : "▫️"} ${trendingBoard.displayEmoji(m.logo)} ${m.label}`, `alchn:${m.id}`),
    );
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  rows.push([cb("⬅ Back to Auto Listing", "al")]);
  return Markup.inlineKeyboard(rows);
}

// One test scan at a time — see the alscan handler.
let alScanBusy = false;
// ⚡ Run now is slow enough to outlive the callback it answers — see the handler.
let atRunBusy = false;

const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** The last scan, in the operator's words. A blocked scan says so loudly: that
 *  is the state where the service looks ON and lists nothing.
 *
 *  Everything derived from an ERROR is escaped. A blocker carries whatever the
 *  site or DexScreener said — an HTML error page, a URL with a query string —
 *  and the panel is sent with parse_mode HTML. Unescaped, a single "<" makes
 *  Telegram reject the edit AND the reply fallback, so the panel silently stops
 *  updating: the exact failure this line exists to report. */
function alScanLine(scan, cfg) {
  // "🟢 ON" above is a CONFIG flag. It says what the operator chose, and it said
  // it for two days while the scanner was not running at all — the service had
  // failed to start behind a swallowed require error, and nothing in this panel
  // could tell the difference. A scan report is the only proof the loop is
  // alive, so its absence or its age is what gets reported here.
  const stale = 2 * cfg.maxGapMin * 60_000 + 600_000; // two full gaps, plus slack
  // ⚠️ A HALT CANNOT REACH THE SCAN REPORT — that is what makes it a halt: the
  // scan refuses to write the very file the report lives in. Without this the
  // stale-report branch below would accuse a perfectly healthy loop of having
  // died and send the operator to pm2 to hunt a process that is running fine,
  // while the actual cause (one unreadable file, a one-line fix) is named
  // nowhere they will look.
  const halt = autoLister.lastHalt();
  if (halt && (!scan || halt.at >= scan.at)) {
    return (
      `⛔ <b>Auto-Listing is halted</b> (${ago(Date.now() - halt.at)})\n` +
      `<code>${escapeHtml(String(halt.why).slice(0, 300))}</code>\n` +
      `<i>The loop IS running — it is refusing to write rather than lose data.</i>\n\n`
    );
  }
  if (!scan) {
    return (
      `⚠️ <b>The scanner has never reported</b> — if the bot has been up more than ` +
      `~${cfg.maxGapMin} min, it is NOT running.\n` +
      `<i>Check the [monitoring] lines in pm2 logs for a service that failed to start.</i>\n\n`
    );
  }
  const age = Date.now() - scan.at;
  const when = ago(age);
  if (age > stale) {
    return (
      `⚠️ <b>The scanner has gone quiet</b> — last report ${when}, and it should run every ` +
      `${cfg.minGapMin}–${cfg.maxGapMin} min.\n` +
      `<i>The loop has stopped. Check the [monitoring] lines in pm2 logs.</i>\n\n`
    );
  }
  if (scan.blocker) {
    return (
      `⛔ <b>Last scan (${when}) could not run</b>\n<code>${escapeHtml(String(scan.blocker).slice(0, 200))}</code>\n` +
      `<i>Nothing will be listed until this clears.</i>\n\n`
    );
  }
  return `🔍 <b>Last scan</b> (${when}): ${escapeHtml(autoLister.scanLine(scan))}\n\n`;
}
function alKb() {
  const cb = Markup.button.callback;
  const c = autoLister.get();
  return Markup.inlineKeyboard([
    [cb(c.enabled ? "⏸ Disable" : "▶️ Enable", "alen")],
    // ✏️ marks a label that opens a typed input. The money figures are COMPACT
    // here: `$1,000,000` renders as "From $1,000,0…" on a phone, so the one row
    // whose job is showing a value showed everything but its last digits.
    [cb(`✏️ 🎯 From ${fmtCap(c.minMcap)}`, "alset:minMcap"), cb("➖", "almin:-100000"), cb("➕", "almin:100000")],
    [cb(`✏️    To ${fmtCap(c.maxMcap)}`, "alset:maxMcap"), cb("➖", "almax:-100000"), cb("➕", "almax:100000")],
    [cb(`✏️ 💧 Liq ${fmtCap(c.minLiq)}`, "alset:minLiq"), cb("➖", "alliq:-5000"), cb("➕", "alliq:5000")],
    [cb(`✏️ 📊 Vol ${fmtCap(c.minVol24)}`, "alset:minVol24"), cb("➖", "alvol:-10000"), cb("➕", "alvol:10000")],
    [cb(`✏️ 🔢 ${c.maxPerDay}/day`, "alset:maxPerDay"), cb("➖", "alday:-1"), cb("➕", "alday:1")],
    [cb(`⏳ Pace: ${c.paceListings ? `1 every ${autoLister.paceRange(c)}` : "OFF"}`, "alpace")],
    // Hidden while the pace is off, like the board-slot row above: a band that
    // governs nothing is a setting the operator can change and not see act.
    ...(c.paceListings
      ? [
          [
            cb(`✏️ ⏳ Every ${autoLister.fmtGap(c.minListGapMin)}`, "alset:minListGapMin"),
            cb("➖", "alpmin:-30"),
            cb("➕", "alpmin:30"),
          ],
          [
            cb(`✏️    to ${autoLister.fmtGap(c.maxListGapMin)}`, "alset:maxListGapMin"),
            cb("➖", "alpmax:-30"),
            cb("➕", "alpmax:30"),
          ],
        ]
      : []),
    // MULTI-select, not a radio: any combination can be on, and two or more
    // means they take turns rather than one winning. Tapping the only enabled
    // one is refused by togglePkg — an empty list is not a setting.
    [
      cb(`${c.pkgs.includes("free") ? "🟢" : "▫️"} Free`, "alpkg:free"),
      cb(`${c.pkgs.includes("xpress") ? "🟢" : "▫️"} Xpress`, "alpkg:xpress"),
      cb(`${c.pkgs.includes("trending") ? "🟢" : "▫️"} + Trending`, "alpkg:trending"),
    ],
    ...(alTrendOn(c)
      ? [[cb(`✏️ 🔥 Slot ${c.trendHours}h`, "alset:trendHours"), cb("➖", "alth:-1"), cb("➕", "alth:1")]]
      : []),
    [cb(`🌐 Chains: ${alChainScope(c)}`, "alch")],
    [cb(`📣 Channel post: ${c.postChannel ? "ON" : "OFF"}`, "alpost")],
    // Below its gate, not above it: @dexvraio only fires when channel posting is
    // already on, and a switch that reads as independent of the one under it is
    // how an operator ends up expecting a post that cannot happen.
    ...(alTrendOn(c)
      ? [[cb(`🔔 ${CHANNELS.announce}: ${c.announceChannel ? "ON" : "OFF"}`, "alann")]]
      : []),
    // Read-only, and the answer to "why has nothing been listed?" — without it
    // the only way to find out is to wait out a 25–90 min gap and still have
    // nothing to read.
    [cb("🔎 Test scan", "alscan"), cb("🔄 Refresh", "al")],
    [cb("↩️ Reset", "alrst"), cb("🧹 Clear history", "alclr"), cb("⬅ Back", "home")],
  ]);
}

/** "⚡ Run now" buttons, one per chain the board can show. Each button carries
 *  the chain's CURRENT featured count, so an operator can see which network is
 *  empty without leaving the panel. */
function atChainRows(cb, counts = _atCounts) {
  const c = autoTrend.get();
  const meta = new Map(trendingBoard.chainList().map((x) => [x.id, x]));
  const btn = (id, withTarget) => {
    const m = meta.get(id);
    if (!m) return null;
    const n = (counts[id] && counts[id].featured) || 0;
    // "5/5" answers the question the button sits next to. A bare "(5)" does not
    // — and a fraction on a chain with no target would invent one.
    const label = withTarget ? `${n}/${tgtRange(c)}` : n ? `(${n})` : "";
    return cb(`⚡ ${trendingBoard.displayEmoji(m.logo)} ${m.label}${label ? " " + label : ""}`, `atrun:${id}`);
  };
  // The auto-filled chains first, in the order they are configured — those are
  // the ones the panel above is about.
  const btns = c.chains.map((id) => btn(id, true)).filter(Boolean);
  // Then any OTHER chain that actually has a listing, so a one-off force is
  // still one tap away. Chains with nothing listed are omitted entirely: the
  // list was 20 rows of "0/5" for networks nobody has listed on, and a Run now
  // there can only fail.
  const extra = Object.keys(counts)
    .filter((id) => !c.chains.includes(id) && meta.has(id) && ((counts[id].featured || 0) + (counts[id].eligible || 0)) > 0)
    .sort();
  for (const id of extra) btns.push(btn(id, false));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return rows;
}

/**
 * ⚠️ WHICH CHAINS THE BOARD COVERS — the ON/OFF row this panel never had.
 *
 * "saya tidak ingin chain ini ada di channel trending dan liat di admin bot
 * harusnya bisa aktivkan dan nonaktifkan". `cfg.chains` has always governed the
 * board, and the only ways to change it were a code default or a shell script —
 * so an operator who wanted POLYGON off had to ask for a deploy. Every other
 * setting on this panel is a tap; this one was not, and it is the one that
 * decides what a channel of 10,543 people sees.
 *
 * A chain with NOTHING listed on it is left out entirely, the same rule the
 * ⚡ Run now rows already follow: a list of twenty networks nobody has listed
 * on is a screen you have to read past to reach the toggle you want.
 */
function atChainToggleRows(cb, counts = _atCounts) {
  const c = autoTrend.get();
  const on = new Set(c.chains.map((x) => String(x).toLowerCase()));
  const meta = new Map(trendingBoard.chainList().map((x) => [x.id, x]));
  // Configured chains ALWAYS show — an operator must be able to switch one off
  // even on a day it happens to have no listings, or the row that turns it off
  // disappears exactly when they go looking for it.
  const ids = [...new Set([
    ...c.chains,
    ...Object.keys(counts).filter((id) => meta.has(id) && ((counts[id].featured || 0) + (counts[id].eligible || 0)) > 0),
  ])].filter((id) => meta.has(id));
  const btns = ids.map((id) => {
    const m = meta.get(id);
    return cb(`${on.has(id) ? "🟢" : "⚪️"} ${trendingBoard.displayEmoji(m.logo)} ${m.label}`, `atch:${id}`);
  });
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return rows;
}
// Last per-chain snapshot, refreshed whenever the panel is opened. Kept out of
// the keyboard builder so drawing the panel never blocks on the API.
let _atCounts = {};
// Queue depth, refreshed with the counts. Every promotion is announced now, so
// a backlog is normal — but an unmoving one means the gap is too wide.
let _atPending = 0;

// ── Interactive layout editor — one PHOTO message that edits itself in place ─
// A full listing-example preview (logo + $TICKER + name + chain·price·MC
// chips + tier badge) with an ELEMENT SELECTOR: pick logo/ticker/chips/badge,
// then the arrows move THAT element and ➕/➖ resize it. Every tap saves the
// setting, re-composes, draws a dashed guide on the selected element and
// editMessageMedia's the same message — a mini design tool inside Telegram.
const BT_NUDGE = 40; // px per arrow tap for the logo slot (2560×1280 artwork)
const BT_TEXT_NUDGE = 20; // finer step for text elements

// element → which settings keys it drives
const BT_ELEMS = {
  logo: { label: "🪙 Logo", xKey: "logoX", yKey: "logoY" },
  ticker: { label: "🔤 Ticker+Name", xKey: "tickerX", yKey: "tickerY", sizeKey: "tickerFontSize", step: 8 },
  meta: { label: "📊 Chips", xKey: "metaX", yKey: "metaY", sizeKey: "metaFontSize", step: 4 },
  badge: { label: "🏷 Label tier", xKey: "badgeX", yKey: "badgeY", sizeKey: "badgeFontSize", step: 4 },
};
const BT_ELEM_KEYS = Object.keys(BT_ELEMS);

function btNum(v, d) {
  return v === "center" ? d : Number(v) || 0;
}

function btGuideOverlay(buf, kind, elem) {
  const cv = require("@napi-rs/canvas");
  return cv.loadImage(buf).then((img) => {
    const c = cv.createCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const s = bannerTpl.getSettings(kind);
    const rect = s.slotShape === "rect";

    // guide box for the SELECTED element
    let gx, gy, gw, gh, circle = false;
    if (elem === "logo") {
      gw = rect ? Number(s.slotW) : Number(s.logoSize);
      gh = rect ? Number(s.slotH) : Number(s.logoSize);
      gx = s.logoX === "center" ? (img.width - gw) / 2 : btNum(s.logoX);
      gy = s.logoY === "center" ? (img.height - gh) / 2 : btNum(s.logoY);
      circle = !rect;
    } else if (elem === "ticker") {
      const fs = Number(s.tickerFontSize) || 96;
      gw = fs * 5.2;
      gh = fs + (Number(s.nameFontSize) || 48) + (Number(s.nameOffsetY) || 96) - fs * 0.4;
      gx = s.tickerX === "center" ? (img.width - gw) / 2 : btNum(s.tickerX);
      gy = btNum(s.tickerY) - fs * 0.85;
    } else if (elem === "meta") {
      const fs = Number(s.metaFontSize) || 34;
      gw = fs * 20;
      gh = fs * 2;
      gx = s.metaX === "center" ? (img.width - gw) / 2 : btNum(s.metaX);
      gy = btNum(s.metaY) - fs * 1.3;
    } else {
      const fs = Number(s.badgeFontSize) || 30;
      gw = fs * 12;
      gh = fs * 2.2;
      gx = btNum(s.badgeX) - gw / 2; // badgeX is CENTER x
      gy = btNum(s.badgeY) - gh / 2;
    }

    const stroke = (color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash([22, 16]);
      g.beginPath();
      if (circle) g.arc(gx + gw / 2, gy + gh / 2, gw / 2, 0, Math.PI * 2);
      else g.rect(gx, gy, gw, gh);
      g.stroke();
    };
    stroke("rgba(0,0,0,.65)", 12);
    stroke("#FFD84D", 5);
    // crosshair at guide center
    g.setLineDash([]);
    g.strokeStyle = "#FFD84D";
    g.lineWidth = 3;
    const cx = gx + gw / 2;
    const cy = gy + gh / 2;
    g.beginPath();
    g.moveTo(cx - 26, cy);
    g.lineTo(cx + 26, cy);
    g.moveTo(cx, cy - 26);
    g.lineTo(cx, cy + 26);
    g.stroke();
    return toSendBuffer(c);
  });
}

function btEditorCaption(kind, elem) {
  const s = bannerTpl.getSettings(kind);
  const e = BT_ELEMS[elem];
  const rect = s.slotShape === "rect";
  let detail;
  if (elem === "logo") {
    detail = rect
      ? `Slot <b>${s.slotW}×${s.slotH}px</b> at (${s.logoX}, ${s.logoY})`
      : `<b>${s.logoSize}px</b> at (${s.logoX}, ${s.logoY})`;
  } else {
    detail = `<b>${s[e.sizeKey]}px</b> at (${s[e.xKey]}, ${s[e.yKey]})`;
  }
  return (
    `🖱 <b>${BT_KINDS[kind]} — layout editor</b>\n` +
    `Active element: <b>${e.label}</b> — ${detail}\n` +
    `Yellow outline = selected element. Pick an element below, arrows move it, ➕/➖ resize.` +
    (elem === "ticker" ? " The token name moves together with the ticker." : "")
  );
}

function btEditorKb(kind, elem) {
  const s = bannerTpl.getSettings(kind);
  const rect = s.slotShape === "rect";
  const cb = Markup.button.callback;
  const showText = s.showText !== false;
  const showBadge = s.showBadge !== false;
  // element selector — active one marked; banner-ads (rect, no text) only has logo.
  // The badge is only selectable when it's turned on (no point positioning a hidden one).
  const selectable = rect || !showText ? ["logo"] : showBadge ? BT_ELEM_KEYS : BT_ELEM_KEYS.filter((k) => k !== "badge");
  const rows = [];
  if (selectable.length > 1) {
    rows.push(
      selectable.map((k) =>
        cb(k === elem ? `• ${BT_ELEMS[k].label} •` : BT_ELEMS[k].label, `bt_esel:${kind}:${k}`),
      ),
    );
  }
  const step = elem === "logo" ? BT_NUDGE : BT_TEXT_NUDGE;
  rows.push([
    cb("◀", `bt_emv:${kind}:${elem}:${-step}:0`),
    cb("🔼", `bt_emv:${kind}:${elem}:0:${-step}`),
    cb("🔽", `bt_emv:${kind}:${elem}:0:${step}`),
    cb("▶", `bt_emv:${kind}:${elem}:${step}:0`),
  ]);
  if (elem === "logo" && rect) {
    rows.push([
      cb("↔️ W−", `bt_ewh:${kind}:${-BT_NUDGE}:0`),
      cb(`${s.slotW}×${s.slotH}`, `bt_slot:${kind}`),
      cb("↔️ W+", `bt_ewh:${kind}:${BT_NUDGE}:0`),
    ]);
    rows.push([cb("↕️ H−", `bt_ewh:${kind}:0:${-BT_NUDGE}`), cb("↕️ H+", `bt_ewh:${kind}:0:${BT_NUDGE}`)]);
  } else {
    const szStep = elem === "logo" ? BT_NUDGE : BT_ELEMS[elem].step;
    const cur = elem === "logo" ? `${s.logoSize}px` : `${s[BT_ELEMS[elem].sizeKey]}px`;
    rows.push([
      cb("➖ Smaller", `bt_esz:${kind}:${elem}:${-szStep}`),
      cb(cur, `bt_pos:${kind}`),
      cb("➕ Bigger", `bt_esz:${kind}:${elem}:${szStep}`),
    ]);
  }
  if (!rect) {
    rows.push([cb(`🏷 Badge: ${showBadge ? "ON" : "OFF"}`, `bt_badge:${kind}`)]);
  }
  rows.push([cb("↩️ Reset layout", `bt_erst:${kind}`), cb("✅ Done", `bt_done:${kind}`)]);
  return Markup.inlineKeyboard(rows);
}

async function btEditorImage(kind, elem) {
  // editorStill draws the token overlay onto the still artwork OR — when only an empty
  // animated template is uploaded — onto a frame of that clip, so positioning matches
  // the real look either way.
  const buf = await bannerTpl.editorStill(kind, sampleMedia(kind), sampleData(kind));
  if (!buf) return null;
  return btGuideOverlay(buf, kind, elem).catch(() => buf);
}

async function btEditorOpen(ctx, kind, elem = "logo") {
  if (!bannerTpl.hasTemplate(kind) && !bannerTpl.hasMedia(kind)) {
    return ctx.reply(`❌ Belum ada template ${BT_KINDS[kind]} — tekan ⬆ Upload gambar atau 🎞 Upload GIF/Video dulu.`).catch(() => {});
  }
  const img = await btEditorImage(kind, elem);
  if (!img) return ctx.reply("⚠️ Editor render failed — check pm2 logs.").catch(() => {});
  await ctx
    .replyWithPhoto({ source: img }, { caption: btEditorCaption(kind, elem), parse_mode: "HTML", ...btEditorKb(kind, elem) })
    .catch(() => {});
}

async function btEditorRefresh(ctx, kind, elem = "logo") {
  const img = await btEditorImage(kind, elem);
  if (!img) return;
  await ctx
    .editMessageMedia(
      { type: "photo", media: { source: img }, caption: btEditorCaption(kind, elem), parse_mode: "HTML" },
      { reply_markup: btEditorKb(kind, elem).reply_markup },
    )
    .catch(() => btEditorOpen(ctx, kind, elem)); // message too old / edit failed → fresh editor
}

function sampleMedia(kind) {
  try {
    const cv = require("@napi-rs/canvas");
    const rect = bannerTpl.getSettings(kind).slotShape === "rect";
    const w = rect ? 800 : 300;
    const h = rect ? 320 : 300;
    const c = cv.createCanvas(w, h);
    const g = c.getContext("2d");
    const lg = g.createLinearGradient(0, 0, w, h);
    lg.addColorStop(0, "#7C3AED");
    lg.addColorStop(1, "#22D3EE");
    g.fillStyle = lg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,.95)";
    g.font = `800 ${rect ? 90 : 170}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(rect ? "SAMPLE AD" : "J", w / 2, h / 2 + (rect ? 4 : 8));
    return toSendBuffer(c);
  } catch {
    return null;
  }
}

// ── Fourtis-style layout editor ─────────────────────────────────────────────
// A plain button menu (not a self-editing photo) with an explicit Size and Move
// screen per element — coarse/fine ± steps, "enter exact", and an on-demand
// Preview. Each element button shows its current value. Reads/writes the same
// layout settings the still + animated compositors use, so tuning here applies
// everywhere. Callback namespace: bx*.
const BX_SAMPLE = { symbol: "SAMPLE", name: "Sample Token", chain: "SOLANA", price: "$0.0042", mcap: "$1.2M", badge: "Sample Badge" };
// Sample token data for every preview / the layout editor. Pump gets its
// DISTINCT fields (▲ +N% · old→new price) so its preview shows the real pump
// layout. The pump % defaults to the configured window MINIMUM (so the example
// matches what actually triggers an alert), or an explicit `pct` to preview a
// specific gain; the old→new price is derived from that %.
function sampleData(kind, pct) {
  if (kind === "pump") {
    const p = Number.isFinite(pct) ? pct : pumpConfig.get().minPct;
    const base = 0.032; // sample baseline price
    const now = base * (1 + p / 100);
    return {
      symbol: "DEXV",
      name: "Dexvra",
      chain: "SOLANA",
      change: `+${Math.round(p)}%`,
      priceFrom: fmtPrice(base),
      priceTo: fmtPrice(now),
      price: fmtPrice(now),
      mcap: "$120M",
      badge: "Sample Badge",
    };
  }
  return BX_SAMPLE;
}
// Size steps offered on every element screen, fine → coarse.
//
// One step per element was both too coarse and too fine at once: 40px could not
// nudge a logo into a socket, and 8px could not carry a font anywhere. Three
// steps is what the operator asked for, and the range each element accepts is
// clamped in the handler, so the same three are safe everywhere — a font pinned
// at its smin simply stops shrinking.
const BX_SIZE_STEPS = [5, 10, 20];
const BX = {
  logo: { label: "🪙 Logo", sizeKey: "logoSize", xKey: "logoX", yKey: "logoY", smin: 60, smax: 1600, sc: 40, recenter: true },
  ticker: { label: "🔤 Ticker", sizeKey: "tickerFontSize", xKey: "tickerX", yKey: "tickerY", smin: 24, smax: 220, sc: 12 },
  // The name used to be nomove: it is DRAWN under the ticker at nameOffsetY, so
  // there was no coordinate to move. It has nameX/nameY now — both null until
  // the operator moves it, which is what keeps it following the ticker on every
  // layout tuned before those keys existed. `follows` is what tells this editor
  // where "here" is before the first nudge.
  name: { label: "📝 Nama token", sizeKey: "nameFontSize", xKey: "nameX", yKey: "nameY", smin: 12, smax: 140, sc: 8, follows: "ticker" },
  // Pump-only elements: the big "▲ +N%" headline and the "old → new" price line.
  pct: { label: "📈 % Kenaikan", sizeKey: "pctFontSize", xKey: "pctX", yKey: "pctY", smin: 60, smax: 320, sc: 12 },
  price: { label: "💱 Harga →", sizeKey: "priceFontSize", xKey: "priceX", yKey: "priceY", smin: 24, smax: 200, sc: 10 },
  meta: { label: "📊 Info (chain·harga·MC)", sizeKey: "metaFontSize", xKey: "metaX", yKey: "metaY", smin: 16, smax: 120, sc: 8 },
  badge: { label: "🏷 Label tier", sizeKey: "badgeFontSize", xKey: "badgeX", yKey: "badgeY", smin: 16, smax: 120, sc: 8 },
};

/**
 * Where an element ACTUALLY sits right now — which is not always what is
 * stored.
 *
 * The token name has no coordinate of its own until someone moves it; it is
 * drawn under the ticker. So the first arrow tap has to start from THERE. Read
 * the raw null instead and `btNum(null, 1070)` hands back a default constant,
 * which is how one nudge teleports the name across the banner.
 */
function bxPos(s, elem) {
  const c = elem === "slot" ? { xKey: "logoX", yKey: "logoY" } : BX[elem];
  if (!c || !c.xKey) return null;
  let x = s[c.xKey];
  let y = s[c.yKey];
  // Per AXIS, because they are pinned independently: centring the name
  // horizontally must not silently pin its vertical position too.
  const followsX = c.follows === "ticker" && unsetPos(x);
  const followsY = c.follows === "ticker" && unsetPos(y);
  if (followsX) x = s.tickerX; // may itself be "center" — carried through
  if (followsY) y = btNum(s.tickerY, 640) + (Number(s.nameOffsetY) || 0);
  return { x, y, followsX, followsY, inherited: followsX || followsY };
}
// 0 is a real coordinate; only null/"" mean "nothing stored".
const unsetPos = (v) => v == null || v === "";

function bxMenuText(kind) {
  const s = bannerTpl.getSettings(kind);
  const rect = s.slotShape === "rect";
  const anim = !!bannerTpl.mediaOverride(kind);
  return (
    `🎛 <b>${BT_KINDS[kind]} — Atur tata letak</b>\n\n` +
    (rect
      ? `Di sini Anda atur <b>kotak</b> tempat gambar client ditaruh.\n\nTekan kotaknya di bawah untuk mengubah <b>ukuran</b> dan <b>posisi</b>, lalu tekan 👁 <b>Lihat hasil</b>.`
      : `Tekan salah satu bagian di bawah untuk mengubah <b>ukuran ➖ ➕</b> dan <b>posisi</b>-nya. Tekan 👁 <b>Lihat hasil</b> kapan saja untuk melihatnya di ${anim ? "<b>template bergerak</b>" : "banner"} Anda.`)
  );
}
function bxMenuKb(kind) {
  const s = bannerTpl.getSettings(kind);
  const rect = s.slotShape === "rect";
  const isPump = kind === "pump";
  const cb = Markup.button.callback;
  const rows = [];
  if (rect) {
    rows.push([cb(`🖼 Kotak gambar · ${s.slotW}×${s.slotH}`, `bxe:${kind}:slot`)]);
  } else {
    const showText = s.showText !== false;
    const showBadge = s.showBadge !== false;
    rows.push([cb(`🪙 Logo · ${s.logoSize}px`, `bxe:${kind}:logo`)]);
    if (showText && isPump) {
      // Pump: its own elements — ▲%, old→new price, ticker/name, MCAP pill.
      rows.push([cb(`📈 % Change · ${s.pctFontSize}px`, `bxe:${kind}:pct`), cb(`💱 Price → · ${s.priceFontSize}px`, `bxe:${kind}:price`)]);
      rows.push([cb(`🔤 Ticker · ${s.tickerFontSize}px`, `bxe:${kind}:ticker`), cb(`📝 Name · ${s.nameFontSize}px`, `bxe:${kind}:name`)]);
      rows.push([cb(`💰 MCAP · ${s.metaFontSize}px`, `bxe:${kind}:meta`)]);
    } else if (showText) {
      rows.push([cb(`🔤 Ticker · ${s.tickerFontSize}px`, `bxe:${kind}:ticker`), cb(`📝 Name · ${s.nameFontSize}px`, `bxe:${kind}:name`)]);
      rows.push([cb(`📊 Chips (chain·price·MC) · ${s.metaFontSize}px`, `bxe:${kind}:meta`)]);
    }
    if (isPump) {
      rows.push([cb(`🔤 Tulisan: ${showText ? "AKTIF" : "MATI"}`, `bxt:${kind}`)]);
    } else {
      rows.push([cb(`🔤 Tulisan: ${showText ? "AKTIF" : "MATI"}`, `bxt:${kind}`), cb(`🏷 Label tier: ${showBadge ? "AKTIF" : "MATI"}`, `bxb:${kind}`)]);
      if (showBadge) rows.push([cb(`🏷 Label tier · ${s.badgeFontSize}px`, `bxe:${kind}:badge`)]);
    }
  }
  rows.push([cb("👁 Lihat hasil", `bxp:${kind}`)]);
  rows.push([cb("🔄 Kembalikan awal", `bxr:${kind}`), cb("⬅ Kembali", `btk:${kind}`)]);
  return Markup.inlineKeyboard(rows);
}
async function bxOpen(ctx, kind) {
  if (!bannerTpl.hasTemplate(kind) && !bannerTpl.hasMedia(kind)) {
    return ctx.reply(`❌ No ${BT_KINDS[kind]} template yet — tap ⬆ Upload artwork or 🎞 Upload GIF/Video first.`).catch(() => {});
  }
  await edit(ctx, bxMenuText(kind), bxMenuKb(kind));
}
// One SIMPLE screen per element: Smaller/Bigger + a single row of arrows, plus
// Preview. Center X and "type exact" stay for precision but out of the way.
// `slot` (banner ads) resizes W & H.
// How far one arrow tap moves an element, in px on the 2560×1280 canvas.
//
// Same three steps as the size rows, and for the same reason: one fixed 24px
// tap was too coarse to seat something against an edge and too fine to carry it
// across the banner. Rendered as three rows of four — a row per step, all four
// directions — rather than a sticky "step size" selector, because a selector is
// a mode: the operator has to look somewhere else to find out what the next tap
// will do. Here the button says what it does.
const BX_MOVE_STEPS = [5, 10, 20];

/** The arrow rows for an element: one row per step, ⬅ ⬆ ⬇ ➡ across. */
function bxArrowRows(kind, elem) {
  const cb = Markup.button.callback;
  return BX_MOVE_STEPS.map((n) => [
    cb(`⬅ ${n}px`, `bxmd:${kind}:${elem}:${-n}:0`),
    cb(`⬆ ${n}px`, `bxmd:${kind}:${elem}:0:${-n}`),
    cb(`⬇ ${n}px`, `bxmd:${kind}:${elem}:0:${n}`),
    cb(`➡ ${n}px`, `bxmd:${kind}:${elem}:${n}:0`),
  ]);
}
function bxElemText(kind, elem) {
  const s = bannerTpl.getSettings(kind);
  if (elem === "slot") {
    // Read by operators whose first language is not English. Every line is a
    // short sentence built from common words: "box", "picture", "space",
    // "middle". No comparatives ("narrower"), no design jargon ("cover-fit",
    // "canvas", "viewport") — the operator asked what "Wider" even meant.
    const W = 2560;
    const H = 1280;
    const w = Number(s.slotW) || 0;
    const h = Number(s.slotH) || 0;
    const cx = s.logoX === "center";
    const cy = s.logoY === "center";
    const x = cx ? Math.round((W - w) / 2) : Number(s.logoX) || 0;
    const y = cy ? Math.round((H - h) / 2) : Number(s.logoY) || 0;
    const right = W - x - w;
    const even = Math.abs(x - right) <= 2;
    const side = x > right ? "KIRI" : "KANAN";
    return (
      `🖼 <b>${BT_KINDS[kind]} — kotak untuk gambar client</b>\n\n` +
      `📏 <b>Ukuran kotak:</b> ${w} × ${h} px — ${Math.round((w / W) * 100)}% dari lebar penuh\n` +
      `📍 <b>Ruang kosong:</b> ${x} px di kiri, ${right} px di kanan\n` +
      (even
        ? `✅ Kotak sudah di tengah (kiri–kanan).\n`
        : `⚠️ Kotak belum di tengah — ruang kosong lebih banyak di <b>${side}</b>. Tekan <b>⬌ Ke tengah</b>.\n`) +
      `\n<b>Fungsi tombol</b>\n` +
      `• <b>➕ Perbesar / ➖ Perkecil</b> — ubah ukuran kotak sekaligus, bentuknya tetap\n` +
      `• <b>Lebar ➕ / ➖</b> — perbesar atau perkecil kotak ke samping saja\n` +
      `• <b>Tinggi ➕ / ➖</b> — perbesar atau perkecil kotak ke atas-bawah saja\n` +
      `• <b>⬅ ⬆ ⬇ ➡</b> — geser kotaknya\n` +
      `• <b>⬌ Ke tengah</b> — taruh di tengah, kiri–kanan\n` +
      `• <b>⬍ Ke tengah</b> — taruh di tengah, atas–bawah\n` +
      `• <b>⌨ Atur ukuran / Atur posisi</b> — ketik angkanya langsung\n` +
      (s.slotFit === "cover"
        ? `\n🖼 <b>Isi penuh</b>: gambar client diperbesar sampai kotak penuh, sisi yang lebih <b>dipotong</b>. ` +
          `Kalau bentuk gambarnya beda jauh dari kotak, bagian pinggirnya hilang.`
        : `\n🖼 <b>Muat semua</b>: gambar client ditampilkan <b>utuh</b>, tidak ada yang dipotong. ` +
          `Sisa ruangnya diisi versi buram dari gambar itu sendiri. Ukuran banner client boleh beda-beda — otomatis menyesuaikan.`)
    );
  }
  const c = BX[elem];
  const p = bxPos(s, elem);
  const pos = c.nomove || !p ? "" : ` · di <b>(${p.x}, ${p.y})</b>`;
  // Said out loud, because "(210, 714)" on a name that has never been moved
  // looks like a stored position and is not — nudging the TICKER moves it too,
  // right up until the first arrow tap here pins it. Named per axis, since
  // centring one leaves the other still following.
  const axes = p && p.followsX && p.followsY ? "Posisi" : p && p.followsX ? "Posisi kiri–kanan" : p && p.followsY ? "Posisi atas–bawah" : "";
  const note = axes ? `\n\n🔗 ${axes} masih <b>ikut Ticker</b>. Tekan panah di bawah untuk melepas dan menaruhnya sendiri.` : "";
  return `🎛 <b>${BT_KINDS[kind]} — ${c.label}</b>\nUkuran <b>${s[c.sizeKey]}px</b>${pos}${note}`;
}
function bxElemKb(kind, elem) {
  const cb = Markup.button.callback;
  if (elem === "slot") {
    // Centring and exact-size entry were both already implemented (bxc / bxsn
    // handle elem "slot"), but neither button was ever rendered here — so the
    // one control that fixes "the creative sits off to one side with dead space
    // beside it" was unreachable, and the only way to move a slot 300px was 15
    // taps of ➡.
    // Indonesian: this panel's only readers are the operator and their admins,
    // and they asked for it. "Wider"/"Narrower" had to be translated in the
    // head before it could be acted on — twice, first the word, then the
    // comparison. "Lebar ➕" needs neither.
    return Markup.inlineKeyboard([
      // Whole-box resize FIRST — it is what "make it bigger/smaller" means, and
      // doing it with the per-axis pair meant tapping two buttons different
      // numbers of times and watching the shape drift.
      [cb("➕ Perbesar", `bxscale:${kind}:up`), cb("➖ Perkecil", `bxscale:${kind}:down`)],
      [cb("Lebar ➕", `bxsd:${kind}:slotw:20`), cb("Lebar ➖", `bxsd:${kind}:slotw:-20`)],
      [cb("Tinggi ➕", `bxsd:${kind}:sloth:20`), cb("Tinggi ➖", `bxsd:${kind}:sloth:-20`)],
      ...bxArrowRows(kind, "slot"),
      [cb("⬌ Ke tengah", `bxc:${kind}:slot`), cb("⬍ Ke tengah", `bxcy:${kind}:slot`)],
      [cb(bannerTpl.getSettings(kind).slotFit === "cover" ? "🖼 Isi penuh (terpotong)" : "🖼 Muat semua (utuh)", `bxfit:${kind}`)],
      [cb("⌨ Atur ukuran", `bxsn:${kind}:slot`), cb("⌨ Atur posisi", `bxmn:${kind}:slot`)],
      [cb("👁 Lihat hasil", `bxp:${kind}`), cb("⬅ Kembali", `bxo:${kind}`)],
    ]);
  }
  const c = BX[elem];
  // Two mirrored rows, same magnitude in the same column, so "smaller by 10" is
  // directly above "bigger by 10" and a mis-tap is one tap to undo.
  const rows = [
    BX_SIZE_STEPS.map((n) => cb(`➖ ${n}px`, `bxsd:${kind}:${elem}:${-n}`)),
    BX_SIZE_STEPS.map((n) => cb(`➕ ${n}px`, `bxsd:${kind}:${elem}:${n}`)),
  ];
  rows.push([cb("⌨ Atur ukuran", `bxsn:${kind}:${elem}`)]);
  if (!c.nomove) {
    rows.push(...bxArrowRows(kind, elem));
    rows.push([cb("⬌ Ke tengah", `bxc:${kind}:${elem}`), cb("⬍ Ke tengah", `bxcy:${kind}:${elem}`)]);
    rows.push([cb("⌨ Atur posisi", `bxmn:${kind}:${elem}`)]);
    // The way BACK. Moving the name pins it, and without this the only undo was
    // "🔄 Kembalikan awal", which throws away every other tweak on the kind too.
    if (c.follows && bxPos(bannerTpl.getSettings(kind), elem)?.inherited === false) {
      rows.push([cb("🔗 Ikut Ticker lagi", `bxfollow:${kind}:${elem}`)]);
    }
  }
  rows.push([cb("👁 Lihat hasil", `bxp:${kind}`), cb("⬅ Kembali", `bxo:${kind}`)]);
  return Markup.inlineKeyboard(rows);
}
async function bxElemOpen(ctx, kind, elem) {
  await edit(ctx, bxElemText(kind, elem), bxElemKb(kind, elem));
}
async function bxPreview(ctx, kind) {
  const media = bannerTpl.mediaOverride(kind);
  // With a clip set, render and send the REAL animated result (exactly what posts),
  // not just a still frame. Falls back to a still if ffmpeg compositing isn't available.
  // A photo has no frames to composite onto — the layout editor does not apply.
  if (media && media.type !== "photo") {
    const filled = await bannerTpl.composeOntoClip(kind, media, sampleMedia(kind), sampleData(kind)).catch(() => null);
    if (filled) {
      await ctx
        .replyWithAnimation({ source: filled.source }, { caption: "👁 <b>Hasil gerak</b> — template GIF/video Anda dengan tata letak ini (data contoh). Beginilah yang akan diposting.", parse_mode: "HTML" })
        .catch(() => {});
      return;
    }
  }
  const buf = await bannerTpl.editorStill(kind, sampleMedia(kind), sampleData(kind)).catch(() => null);
  if (!buf) return ctx.reply("⚠️ Gagal membuat gambar — cek pm2 logs ([bannerTpl]); @napi-rs/canvas atau ffmpeg mungkin belum ada di server.").catch(() => {});
  const cap = media
    ? "👁 Hasil tata letak (gambar diam — penggabungan versi gerak gagal; cek ffmpeg di server). Post asli tetap memutar versi geraknya."
    : "👁 Hasil tata letak (data contoh).";
  await ctx.replyWithPhoto({ source: buf }, { caption: cap }).catch(() => {});
}

async function btPreview(ctx, kind, pct) {
  // `pct` (pump only) previews the alert at a specific % gain; omitted → the
  // configured window minimum, so the default example matches a real trigger.
  const data = sampleData(kind, pct);
  const pctNote = kind === "pump" ? ` — showing <b>${data.change}</b> (${data.priceFrom} → ${data.priceTo})` : "";
  // A GIF/video clip WINS over the still artwork in real posts, so preview IT — this is
  // exactly what will play above every post, letting the admin verify it before going live.
  const media = bannerTpl.mediaOverride(kind);
  // A still photo posts as a photo. Everything below it is clip machinery —
  // ffmpeg normalising, frame compositing — which would either fail on a JPG or
  // show the admin something the group will never receive.
  if (media && media.type === "photo") {
    await ctx
      .replyWithPhoto({ source: media.source }, { caption: `👁 <b>${BT_KINDS[kind]} preview</b> — dikirim apa adanya, detail token jadi captionnya.`, parse_mode: "HTML" })
      .catch((e) => ctx.reply(`⚠️ Gagal menampilkan foto: ${e.message}`).catch(() => {}));
    return;
  }
  if (media) {
    // Diagnostic: which exact clip file the preview resolved to (path+size+mtime).
    // If a stale-clip report ever recurs, this line pins whether the newest file
    // was picked, without guessing.
    try {
      const st = fss.statSync(media.source);
      log.info(`[adminbot] btPreview ${kind}: clip → ${media.source} (${st.size}B, mtime ${new Date(st.mtimeMs).toISOString()})`);
    } catch {
      /* stat is best-effort diagnostics */
    }
    // Token banners: preview the clip WITH sample token data composited on — exactly what
    // posts. Banner Ads composites the ADVERTISER'S CREATIVE into the frame's slot
    // instead of token data, which is the whole point of an ad template: the buyer's
    // artwork sits inside your frame, on every frame of the clip.
    // Falls back to the raw clip if ffmpeg compositing isn't available.
    if (BT_CLIP_FILL_KINDS.has(kind)) {
      const filled = await bannerTpl
        .composeOntoClip(kind, media, sampleMedia(kind), kind === "banner" ? {} : data)
        .catch(() => null);
      if (filled) {
        const what =
          kind === "banner"
            ? `the <b>advertiser's creative</b> drawn into the frame's slot (sample creative)`
            : `the token's data <b>drawn on automatically</b> (sample data)`;
        await ctx
          .replyWithAnimation({ source: filled.source }, { caption: `👁 <b>${BT_KINDS[kind]} preview</b>${pctNote} — your animated template with ${what}. Tune the slot in 🎛 Layout editor.`, parse_mode: "HTML" })
          .catch(() => {});
        return;
      }
    }
    // Preview the clip the way it will POST: normalised to a silent MP4 and
    // sent as an animation. Previewing the raw upload was misleading — an .mp4
    // came back as a video card with a play button, which is not what the
    // channel gets.
    const playable = await bannerTpl.toInlineClip(media).catch(() => media);
    const note = BT_FILL_KINDS.has(kind)
      ? ` In posts the bot draws the token's logo/$ticker/price onto it (couldn't composite here — check ffmpeg on the server).`
      : kind === "banner"
        ? ` In posts the advertiser's creative is drawn into the frame's slot.`
        : ` Played as-is; token details go in the caption.`;
    const cap = `👁 <b>${BT_KINDS[kind]} preview</b> — autoplaying clip.${note}`;
    try {
      await ctx.replyWithAnimation({ source: playable.source }, { caption: cap, parse_mode: "HTML" });
    } catch (e) {
      await ctx.reply(`⚠️ Gagal menampilkan GIF/video: ${e.message}`).catch(() => {});
    }
    return;
  }
  if (!bannerTpl.hasTemplate(kind)) {
    return ctx.reply(`❌ No ${BT_KINDS[kind]} artwork or clip yet. Tap ⬆ Upload artwork or 🎞 Upload GIF/Video first.`).catch(() => {});
  }
  const buf = await bannerTpl.compose(kind, sampleMedia(kind), data);
  if (!buf) return ctx.reply("⚠️ Preview failed — check pm2 logs.").catch(() => {});
  await ctx
    .replyWithPhoto({ source: buf }, { caption: `👁 ${BT_KINDS[kind]} preview${pctNote} — tune the slot/text until it sits perfectly.` })
    .catch(() => {});
}

// ── Views ────────────────────────────────────────────────────────────────────
function homeText() {
  return "🛠 <b>Dexvra Admin — Templates</b>\n\nEdit any bot message or channel-post layout. Changes go live within ~30s (no redeploy). Pick a category:";
}
// Plain-language meaning for every {placeholder}, so admins aren't staring at
// cryptic tags. AUTO ones are filled AND formatted automatically (usually leave
// them as-is); the rest are simple live values you place wherever you want them.
const PH_HELP = {
  // auto-filled links & blocks (leave them where they are)
  logoEmoji: "the token’s logo emoji",
  chainEmoji: "the network’s emoji (from the Chain emoji template)",
  twitter: "the token’s X link",
  website: "the token’s Website link",
  telegram: "the token’s Telegram link",
  site: "the dexvra.io link",
  listing: "the Listings channel link",
  trending: "the Trending channel link",
  announce: "the Announcements channel link",
  xUrl: "link to the X announcement post (auto after tweeting)",
  announceX: "the “Announce on X” link line (auto — shows after a tweet, hidden otherwise)",
  postLinks: "the posted-message links (Listing/Trending/Announcement — auto)",
  tradeUrl: "deep link that opens this token in the Dexvra Trade Bot",
  change: "24h change sentence",
  tierEmoji: "tier emoji (from the paid tier)",
  // legacy blocks (older saved templates only)
  head: "the header line (e.g. “New Listing on Dexvra”)",
  tierLine: "tier badge line (e.g. “💎 Diamond tier”)",
  overview: "the project description paragraph",
  socials: "the project’s social links block (X · Website · Telegram)",
  footer: "the Dexvra channel links block",
  // simple live values
  name: "token name",
  symbol: "ticker (e.g. $CUBEMAN)",
  tag: "ticker without the $",
  mention: "the token’s X @handle",
  chain: "blockchain (e.g. Solana)",
  address: "contract address",
  price: "token price",
  mcap: "market cap",
  liq: "liquidity",
  coinUrl: "full Dexvra token-page link",
  coinUrlLabel: "the Dexvra link shown as text",
  url: "link",
  rank: "trending rank number",
  percent: "pump % since listing",
  multiple: "pump multiple (e.g. 2×)",
  firstMc: "market cap at listing",
  lastMc: "current market cap",
  native: "native coin (SOL / BNB / ETH)",
  network: "which network to send on (Ethereum / Robinhood Chain)",
  hours: "number of hours",
  discount: "renewal discount %",
  reached: "number of users reached (the old receipt's line — the shipped copy no longer uses it)",
  reach: "whether it went out — filled by the bot, never typed",
  fail: "what could not be reached — filled by the bot, blank on a clean run",
  ref: "reference id",
  slot: "banner slot name",
  linkUrl: "advertiser link",
  title: "advertiser / project title",
  tier: "tier name (Diamond, Gold…)",
  // 🐋 WHALE WALLET card
  holds: "how much of THIS token the buyer holds (token amount)",
  holdsUsd: "that holding valued in USD at the pool price",
  position: "how much this buy grew their bag (or “new position”)",
  whaleBar: "the whale bar this wallet cleared (group’s /setwhale, else the global one)",
  wallet: "the whole 💼 Position row — holding · value · growth (vanishes if unreadable)",
  impact: "this buy as a % of the pool’s liquidity",
  tokenAmt: "tokens the buyer received",
  usd: "USD the buyer spent",
  verify: "the buyer + “View txn” row (drops on chains with no explorer)",
  emoji: "the buy-size icon row — one icon per step, bigger buy, longer row",
  bar: "a fill-meter version of the size row (off by default — see the template note)",
};
const AUTO_PH = new Set([
  "head", "tierLine", "logoEmoji", "overview", "socials", "footer",
  "chainEmoji", "twitter", "website", "telegram", "site", "listing", "trending", "announce",
  "xUrl", "tradeUrl", "change", "tierEmoji", "announceX", "postLinks",
]);

// A friendly legend: split the template's placeholders into "your values" vs
// "auto — leave as-is" with a plain description for each.
function phLegend(phList) {
  if (!phList || !phList.length) return "";
  const val = [];
  const auto = [];
  for (const p of phList) {
    const line = `• <code>{${p}}</code> — ${PH_HELP[p] || "live value"}`;
    (AUTO_PH.has(p) ? auto : val).push(line);
  }
  let out = "";
  if (val.length) out += `\n✍️ <b>Your values</b> (put where you want them):\n${val.join("\n")}\n`;
  if (auto.length) out += `\n🤖 <b>Auto — usually leave as-is</b>:\n${auto.join("\n")}\n`;
  return out;
}

// The controls card (label + placeholders + hint). The current text itself is
// NOT embedded here — it's sent as its own PLAIN message just above (see
// sendTemplateView), like fourtisadminbot, so operators see it as normal text
// with no code-box / blockquote / copy button.
/**
 * What the saved template did to its placeholders, as a line to append.
 *
 * A group card went out reading "{💎}" where its size row belongs: something had
 * turned {emoji} into {💎}, and nothing objected — a mangled placeholder is just
 * text, so it renders as text, in a customer's group, under their ticker. This
 * editor is the only place that can notice; by the time an alert posts it is far
 * too late.
 *
 * Shown on the CONTROLS CARD too, not only after a save, because the template
 * that broke was already broken — an operator opening it has to be told, not
 * left to spot a stray brace in a wall of copy.
 *
 * A WARNING, never a refusal. Dropping a placeholder on purpose is the whole
 * point of editing a template. Saying so is not.
 */
function placeholderWarning(key) {
  const val = tpl.getRawValue(key);
  const mangled = tpl.mangledPlaceholders(val);
  const missing = tpl.missingPlaceholders(key, val);
  const bits = [];
  if (mangled.length) {
    bits.push(
      `⚠️ <b>Placeholder rusak:</b> <code>${escapeHtml(mangled.join(" "))}</code> — ` +
        `ini tidak diisi apa pun dan akan tampil apa adanya di grup.`,
    );
  }
  if (missing.length) {
    bits.push(
      `ℹ️ Tidak lagi dipakai: <code>${escapeHtml(missing.map((m) => "{" + m + "}").join(" "))}</code>. ` +
        `Sengaja? Kalau tidak, ♻️ Reset default mengembalikannya.`,
    );
  }
  return bits.length ? "\n\n" + bits.join("\n") : "";
}

function viewText(key) {
  const m = tpl.meta(key);
  const val = tpl.getRawValue(key);
  let premiumNote = "";
  if (val && typeof val === "object" && val.entities && val.entities.length) {
    const nPrem = val.entities.filter((e) => e.type === "custom_emoji").length;
    premiumNote = nPrem
      ? `💎 Saved with ${nPrem} premium emoji.\n`
      : `ℹ️ Saved with ${val.entities.length} formatting entities.\n`;
  }
  return (
    `<b>${escapeHtml(m.label)}</b> — ${tpl.isCustom(key) ? "✏️ custom" : "📋 default"}\n` +
    `${premiumNote}` +
    `\n☝️ The message above is what’s live now. Tap <b>✏️ Edit</b> to change the wording — ` +
    `type it like a normal message (emoji & line breaks are kept).` +
    (m.ph.length
      ? ` The <code>{tags}</code> below get swapped for live data — keep the ones you want, delete the rest.\n${phLegend(m.ph)}`
      : ``) +
    placeholderWarning(key)
  );
}

// Send the current template as a PLAIN standalone message (premium emoji ride
// via entities; markup/default strings render to clean text), then the controls
// card — the fourtisadminbot layout.
async function sendTemplateView(ctx, key) {
  const cur = currentCopyable(key);
  if (cur.text && cur.text.trim()) {
    await ctx
      .reply(cur.text, cur.extra)
      .catch(() => ctx.reply(cur.text, { disable_web_page_preview: true }).catch(() => {}));
  }
  await ctx.reply(viewText(key), { ...HTML, ...viewKb(key) }).catch(() => {});
}

// The current template value in COPYABLE form, so an admin can copy → tweak →
// send back instead of retyping a long message from scratch. Entity-saved
// templates keep their text (premium emoji ride as fallback chars — a regular
// bot can't re-emit real premium emoji, and the admin re-inserts their own
// anyway); markup/default strings are rendered to clean text (no raw
// [💎](emoji/ID) / **bold** noise).
function currentCopyable(key) {
  const val = tpl.getRawValue(key);
  if (val && typeof val === "object" && val.text != null) {
    const extra = val.entities && val.entities.length
      ? { entities: val.entities, disable_web_page_preview: true }
      : { disable_web_page_preview: true };
    return { text: val.text, extra };
  }
  let clean;
  try {
    clean = require("../premium").parse(String(val || "")).text;
  } catch {
    clean = String(val || "");
  }
  return { text: clean, extra: { disable_web_page_preview: true } };
}

async function edit(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { ...HTML, ...(kb || {}) });
  } catch (e) {
    // "message is not modified" means the panel already shows this exactly —
    // re-sending it as a NEW message just stacks duplicates down the chat.
    if (/not modified/i.test(e && e.message ? e.message : "")) return;
    await ctx.reply(text, { ...HTML, ...(kb || {}) });
  }
}

async function saveBanner(telegram, fileId) {
  await downloadTo(telegram, fileId, tpl.BANNER_PATH);
}
/** Download a Telegram file to a Buffer, resiliently. Two failure modes are
 *  handled explicitly instead of surfacing a bare "fetch failed":
 *   • getFileLink throws for files over the Bot API's 20 MB getFile ceiling →
 *     a clear "too big" message with the actual limit.
 *   • the GET itself fails transiently (a DNS/TLS/connection-reset blip to
 *     api.telegram.org — undici reports these as "fetch failed") → retried a few
 *     times with backoff, and the REAL cause (e.cause.code) is surfaced. */
async function fetchTelegramFileBuffer(telegram, fileId, { timeoutMs = 30000, tries = 3 } = {}) {
  let link;
  try {
    link = await telegram.getFileLink(fileId);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/too big|file is too big|413|420/i.test(msg)) {
      throw new Error("file is too big — a Telegram bot can only fetch files up to 20 MB. Compress the clip or send a shorter one.");
    }
    throw new Error(`couldn't get the file link: ${msg}`);
  }
  const url = link.href || String(link);
  let lastErr = "unknown error";
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      // undici hides the real transport reason in .cause — that's the useful bit.
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      lastErr = cause ? `${e.message} (${cause})` : (e && e.message) || String(e);
      log.warn(`[adminbot] telegram download attempt ${i}/${tries} failed: ${lastErr}`);
      if (i < tries) await new Promise((r) => setTimeout(r, 800 * i)); // 0.8s → 1.6s backoff
    }
  }
  throw new Error(`download failed after ${tries} tries (${lastErr}) — Telegram may be briefly unreachable from the server; try again in a moment.`);
}
async function downloadTo(telegram, fileId, destPath) {
  const buf = await fetchTelegramFileBuffer(telegram, fileId, { timeoutMs: 20000 });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
}

// ── Broadcast ────────────────────────────────────────────────────────────────
function bcControlKb(count) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Send to all (${count})`, "bc_send")],
    [Markup.button.callback("🧪 Test (me only)", "bc_test")],
    [Markup.button.callback("❌ Cancel", "bc_cancel")],
  ]);
}

// ── Broadcast Manager — the fourtis adminbot's dashboard, over this bot's
//    own job store: who can be reached, how the last send went, and the
//    all-time record, with every broadcast action one tap below it. ─────────
const bcDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

function bcManagerText(s = bcStore.stats(), audienceCount = bcStore.audience().length) {
  const last = s.lastCompleted
    ? `${bcDate(s.lastCompleted.finishedAt || s.lastCompleted.createdAt)} · ✅ ${s.lastCompleted.sent} / ${s.lastCompleted.total} · ❌ ${s.lastCompleted.failed}`
    : "— none completed yet";
  // No fabricated 100% over zero attempts: with nothing sent there is no rate.
  const rate = s.successRate == null ? "—" : `${s.successRate.toFixed(1)}%`;
  return (
    `📣 <b>Broadcast Manager</b>\n\n` +
    `👥 <b>Audience</b>\n· Total users: <b>${audienceCount}</b>\n\n` +
    `🏁 <b>Last completed</b>\n${last}\n\n` +
    `📈 <b>All-time</b>\n` +
    `· Broadcasts: <b>${s.broadcasts}</b> (${s.done} done)\n` +
    `· Messages sent: <b>${s.sent}</b>\n` +
    `· Success rate: <b>${rate}</b>`
  );
}

function bcManagerKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Create Broadcast", "bc_new")],
    [Markup.button.callback("📋 Status", "bc_status"), Markup.button.callback("✏️ Edit Sent", "bc_edit")],
    [Markup.button.callback("📁 History / Export", "bc_hist")],
    [Markup.button.callback("🔄 Refresh", "bc_refresh"), Markup.button.callback("🏠 Home", "home")],
  ]);
}

const bcKindTag = (j) =>
  `${(j.kind || "send") === "edit" ? "✏️ edit" : "📣 send"}${j.test ? " · 🧪 test" : ""}`;

/** History: the last N jobs, newest first — date, kind, and the counts that
 *  say how it went. `jobs` is an argument so the render is testable without a
 *  disk (the stats() rule). */
function bcHistoryText(jobs = bcStore.allJobs(), limit = 10) {
  if (!jobs.length) return "📁 <b>Broadcast history</b>\n\nNo broadcasts yet.";
  const lines = jobs.slice(0, limit).map((j) => {
    const st = j.status === "completed" ? `✅ ${j.sent}/${j.total} · ❌ ${j.failed}` : `⏳ ${j.status} (${j.cursor}/${j.total})`;
    return `${bcDate(j.finishedAt || j.createdAt)} · ${bcKindTag(j)} · ${st}`;
  });
  const more = jobs.length > limit ? `\n\n…and ${jobs.length - limit} older — 📤 Export has all of them.` : "";
  return `📁 <b>Broadcast history</b> (${jobs.length} total)\n\n${lines.join("\n")}${more}`;
}

/** The full record as CSV — the export half of 📁 History / Export. */
function bcCsv(jobs = bcStore.allJobs()) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = "id,kind,test,status,created_at,finished_at,sent,failed,total,by";
  const rows = jobs.map((j) =>
    [
      j.id,
      j.kind || "send",
      j.test ? "yes" : "no",
      j.status,
      new Date(j.createdAt).toISOString(),
      j.finishedAt ? new Date(j.finishedAt).toISOString() : "",
      j.sent,
      j.failed,
      j.total,
      j.createdByUsername ? `@${j.createdByUsername}` : j.createdBy,
    ]
      .map(esc)
      .join(","),
  );
  return [head, ...rows].join("\n");
}

/** The newest completed real send that ✏️ Edit Sent can point at — or the
 *  reason there is none. Two different "no" answers on purpose: "nothing to
 *  edit" and "sent before message ids were recorded" send the admin to
 *  different conclusions. */
function bcEditable() {
  const done = bcStore
    .allJobs()
    .filter((j) => (j.kind || "send") === "send" && !j.test && j.status === "completed");
  if (!done.length) return { error: "none" };
  const job = done[0]; // allJobs is newest-first
  if (!job.sentIds || !Object.keys(job.sentIds).length) return { error: "no_ids", job };
  return { job };
}

/** Poll a broadcast job and live-edit a status message until it completes. */
function pollProgress(telegram, chatId, messageId, jobId) {
  const started = Date.now();
  let lastText = "";
  const iv = setInterval(async () => {
    const job = bcStore.loadJob(jobId);
    if (!job || Date.now() - started > 20 * 60 * 1000) {
      clearInterval(iv);
      return;
    }
    const done = job.status === "completed";
    const isEdit = (job.kind || "send") === "edit";
    const pct = job.total ? Math.round((job.cursor / job.total) * 100) : 100;
    const verb = isEdit ? "Edited" : "Sent";
    const text = done
      ? `✅ <b>${isEdit ? "Edit" : "Broadcast"} complete</b>${job.test ? " (test)" : ""}\n${verb}: <b>${job.sent}</b>  ·  Failed: <b>${job.failed}</b>  ·  Total: <b>${job.total}</b>`
      : `📣 <b>${isEdit ? "Editing sent messages…" : "Broadcasting…"}</b>${job.test ? " (test)" : ""}\nProgress: <b>${pct}%</b> (${job.cursor}/${job.total})\n${verb}: ${job.sent}  ·  Failed: ${job.failed}`;
    if (text !== lastText) {
      lastText = text;
      try {
        await telegram.editMessageText(chatId, messageId, undefined, text, HTML);
      } catch {
        /* not modified / too old */
      }
    }
    if (done) clearInterval(iv);
  }, 3000);
}

async function launchBroadcast(ctx, test) {
  const draft = ctx.session.bcDraft;
  if (!draft) return ctx.reply("Nothing composed. Tap ➕ Create Broadcast to start.").catch(() => {});
  const targets = test ? [String(ctx.from.id)] : bcStore.audience();
  if (!targets.length) {
    return ctx.reply("No /start users yet — nobody to broadcast to.").catch(() => {});
  }
  let mediaPath = null;
  if (draft.adminFileId) {
    try {
      mediaPath = path.join(bcStore.BC_DIR, `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.img`);
      await downloadTo(ctx.telegram, draft.adminFileId, mediaPath);
    } catch (e) {
      return ctx.reply(`⚠️ Couldn't prepare the image: ${e.message}`).catch(() => {});
    }
  }
  const job = await bcStore.createJob({
    text: draft.text || "",
    entities: draft.entities || [],
    mediaPath,
    createdBy: String(ctx.from.id),
    createdByUsername: ctx.from.username,
    targets,
    test,
  });
  ctx.session.bcDraft = null;
  const msg = await ctx.reply(
    `📣 <b>Broadcast queued</b> to <b>${targets.length}</b> user(s). Delivering via the main bot…`,
    HTML,
  );
  pollProgress(ctx.telegram, msg.chat.id, msg.message_id, job.id);
}

// The admin bot can't DM a buyer with its own token (the buyer /start-ed the
// MAIN bot). A minimal main-bot Telegram client lets us notify buyers on
// reject. Telegraf's telegram client needs no polling — send-only is fine.
let mainBotApi = null;
try {
  const { BOT_TOKEN } = require("../config/constants");
  if (BOT_TOKEN) mainBotApi = new Telegraf(BOT_TOKEN).telegram;
} catch {
  /* main-bot DMs are best-effort */
}

// ── Bot ──────────────────────────────────────────────────────────────────────
function build() {
  const bot = new Telegraf(ADMIN_BOT_TOKEN, { handlerTimeout: 60000 });
  bot.use(session({ getSessionKey: (ctx) => (ctx.from && ctx.chat ? `${ctx.from.id}:${ctx.chat.id}` : undefined), defaultSession: () => ({}) }));

  const start = async (ctx) => {
    if (!guard(ctx)) return ctx.reply("⛔ Admins only.").catch(() => {});
    ctx.session = {};
    await ctx.reply(homeText(), { ...HTML, ...mainKb() });
  };
  bot.start(start);
  bot.command("home", start);

  // /preview [group-slug] — audit EVERY template at once (clean rendered text,
  // grouped, ✏️=custom / •=default). No arg → short snippet of all; a group slug
  // → longer previews for just that group. Messages are chunked under 4096.
  bot.command("preview", async (ctx) => {
    if (!guard(ctx)) return;
    await sendTemplateAudit(ctx, (ctx.message.text.split(/\s+/)[1] || "").toLowerCase());
  });
  bot.action("audit", async (ctx) => {
    ctx.answerCbQuery("Auditing all templates…").catch(() => {});
    if (!guard(ctx)) return;
    await sendTemplateAudit(ctx, "");
  });

  // Why isn't the trending board premium? — names the actual blocking cause.
  bot.command("premium", async (ctx) => {
    if (!guard(ctx)) return;
    await ctx.reply(await premiumReportText(), { ...HTML, ...Markup.inlineKeyboard([[Markup.button.callback("⬅ Trending board", "tb")]]) }).catch(() => {});
  });

  // Reset ALL templates to their code defaults — destructive, so gate behind a
  // confirm. Counts how many custom overrides exist before wiping.
  bot.action("resetall", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    // overrideCount() counts EVERY saved override, incl. orphaned keys from
    // older template generations — keys() would miss those and wrongly report
    // "nothing to reset" on a data file that still has stale entries.
    const n = tpl.overrideCount();
    if (!n) {
      return edit(ctx, "♻️ <b>Nothing to reset</b>\n\nEvery template is already on its default.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "home")]]));
    }
    await edit(
      ctx,
      `♻️ <b>Reset ALL templates to default?</b>\n\nThis reverts <b>${n}</b> custom template${n === 1 ? "" : "s"} you've edited back to the built-in defaults. This cannot be undone.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Yes, reset all ${n}`, "resetall_yes")],
        [Markup.button.callback("⬅ Cancel", "home")],
      ]),
    );
  });
  bot.action("resetall_yes", async (ctx) => {
    ctx.answerCbQuery("Resetting…").catch(() => {});
    if (!guard(ctx)) return;
    const n = await tpl.resetAllTemplates();
    log.info(`[adminbot] ALL templates reset to default (${n} custom cleared) by @${ctx.from.username || ctx.from.id}`);
    await edit(
      ctx,
      `✅ <b>Done — ${n} template${n === 1 ? "" : "s"} reset to default.</b>\n\nAll bot messages and channel posts are back to the built-in copy. Goes live within ~30s.`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅ Back to menu", "home")]]),
    );
  });

  bot.action("home", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session = {};
    await edit(ctx, homeText(), mainKb());
  });

  bot.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.action(/^grp:([a-z0-9]+)(?::(\d+))?$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const slug = ctx.match[1];
    const name = nameFromSlug(slug);
    if (!name) return edit(ctx, homeText(), mainKb());
    const g = tpl.groups()[name] || [];
    const pages = pageCount(g.length);
    const p = clampPage(ctx.match[2], pages);
    await edit(ctx, groupText(name, p, pages), groupKb(slug, p));
  });

  bot.action(/^v:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await sendTemplateView(ctx, key);
  });

  bot.action(/^e:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    ctx.session.awaitingTemplate = key;
    const m = tpl.meta(key);
    await ctx.reply(
      `✏️ Send the new text for <b>${escapeHtml(m.label)}</b>.\n\n` +
        `Type it like a normal message — line breaks, spaces and emoji are kept exactly. ` +
        `💎 For <b>premium emoji</b>, insert them straight from your keyboard as you type.\n\n` +
        `Tip: copy the current text shown above, tweak the wording, and send it back — keep the <code>{tags}</code> where you want the live values.` +
        (m.ph.length ? `\n${phLegend(m.ph)}` : ``) +
        `\nSend /cancel to abort.`,
      HTML,
    );
  });

  // ── Swap ONE emoji in a template ─────────────────────────────────────────
  // Editing a template means re-sending the whole message; swapping a single
  // emoji in a 12-line card that way is absurd, and it is the most common edit
  // an operator actually wants.
  bot.action(/^tem:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await sendEmojiPicker(ctx, key);
  });

  // ── Every icon on the buy card, one screen ───────────────────────────────

  async function sendBuyEmojiPicker(ctx) {
    await ctx.reply(buyEmojiText(), { ...HTML, ...buyEmojiKb() }).catch(() => {});
  }

  bot.action(/^adopt:(.+)$/, async (ctx) => {
    ctx.answerCbQuery("Mengambil layout terbaru…").catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    let res;
    try {
      res = await tpl.adoptShippedLayout(key);
    } catch (e) {
      return ctx.reply(`⚠️ ${escapeHtml(String(e && e.message))}`, HTML).catch(() => {});
    }
    log.info(`[adminbot] '${key}' adopted the shipped layout by @${ctx.from.username || ctx.from.id} — ${res.carried} icon(s) kept, ${res.dropped.length} line(s) dropped`);
    // Every dropped line is named. This action deletes copy, and an operator has
    // to be able to see exactly what left rather than trust that it was stale.
    await ctx
      .reply(
        `✅ <b>${escapeHtml(tpl.meta(key).label)}</b> sekarang pakai layout terbaru.\n` +
          `🎨 ${res.carried} emoji Anda dipertahankan.` +
          (res.dropped.length
            ? `\n\n🗑 Baris yang hilang (sudah tidak ada di versi terbaru):\n` +
              res.dropped.map((l) => `<code>${escapeHtml(l)}</code>`).join("\n")
            : "\n\nTidak ada baris yang dibuang.") +
          `\n\nKalau ini bukan yang Anda mau, ♻️ Reset default mengembalikan kartu bawaan.`,
        HTML,
      )
      .catch(() => {});
    await sendTemplatePreview(ctx, key);
    await sendTemplateView(ctx, key);
  });

  bot.action(/^temp:(.+)$/, async (ctx) => {
    ctx.answerCbQuery("Merender…").catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await sendTemplatePreview(ctx, key);
  });

  bot.action("bemp", async (ctx) => {
    ctx.answerCbQuery("Merender…").catch(() => {});
    if (!guard(ctx)) return;
    await sendBuyPreview(ctx);
    await sendBuyEmojiPicker(ctx);
  });

  bot.action("bem", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await sendBuyEmojiPicker(ctx);
  });

  // ── The buy card's and the raid's icons, one screen ──────────────────────
  async function sendAllEmojiPicker(ctx, page) {
    await ctx.reply(allEmojiText(page), { ...HTML, ...allEmojiKb(page) }).catch(() => {});
  }
  /** Both surfaces this screen owns, as a group would receive them: the buy
   *  card through the alert's own sender (so its clip plays too), the raid card
   *  through the same renderer the live board uses. */
  async function sendAllEmojiPreview(ctx) {
    await sendBuyPreview(ctx, "buy");
    let payload;
    try {
      payload = renderSample("raid_card");
    } catch (e) {
      return void ctx.reply(`⚠️ Kartu raid gagal dirender: <code>${escapeHtml(String(e && e.message))}</code>`, HTML).catch(() => {});
    }
    const { text, extra } = payloadArgs(payload);
    await ctx.reply(`👁 <b>Raid</b> — contoh`, HTML).catch(() => {});
    await ctx.reply(text, extra).catch((e) => {
      ctx.reply(`⚠️ Telegram menolak kartu ini: <code>${escapeHtml(String(e && e.message))}</code>`, HTML).catch(() => {});
    });
  }
  /**
   * The card(s) ONE slot appears on — the answer to "untuk yang mana?".
   *
   * Only the surfaces the slot actually touches. An icon that lives on the buy
   * card gets the buy card; a raid icon gets the raid card; the handful that
   * appear on both get both. Sending everything every time would make the
   * preview something an operator scrolls past instead of reads.
   */
  async function sendSlotPreview(ctx, slot) {
    const keys = new Set(slot.spots.map((s) => s.key));
    const onBuy = BUY_CARD_EMOJI_KEYS.some((k) => keys.has(k));
    const onRaid = [...keys].some((k) => k.startsWith("raid_"));
    if (onBuy) await sendBuyPreview(ctx, "buy");
    if (onRaid) {
      try {
        const { text, extra } = payloadArgs(renderSample("raid_card"));
        await ctx.reply(`👁 <b>Raid</b> — contoh`, HTML).catch(() => {});
        await ctx.reply(text, extra).catch(() => {});
      } catch {
        /* a template that will not render must not block the swap */
      }
    }
    // Neither: the icon lives on a toast or a prompt, which has no card. The
    // named list above is the whole answer, and inventing a card for it would
    // be worse than saying nothing.
  }

  bot.action(/^aemp:(\d+)$/, async (ctx) => {
    ctx.answerCbQuery("Merender…").catch(() => {});
    if (!guard(ctx)) return;
    await sendAllEmojiPreview(ctx);
    await sendAllEmojiPicker(ctx, Number(ctx.match[1]) || 0);
  });
  bot.action(/^aem:(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const page = Number(ctx.match[1]) || 0;
    // Repainted in place when paging, so flipping through four pages does not
    // leave four identical screens in the chat.
    await edit(ctx, allEmojiText(page), allEmojiKb(page));
  });
  bot.action(/^aemx:(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    // Re-derived at press time, never trusted from the button: an operator can
    // leave this open, edit a template elsewhere, and come back to a keyboard
    // whose slot numbers no longer describe anything.
    const slots = allEmojiSlots();
    const slot = slots[Number(ctx.match[1])];
    if (!slot) return sendAllEmojiPicker(ctx, 0);
    const page = Math.floor(Number(ctx.match[1]) / ALL_EMOJI_PER_PAGE);
    ctx.session.awaitingEmoji = { spots: slot.spots, from: "aem", page, was: slot.char };
    const keys = [...new Set(slot.spots.map((s) => s.key))];
    // NAMED, not counted. "6 tempat di 6 template" tells an operator the blast
    // radius and nothing about the blast: they are about to change an icon they
    // cannot place, on cards they cannot see from here. The templates are
    // listed by their own labels, and the CARD each one feeds is previewed
    // below — so the question "untuk yang mana?" is answered before the answer
    // matters rather than after.
    const labels = keys.map((k) => {
      try {
        return tpl.meta(k).label;
      } catch {
        return k;
      }
    });
    await ctx.reply(
      `⌨ Kirim emoji pengganti untuk ${escapeHtml(slot.char)}` +
        `${slot.label ? ` — <b>${escapeHtml(slot.label)}</b>` : ""}${slot.id ? " (sekarang 💎 premium)" : ""}.\n\n` +
        `Ini akan mengubah <b>${slot.spots.length} tempat</b> di ${keys.length} template:\n` +
        labels.map((l) => `• ${escapeHtml(l)}`).join("\n") +
        `\n\nTeks template tidak diubah sama sekali.\n\n/cancel untuk batal.` +
        premiumNoteFor(keys),
      HTML,
    );
    // …and the card itself, so the icon is seen where it lives. Only the
    // surfaces this slot actually touches: previewing a raid card under a
    // question about the money row is noise.
    await sendSlotPreview(ctx, slot);
  });

  bot.action(/^bemx:(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    // Re-derived at press time, never trusted from the button: an operator can
    // leave this screen open, edit a template from another chat, and come back
    // to a keyboard whose slot numbers no longer describe anything.
    const slot = buyEmojiSlots()[Number(ctx.match[1])];
    if (!slot) return sendBuyEmojiPicker(ctx);
    ctx.session.awaitingEmoji = { spots: slot.spots, from: "bem", was: slot.char };
    const where = slot.chain
      ? `lambang jaringan <b>${escapeHtml(slot.label)}</b>`
      : `ikon <b>${escapeHtml(slot.label || slot.char)}</b>`;
    await ctx.reply(
      `⌨ Kirim emoji pengganti untuk ${escapeHtml(slot.char)} — ${where}` +
        `${slot.id ? " (sekarang 💎 premium)" : ""}.\n\n` +
        `Kirim emoji <b>premium</b> dan tetap premium. ` +
        `Teks template tidak diubah sama sekali` +
        (slot.spots.length > 1 ? `, dan ${slot.spots.length} tempat yang memakai ikon ini ikut berubah` : "") +
        `. /cancel untuk batal.` +
        premiumNoteFor(slot.spots.map((sp) => sp.key)),
      HTML,
    );
  });
  bot.action(/^temx:([^:]+):(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    const i = Number(ctx.match[2]);
    const cur = tpl.listEmojis(key)[i];
    if (!cur) return;
    ctx.session.awaitingEmoji = { key, i };
    await ctx.reply(
      `⌨ Send the emoji to put in place of <b>${escapeHtml(cur.char)}</b> (#${i + 1})` +
        `${cur.id ? " — 💎 currently premium" : ""}.\n\n` +
        `Send a <b>premium</b> emoji and it stays premium. Everything else in the template is left untouched. /cancel to abort.` +
        premiumNoteFor(key),
      HTML,
    );
  });

  bot.action(/^r:(.+)$/, async (ctx) => {
    ctx.answerCbQuery("Reset to default").catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await tpl.resetTemplate(key);
    await sendTemplateView(ctx, key);
  });

  async function sendEmojiPicker(ctx, key) {
    const list = tpl.listEmojis(key);
    if (!list.length) {
      return ctx.reply("This template has no emoji to swap — use ✏️ Edit to change the text.", HTML).catch(() => {});
    }
    const cb = Markup.button.callback;
    // EVERY button says which row it belongs to, read out of the template
    // itself — the same hint the buy-card screen shows. Without it this was six
    // anonymous glyphs in a grid: an operator could see 💎📈 twice and had no way
    // to tell the price row from the Chart button, and a `key = emoji` map was a
    // row of near-identical coloured circles with nothing saying which is
    // Ethereum, Base or TON.
    const hints = list.map((e) => emojiHint(key, e));
    const labelled = hints.some(Boolean);
    const btns = list
      .slice(0, 48)
      .map((e) => cb(`${e.id ? "💎" : ""}${e.char}${hints[e.i] ? ` ${hints[e.i]}` : ""}`, `temx:${key}:${e.i}`));
    const perRow = labelled ? 3 : 6;
    const rows = [];
    for (let i = 0; i < btns.length; i += perRow) rows.push(btns.slice(i, i + perRow));
    // Look at the result without changing anything first — the same button the
    // buy-card screen has, on every template.
    rows.push([cb("👁 Lihat hasilnya", `temp:${key}`)]);
    rows.push([cb("⬅ Back", `v:${key}`)]); // the view handler is v:, not t: — this button was dead
    // The buy and whale cards each have their own copy of the same icon column,
    // so editing one here leaves the other looking different — which is exactly
    // the "the emoji do not match the card" confusion. Point at the screen that
    // changes both at once.
    // Names the SAME screen the button below offers — see the note there. Gated
    // on the buy card's eight, this pointer was invisible on every raid
    // template, so the one screen that can restyle a raid card went unnamed on
    // the very screen an operator opens when they want to.
    const buyScreen = BUY_CARD_EMOJI_KEYS.includes(key) || key === "chain_emojis";
    const raidScreen = !buyScreen && allEmojiKeys().includes(key);
    const sharedScreen = buyScreen
      ? "kartu <b>buy</b> dan <b>whale</b> sekaligus, pakai <b>🎨 Semua emoji kartu buy</b>"
      : "kartu <b>buy</b>, <b>whale</b> dan <b>raid</b> sekaligus, pakai <b>🎨 Semua emoji kartu buy + raid</b>";
    const bothCards = buyScreen || raidScreen;
    await ctx
      .reply(
        `😀 <b>Swap an emoji</b> — ${escapeHtml(tpl.meta(key).label)}\n\n` +
          `Tekan ikon yang mau diganti. Tulisan di sampingnya adalah baris tempat ikon itu dipakai. ` +
          `💎 menandai yang sudah premium.` +
          (list.length > 48 ? `\n\n<i>Showing the first 48 of ${list.length}.</i>` : "") +
          (bothCards
            ? `\n\nℹ️ Ini hanya kartu <b>${escapeHtml(tpl.meta(key).label)}</b>. Untuk mengganti ikon di ${sharedScreen}.`
            : "") +
          premiumNoteFor(key),
        { ...HTML, ...Markup.inlineKeyboard(rows) },
      )
      .catch(() => {});
  }

  bot.action("banner", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(
      ctx,
      `🖼 <b>Banner Image</b>\n\nShown on /start in the main bot.\nStatus: ${bannerExists() ? "✅ set" : "— none"}`,
      bannerKb(),
    );
  });
  bot.action("bup", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBanner = true;
    await ctx.reply("⬆ Send the banner <b>image as a photo</b>. Send /cancel to abort.", HTML);
  });
  bot.action("brm", async (ctx) => {
    ctx.answerCbQuery("Removed").catch(() => {});
    if (!guard(ctx)) return;
    try {
      await fs.unlink(tpl.BANNER_PATH);
    } catch {
      /* already gone */
    }
    await edit(ctx, `🖼 <b>Banner Image</b>\n\nStatus: — none`, bannerKb());
  });

  // ── Channel banner artwork (template compositor, per service) ──
  const K = "(listing|trending|banner)";
  // Media-capable kinds (incl. pump, rank-up, the group buy/whale alerts and the
  // shared ⭐ default fallback). A kind missing from here renders a button that
  // silently does nothing.
  const KM = "(listing|trending|banner|pump|rankup|buy|whale|default)";
  bot.action("bt", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btHomeText(), btHomeKb());
  });
  bot.action(new RegExp(`^btk:${KM}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
  });
  // Upload a GIF/video clip for a kind (incl. pump). Accepts animation/video/
  // document; the file's extension picks animation vs video at send time.
  bot.action(new RegExp(`^bt_med:${KM}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "media_upload", kind };
    const fillNote = BT_FILL_KINDS.has(kind)
      ? `\n\n✨ <b>Auto-fill:</b> send an <b>EMPTY animated template</b> (ideally <b>2560×1280</b>, no text/logo baked in). The bot draws each token's <b>logo, $ticker, name and price/MC</b> onto it automatically — same as the still artwork, but animated.`
      : kind === "banner"
        ? `\n\n⚠️ Banner Ads play the advertiser's clip <b>as-is</b> — token data is not drawn onto it.`
        : "";
    const photoNote = BT_PHOTO_KINDS.has(kind)
      ? ` <b>Foto juga boleh</b> (JPG/PNG) kalau Anda mau gambar diam — dikirim apa adanya di atas caption alert.`
      : "";
    await ctx.reply(
      `🎞 Kirim <b>${btMediaWord(kind)} untuk ${BT_KINDS[kind]}</b> — GIF/animasi atau MP4 pendek (kirim sebagai <b>file/dokumen</b> supaya kualitasnya bagus, maks ~20 MB). Ini diputar di atas setiap post ${BT_KINDS[kind]}.${photoNote}${fillNote}\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_medrm:${KM}$`), async (ctx) => {
    ctx.answerCbQuery("Clip removed").catch(() => {});
    if (!guard(ctx)) return;
    await bannerTpl.removeMedia(ctx.match[1]);
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
  });
  bot.action(new RegExp(`^bt_up:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "upload", kind: ctx.match[1] };
    await ctx.reply(
      `⬆ Kirim <b>gambar ${BT_KINDS[ctx.match[1]]}</b> — sebaiknya <b>PNG 2560×1280 dikirim sebagai FILE/dokumen</b> (Telegram mengompres foto jadi ~1280px; foto biasa tetap bisa, cuma diperbesar otomatis).\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  // Banner posts master switch — persisted config, beats POST_BANNERS env.
  bot.action(/^bt_on:(0|1)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const on = ctx.match[1] === "1";
    await bannerTpl.setPostingEnabled(on);
    log.info(`[adminbot] banner posts turned ${on ? "ON" : "OFF"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(on ? "🟢 Banner posts ON" : "🔴 Banner posts OFF").catch(() => {});
    await edit(ctx, btHomeText(), btHomeKb());
  });

  // ── Pump alert window (min%/max%) ──
  bot.action("pth", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, pthText(), pthKb());
  });
  bot.action(/^pwmin:(-?\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const cur = pumpConfig.get();
    const res = await pumpConfig.set({ minPct: cur.minPct + Number(ctx.match[1]) });
    ctx.answerCbQuery(`Min ${res.minPct}%`).catch(() => {});
    await edit(ctx, pthText(), pthKb());
  });
  bot.action(/^pwmax:(-?\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const cur = pumpConfig.get();
    const res = await pumpConfig.set({ maxPct: cur.maxPct + Number(ctx.match[1]) });
    ctx.answerCbQuery(`Max ${res.maxPct}%`).catch(() => {});
    await edit(ctx, pthText(), pthKb());
  });
  bot.action("pwset", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "pumpwindow" };
    const { minPct, maxPct } = pumpConfig.get();
    await ctx.reply(
      `⌨ <b>Pump alert window</b>\nNow: <b>${minPct}%–${maxPct}%</b>\n\nSend the new window as <code>MIN,MAX</code> (percent, min first).\n👉 Example: <code>100,2000</code>\n\n/cancel to abort.`,
      HTML,
    );
  });
  bot.action("pwrst", async (ctx) => {
    if (!guard(ctx)) return;
    const res = await pumpConfig.reset();
    log.info(`[adminbot] pump window reset to ${res.minPct}%–${res.maxPct}% by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(`↩️ Reset ${res.minPct}%–${res.maxPct}%`).catch(() => {});
    await edit(ctx, pthText(), pthKb());
  });
  // Preview the pump alert at a chosen % gain (min / mid / max shortcuts).
  bot.action(/^pwpv:(\d+)$/, async (ctx) => {
    ctx.answerCbQuery("Sedang membuat gambar…").catch(() => {});
    if (!guard(ctx)) return;
    if (!bannerTpl.mediaOverride("pump")) {
      return ctx.reply("❌ No pump clip yet — tap 🎞 Upload GIF/Video first, then preview.").catch(() => {});
    }
    await btPreview(ctx, "pump", Number(ctx.match[1]));
  });
  bot.action("pwpvc", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "pumppreviewpct" };
    const { minPct, maxPct } = pumpConfig.get();
    await ctx.reply(
      `⌨ <b>Preview at what %?</b>\nWindow is <b>${minPct}%–${maxPct}%</b>.\n\nSend a number, e.g. <code>${minPct}</code>, <code>${Math.round((minPct + maxPct) / 2)}</code> or <code>${maxPct}</code>.\n\n/cancel to abort.`,
      HTML,
    );
  });

  // ── Whale WALLET bar (global; a group's own /setwhale still wins) ──
  bot.action("wth", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, wthText(), wthKb());
  });
  bot.action(/^wwal:(-?\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const cur = whaleConfig.get();
    const res = await whaleConfig.set({ walletUsd: cur.walletUsd + Number(ctx.match[1]) });
    ctx.answerCbQuery(`Batas saldo ${usdLabel(res.walletUsd)}`).catch(() => {});
    await edit(ctx, wthText(), wthKb());
  });
  bot.action(/^wmin:(-?\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const cur = whaleConfig.get();
    const res = await whaleConfig.set({ minBuyUsd: cur.minBuyUsd + Number(ctx.match[1]) });
    ctx.answerCbQuery(`Min beli ${usdLabel(res.minBuyUsd)}`).catch(() => {});
    await edit(ctx, wthText(), wthKb());
  });
  bot.action("wwset", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "whalebar" };
    const w = whaleConfig.get();
    await ctx.reply(
      `⌨ <b>Batas Whale Wallet</b>\nSekarang: <b>${usdLabel(w.walletUsd)}</b>\n\n` +
        `Kirim angka USD-nya saja.\n👉 Contoh: <code>50000</code>\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  bot.action(/^wwon:(0|1)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const res = await whaleConfig.set({ enabled: ctx.match[1] === "1" });
    log.info(`[adminbot] whale wallet alerts turned ${res.enabled ? "ON" : "OFF"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(res.enabled ? "🐋 Whale alert AKTIF" : "🔴 Whale alert MATI").catch(() => {});
    await edit(ctx, wthText(), wthKb());
  });
  bot.action("wwrst", async (ctx) => {
    if (!guard(ctx)) return;
    const res = await whaleConfig.reset();
    log.info(`[adminbot] whale bar reset to ${res.walletUsd} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(`↩️ Reset ${usdLabel(res.walletUsd)}`).catch(() => {});
    await edit(ctx, wthText(), wthKb());
  });

  // ── Auto Trending (auto-fill slots, random duration/timing, max 18h) ──
  bot.action("at", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    _atCounts = await autoTrend.featuredByChain().catch(() => ({}));
    _atPending = autoTrend.pendingCount();
    await edit(ctx, atText(), atKb());
  });
  bot.action("atann", async (ctx) => {
    if (!guard(ctx)) return;
    const c = await autoTrend.set({ announce: !autoTrend.get().announce });
    log.info(`[adminbot] auto-trend announce ${c.announce ? "ON" : "OFF"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(c.announce ? "📣 Auto slots post a Spotlight card" : "🤫 Board only, no channel post").catch(() => {});
    await edit(ctx, atText(), atKb());
  });
  // ⚠️ SWITCH A CHAIN ON OR OFF FOR THE TRENDING BOARD.
  //
  // `cfg.chains` decides what the channel COVERS — the poster skips a chain
  // that is off, and the promoter never fills one. Until now it could only be
  // changed by a code default or a shell script, so "hapus polygon" needed a
  // deploy.
  bot.action(/^atch:([a-z0-9]+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const id = ctx.match[1];
    const cur = autoTrend.get().chains.map((x) => String(x).toLowerCase());
    const on = cur.includes(id);
    const next = on ? cur.filter((x) => x !== id) : [...cur, id];
    // ⚠️ THE LAST CHAIN MAY NOT BE SWITCHED OFF. `set()` reads an empty list as
    // a mistake and falls back to the shipped six — so the tap would appear to
    // work and then silently restore every chain the operator had just removed.
    // Refusing is the honest answer, and it names the switch that turns the
    // whole service off.
    if (!next.length) {
      return ctx
        .answerCbQuery("That is the last chain — use ⏸ Disable to stop the board entirely.", { show_alert: true })
        .catch(() => {});
    }
    // Answer FIRST: this writes and then redraws, and a callback answer is the
    // one channel with a deadline. Same rule as ⚡ Run now beside it.
    const m = trendingBoard.chainList().find((x) => x.id === id);
    const label = (m && m.label) || id;
    await ctx
      .answerCbQuery(on ? `⚪️ ${label} removed from the board` : `🟢 ${label} added to the board`)
      .catch(() => {});
    try {
      await autoTrend.set({ chains: next });
    } catch (e) {
      // A write that throws inside a bot.action is swallowed by bot.catch, so
      // the button would spin and the panel would not change — this file's own
      // scar, from the guard that produced the symptom it was written to end.
      log.error(`[adminbot] chain toggle refused: ${e.message}`);
      await ctx.reply(`⛔ Could not save: ${String(e.message).slice(0, 180)}`).catch(() => {});
      return;
    }
    // The board is edited in place on its own 5-minute timer, so the channel
    // does not change the instant this is tapped — say so, or the next report
    // is "saya sudah matikan tapi masih ada".
    if (on) {
      await ctx
        .reply(
          `⚪️ <b>${label}</b> is off the trending board.\n` +
            `The channel updates on its next publish (up to 5 min). A slot somebody PAID for on that chain still ` +
            `publishes — the ops channel says so if there is one.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    }
    await edit(ctx, atText(), atKb()).catch(() => {});
  });

  bot.action(/^atrun:([a-z0-9]+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const chain = ctx.match[1];
    // ⚠️ A CALLBACK ANSWER EXPIRES; A MESSAGE EDIT DOES NOT.
    //
    // "di klik fiturnya not work" — the button spun and nothing came back. The
    // work is what takes the time: `byGain` prices up to PROBE_CAP candidates
    // SERIALLY with a 250ms gap — ten seconds of sleeping at the shipped budget,
    // before a single lookup — and on a chain with dozens of spares (Robinhood
    // had 44) it runs well past
    // Telegram's ~15s callback deadline. `answerCbQuery` then fails with "query
    // is too old", the .catch swallows it, and the operator is told nothing at
    // all — while the promotion may well have succeeded.
    //
    // A previous round deleted the early "working…" toast on the rule that only
    // the FIRST answerCbQuery counts. That rule is true; the conclusion was
    // backwards. The answer is the one channel with a deadline, so it must
    // carry the acknowledgement — which is bounded — and the RESULT belongs on
    // the panel, which has no deadline. `alscan` beside this already does
    // exactly that.
    if (atRunBusy) {
      ctx.answerCbQuery("⚡ A run is already going — hold on").catch(() => {});
      return;
    }
    atRunBusy = true;
    ctx.answerCbQuery(`⚡ Running on ${chain} — this can take a minute. The panel below will say what happened.`).catch(() => {});
    const res = await autoTrend.forceChain(chain).catch((e) => {
      log.warn(`[adminbot] forced auto-trend ${chain}: ${e.message}`);
      return { promoted: 0, syms: [], reason: e.message };
    });
    atRunBusy = false;
    log.info(
      `[adminbot] forced auto-trend on ${chain} → ${res.promoted} promoted (${res.reason || res.syms.join(", ")}) ` +
        `by @${ctx.from.username || ctx.from.id}`,
    );
    _atCounts = await autoTrend.featuredByChain().catch(() => _atCounts);
    _atPending = autoTrend.pendingCount();
    const outcome = res.promoted
      ? `⚡ <b>Ran on ${escapeHtml(chain)}</b> → now trending: <b>${escapeHtml(res.syms.join(", "))}</b>`
      : `⚠️ <b>Nothing promoted on ${escapeHtml(chain)}</b>\n<code>${escapeHtml(String(res.reason || "no reason given").slice(0, 300))}</code>`;
    await edit(ctx, `${atText()}\n\n${outcome}`, atKb());
  });
  bot.action("atfill", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const c = await autoTrend.set({ fillFromMarket: !autoTrend.get().fillFromMarket });
    // A `show_alert`, not a toast: turning it OFF means a chain with no spare
    // listings goes back to publishing a short board silently, and that is the
    // state this feature exists to end.
    await ctx
      .answerCbQuery(
        c.fillFromMarket
          ? "Fill from market ON — short chains get their biggest tokens listed."
          : "OFF — a chain with no spare listings will publish a SHORT board again.",
        { show_alert: !c.fillFromMarket },
      )
      .catch(() => {});
    await edit(ctx, atText(), atKb());
  });
  bot.action("atnop", (ctx) => ctx.answerCbQuery().catch(() => {})); // label buttons — no-op
  // The board readout is a snapshot taken when the panel opened. Re-reading it
  // is the one thing the operator wants after a Run now, or after waiting out a
  // cycle, and reopening the whole menu to get it is not obvious.
  bot.action("atref", async (ctx) => {
    if (!guard(ctx)) return;
    // Answered BEFORE the read, same rule as ⚡ Run now above: this waits on the
    // site's listings API, and a slow answer is one Telegram throws away. The
    // refreshed panel below is the real report anyway.
    ctx.answerCbQuery("Refreshing…").catch(() => {});
    _atCounts = await autoTrend.featuredByChain().catch(() => _atCounts);
    _atPending = autoTrend.pendingCount();
    await edit(ctx, atText(), atKb());
  });
  bot.action("aten", async (ctx) => {
    if (!guard(ctx)) return;
    const c = await autoTrend.set({ enabled: !autoTrend.get().enabled });
    log.info(`[adminbot] auto-trend ${c.enabled ? "ENABLED" : "disabled"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(c.enabled ? "🟢 Auto Trending ON" : "🔴 Auto Trending OFF").catch(() => {});
    await edit(ctx, atText(), atKb());
  });
  const atStep = (key, label) => async (ctx) => {
    if (!guard(ctx)) return;
    const c = await autoTrend.set({ [key]: autoTrend.get()[key] + Number(ctx.match[1]) });
    ctx.answerCbQuery(`${label}: ${c[key]}`).catch(() => {});
    await edit(ctx, atText(), atKb());
  };
  bot.action(/^athmin:(-?\d+)$/, atStep("minHours", "Min hours"));
  bot.action(/^athmax:(-?\d+)$/, atStep("maxHours", "Max hours"));
  bot.action(/^atgmin:(-?\d+)$/, atStep("minGapMin", "Min gap"));
  bot.action(/^atgmax:(-?\d+)$/, atStep("maxGapMin", "Max gap"));
  bot.action(/^attgt:(-?\d+)$/, atStep("perChainMin", "Per-chain minimum"));
  bot.action(/^attgx:(-?\d+)$/, atStep("perChainMax", "Per-chain maximum"));
  bot.action(/^atapd:(-?\d+)$/, atStep("announcePerDay", "Announce/day"));
  bot.action(/^atagap:(-?\d+)$/, atStep("announceGapMin", "Announce gap"));
  bot.action(/^atgain:(-?\d+)$/, atStep("minGainPct", "Min 24h gain"));
  bot.action(/^atfmc:(-?\d+)$/, atStep("fillMinMcap", "Big-coin floor"));
  bot.action(/^atfmax:(-?\d+)$/, atStep("fillMaxPerCycle", "Fill per chain"));
  // ⚠️ MONEY ROWS ECHO THROUGH fmtCap, NOT THE RAW NUMBER. `atStep`'s toast is
  // `${label}: ${c[key]}`, which for these would read "Min cap: 100000" — the
  // spelling this repo already replaced everywhere else because `$1,000,000`
  // rendered as `From $1,000,0…` on a phone. And a clamped-to-0 value must say
  // OFF, or a floor the operator just switched off reports as "$0", which reads
  // like a floor that is set and refusing nothing.
  const atMoneyStep = (key, label) => async (ctx) => {
    if (!guard(ctx)) return;
    const c = await autoTrend.set({ [key]: autoTrend.get()[key] + Number(ctx.match[1]) });
    ctx.answerCbQuery(`${label}: ${floorLabel(c[key])}`).catch(() => {});
    await edit(ctx, atText(), atKb());
  };
  bot.action(/^atmcap:(-?\d+)$/, atMoneyStep("minMcapUsd", "Min market cap"));
  bot.action(/^atvol:(-?\d+)$/, atMoneyStep("minVol24hUsd", "Min 24h volume"));
  // ✏️ The LABEL is the input — the same three-part pattern Auto Listing uses
  // (`alset:` → a spec table → the shared text handler), so a fourth row added
  // later cannot grow its own idea of what a valid value is.
  bot.action(/^atset:([A-Za-z0-9]+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    const spec = AT_TYPED[key];
    // An unknown key is an old button from somebody's scrollback. Answer it,
    // change nothing, and never arm a wait whose reply has nowhere to go.
    if (!spec) return ctx.answerCbQuery("That row is gone — reopen 🤖 Auto Trending.").catch(() => {});
    ctx.session.awaitingBt = { mode: "atset", atKey: key };
    ctx.answerCbQuery().catch(() => {});
    await ctx
      .reply(
        `✏️ <b>${spec.label}</b>\n\nKirim angkanya — contoh: <code>${spec.eg}</code>\n` +
          `<code>0</code> mematikan filter ini.\n\n/cancel untuk batal.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  });
  bot.action("atrst", async (ctx) => {
    if (!guard(ctx)) return;
    await autoTrend.reset();
    ctx.answerCbQuery("↩️ Reset").catch(() => {});
    await edit(ctx, atText(), atKb());
  });

  // ── Auto Listing ──
  /**
   * Run an Auto-Listing WRITE and never let it fail in silence.
   *
   * ⚠️ `set()` and `reset()` refuse over an unreadable `autoLister.json` — the
   * right call, because writing DEFAULTS over a file we could not read wipes
   * every tuned threshold. But a throw inside a `bot.action` handler is caught
   * by `bot.catch` and nothing reaches the operator: the button spins, the
   * panel does not change, and free listings stay stopped. That is the same
   * "tidak bekerja" the whole feature was reported for, produced by its own
   * guard. One helper rather than fourteen try/catches — a guard the fifteenth
   * handler has to remember is one it forgets.
   */
  async function alWrite(ctx, fn, onOk) {
    let c;
    try {
      c = await fn();
    } catch (e) {
      ctx.answerCbQuery(`⛔ ${String(e.message).slice(0, 180)}`, { show_alert: true }).catch(() => {});
      log.error(`[adminbot] auto-listing write refused: ${e.message}`);
      await edit(ctx, alText(), alKb());
      return null;
    }
    if (onOk) onOk(c);
    return c;
  }

  bot.action("al", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, alText(), alKb());
  });
  bot.action("alnop", (ctx) => ctx.answerCbQuery().catch(() => {})); // pre-✏️ label buttons, still in scrollback
  // ✏️ A typed value for any row on the panel — see AL_TYPED for why it is one
  // table. Arms the wait and PROMPTS; nothing is stored until the reply lands.
  bot.action(/^alset:([A-Za-z0-9]+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    const spec = AL_TYPED[key];
    // An unknown key means an old button from scrollback. Answer it, change
    // nothing, and never arm a wait whose reply has nowhere to go.
    if (!spec) return ctx.answerCbQuery("That row is gone — reopen 🆓 Auto Listing.").catch(() => {});
    ctx.session.awaitingBt = { mode: "alset", alKey: key };
    ctx.answerCbQuery("✏️ Kirim nilainya").catch(() => {});
    await ctx
      .reply(
        `✏️ <b>${spec.label}</b> — sekarang <b>${escapeHtml(alShow(key, autoLister.get()[key]))}</b>\n\n` +
          `Kirim nilai barunya. Contoh: <code>${escapeHtml(spec.eg)}</code>\n\n` +
          `<i>/cancel untuk batal.</i>`,
        HTML,
      )
      .catch(() => {});
  });
  bot.action("alen", async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ enabled: !autoLister.get().enabled }));
    if (!c) return;
    log.info(`[adminbot] auto-listing ${c.enabled ? "ENABLED" : "disabled"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(c.enabled ? "🟢 Auto Listing ON" : "🔴 Auto Listing OFF").catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  bot.action("alpost", async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ postChannel: !autoLister.get().postChannel }));
    if (!c) return;
    log.info(`[adminbot] auto-listing channel post ${c.postChannel ? "ON" : "OFF"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(c.postChannel ? "📣 Posts to the listing channel" : "🤫 Site only").catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  bot.action("alann", async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ announceChannel: !autoLister.get().announceChannel }));
    if (!c) return;
    log.info(`[adminbot] auto-listing ${CHANNELS.announce} announcement ${c.announceChannel ? "ON" : "OFF"} by @${ctx.from.username || ctx.from.id}`);
    ctx
      .answerCbQuery(
        c.announceChannel
          ? `🔔 Listing & Trending is announced in ${CHANNELS.announce}`
          : `🤫 No ${CHANNELS.announce} post`,
      )
      .catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  const alStep = (key, label) => async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ [key]: autoLister.get()[key] + Number(ctx.match[1]) }));
    if (!c) return;
    ctx.answerCbQuery(`${label}: ${usd(c[key])}`).catch(() => {});
    await edit(ctx, alText(), alKb());
  };
  bot.action(/^almin:(-?\d+)$/, alStep("minMcap", "From"));
  bot.action(/^almax:(-?\d+)$/, alStep("maxMcap", "To"));
  bot.action(/^alliq:(-?\d+)$/, alStep("minLiq", "Min liquidity"));
  bot.action(/^alvol:(-?\d+)$/, alStep("minVol24", "Min 24h volume"));
  bot.action(/^alday:(-?\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ maxPerDay: autoLister.get().maxPerDay + Number(ctx.match[1]) }));
    if (!c) return;
    ctx.answerCbQuery(`Max/day: ${c.maxPerDay}`).catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  bot.action("alpace", async (ctx) => {
    if (!guard(ctx)) return;
    const on = !autoLister.get().paceListings;
    const c = await alWrite(ctx, () => autoLister.set({ paceListings: on }));
    if (!c) return;
    log.info(
      `[adminbot] auto-listing pace ${on ? `ON (1 every ${autoLister.paceRange(c)})` : "OFF"} ` +
        `by @${ctx.from.username || ctx.from.id}`,
    );
    ctx
      .answerCbQuery(
        on
          ? `⏳ One free listing every ${autoLister.paceRange(c)}`
          : `⚠️ Pace OFF — up to ${c.maxPerRun} listings can go out in one scan, back to back. ` +
            `Only the ${c.maxPerDay}/day cap spaces them after that.`,
        // A `show_alert` on the way OFF, the 🧲 rule: it changes what the public
        // feed does, and a toast is furniture people tap past.
        { show_alert: !on },
      )
      .catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  const alGapStep = (key) => async (ctx) => {
    if (!guard(ctx)) return;
    const asked = autoLister.get()[key] + Number(ctx.match[1]);
    const c = await alWrite(ctx, () => autoLister.set({ [key]: asked }));
    if (!c) return;
    // The whole BAND is reported, never just the end that was tapped: lowering
    // the ceiling under the floor moves the floor's partner too (an inverted
    // range resolves to the floor), and an answer naming one number while the
    // other moved is the ✅-carrying-a-number-nobody-asked-for defect.
    //
    // A refused value names WHICH refusal it was. "1h is outside the limits" is
    // false about a 1h ceiling under a 2h30m floor — 1h is well inside the
    // rails — and a diagnosis pointing at the wrong cause sends the operator to
    // change the wrong setting.
    const askedTxt = asked < 0 ? "a negative wait" : autoLister.fmtGap(asked);
    const note =
      c[key] === asked
        ? ""
        : key === "maxListGapMin" && asked >= 0 && asked < c.minListGapMin
          ? ` — a ceiling under the ${autoLister.fmtGap(c.minListGapMin)} floor pins it there`
          : ` — ${askedTxt} is outside the limits`;
    ctx.answerCbQuery(`⏳ Pace: one every ${autoLister.paceRange(c)}${note}`).catch(() => {});
    await edit(ctx, alText(), alKb());
  };
  bot.action(/^alpmin:(-?\d+)$/, alGapStep("minListGapMin"));
  bot.action(/^alpmax:(-?\d+)$/, alGapStep("maxListGapMin"));
  bot.action("alch", async (ctx) => {
    if (!guard(ctx)) return;
    ctx.answerCbQuery().catch(() => {});
    await edit(ctx, alchText(), alchKb());
  });

  bot.action(/^alchn:([a-z0-9]+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const id = ctx.match[1];
    const on = autoLister.get().chains;
    const next = on.includes(id) ? on.filter((k) => k !== id) : [...on, id];
    const c = await alWrite(ctx, () => autoLister.set({ chains: next }));
    if (!c) return;
    log.info(`[adminbot] auto-listing chain scope → ${c.chains.length ? c.chains.join(", ") : "ALL"} by @${ctx.from.username || ctx.from.id}`);
    ctx
      .answerCbQuery(
        // Dropping the last chain is not a refusal here — an empty scope MEANS
        // every chain. Said out loud, because a tap that widens the blast
        // radius back to the whole market must not pass as a toast.
        c.chains.length ? `🌐 ${alChainScope(c)}` : "🌐 Scope cleared — back to ALL chains",
        { show_alert: c.chains.length === 0 },
      )
      .catch(() => {});
    await edit(ctx, alchText(), alchKb());
  });

  bot.action("alchall", async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ chains: [] }));
    if (!c) return;
    log.info(`[adminbot] auto-listing chain scope → ALL by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery("🌐 ALL chains").catch(() => {});
    await edit(ctx, alchText(), alchKb());
  });

  bot.action(/^alpkg:(free|xpress|trending)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    const before = autoLister.get().pkgs;
    const c = await alWrite(ctx, () => autoLister.togglePkg(key));
    if (!c) return;
    log.info(`[adminbot] auto-listing packages → ${c.pkgs.join(", ")} by @${ctx.from.username || ctx.from.id}`);
    // Refused: this was the last one on. Say so, or the tap looks like a bug.
    const refused = before.length === 1 && before[0] === key && c.pkgs.length === 1;
    ctx
      .answerCbQuery(
        refused
          ? `⚠️ ${autoLister.pkgOf(key).label} is the only one left — enable another first`
          : c.pkgs.length > 1
            ? `📦 ${c.pkgs.map((k) => autoLister.pkgOf(k).label).join(" → ")} (taking turns)`
            : `📦 ${autoLister.pkgOf(c.pkgs[0]).label}`,
      )
      .catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  bot.action(/^alth:(-?\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const c = await alWrite(ctx, () => autoLister.set({ trendHours: autoLister.get().trendHours + Number(ctx.match[1]) }));
    if (!c) return;
    ctx.answerCbQuery(`🔥 Slot: ${c.trendHours}h`).catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  // A DRY RUN: prices this scan's candidates and reports the verdicts without
  // listing, writing or posting anything. Safe while the service is off, and
  // safe here — @dexvraadminbot is not the process that posts to the channels.
  bot.action("alscan", async (ctx) => {
    if (!guard(ctx)) return;
    // One at a time. A test scan takes seconds of network I/O, and a panel that
    // looks idle invites a second tap — which would double the load on
    // DexScreener and race two edits onto the same message.
    if (alScanBusy) {
      ctx.answerCbQuery("🔎 A test scan is already running — hold on").catch(() => {});
      return;
    }
    alScanBusy = true;
    ctx.answerCbQuery("🔎 Scanning — this takes a moment…").catch(() => {});
    let r;
    try {
      r = await autoLister.dryRun();
    } catch (e) {
      alScanBusy = false;
      await edit(ctx, `${alText()}\n\n🔎 <b>Test scan failed</b>\n<code>${escapeHtml(String(e.message).slice(0, 300))}</code>`, alKb());
      return;
    }
    alScanBusy = false;
    const found = (r.qualified || [])
      .slice(0, 8) // the verdict has to fit beside the panel, and eight is a list
      .map((q) => `• <b>${q.sym}</b> on ${q.chain} — ${usd(q.mcap)} (trigger ${usd(q.trigger)})`)
      .join("\n");
    const sampled = r.sampled ? ` <i>(sample of the first ${r.priced} — a tap must not run for minutes)</i>` : "";
    // ⚠️ The verdict has to answer to the PACE, or the panel contradicts itself
    // four lines apart: "next one due in 2h30m" above, "2 would be listed right
    // now" below. A test scan reports the MARKET (that is what it is for, and
    // why dryRun still prices while the pace holds) — what it may not do is
    // describe a scan the engine would not perform.
    const p = r.pace || autoLister.pace();
    // ⚠️ AND TO THE TWO GATES THAT RUN BEFORE IT. `runOnce` checks `enabled` and
    // the daily cap and returns without ever reaching the pace, so a verdict
    // that starts at the pace promises a listing over a service that is switched
    // off — the same defect alPaceLine had to be rescued from, one message down.
    const cfgNow = autoLister.get();
    const todayNow = autoLister.stats().today;
    const held = !cfgNow.enabled
      ? `the service is 🔴 OFF, so a real scan lists nothing`
      : todayNow >= cfgNow.maxPerDay
        ? `today's <b>${todayNow}/${cfgNow.maxPerDay}</b> cap is reached, so a real scan lists nothing`
        : null;
    const wouldList = held
      ? `<b>${r.listed}</b> qualif${r.listed === 1 ? "ies" : "y"}, but ${held}`
      : !p.on
      ? `<b>${r.listed}</b> would be listed right now`
      : p.due
        ? `<b>${r.listed}</b> qualif${r.listed === 1 ? "ies" : "y"} — a real scan would list <b>the first one</b>, then wait ${escapeHtml(autoLister.paceRange())}`
        : `<b>${r.listed}</b> qualif${r.listed === 1 ? "ies" : "y"}, but the pace holds the next listing for ` +
          `<b>${escapeHtml(autoLister.fmtGap(p.waitMs / 60000))}</b>`;
    // ⚠️ BOUNDED AT SOURCE. A blocker now names each failing source and its
    // reason, so it can run to several hundred characters — and the trim below
    // only shortens the PANEL half, so an over-long verdict built a message
    // Telegram rejects outright. The edit then fails, the panel never updates,
    // and the one button that answers "why has nothing been listed?" reads as
    // dead precisely when it has an answer. Same cap as alScanLine.
    const verdict = r.blocker
      ? `⛔ <b>${escapeHtml(String(r.blocker).slice(0, 300))}</b>\n\n<i>This is why nothing is being listed. The service cannot work until it clears.</i>`
      : `🔎 <b>Test scan</b> — ${escapeHtml(autoLister.scanLine(r))}${sampled}\n\n` +
        (r.listed
          ? `${wouldList}:\n${found}\n\n<i>Nothing was listed — this was a dry run.</i>`
          : `<i>Nothing qualifies in this sample. No token is past its trigger with enough liquidity and volume — the service itself is working.</i>`);
    // Telegram rejects an edit over 4096 chars, and the panel text is already
    // long — a rejected edit would lose the verdict entirely, which is the one
    // thing the operator tapped for. Keep the verdict, trim the panel.
    const body = `${alText()}\n${verdict}`;
    await edit(ctx, body.length > 4000 ? `${body.slice(0, 4000 - verdict.length - 2)}\n${verdict}` : body, alKb());
  });
  bot.action("alrst", async (ctx) => {
    if (!guard(ctx)) return;
    // ⚠️ It resets the THRESHOLDS and leaves the switch alone — see
    // autoLister.reset(). It used to take `enabled` with everything else, so
    // this button silently stopped a running public feed and the panel then
    // accused the loop of having died. The answer says which it did, because
    // a bare "↩️ Reset" is what made that invisible.
    // ⚠️ IT RESETS EVERY SETTING BUT THE SWITCH, so the answer names what
    // actually moved. "Thresholds reset" alone was true of the thresholds and
    // silent about the pace going back ON, the packages falling back to Free
    // and the chain scope reopening — three changes an operator would report as
    // "free listing tidak bekerja, sebelumnya bekerja".
    const before = autoLister.get();
    const c = await alWrite(ctx, () => autoLister.reset());
    if (!c) return;
    const moved = [];
    if (before.paceListings !== c.paceListings) moved.push(`pace ${c.paceListings ? `ON (${autoLister.paceRange(c)})` : "OFF"}`);
    if (before.pkgs.join() !== c.pkgs.join()) moved.push(`packages ${c.pkgs.map((k) => autoLister.pkgOf(k).label).join(" → ")}`);
    if (before.chains.length !== c.chains.length) moved.push(c.chains.length ? `chains ${c.chains.join(", ")}` : "chains ALL");
    if (before.postChannel !== c.postChannel) moved.push(`channel post ${c.postChannel ? "ON" : "OFF"}`);
    ctx
      .answerCbQuery(
        `↩️ Settings back to defaults${moved.length ? ` · ${moved.join(" · ")}` : ""} — the service stays ${c.enabled ? "🟢 ON" : "🔴 OFF"}`,
        { show_alert: moved.length > 0 },
      )
      .catch(() => {});
    await edit(ctx, alText(), alKb());
  });
  bot.action("alclr", async (ctx) => {
    // After clearing listings on the site: without this a token already
    // auto-listed would never be considered again. This is ALSO the only thing
    // that wipes the never-re-list ledger, so it re-opens every contract the
    // site has ever held — deliberate, and only from this button.
    if (!guard(ctx)) return;
    await autoLister.resetState();
    log.info(`[adminbot] auto-listing history cleared by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery("🧹 History cleared — previously listed tokens can be auto-listed again").catch(() => {});
    await edit(ctx, alText(), alKb());
  });

  // ── Force post: pick a kind → confirm → publish for real ──
  bot.action("fp", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, fpText(), fpKb());
  });
  bot.action(/^fpk:([a-z_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    if (!forcePost.kindIds().includes(kind)) return;
    await edit(
      ctx,
      fpConfirmText(kind),
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Post it now", `fpgo:${kind}`)],
        [Markup.button.callback("⬅ Cancel", "fp")],
      ]),
    );
  });
  bot.action(/^fpgo:([a-z_]+)$/, async (ctx) => {
    ctx.answerCbQuery("Queued…").catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    if (!forcePost.kindIds().includes(kind)) return;
    const who = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
    // The MAIN bot publishes it — this process can't (see forcepost/store.js).
    let job;
    try {
      job = await fpStore.request(kind, { by: who });
    } catch (e) {
      log.warn(`[adminbot] force post ${kind} by ${who}: ${e.message}`);
      return edit(ctx, `⚠️ <b>Couldn't queue it</b>\n\n<code>${escapeHtml(e.message)}</code>`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "fp")]]));
    }
    log.info(`[adminbot] force post ${kind} queued by ${who} (${job.id})`);
    await edit(ctx, `⏳ Publishing <b>${escapeHtml(forcePost.labelOf(kind))}</b>…`, Markup.inlineKeyboard([]));
    // Poll the job file for the main bot's result — a public post should confirm
    // itself here, not leave the operator guessing whether it went out.
    const done = await waitForJob(job.id);
    if (!done || done.status === "pending" || done.status === "running") {
      return edit(
        ctx,
        `⏳ <b>Still working…</b>\n\nThe request is queued but the main bot hasn't reported back. ` +
          `If this persists, check that <code>dexvra-bot</code> is running (<code>pm2 ls</code>).`,
        Markup.inlineKeyboard([[Markup.button.callback("🔄 Check again", `fpst:${job.id}`), Markup.button.callback("⬅ Back", "fp")]]),
      );
    }
    await edit(ctx, fpResultText(kind, done), fpResultKb());
  });
  // Re-check a job whose result hadn't landed yet.
  bot.action(/^fpst:(fp_[a-z0-9]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const job = fpStore.get(ctx.match[1]);
    if (!job) return edit(ctx, "⚠️ That request is gone (it may have expired).", fpResultKb());
    if (job.status === "pending" || job.status === "running") {
      return edit(
        ctx,
        `⏳ <b>Still working…</b>\n\nStatus: <code>${escapeHtml(job.status)}</code>. Is <code>dexvra-bot</code> running?`,
        Markup.inlineKeyboard([[Markup.button.callback("🔄 Check again", `fpst:${job.id}`), Markup.button.callback("⬅ Back", "fp")]]),
      );
    }
    await edit(ctx, fpResultText(job.kind, job), fpResultKb());
  });

  bot.action("tbref", async (ctx) => {
    ctx.answerCbQuery("Refreshing…").catch(() => {});
    if (!guard(ctx)) return;
    const who = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
    let job;
    try {
      // The MAIN bot owns the board message and the premium session, so this is
      // a job for it — the same channel the force-post screen uses.
      job = await fpStore.request("board_refresh", { by: who });
    } catch (e) {
      log.warn(`[adminbot] board refresh by ${who}: ${e.message}`);
      return edit(ctx, `⚠️ <b>Couldn't queue it</b>\n\n<code>${escapeHtml(e.message)}</code>`, tbKb());
    }
    log.info(`[adminbot] trending board refresh queued by ${who} (${job.id})`);
    await edit(ctx, "⏳ Asking the main bot to refresh the board…", Markup.inlineKeyboard([]));
    const done = await waitForJob(job.id);
    if (!done || done.status === "pending" || done.status === "running") {
      return edit(
        ctx,
        `⏳ <b>Still working…</b>\n\nThe main bot hasn't reported back. Check that <code>dexvra-bot</code> is running (<code>pm2 ls</code>).`,
        Markup.inlineKeyboard([[Markup.button.callback("🔄 Try again", "tbref"), Markup.button.callback("⬅ Back", "tb")]]),
      );
    }
    await edit(ctx, tbRefreshText(done), Markup.inlineKeyboard([[Markup.button.callback("💎 Premium status", "tbdiag"), Markup.button.callback("⬅ Back", "tb")]]));
  });

  // ── Trending board (chain logos + rank badges 1–10) ──
  bot.action("tb", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, tbText(), tbKb());
  });
  bot.action(/^tbr:(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const pos = Number(ctx.match[1]);
    ctx.session.awaitingBt = { mode: "tbrank", pos };
    const cur = trendingBoard.rankEmojis()[pos - 1];
    await ctx.reply(
      `⌨ Send the new badge emoji for <b>rank ${pos}</b> (current: ${trendingBoard.displayEmoji(cur)}${trendingBoard.isRankPremium(pos) ? " — 💎 premium" : ""}).\n\n` +
        `Tip: send a <b>premium</b> emoji and it renders premium on the board (posted via the premium account). /cancel to abort.`,
      HTML,
    );
  });
  bot.action("tbt", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "tbtitle" };
    await ctx.reply(
      `⌨ Send the emoji for the board's <b>title line</b> (current: ${trendingBoard.displayEmoji(trendingBoard.titleEmoji())}` +
        `${trendingBoard.isTitlePremium() ? " — 💎 premium" : ""}).\n\n` +
        `It opens “<i>Dexvra Trending — live featured slots</i>”. Send a <b>premium</b> emoji and it animates on the board ` +
        `(posted via the premium account). /cancel to abort.`,
      HTML,
    );
  });
  bot.action("tbn", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "tbnew" };
    await ctx.reply(
      `⌨ Send the emoji that marks a <b>newly entered</b> token (current: ${trendingBoard.displayEmoji(trendingBoard.newEmoji())}` +
        `${trendingBoard.isNewPremium() ? " — 💎 premium" : ""}).\n\n` +
        `It appears beside any token whose slot started in the last <b>${trendingBoard.newHours()}h</b>, and in the legend ` +
        `under the board. Send a <b>premium</b> emoji and it animates. /cancel to abort.`,
      HTML,
    );
  });
  bot.action("tbnh", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "tbnewhours" };
    await ctx.reply(
      `⌨ How many hours counts as <b>newly entered</b>? Send a number from ` +
        `<b>${trendingBoard.NEW_HOURS_MIN}</b> to <b>${trendingBoard.NEW_HOURS_MAX}</b> (current: <b>${trendingBoard.newHours()}h</b>).\n\n` +
        `<i>Short is the point — a mark that lasts a day stops meaning "just now". /cancel to abort.</i>`,
      HTML,
    );
  });
  bot.action("tbc", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, tbChainsText(), tbChainsKb());
  });
  bot.action(/^tbcl:([a-z0-9]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const chain = ctx.match[1];
    ctx.session.awaitingBt = { mode: "tbchain", chain };
    // displayEmoji(), never the raw fragment — a premium logo is stored as
    // "[🔶](emoji/…)" markup and would otherwise be shown to the admin verbatim.
    await ctx.reply(
      `⌨ Send the new logo emoji for <b>${chain.toUpperCase()}</b> (current: ${trendingBoard.displayEmoji(trendingBoard.chainLogo(chain))}` +
        `${trendingBoard.isChainPremium(chain) ? " — 💎 premium" : ""}).\n\nSend a single emoji. /cancel to abort.`,
      HTML,
    );
  });
  bot.action("tbrst", async (ctx) => {
    if (!guard(ctx)) return;
    await trendingBoard.reset();
    log.info(`[adminbot] trending board reset by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery("↩️ Restored the built-in premium defaults").catch(() => {});
    await edit(ctx, tbText(), tbKb());
  });
  bot.action("tbdiag", async (ctx) => {
    ctx.answerCbQuery("Checking…").catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, await premiumReportText(), Markup.inlineKeyboard([[Markup.button.callback("🔄 Re-check", "tbdiag"), Markup.button.callback("⬅ Back", "tb")]]));
  });

  // Interactive layout editor: element selector + nudge + resize, all editing
  // one photo message in place. Element rides in the callback data (stateless).
  const E = "(logo|ticker|meta|badge)";
  // ── Fourtis-style layout editor handlers (bx*) ────────────────────────────
  const EX = "(logo|ticker|name|meta|badge|pct|price|slot)";
  // Layout-editor kinds — the still-artwork kinds PLUS pump (a clip-only fill
  // kind that auto-fills its OWN ▲%/price/MCAP layout). rank-up has no layout.
  const KL = "(listing|trending|banner|pump)";
  bot.action(new RegExp(`^bxo:${KL}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await bxOpen(ctx, ctx.match[1]);
  });
  bot.action(new RegExp(`^bxe:${KL}:${EX}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    await bxElemOpen(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bxsd:${KL}:(logo|ticker|name|meta|badge|pct|price|slotw|sloth):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem, ds] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    const d = Number(ds);
    if (elem === "slotw" || elem === "sloth") {
      const key = elem === "slotw" ? "slotW" : "slotH";
      const lim = elem === "slotw" ? [200, 2560] : [120, 1280];
      const v = Math.max(lim[0], Math.min(lim[1], Number(s[key]) + d));
      await bannerTpl.updateSettings(kind, { [key]: v });
      ctx.answerCbQuery(`${elem === "slotw" ? "Lebar" : "Tinggi"} ${v}px`).catch(() => {});
      return void bxElemOpen(ctx, kind, "slot");
    }
    const c = BX[elem];
    if (elem === "logo") {
      const size = Math.max(c.smin, Math.min(c.smax, Number(s.logoSize) + d));
      // Grow/shrink around the slot CENTRE so the ring doesn't drift while
      // resizing. TRUNCATED toward zero, not rounded: an odd step (5px) makes
      // the half-delta 2.5, and Math.round on the SUM sent ➕5 and ➖5 to
      // different places — press one then the other and the logo came back a
      // pixel off. Truncating makes them exact inverses. (The centre can still
      // sit half a pixel out per odd-step tap; that is sub-pixel once the
      // 2560px canvas is delivered at 1280, and ⬌ Ke tengah resets it exactly.)
      const dx = Math.trunc((Number(s.logoSize) - size) / 2);
      await bannerTpl.updateSettings(kind, {
        logoSize: size,
        logoX: Math.round(btNum(s.logoX, 1070) + dx),
        logoY: Math.round(btNum(s.logoY, 430) + dx),
      });
      ctx.answerCbQuery(`Logo ${size}px`).catch(() => {});
    } else {
      const size = Math.max(c.smin, Math.min(c.smax, Number(s[c.sizeKey]) + d));
      await bannerTpl.updateSettings(kind, { [c.sizeKey]: size });
      ctx.answerCbQuery(`${c.label} ${size}px`).catch(() => {});
    }
    await bxElemOpen(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bxmd:${KL}:${EX}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem, dxs, dys] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    const c = elem === "slot" ? { xKey: "logoX", yKey: "logoY" } : BX[elem];
    const p = bxPos(s, elem);
    if (!c || c.nomove || !p) return ctx.answerCbQuery("Bagian ini tidak bisa digeser.").catch(() => {});
    // From where it IS, not from what is stored — the token name inherits the
    // ticker's position until this very tap pins it (see bxPos).
    const x = Math.max(-800, Math.min(3200, btNum(p.x, 1070) + Number(dxs)));
    const y = Math.max(-800, Math.min(3200, btNum(p.y, 430) + Number(dys)));
    await bannerTpl.updateSettings(kind, { [c.xKey]: x, [c.yKey]: y });
    ctx.answerCbQuery(`📍 ${x}, ${y}`).catch(() => {});
    await bxElemOpen(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bxc:${KL}:${EX}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    const c = elem === "slot" ? { xKey: "logoX" } : BX[elem];
    if (!c || c.nomove) return ctx.answerCbQuery("Bagian ini tidak bisa digeser.").catch(() => {});
    await bannerTpl.updateSettings(kind, { [c.xKey]: "center" });
    ctx.answerCbQuery("⬌ Sudah di tengah (kiri–kanan)").catch(() => {});
    await bxElemOpen(ctx, kind, elem);
  });
  // Vertical twin of bxc. Horizontal-only centring is enough for a token logo
  // sitting on a designed row, but an ad slot has to land inside a frame, and
  // that frame is centred on both axes on most templates.
  bot.action(new RegExp(`^bxcy:${KL}:${EX}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    const c = elem === "slot" ? { yKey: "logoY" } : BX[elem];
    if (!c || c.nomove || !c.yKey) return ctx.answerCbQuery("Bagian ini tidak bisa digeser.").catch(() => {});
    await bannerTpl.updateSettings(kind, { [c.yKey]: "center" });
    ctx.answerCbQuery("⬍ Sudah di tengah (atas–bawah)").catch(() => {});
    await bxElemOpen(ctx, kind, elem);
  });
  // Un-pin: back to "wherever the ticker is". Clearing BOTH keys is the point —
  // a half-cleared name follows on one axis and not the other, which is exactly
  // the state that made the position readout confusing to begin with.
  bot.action(new RegExp(`^bxfollow:${KL}:${EX}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    const c = BX[elem];
    if (!c || !c.follows) return ctx.answerCbQuery("Bagian ini tidak mengikuti apa pun.").catch(() => {});
    await bannerTpl.updateSettings(kind, { [c.xKey]: null, [c.yKey]: null });
    ctx.answerCbQuery("🔗 Kembali ikut Ticker").catch(() => {});
    await bxElemOpen(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bxsn:${KL}:${EX}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    ctx.session.awaitingBt = { mode: elem === "slot" ? "bxslotsize" : "bxsize", kind, elem };
    const s = bannerTpl.getSettings(kind);
    const label = elem === "slot" ? "🖼 Ad slot" : (BX[elem] && BX[elem].label) || elem;
    if (elem === "slot") {
      await ctx.reply(
        `⌨ <b>${BT_KINDS[kind]} — ukuran kotak</b>\nSekarang: <b>${s.slotW} × ${s.slotH}</b>\n\n` +
          `Kirim dua angka: <b>lebar</b> lalu <b>tinggi</b>.\n` +
          `Ukuran gambar penuh: lebar 2560, tinggi 1280.\n\n` +
          `👉 Contoh: <code>${s.slotW} ${s.slotH}</code>\n\n/cancel untuk batal.`,
        HTML,
      );
    } else {
      const cur = s[BX[elem].sizeKey];
      await ctx.reply(
        `⌨ <b>${BT_KINDS[kind]} — ukuran ${label}</b>\nSekarang: <b>${cur}px</b>\n\nKirim satu angka saja (makin besar angkanya, makin besar tampilannya).\n👉 Contoh: <code>${cur}</code>  ·  coba <code>${Math.round(cur * 1.25)}</code> untuk perbesar, <code>${Math.max(BX[elem].smin, Math.round(cur * 0.8))}</code> untuk perkecil.\n\n/cancel untuk batal.`,
        HTML,
      );
    }
  });
  bot.action(new RegExp(`^bxmn:${KL}:${EX}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    if (elem !== "slot" && BX[elem] && BX[elem].nomove) return;
    ctx.session.awaitingBt = { mode: "bxmove", kind, elem };
    const s = bannerTpl.getSettings(kind);
    const c = elem === "slot" ? { label: "🖼 Ad slot", xKey: "logoX", yKey: "logoY" } : BX[elem];
    const p = bxPos(s, elem) || { x: s[c.xKey], y: s[c.yKey] };
    const cx = p.x;
    const cy = p.y;
    await ctx.reply(
      `⌨ <b>${BT_KINDS[kind]} — geser ${c.label}</b>\nSekarang di: <b>(${cx}, ${cy})</b>\n\n` +
        `Kirim dua angka, dipisah koma:\n` +
        `• angka pertama = <b>kiri ke kanan</b> (0 = paling kiri, 2560 = paling kanan)\n` +
        `• angka kedua = <b>atas ke bawah</b> (0 = paling atas, 1280 = paling bawah)\n\n` +
        `👉 Contoh: <code>${cx === "center" ? "1280" : cx},${cy}</code>\n` +
        `👉 Atau tulis <code>center</code> sebagai ganti angka: <code>center,center</code>\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bxp:${KL}$`), async (ctx) => {
    ctx.answerCbQuery("Sedang membuat gambar…").catch(() => {});
    if (!guard(ctx)) return;
    await bxPreview(ctx, ctx.match[1]);
  });
  bot.action(new RegExp(`^bxr:${KL}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    await bannerTpl.resetSettings(kind);
    log.info(`[adminbot] ${kind} banner layout reset by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery("🔄 Layout reset to defaults").catch(() => {});
    await edit(ctx, bxMenuText(kind), bxMenuKb(kind));
  });
  bot.action(new RegExp(`^bxt:${KL}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const on = bannerTpl.getSettings(kind).showText !== false;
    await bannerTpl.updateSettings(kind, { showText: !on });
    ctx.answerCbQuery(`🔤 Tulisan ${on ? "MATI" : "AKTIF"}`).catch(() => {});
    await edit(ctx, bxMenuText(kind), bxMenuKb(kind));
  });
  // Scale the WHOLE box, keeping its shape. 8% a tap: fine enough to stop on
  // the right size, coarse enough that a big change is a few taps and not
  // twenty. Both sides move together, so the box never drifts out of shape the
  // way it did when the only controls were per-axis.
  bot.action(new RegExp(`^bxscale:${KL}:(up|down)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, dir] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    const f = dir === "up" ? 1.08 : 1 / 1.08;
    const w = Math.max(200, Math.min(2560, Math.round((Number(s.slotW) || 1548) * f)));
    const h = Math.max(120, Math.min(1280, Math.round((Number(s.slotH) || 760) * f)));
    await bannerTpl.updateSettings(kind, { slotW: w, slotH: h });
    ctx.answerCbQuery(`${dir === "up" ? "➕" : "➖"} ${w} × ${h}`).catch(() => {});
    await bxElemOpen(ctx, kind, "slot");
  });
  // How a client picture whose shape differs from the box is fitted. Default is
  // "muat semua" (contain) — cropping artwork the advertiser paid for is not a
  // default anyone should get by accident.
  bot.action(new RegExp(`^bxfit:${KL}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const cover = bannerTpl.getSettings(kind).slotFit === "cover";
    await bannerTpl.updateSettings(kind, { slotFit: cover ? "contain" : "cover" });
    ctx.answerCbQuery(cover ? "🖼 Muat semua — gambar utuh" : "🖼 Isi penuh — pinggirnya dipotong").catch(() => {});
    await bxElemOpen(ctx, kind, "slot");
  });
  bot.action(new RegExp(`^bxb:${KL}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const on = bannerTpl.getSettings(kind).showBadge !== false;
    await bannerTpl.updateSettings(kind, { showBadge: !on });
    ctx.answerCbQuery(`🏷 Badge ${on ? "OFF" : "ON"}`).catch(() => {});
    await edit(ctx, bxMenuText(kind), bxMenuKb(kind));
  });
  // One-tap auto-text toggle straight from the kind menu — when a designed clip
  // already carries text ("Trending Alert" etc.), hiding the auto-drawn
  // $ticker/name/chips stops them overlapping; the bot then draws only the logo.
  bot.action(new RegExp(`^bt_txt:${KL}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const on = bannerTpl.getSettings(kind).showText !== false;
    await bannerTpl.updateSettings(kind, { showText: !on });
    ctx.answerCbQuery(on ? "🔤 Auto-text hidden — logo only (no overlap)" : "🔤 Auto-text shown").catch(() => {});
    await edit(ctx, btKindText(kind), btKindKb(kind));
  });
  bot.action(new RegExp(`^bt_ed:${KL}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await bxOpen(ctx, ctx.match[1]);
  });
  bot.action(new RegExp(`^bt_esel:${K}:${E}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    ctx.answerCbQuery(BT_ELEMS[elem].label).catch(() => {});
    await btEditorRefresh(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bt_emv:${K}:${E}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem, dxs, dys] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    const e = BT_ELEMS[elem];
    const x = Math.max(-800, Math.min(3200, btNum(s[e.xKey], 1070) + Number(dxs)));
    const y = Math.max(-800, Math.min(3200, btNum(s[e.yKey], 430) + Number(dys)));
    await bannerTpl.updateSettings(kind, { [e.xKey]: x, [e.yKey]: y });
    ctx.answerCbQuery(`📍 ${x}, ${y}`).catch(() => {});
    await btEditorRefresh(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bt_esz:${K}:${E}:(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem, ds] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    if (elem === "logo") {
      const size = Math.max(60, Math.min(1600, Number(s.logoSize) + Number(ds)));
      // grow/shrink around the slot CENTER so the ring stays put while resizing
      const dx = (Number(s.logoSize) - size) / 2;
      await bannerTpl.updateSettings(kind, {
        logoSize: size,
        logoX: Math.round(btNum(s.logoX, 1070) + dx),
        logoY: Math.round(btNum(s.logoY, 430) + dx),
      });
      ctx.answerCbQuery(`Logo ${size}px`).catch(() => {});
    } else {
      const e = BT_ELEMS[elem];
      const size = Math.max(12, Math.min(200, Number(s[e.sizeKey]) + Number(ds)));
      const patch = { [e.sizeKey]: size };
      // name stays visually paired with the ticker at half its size
      if (elem === "ticker") patch.nameFontSize = Math.max(12, Math.round(size / 2));
      await bannerTpl.updateSettings(kind, patch);
      ctx.answerCbQuery(`${e.label} ${size}px`).catch(() => {});
    }
    await btEditorRefresh(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bt_ewh:${K}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const w = Math.max(200, Math.min(2560, Number(s.slotW) + Number(ctx.match[2])));
    const h = Math.max(120, Math.min(1280, Number(s.slotH) + Number(ctx.match[3])));
    await bannerTpl.updateSettings(kind, { slotW: w, slotH: h });
    ctx.answerCbQuery(`📐 ${w}×${h}`).catch(() => {});
    await btEditorRefresh(ctx, kind, "logo");
  });
  bot.action(new RegExp(`^bt_erst:${K}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    await bannerTpl.resetSettings(kind);
    log.info(`[adminbot] ${kind} banner layout reset to defaults by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery("↩️ Layout reset to default").catch(() => {});
    await btEditorRefresh(ctx, kind, "logo");
  });
  bot.action(new RegExp(`^bt_done:${K}$`), async (ctx) => {
    ctx.answerCbQuery("✅ Saved").catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    await ctx.reply(btKindText(kind), { ...HTML, ...btKindKb(kind) }).catch(() => {});
  });

  bot.action(new RegExp(`^bt_sz:${K}:(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const size = Math.max(60, Math.min(1600, Number(s.logoSize) + Number(ctx.match[2])));
    await bannerTpl.updateSettings(kind, { logoSize: size });
    ctx.answerCbQuery(`Logo ${size}px`).catch(() => {});
    await edit(ctx, btKindText(kind), btKindKb(kind));
    if (bannerTpl.hasTemplate(kind)) await btPreview(ctx, kind);
  });
  bot.action(new RegExp(`^bt_pos:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "pos", kind };
    const s = bannerTpl.getSettings(kind);
    await ctx.reply(
      `📍 <b>Posisi logo — ${BT_KINDS[kind]}</b>\n` +
        `Sekarang: <b>${s.logoSize}px</b> di (${s.logoX}, ${s.logoY})\n\n` +
        `Kirim: <b>ukuran posisi</b>\n` +
        `👉 Contoh: <code>420 1890,410</code>\n` +
        `👉 Atau: <code>420 center,center</code>\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_slot:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "slot", kind };
    const s = bannerTpl.getSettings(kind);
    await ctx.reply(
      `📐 <b>Kotak gambar — ${BT_KINDS[kind]}</b>\n` +
        `Sekarang: <b>${s.slotW} × ${s.slotH}</b> di (${s.logoX}, ${s.logoY})\n\n` +
        `Kirim: <b>lebar tinggi posisi</b>\n` +
        `👉 Contoh: <code>1680 800 690,310</code>\n` +
        `👉 Atau: <code>1680 800 center,center</code>\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_text:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "text", kind };
    const s = bannerTpl.getSettings(kind);
    await ctx.reply(
      `🔤 <b>Tulisan otomatis — ${BT_KINDS[kind]}</b> ($TICKER + nama token di gambar).\n` +
        `Sekarang: <b>${s.showText ? "aktif" : "mati"}</b>, ${s.tickerFontSize}px di (${s.tickerX}, ${s.tickerY})\n\n` +
        `Kirim: <b>ukuran posisi</b>\n` +
        `👉 Contoh: <code>96 430,660</code>\n` +
        `👉 Atau tulis <code>off</code> / <code>on</code> untuk mematikan/menyalakan.\n\n/cancel untuk batal.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_badge:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const on = bannerTpl.getSettings(kind).showBadge !== false;
    await bannerTpl.updateSettings(kind, { showBadge: !on });
    // Turning on → jump to the badge element so it's visible to position; off → back to logo.
    await btEditorRefresh(ctx, kind, on ? "logo" : "badge");
  });
  bot.action(new RegExp(`^bt_prev:${KM}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await btPreview(ctx, ctx.match[1]);
  });
  bot.action(new RegExp(`^bt_rm:${K}$`), async (ctx) => {
    ctx.answerCbQuery("Custom artwork removed").catch(() => {});
    if (!guard(ctx)) return;
    await bannerTpl.removeTemplate(ctx.match[1]);
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
  });

  // 📣 opens the MANAGER, not the compose prompt: the dashboard answers the
  // questions an admin actually arrives with (who can I reach? how did the
  // last one go?) and every action is one tap below it — the fourtis panel.
  bot.action("bc", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, bcManagerText(), bcManagerKb());
  });
  bot.action("bc_refresh", async (ctx) => {
    ctx.answerCbQuery("Refreshed").catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, bcManagerText(), bcManagerKb());
  });
  bot.action("bc_new", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBroadcast = true;
    ctx.session.awaitingBcEdit = null;
    ctx.session.bcDraft = null;
    await ctx.reply(
      `📣 <b>Broadcast</b>\n\nSend the message to broadcast to all /start users — <b>text</b>, or a <b>photo with a caption</b> (HTML allowed). /cancel to abort.`,
      HTML,
    );
  });
  bot.action("bc_status", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    // resumable first — an interrupted job is the one an admin is here about
    const live = [...bcStore.jobsByStatus("in_progress"), ...bcStore.jobsByStatus("pending")][0];
    if (live) {
      const msg = await ctx.reply("📋 Reading the running broadcast…", HTML);
      return pollProgress(ctx.telegram, msg.chat.id, msg.message_id, live.id);
    }
    const s = bcStore.stats();
    const last = s.lastCompleted
      ? `Last completed: ${bcDate(s.lastCompleted.finishedAt || s.lastCompleted.createdAt)} · ✅ ${s.lastCompleted.sent}/${s.lastCompleted.total} · ❌ ${s.lastCompleted.failed}`
      : "Nothing has completed yet.";
    await ctx.reply(`📋 No broadcast is running.\n${last}`, HTML);
  });
  bot.action("bc_edit", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const r = bcEditable();
    if (r.error === "none") {
      return ctx.reply("✏️ Nothing to edit yet — no completed broadcast on file.").catch(() => {});
    }
    if (r.error === "no_ids") {
      // Different fact from "nothing to edit": the send predates message-id
      // recording, so its messages can never be found again.
      return ctx
        .reply(
          "✏️ The last broadcast was sent before message ids were recorded, so its messages can't be edited. Broadcasts sent from now on can be.",
        )
        .catch(() => {});
    }
    ctx.session.awaitingBcEdit = r.job.id;
    ctx.session.awaitingBroadcast = false;
    const snippet = (r.job.text || "(photo, no caption)").slice(0, 300);
    const media = r.job.mediaFileId || r.job.mediaPath ? "\n<i>It is a photo — the new text replaces its CAPTION; the photo itself stays.</i>" : "";
    await ctx.reply(
      `✏️ <b>Edit Sent</b> — rewriting the broadcast of ${bcDate(r.job.finishedAt || r.job.createdAt)} ` +
        `(✅ ${r.job.sent} delivered).\n\nCurrent text:\n<blockquote>${escapeHtml(snippet)}</blockquote>\n` +
        `Send the NEW text (HTML allowed). /cancel to abort.${media}`,
      HTML,
    );
  });
  bot.action("bc_hist", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(
      ctx,
      bcHistoryText(),
      Markup.inlineKeyboard([
        [Markup.button.callback("📤 Export CSV", "bc_csv")],
        [Markup.button.callback("⬅ Back", "bc")],
      ]),
    );
  });
  bot.action("bc_csv", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const jobs = bcStore.allJobs();
    if (!jobs.length) return ctx.reply("Nothing to export yet.").catch(() => {});
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    await ctx
      .replyWithDocument({ source: Buffer.from(bcCsv(jobs), "utf8"), filename: `broadcasts_${stamp}.csv` })
      .catch((e) => ctx.reply(`⚠️ Export failed: ${e.message}`).catch(() => {}));
  });
  bot.action("bc_send", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await launchBroadcast(ctx, false);
  });
  bot.action("bc_test", async (ctx) => {
    ctx.answerCbQuery("Sending test to you").catch(() => {});
    if (!guard(ctx)) return;
    await launchBroadcast(ctx, true);
  });
  bot.action("bc_cancel", async (ctx) => {
    ctx.answerCbQuery("Cancelled").catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.bcDraft = null;
    ctx.session.awaitingBroadcast = false;
    ctx.session.awaitingBcEdit = null;
    await edit(ctx, bcManagerText(), bcManagerKb());
  });

  bot.command("cancel", async (ctx) => {
    if (!guard(ctx)) return;
    ctx.session.awaitingTemplate = null;
    // Without this a "cancelled" swap stayed armed and ate the NEXT plain
    // message — including a full template someone sent for a different key.
    ctx.session.awaitingEmoji = null;
    ctx.session.awaitingBanner = false;
    ctx.session.awaitingBroadcast = false;
    ctx.session.awaitingBcEdit = null;
    ctx.session.awaitingBt = null;
    ctx.session.bcDraft = null;
    // Top-Gainers state too, for the same reason: an armed "send me a token link"
    // that /cancel didn't clear would eat the next plain message.
    ctx.session.awaitingGn = null;
    ctx.session.gn = null;
    await ctx.reply("Cancelled.", { ...HTML, ...mainKb() });
  });

  // ── Paid Mass DM review ─────────────────────────────────────────────────
  // Lists pending paid broadcasts and previews each with Approve/Reject. The
  // main-bot sender only runs jobs in `in_progress`, so approve = flip status.
  const massStore = require("../massdm/store");
  async function previewMassJob(ctx, job) {
    const buyer = job.createdByUsername ? `@${job.createdByUsername}` : `id ${job.createdBy}`;
    const cap = `🕵️ <b>Mass DM review</b> — ref <code>${escapeHtml(job.ref || job.id)}</code>\nFrom: ${escapeHtml(buyer)} · audience ${job.total}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("✅ Approve & send", `massrev_ok_${job.id}`), Markup.button.callback("🚫 Reject", `massrev_no_${job.id}`)],
    ]);
    try {
      if (job.mediaPath && fss.existsSync(job.mediaPath)) {
        await ctx.replyWithPhoto({ source: job.mediaPath }, { caption: job.text || cap, ...(job.entities && job.entities.length ? { caption_entities: job.entities } : {}) });
      } else if (job.entities && job.entities.length) {
        await ctx.reply(job.text, { entities: job.entities, disable_web_page_preview: true });
      } else if (job.text) {
        await ctx.reply(job.text, HTML);
      }
    } catch {
      /* preview best-effort */
    }
    await ctx.reply(cap, { ...HTML, ...kb });
  }
  bot.command("reviewmassdm", async (ctx) => {
    if (!guard(ctx)) return;
    const pending = massStore.jobsByStatus("pending_review");
    if (!pending.length) return ctx.reply("No paid Mass DM broadcasts awaiting review. ✅", HTML);
    await ctx.reply(`📣 <b>${pending.length}</b> broadcast(s) awaiting review:`, HTML);
    for (const job of pending.slice(0, 10)) await previewMassJob(ctx, job);
  });
  bot.action(/^massrev_ok_(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const job = massStore.loadJob(ctx.match[1]);
    if (!job) return ctx.reply("That job no longer exists.", HTML);
    if (job.status !== "pending_review") return ctx.reply(`Already ${job.status}.`, HTML);
    job.status = "in_progress"; // the main-bot sender picks it up within ~poll interval
    await massStore.saveJob(job);
    log.info(`[adminbot] mass DM ${job.id} APPROVED by @${ctx.from.username || ctx.from.id}`);
    await ctx.reply(`✅ Approved <code>${escapeHtml(job.ref || job.id)}</code> — sending now.`, HTML);
  });
  bot.action(/^massrev_no_(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const job = massStore.loadJob(ctx.match[1]);
    if (!job) return ctx.reply("That job no longer exists.", HTML);
    if (job.status !== "pending_review") return ctx.reply(`Already ${job.status}.`, HTML);
    job.status = "rejected";
    job.rejectedAt = Date.now();
    await massStore.saveJob(job);
    log.info(`[adminbot] mass DM ${job.id} REJECTED by @${ctx.from.username || ctx.from.id}`);
    // DM the buyer via the MAIN bot (this admin bot can't reach them).
    if (mainBotApi && job.createdBy) {
      mainBotApi
        .sendMessage(job.createdBy, `Your Mass DM broadcast (ref ${job.ref || job.id}) wasn't approved. Contact support for a review or refund.`)
        .catch(() => {});
    }
    await ctx.reply(`🚫 Rejected <code>${escapeHtml(job.ref || job.id)}</code>.`, HTML);
  });

  // The Top-Gainers banner generator owns its own keyboards and awaited inputs.
  // Registered HERE, before the two generic handlers below: neither of them calls
  // next(), so anything registered after them never sees a message. gainersMenu's
  // own handlers pass through everything they aren't waiting for.
  gainersMenu.register(bot, { guard, edit, HTML, fetchTelegramFileBuffer });

  // Text = new template value (when awaiting)
  bot.on("text", async (ctx) => {
    if (!guard(ctx)) return;
    const text = ctx.message.text || "";
    if (text.startsWith("/")) return; // commands handled above
    const entities = ctx.message.entities || [];
    // Banner-artwork settings input (per service: logo spot / creative slot /
    // text overlay)
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode !== "upload") {
      const { mode, kind, elem, pos, chain, alKey, atKey } = ctx.session.awaitingBt;
      ctx.session.awaitingBt = null;
      const low = text.trim().toLowerCase();
      // ── Auto-Trending: a typed value for one of the two quality floors ──
      //
      // Same three rules as `alset` below, deliberately in the same shape: the
      // parser is `parseCap` (never a private copy — `500k` reaching `Number()`
      // as NaN and being stored as the DEFAULT under a ✅ is the scar it
      // carries), a value it cannot read is REFUSED rather than defaulted, and
      // a clamped value says it was clamped.
      if (mode === "atset") {
        const spec = AT_TYPED[atKey];
        if (!spec) return;
        const asked = parseCap(text);
        if (asked == null) {
          return ctx
            .reply(
              `⚠️ tidak bisa membaca <code>${escapeHtml(text.trim())}</code> sebagai angka.\n\n` +
                `Contoh: <code>${escapeHtml(spec.eg)}</code> — atau <code>0</code> untuk mematikan filter ini.\n\n` +
                `<i>Tidak ada yang diubah.</i>`,
              { ...HTML, ...atKb() },
            )
            .catch(() => {});
        }
        const c = await autoTrend.set({ [atKey]: asked });
        const got = c[atKey];
        const clamped =
          got !== asked
            ? `\n<i>Disesuaikan dari ${escapeHtml(floorLabel(asked))} — itu batas yang diizinkan.</i>`
            : "";
        // A floor set to 0 is OFF, and the confirmation has to say so: "✅ Min
        // 24h volume → $0" reads like a filter that is on and refusing nothing.
        const off = got === 0 ? `\n<i>Filter ini sekarang MATI — token tanpa transaksi bisa masuk board lagi.</i>` : "";
        log.info(`[adminbot] auto-trend ${atKey} → ${got} by @${ctx.from.username || ctx.from.id}`);
        return ctx
          .reply(`✅ <b>${spec.label}</b> → <b>${escapeHtml(floorLabel(got))}</b>${clamped}${off}`, { ...HTML, ...atKb() })
          .catch(() => {});
      }
      // ── Auto-Listing: a typed value for one panel row ──
      if (mode === "alset") {
        const spec = AL_TYPED[alKey];
        if (!spec) return;
        const asked = spec.kind === "gap" ? autoLister.parseGap(text) : parseCap(text);
        // PARSE, THEN REFUSE — never fall through to a default. `clampInt`
        // answers a non-finite value with the shipped default, so a value the
        // bot could not read would be stored as a number nobody asked for,
        // under a ✅. That defect has been paid for once already, on the
        // gainers settings, and it is the reason both parsers return null.
        if (asked == null) {
          const hint =
            spec.kind === "gap"
              ? // ⚠️ A bare number is the one refusal worth spelling out: "3" is
                // three minutes to the store and three hours to the label above
                // it, and being wrong by 20× here is the firehose the pace
                // exists to prevent. Name BOTH readings rather than guess.
                /^\d+(\.\d+)?$/.test(low)
                ? `<code>${escapeHtml(text.trim())}</code> bisa berarti ${escapeHtml(text.trim())} menit atau ${escapeHtml(text.trim())} jam — tulis satuannya.`
                : `tidak bisa membaca <code>${escapeHtml(text.trim())}</code> sebagai durasi.`
              : `tidak bisa membaca <code>${escapeHtml(text.trim())}</code> sebagai angka.`;
          return ctx
            .reply(`⚠️ ${hint}\n\nContoh: <code>${escapeHtml(spec.eg)}</code>\n\n<i>Tidak ada yang diubah.</i>`, {
              ...HTML,
              ...alKb(),
            })
            .catch(() => {});
        }
        // ⚠️ THE ONE WRITE `alWrite` CANNOT SERVE, and so the one that was left
        // bare. `set()` refuses over an unreadable `autoLister.json` — right,
        // because writing DEFAULTS over it wipes every tuned threshold — and a
        // throw out of `bot.on("text")` is swallowed by `bot.catch`, i.e. pm2
        // only. So the operator taps a ✏️ row, types `2h30m`, and the bot says
        // NOTHING AT ALL: no ✅, no ⚠️, no panel edit. That is the worse half of
        // the pair — a spinning button at least spins — and it is "tidak
        // bekerja" produced by the guard written to end it. Same sentence
        // `alWrite` gives, through the channel a text message actually has.
        let c;
        try {
          c = await autoLister.set({ [alKey]: asked });
        } catch (e) {
          log.error(`[adminbot] auto-listing typed write refused: ${e.message}`);
          return ctx
            .reply(`⛔ ${escapeHtml(String(e.message).slice(0, 300))}\n\n<i>Tidak ada yang diubah.</i>`, {
              ...HTML,
              ...alKb(), // hands attached: back on the panel whose banner names the file
            })
            .catch(() => {});
        }
        const got = c[alKey];
        // AND SAY SO WHEN IT WAS CLAMPED. Storing something other than what was
        // asked for and answering ✅ is the same defect as the default
        // fallback, moved to the edges. The two pace rows report the whole BAND
        // rather than the end that was typed: raising the floor past the
        // ceiling moves the ceiling too, and an answer naming one number while
        // the other moved sends the operator to change the wrong setting.
        const shown = spec.kind === "gap" ? `one every ${autoLister.paceRange(c)}` : alShow(alKey, got);
        const clamped =
          got !== asked
            ? `\n<i>Disesuaikan dari ${escapeHtml(alShow(alKey, asked))} — itu batas yang diizinkan.</i>`
            : "";
        log.info(`[adminbot] auto-listing ${alKey} → ${got} by @${ctx.from.username || ctx.from.id}`);
        return ctx
          .reply(`✅ <b>${spec.label}</b> → <b>${escapeHtml(shown)}</b>${clamped}`, { ...HTML, ...alKb() })
          .catch(() => {});
      }
      const cv = (v) => (v === "center" ? "center" : Number(v));
      // ── Pump alert window: "MIN,MAX" (or "MIN MAX") ──
      if (mode === "pumpwindow") {
        const m = low.match(/^(\d+)\s*[, ]\s*(\d+)$/);
        if (!m) return ctx.reply("❌ Format: <code>MIN,MAX</code> — e.g. <code>100,2000</code>.", HTML).catch(() => {});
        const res = await pumpConfig.set({ minPct: Number(m[1]), maxPct: Number(m[2]) });
        await ctx.reply(`✅ Pump alert window set to <b>${res.minPct}%–${res.maxPct}%</b>.`, { ...HTML, ...pthKb() }).catch(() => {});
        return;
      }
      // ── Whale WALLET bar: a plain USD figure ("50000" / "$50,000" / "50k") ──
      if (mode === "whalebar") {
        // Operators type money the way they say it. "50k" and "$50,000" are the
        // same number, and rejecting either as a format error is the bot being
        // pedantic about its own input box.
        const m = low.replace(/[$,_\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
        if (!m) return ctx.reply("❌ Kirim angka USD saja — contoh <code>50000</code>, <code>$50,000</code> atau <code>50k</code>.", HTML).catch(() => {});
        const usd = Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
        const res = await whaleConfig.set({ walletUsd: usd });
        // Echo the STORED value, not what was typed: it passes through the
        // clamp, so "5" comes back as $100 and the operator sees that happen
        // instead of believing a bar the bot never accepted.
        await ctx.reply(`✅ Batas whale wallet: <b>${usdLabel(res.walletUsd)}</b>.`, { ...HTML, ...wthKb() }).catch(() => {});
        return;
      }
      // ── Pump preview at a typed % ──
      if (mode === "pumppreviewpct") {
        const n = Math.round(Number(low));
        if (!Number.isFinite(n) || n <= 0) return ctx.reply("❌ Send a positive number, e.g. <code>100</code>.", HTML).catch(() => {});
        if (!bannerTpl.mediaOverride("pump")) return ctx.reply("❌ No pump clip yet — upload one first.", HTML).catch(() => {});
        await btPreview(ctx, "pump", n);
        return;
      }
      // ── Trending board: set a rank badge / chain logo. A PREMIUM emoji is
      //    stored as markup ("[fallback](emoji/ID)") so it renders premium on
      //    the board (posted via the GramJS premium account); a plain emoji is
      //    stored as-is. ──
      // Echo back what the board will ACTUALLY render (after the plain→premium
      // promotion), so "did my premium emoji take?" is answered on the spot.
      const savedNote = (rendered) =>
        /\(emoji\//.test(rendered)
          ? gramjs.available()
            ? " — 💎 premium"
            : " — 💎 premium (⚠️ account offline, posts as fallback until you run gramjs-login.js)"
          : " — plain emoji";
      if (mode === "tbrank") {
        const frag = emojiFragment(ctx.message);
        if (!frag) return ctx.reply("❌ Send a single emoji.", HTML).catch(() => {});
        const p = pos || 1;
        await trendingBoard.setRankEmoji(p, frag).catch((e) => log.warn(`[adminbot] setRankEmoji: ${e.message}`));
        const rendered = trendingBoard.rankBadge(p);
        log.info(`[adminbot] rank ${p} badge → ${rendered} by @${ctx.from.username || ctx.from.id}`);
        await ctx
          .reply(`✅ Rank ${p} badge → ${trendingBoard.displayEmoji(rendered)}${savedNote(rendered)}`, { ...HTML, ...tbKb() })
          .catch(() => {});
        return;
      }
      if (mode === "tbtitle") {
        const frag = emojiFragment(ctx.message);
        if (!frag) return ctx.reply("❌ Send a single emoji.", HTML).catch(() => {});
        await trendingBoard.setTitleEmoji(frag).catch((e) => log.warn(`[adminbot] setTitleEmoji: ${e.message}`));
        const rendered = trendingBoard.titleEmoji();
        log.info(`[adminbot] board title emoji → ${rendered} by @${ctx.from.username || ctx.from.id}`);
        await ctx
          .reply(`✅ Board title → ${trendingBoard.displayEmoji(rendered)} Dexvra Trending${savedNote(rendered)}`, {
            ...HTML,
            ...tbKb(),
          })
          .catch(() => {});
        return;
      }
      if (mode === "tbnew") {
        const frag = emojiFragment(ctx.message);
        if (!frag) return ctx.reply("❌ Send a single emoji.", HTML).catch(() => {});
        await trendingBoard.setNewEmoji(frag).catch((e) => log.warn(`[adminbot] setNewEmoji: ${e.message}`));
        const rendered = trendingBoard.newEmoji();
        log.info(`[adminbot] new-entry marker → ${rendered} by @${ctx.from.username || ctx.from.id}`);
        await ctx
          .reply(
            `✅ New-entry marker → ${trendingBoard.displayEmoji(rendered)}${savedNote(rendered)}\n\n` +
              `<i>Legend on the board: ${trendingBoard.displayEmoji(rendered)} = Newly Entered Trending (slot started in the last ${trendingBoard.newHours()}h)</i>`,
            { ...HTML, ...tbKb() },
          )
          .catch(() => {});
        return;
      }
      if (mode === "tbnewhours") {
        const n = Math.round(Number(String(ctx.message.text || "").trim()));
        if (!Number.isFinite(n)) return ctx.reply("❌ Send a number, e.g. <code>3</code>.", HTML).catch(() => {});
        const saved = await trendingBoard.setNewHours(n);
        // Say what was STORED, not what was typed: 99 becomes 48 and the admin
        // must not walk away believing otherwise.
        const note = saved !== n ? ` <i>(clamped from ${n} — the range is ${trendingBoard.NEW_HOURS_MIN}–${trendingBoard.NEW_HOURS_MAX})</i>` : "";
        log.info(`[adminbot] new-entry window → ${saved}h by @${ctx.from.username || ctx.from.id}`);
        await ctx.reply(`✅ Newly-entered window → <b>${saved}h</b>${note}`, { ...HTML, ...tbKb() }).catch(() => {});
        return;
      }
      if (mode === "tbchain") {
        const frag = emojiFragment(ctx.message);
        if (!frag || !chain) return ctx.reply("❌ Send a single emoji.", HTML).catch(() => {});
        await trendingBoard.setChainLogo(chain, frag).catch((e) => log.warn(`[adminbot] setChainLogo: ${e.message}`));
        const rendered = trendingBoard.chainLogo(chain);
        log.info(`[adminbot] ${chain} logo → ${rendered} by @${ctx.from.username || ctx.from.id}`);
        await ctx
          .reply(`✅ ${chain.toUpperCase()} logo → ${trendingBoard.displayEmoji(rendered)}${savedNote(rendered)}`, {
            ...HTML,
            ...tbChainsKb(),
          })
          .catch(() => {});
        return;
      }
      // ── Fourtis-style editor: exact size / slot size / move ──────────────
      if (mode === "bxsize" || mode === "bxslotsize" || mode === "bxmove") {
        try {
          if (mode === "bxsize") {
            const n = Math.round(Number(low));
            const c = BX[elem];
            if (!c || !Number.isFinite(n)) return ctx.reply("❌ Send a number, e.g. <code>96</code>.", HTML).catch(() => {});
            const v = Math.max(c.smin, Math.min(c.smax, n));
            await bannerTpl.updateSettings(kind, { [c.sizeKey]: v });
            await ctx.reply(bxElemText(kind, elem), { ...HTML, ...bxElemKb(kind, elem) });
          } else if (mode === "bxslotsize") {
            const m = low.match(/^(\d+)\s+(\d+)$/);
            if (!m) return ctx.reply("❌ Kirim dua angka dipisah spasi — lebar dulu, lalu tinggi.\n👉 Contoh: <code>1548 760</code>", HTML).catch(() => {});
            await bannerTpl.updateSettings(kind, { slotW: Math.max(200, Math.min(2560, Number(m[1]))), slotH: Math.max(120, Math.min(1280, Number(m[2]))) });
            await ctx.reply(bxElemText(kind, "slot"), { ...HTML, ...bxElemKb(kind, "slot") });
          } else {
            const m = low.match(/^(center|-?\d+)\s*,\s*(center|-?\d+)$/);
            if (!m) return ctx.reply("❌ Kirim dua angka dipisah koma — kiri-ke-kanan dulu, lalu atas-ke-bawah.\n👉 Contoh: <code>1890,410</code>\n👉 Atau: <code>center,center</code>", HTML).catch(() => {});
            const c = elem === "slot" ? { xKey: "logoX", yKey: "logoY" } : BX[elem];
            await bannerTpl.updateSettings(kind, { [c.xKey]: cv(m[1]), [c.yKey]: cv(m[2]) });
            await ctx.reply(bxElemText(kind, elem), { ...HTML, ...bxElemKb(kind, elem) });
          }
        } catch (e) {
          await ctx.reply(`⚠️ ${e.message}`).catch(() => {});
        }
        return;
      }
      try {
        if (mode === "text" && (low === "off" || low === "on")) {
          await bannerTpl.updateSettings(kind, { showText: low === "on" });
          await ctx.reply(`✅ ${BT_KINDS[kind]}: text overlay <b>${low}</b>.`, HTML);
        } else if (mode === "slot") {
          const m = low.match(/^(\d+)\s+(\d+)\s+(center|-?\d+)\s*,\s*(center|-?\d+)$/);
          if (!m) return ctx.reply("❌ Format: <code>WIDTH HEIGHT X,Y</code> — e.g. <code>1680 800 690,310</code>", HTML).catch(() => {});
          await bannerTpl.updateSettings(kind, { slotW: Number(m[1]), slotH: Number(m[2]), logoX: cv(m[3]), logoY: cv(m[4]) });
          await ctx.reply(`✅ ${BT_KINDS[kind]}: kotak tersimpan. Sedang menampilkan hasil…`, HTML);
        } else {
          const m = low.match(/^(\d+)\s+(center|-?\d+)\s*,\s*(center|-?\d+)$/);
          if (!m) return ctx.reply("❌ Format: <code>SIZE X,Y</code> — e.g. <code>420 1890,410</code>", HTML).catch(() => {});
          const patch =
            mode === "pos"
              ? { logoSize: Number(m[1]), logoX: cv(m[2]), logoY: cv(m[3]) }
              : { tickerFontSize: Number(m[1]), tickerX: cv(m[2]), tickerY: cv(m[3]), showText: true };
          await bannerTpl.updateSettings(kind, patch);
          await ctx.reply(`✅ ${BT_KINDS[kind]}: tersimpan. Sedang menampilkan hasil…`, HTML);
        }
        if (bannerTpl.hasTemplate(kind)) await btPreview(ctx, kind);
      } catch (e) {
        await ctx.reply(`⚠️ ${e.message}`).catch(() => {});
      }
      return;
    }
    if (ctx.session.awaitingBcEdit) {
      const sourceId = ctx.session.awaitingBcEdit;
      ctx.session.awaitingBcEdit = null;
      const r = await bcStore.createEditJob({
        sourceId,
        text,
        entities,
        createdBy: String(ctx.from.id),
        createdByUsername: ctx.from.username,
      });
      if (r.error) {
        await ctx.reply(`⚠️ Couldn't queue the edit (${r.error}).`).catch(() => {});
        return;
      }
      const msg = await ctx.reply(
        `✏️ <b>Edit queued</b> for <b>${r.job.total}</b> delivered message(s). Rewriting via the main bot…`,
        HTML,
      );
      pollProgress(ctx.telegram, msg.chat.id, msg.message_id, r.job.id);
      return;
    }
    if (ctx.session.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      ctx.session.bcDraft = { text, entities };
      // rendered preview — re-send with the admin's entities so premium emoji show
      const prevExtra = entities.length
        ? { entities, disable_web_page_preview: true }
        : HTML;
      await ctx.reply(text, prevExtra).catch(() => {});
      await ctx.reply("Send this broadcast?", bcControlKb(bcStore.audience().length));
      return;
    }
    if (ctx.session.awaitingEmoji) {
      const { key, i, spots, from, page } = ctx.session.awaitingEmoji;
      ctx.session.awaitingEmoji = null;
      const frag = emojiFragment(ctx.message);
      if (!frag) return ctx.reply("❌ Send a single emoji.", HTML).catch(() => {});
      // One slot on the buy-card screen can own several spots across several
      // templates (the 💲 on the buy card and the 💲 on the whale card are one
      // icon to the operator). A single-template swap is that same list of one.
      const targets = spots && spots.length ? spots : [{ key, i }];
      try {
        // Every replacement is exactly one emoji for one emoji, so the indices
        // of the spots still to come do not move. Anything that changed the
        // COUNT would have to run back-to-front instead.
        for (const t of targets) await tpl.replaceEmojiAt(t.key, t.i, frag);
      } catch (e) {
        return ctx.reply(`⚠️ ${escapeHtml(e.message)}`, HTML).catch(() => {});
      }
      const head = targets[0];
      const now = tpl.listEmojis(head.key)[head.i];
      const who = `@${ctx.from.username || ctx.from.id}`;
      log.info(
        `[adminbot] emoji → ${frag} by ${who} in ${targets.map((t) => `${t.key}#${t.i + 1}`).join(", ")}`,
      );
      await ctx
        .reply(
          `✅ Diganti jadi ${escapeHtml(now ? now.char : frag)}${now && now.id ? " — 💎 premium" : ""}` +
            `${targets.length > 1 ? ` di ${targets.length} tempat` : ""}. Aktif dalam ~30 detik.` +
            // Every template that was touched gets checked: a swap landing on the
            // wrong span is exactly how "{💎}" reached a customer's group.
            [...new Set(targets.map((t) => t.key))].map((k) => placeholderWarning(k)).join(""),
          HTML,
        )
        .catch(() => {});
      // The card, immediately, without being asked. "Aktif dalam ~30 detik" is
      // not something an operator can check: on a quiet contract the next real
      // buy is hours away, in a customer's group, in public. Seeing it here is
      // the difference between changing an icon and choosing one.
      if (from === "aem") {
        // The cards, then straight back to the same page — so restyling forty
        // icons is forty taps rather than forty round trips through the menu,
        // and each one is CHOSEN rather than merely changed. "Aktif dalam ~30
        // detik" is not something an operator can check: the next real buy is
        // hours away, in a customer's group, in public.
        await sendAllEmojiPreview(ctx);
        await sendAllEmojiPicker(ctx, page || 0);
      } else if (from === "bem") {
        await sendBuyPreview(ctx);
        await sendBuyEmojiPicker(ctx);
      } else {
        await sendTemplatePreview(ctx, head.key);
        await sendEmojiPicker(ctx, head.key);
      }
      return;
    }
    const key = ctx.session.awaitingTemplate;
    if (!key) return;
    ctx.session.awaitingTemplate = null;
    // A message pasted with AUTHORED formatting (premium emoji, bold, links…)
    // is stored verbatim as {text, entities} so custom emoji survive. Telegram
    // auto-detects url/command/mention entities on ANY plain message — those
    // alone must NOT freeze a typed markup template into verbatim storage.
    const premiumLib = require("../premium");
    const value = premiumLib.hasAuthoredFormatting(entities) ? { text, entities } : text;
    await tpl.setTemplate(key, value);
    const nPrem = entities.filter((e) => e.type === "custom_emoji").length;
    log.info(
      `[adminbot] template '${key}' updated by @${ctx.from.username || ctx.from.id} (${text.length} chars, ${entities.length} entities, ${nPrem} premium emoji)`,
    );
    await ctx.reply(
      `✅ Saved <b>${escapeHtml(tpl.meta(key).label)}</b>${nPrem ? ` with 💎 ${nPrem} premium emoji` : ""}. It goes live within ~30s.` +
        placeholderWarning(key),
      HTML,
    );
    // Rewriting a card is exactly when a placeholder gets mistyped or a row
    // ends up two lines long. Showing the result costs one message and answers
    // both without waiting for the bot to send it somewhere real.
    await sendTemplatePreview(ctx, key);
    await sendTemplateView(ctx, key);
  });

  // Photo = banner upload (when awaiting)
  bot.on(["photo", "document", "animation", "video"], async (ctx) => {
    if (!guard(ctx)) return;
    // GIF/video clip upload (per kind, incl. pump) — wins over the still artwork
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode === "media_upload") {
      const { kind } = ctx.session.awaitingBt;
      const m = ctx.message;
      // A still photo counts as media for the group-alert slots only — see
      // BT_PHOTO_KINDS. Everywhere else a photo lands in the ⬆ Upload artwork
      // slot instead, and accepting it here would quietly replace a composited
      // banner with a flat one.
      const photoOk = BT_PHOTO_KINDS.has(kind);
      let fileId, ext;
      if (m.animation) { fileId = m.animation.file_id; ext = "gif"; } // looping clip → sendAnimation
      else if (m.video) { fileId = m.video.file_id; ext = "mp4"; }
      else if (m.photo && photoOk) { fileId = m.photo[m.photo.length - 1].file_id; ext = "jpg"; } // largest size
      else if (m.document) {
        fileId = m.document.file_id;
        const fn = String(m.document.file_name || "").toLowerCase();
        const still = photoOk && /\.(jpe?g|png)$/.test(fn);
        ext = still
          ? fn.endsWith(".png") ? "png" : "jpg"
          : fn.endsWith(".gif") ? "gif" : fn.endsWith(".webm") ? "webm" : fn.endsWith(".mov") ? "mov" : "mp4";
      }
      if (!fileId) return ctx.reply(`Kirim ${btMediaWord(kind)}.`).catch(() => {});
      ctx.session.awaitingBt = null;
      try {
        // Clips can be up to ~20 MB, so allow a generous timeout, and retry the
        // download so a transient "fetch failed" doesn't lose the whole upload.
        const buf = await fetchTelegramFileBuffer(ctx.telegram, fileId, { timeoutMs: 45000 });
        const { type, bytes, path: savedPath } = await bannerTpl.saveMedia(kind, buf, ext);
        log.info(`[adminbot] ${kind} ${type} clip uploaded by @${ctx.from.username || ctx.from.id} (${bytes}B → ${savedPath})`);
        const mb = (bytes / 1048576).toFixed(2);
        // ONE preview only, and it's admin-triggered — auto-previewing here on top
        // of the admin tapping 👁 Preview produced two identical previews.
        const word = type === "photo" ? "Foto" : "GIF/video";
        const verb = type === "photo" ? "dikirim" : "diputar";
        await ctx.reply(`✅ <b>${word} ${BT_KINDS[kind]} tersimpan</b> (${mb} MB). Sekarang ${verb} di atas setiap post ${BT_KINDS[kind]} (menggantikan gambar diamnya).\n\nTekan 👁 <b>Lihat hasil</b> di bawah untuk melihatnya.`, { ...HTML, ...btKindKb(kind) });
      } catch (e) {
        await ctx.reply(`⚠️ Gagal menyimpan media: ${e.message}`).catch(() => {});
      }
      return;
    }
    // Channel banner artwork upload
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode === "upload") {
      const { kind } = ctx.session.awaitingBt;
      const fileId = getMediaFileId(ctx);
      if (!fileId) return ctx.reply("Gambarnya tidak terbaca — kirim sebagai foto atau file.").catch(() => {});
      ctx.session.awaitingBt = null;
      try {
        const artBuf = await fetchTelegramFileBuffer(ctx.telegram, fileId, { timeoutMs: 30000 });
        await bannerTpl.saveTemplate(kind, artBuf);
        let sizeNote = "";
        try {
          const im = await require("@napi-rs/canvas").loadImage(artBuf);
          if (im.width < 2000) {
            sizeNote = `\n\n⚠️ Terkirim ${im.width}×${im.height}px (Telegram mengompres foto). Tetap dipakai — otomatis diperbesar ke 2560×1280 — tapi supaya tajam, kirim ulang sebagai <b>File/dokumen</b>.`;
          }
        } catch { /* dimension probe is best-effort */ }
        log.info(`[adminbot] ${kind} banner artwork uploaded by @${ctx.from.username || ctx.from.id}`);
        await ctx.reply(
          `✅ <b>Gambar ${BT_KINDS[kind]} tersimpan.</b> Buka 🎛 Atur tata letak untuk menaruh logo/tulisan, lalu 👁 Lihat hasil.${sizeNote}`,
          { ...HTML, ...btKindKb(kind) },
        );
        await btPreview(ctx, kind);
      } catch (e) {
        await ctx.reply(`⚠️ Couldn't save the artwork: ${e.message}`).catch(() => {});
      }
      return;
    }
    if (ctx.session.awaitingBroadcast) {
      const fileId = getMediaFileId(ctx);
      if (!fileId) return ctx.reply("Couldn't read that image — send it as a photo.").catch(() => {});
      ctx.session.awaitingBroadcast = false;
      const capEntities = ctx.message.caption_entities || [];
      ctx.session.bcDraft = { adminFileId: fileId, text: ctx.message.caption || "", entities: capEntities };
      try {
        const prevExtra = capEntities.length
          ? { caption: ctx.message.caption, caption_entities: capEntities }
          : ctx.message.caption
            ? { caption: ctx.message.caption, parse_mode: "HTML" }
            : {};
        await ctx.replyWithPhoto(fileId, prevExtra);
      } catch {
        /* preview best-effort */
      }
      await ctx.reply("Send this broadcast?", bcControlKb(bcStore.audience().length));
      return;
    }
    if (!ctx.session.awaitingBanner) return;
    const fileId = getMediaFileId(ctx);
    if (!fileId) return ctx.reply("Couldn't read that image — send it as a photo.").catch(() => {});
    ctx.session.awaitingBanner = false;
    try {
      await saveBanner(ctx.telegram, fileId);
      log.info(`[adminbot] banner updated by @${ctx.from.username || ctx.from.id}`);
      await ctx.reply("✅ Banner saved. It shows on /start within ~30s.", { ...HTML, ...bannerKb() });
    } catch (e) {
      await ctx.reply(`⚠️ Couldn't save the banner: ${e.message}`, HTML);
    }
  });

  bot.catch((err, ctx) => log.error(`[adminbot] ${ctx && ctx.updateType}: ${err && err.message}`));
  return bot;
}

async function startAdminBot() {
  if (!ADMIN_BOT_TOKEN) {
    log.warn("[adminbot] ADMIN_BOT_TOKEN not set — admin bot disabled");
    return false; // the caller has to keep the process alive; see adminbot.js
  }
  // Restore/seed templates + banner config from the Mongo durable mirror before
  // serving the editor (fail-open without MONGO_URI).
  try {
    await require("../helpers/persist").hydrate();
    // Keep it converged, not just converged once. Each save mirrors
    // fire-and-forget, so a Mongo blip leaves that store unmirrored with nothing
    // to notice — and the store most likely to be edited and least likely to be
    // re-saved soon is templates.json, where an admin's premium emoji live.
    require("../helpers/persist").startMirrorSweep();
    await require("../db/jobMirror").restoreAll(); // so /reviewbroadcasts sees pending jobs after a VPS reset
    await require("../db/mediaMirror").hydrate(); // restore banner clips/artwork so the editor previews them
  } catch (e) {
    log.warn(`[adminbot] persist hydrate failed (continuing on local files): ${e && e.message}`);
  }
  // Same un-forking the main bot does, and run here too because THIS is the
  // process that shows an operator whether a template is ✏️ custom or 📋 default.
  // Whichever of the two boots first does the work; it is idempotent.
  try {
    const moved = await tpl.migrateEmojiOnlyOverrides();
    if (moved.length) log.info(`[adminbot] ${moved.length} icon-only override(s) now follow releases again: ${moved.join(", ")}`);
  } catch (e) {
    log.warn(`[adminbot] emoji overlay migration skipped: ${e && e.message}`);
  }
  const bot = build();
  await bot.telegram.setMyCommands([
    { command: "start", description: "Open the template editor" },
    { command: "preview", description: "Audit all templates at once" },
    { command: "gainers", description: "Top Gainers banner (live 24h movers)" },
    { command: "home", description: "Back to the menu" },
    { command: "cancel", description: "Cancel the current edit" },
  ]).catch(() => {});
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  log.info("[adminbot] launching (long-polling)…");
  // Clear any stray webhook (a set webhook makes getUpdates 409 forever → the bot
  // silently stops answering) and drop the backlog. Best-effort, never blocks startup.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    log.warn(`[adminbot] deleteWebhook: ${e.message}`);
  }
  await bot
    .launch({ dropPendingUpdates: true, allowedUpdates: ["message", "callback_query"] })
    .catch((e) => {
      log.error(`[adminbot] launch FAILED (no updates will be received): ${e.message}`);
      throw e;
    });
  log.info("[adminbot] polling started ✔");
  return true;
}

module.exports = {
  // Panel-rendering seam: the layout is the thing that was wrong, so a test
  // (and the preview script) must be able to render it without a bot.
  _test: { atText, atKb, atBoardLines, setAtCounts: (c) => (_atCounts = c), setAtPending: (n) => (_atPending = n) }, startAdminBot, build };
// Exposed for tests: the group-menu keyboard builder + its paging constant.
module.exports._menu = { groupKb, mainKb, groupNames, slugOf, nameFromSlug, GROUP_PAGE };
// Exposed for tests: the trending-board editor + the premium-emoji report.
module.exports._board = { tbText, tbKb, tbChainsText, tbChainsKb, tbMark, tbRefreshText, emojiFragment, premiumReportText };
// Exposed for tests: the resilient Telegram file downloader (retry + clear errors).
module.exports._net = { fetchTelegramFileBuffer };
// Exposed for tests: the template controls card and its broken-placeholder guard.
module.exports._tpl = { viewText, placeholderWarning, viewKb };
module.exports._premium = { premiumSurface, premiumNoteFor, GROUP_PREMIUM_NOTE, CHANNEL_PREMIUM_NOTE, X_PREMIUM_NOTE };
// Exposed for tests: the one screen that owns every icon on the buy card.
module.exports._buyEmoji = { buyEmojiSlots, buyEmojiKb, buyEmojiText, emojiHint, buyPreviews, BUY_CARD_EMOJI_KEYS, CARD_OF_KEY, sendBuyPreview, sendTemplatePreview };
module.exports._allEmoji = { allEmojiSlots, allEmojiKeys, allEmojiKb, allEmojiText, allEmojiPages, ALL_EMOJI_PER_PAGE };
// Exposed for tests: any template rendered on sample values, the thing every
// preview button shows.
module.exports._preview = { renderSample, SPECIAL_RENDER, SAMPLE_VARS };
module.exports._bc = { bcManagerText, bcManagerKb, bcHistoryText, bcCsv, bcEditable, bcDate };
