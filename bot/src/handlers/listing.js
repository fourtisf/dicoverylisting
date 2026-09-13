// Listing flow: Xpress Listing (instant, XPRESS tier) and Listing & Trending
// (pick a ranked tier). Guided form → review card → tier (tiered) → payment.
// Per-chain contract-address validation is enforced (the reference bot skipped it).
const { answer, toast, sendCard, sendPhotoCard, getMediaFileId } = require("../helpers/message");
const { chainOf, isValidAddress, payChainOf, payNativeOf } = require("../config/chains");
const { RANKED_TIERS, tierPrice, tierMeta, tierLabel, tierEmoji, tierTrendingHours } = require("../config/packages");
const { fetchMarket, fetchTokenDescription } = require("../marketdata");
// Autofill asks every source that indexes the chain, not just DexScreener —
// on Robinhood Chain, which DexScreener does not index, pools.trade is the only
// one that knows the token at all. See discovery.js.
const { fetchTokenInfo } = require("../discovery");
const { escapeHtml } = require("../helpers/format");
const { normalizeTicker, isValidTicker, sanitizeTicker } = require("../helpers/ticker");
// ⚠️ The MODULE, not a destructured startPayment. A destructured import is
// bound at require time, so a test that stubs pay.startPayment afterwards is
// never seen — and what this flow hands the payment path (the total, the coin,
// the attached broadcast) is exactly what needs pinning. The rule autoTrend.js
// and trendingPoster.js already state at their own requires.
const pay = require("./pay");
const menu = require("./menu");
const { Markup } = menu;
const tpl = require("../templates");
const listed = require("../helpers/listedGuard");
const log = require("../helpers/logger");

const URL_RE = /^https?:\/\/\S+$/i;

/*
 * ⚠️ THE AUTOFILL IS BOUNDED, because two of its three sources queue on the
 * shared GeckoTerminal budget with NO deadline of their own.
 *
 * `fetchMarket` and `fetchTokenDescription` wait on `gtTurn()` →
 * `gtSlot(PRIO_BACKGROUND)` (group/gtPairs): a queue released once per
 * GT_MIN_GAP_MS — 12 SECONDS per slot on the keyless 5/min split — capped at
 * 200 entries, i.e. up to ~40 minutes of wait before it even rejects. Every
 * background pipeline (trending poster, autoTrend, pump checker, the candle
 * reads) keeps that queue populated all day, so a USER-PROMPTED paste sat
 * behind timer jobs for minutes. From Telegram that is a prompt card standing
 * over a bot that never answers — reported verbatim as "bot tidak merespon
 * untuk paket listing setelah di minta drop ca", the day after the GT budget
 * was halved and every queue wait tripled.
 *
 * Autofill is an ENRICHMENT: every field it fills, the form lets the user
 * edit. A slow source contributes nothing and the form goes on — the same
 * rule the launchpad registry states for a dead pad. The abandoned lookup
 * keeps running and lands in its cache, so a retry gets it for free.
 */
const AUTOFILL_MAX_MS = Math.max(1000, Number(process.env.LISTING_AUTOFILL_MS || 8000));

/** Test seam — the three lookups, swappable without a network. The
 *  `core._deps.providerFor` shape, for the same reason. */
const _lookups = { fetchTokenInfo, fetchMarket, fetchTokenDescription };

/** Run one lookup with a ceiling. Resolves null on timeout, rejection, or a
 *  synchronous throw — an autofill source can fail, never the form.
 *  ⚠️ NOT unref'd — the gtDrain rule, one module over: a user is waiting on
 *  this timer, an unref'd one does not hold the event loop open, and a process
 *  with nothing else pending would exit with the form hung forever. It lives
 *  at most AUTOFILL_MAX_MS, so reffing it cannot keep a process alive. */
const bounded = (fn, ms = AUTOFILL_MAX_MS) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    Promise.resolve()
      .then(fn)
      .then(
        (v) => { clearTimeout(t); resolve(v); },
        () => { clearTimeout(t); resolve(null); },
      );
  });

function emptyForm() {
  return {
    chain: null, address: null, sym: null, name: null, emoji: "🪙", overview: null,
    website: null, twitter: null, telegram: null, logoFileId: null, logoUrl: null,
    // Set from the launchpad autofill when the token has not migrated; null
    // otherwise. Declared here so the form has one shape, not two.
    bonding: null,
  };
}

// One clean paragraph — the overview renders on the channel post and the site.
// Length limits count code points so an emoji at the boundary never gets its
// surrogate pair split (which would store/send ill-formed text).
const cpSlice = (s, n) => Array.from(String(s)).slice(0, n).join("");
const cleanOverview = (s) => cpSlice(String(s || "").replace(/\s+/g, " ").trim(), 500) || null;

// Auto-written project intro — used when the token carries no on-chain/API
// description and the user didn't type one, so the review card and channel post
// always read as a finished listing instead of "not set". Editable like any
// field. Returns null only if we don't even know the token name yet.
function autoIntro(f) {
  const nm = String(f.name || "").trim();
  if (!nm) return null;
  const sy = f.sym ? ` ($${String(f.sym).replace(/^\$+/, "")})` : "";
  const ch = f.chain && chainOf(f.chain) ? chainOf(f.chain).label : f.chain || "";
  return `${nm}${sy} is now live and trading on ${ch}.`;
}
function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}
function isListing(ctx) {
  const t = ctx.session && ctx.session.type;
  return t === "xpress_listing" || t === "tiered_listing";
}

// ── Entry ────────────────────────────────────────────────────────────────────
async function entry(ctx, type) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  freshSession(ctx, { type, form: emptyForm() });
  const intro = tpl.render(type === "xpress_listing" ? "intro_xpress" : "intro_tiered");
  // The Xpress intro points to Listing & Trending — give a one-tap route to it
  // (a button, not just text), so nobody has to backtrack to Home to upgrade.
  const extra =
    type === "xpress_listing"
      ? [[menu.Markup.button.callback("🏆 Listing & Trending", "listing_trend_coin")]]
      : [];
  await sendCard(ctx, intro, menu.chainMenu("lc", extra));
}
const entryXpress = (ctx) => entry(ctx, "xpress_listing");
const entryListingTrending = (ctx) => entry(ctx, "tiered_listing");

// ── Chain pick ───────────────────────────────────────────────────────────────
async function chainPick(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const chain = ctx.match[1];
  if (!chainOf(chain)) return toast(ctx, "Unknown chain.");
  ctx.session.form.chain = chain;
  ctx.session.awaitingField = "address";
  await sendCard(ctx, tpl.render("listing_ca_prompt", { chain: chainOf(chain).label }), menu.withHome([]));
}

// ── Free-text field capture ──────────────────────────────────────────────────
async function handleText(ctx) {
  const s = ctx.session;
  const f = s.form;
  if (!f) return;
  const field = s.awaitingField;
  const input = (ctx.message.text || "").trim();

  if (input === "/skip" && ["logo", "website", "twitter", "telegram", "overview"].includes(field)) {
    // overview + logo edit prompts promise "/skip to remove" — honour it
    if (field === "overview") f.overview = null;
    if (field === "logo") { f.logoFileId = null; f.logoUrl = null; }
    s.awaitingField = null;
    return showReview(ctx);
  }

  switch (field) {
    case "address": {
      if (!isValidAddress(f.chain, input)) {
        return toast(ctx, tpl.render("invalid_address", { chain: chainOf(f.chain).label }));
      }
      // One token, one listing. Checked BEFORE the autofill round-trip so a
      // repeat contract is answered immediately, and before any of the form is
      // filled in for a listing that can never be sold.
      if (await listed.blockIfListed(ctx, input, f.chain)) return;
      f.address = input;
      // The paste is ANSWERED before the indexers are asked. The lookups below
      // are bounded but still seconds long, and a prompted input followed by
      // seconds of nothing is "the button does nothing" — the report that
      // produced the atrun fix, on a text prompt. The review card (or the next
      // prompt) replaces this card, so the flow stays one live message.
      await sendCard(ctx, tpl.render("listing_lookup_wait"), menu.withHome([]));
      // Autofill from the token's own indexer — pools.trade on Robinhood Chain,
      // DexScreener everywhere else (name/symbol/logo + socials: X/Telegram/
      // Website) — and GeckoTerminal (name/symbol/logo + project overview).
      // The indexer wins for socials. Each source has AUTOFILL_MAX_MS to
      // answer; see `bounded` for why a ceiling here is load-bearing.
      const [ds, gt, desc] = await Promise.all([
        bounded(() => _lookups.fetchTokenInfo(f.chain, input)),
        bounded(() => _lookups.fetchMarket(f.chain, input)),
        bounded(() => _lookups.fetchTokenDescription(f.chain, input)),
      ]);
      const name = (ds && ds.name) || (gt && gt.name);
      const symbol = (ds && ds.symbol) || (gt && gt.symbol);
      const logoUrl = (ds && ds.logoUrl) || (gt && gt.logoUrl);
      if (desc && !f.overview) f.overview = cleanOverview(desc);
      // Only when a launchpad SAID the token is on a curve. `onCurve` is
      // three-valued — true, false, or null for "no pad knows" — and treating
      // the null as true would put a bonding notice on every token nothing
      // happened to index.
      f.bonding = ds && ds.onCurve === true
        ? { progressPct: Number.isFinite(ds.progressPct) ? ds.progressPct : null, launchpad: ds.launchpad || null }
        : null;
      // An AUTOFILLED ticker has to satisfy the site's rule too. DexScreener and
      // GeckoTerminal return whatever the token deployer wrote — "SAFE MOON",
      // "PEPE🐸" — and storing that verbatim only failed at fulfilment, i.e.
      // after the buyer paid. Repair what we can; when nothing valid survives,
      // ASK instead of carrying a ticker the site will reject.
      const autoSym = sanitizeTicker(symbol || name);
      if (name || autoSym) {
        f.name = f.name || name || autoSym;
        if (!f.sym && autoSym) f.sym = autoSym;
        if (logoUrl && !f.logoUrl) f.logoUrl = logoUrl;
        if (ds) {
          if (ds.website && !f.website) f.website = ds.website;
          if (ds.twitter && !f.twitter) f.twitter = ds.twitter;
          if (ds.telegram && !f.telegram) f.telegram = ds.telegram;
        }
        if (!f.sym) {
          log.warn(`[listing] autofill gave no usable ticker for ${f.chain}/${input} (symbol=${symbol ?? "-"})`);
          s.awaitingField = "symbol";
          return sendCard(ctx, tpl.render("listing_symbol_prompt"), menu.withHome([]));
        }
        s.awaitingField = null;
        return showReview(ctx);
      }
      s.awaitingField = "name";
      return sendCard(ctx, tpl.render("listing_name_prompt"), menu.withHome([]));
    }
    case "name":
      f.name = input.slice(0, 60);
      if (!s.reviewShown) {
        s.awaitingField = "symbol";
        return sendCard(ctx, tpl.render("listing_symbol_prompt"), menu.withHome([]));
      }
      s.awaitingField = null;
      return showReview(ctx);
    case "symbol":
      // Checked HERE, not at fulfilment: the site rejects a bad ticker with a
      // 400, and by fulfilment the buyer has already paid.
      if (!isValidTicker(input)) return toast(ctx, tpl.render("invalid_ticker"));
      f.sym = normalizeTicker(input);
      if (!s.reviewShown) {
        s.awaitingField = "logo";
        return sendCard(ctx, tpl.render("listing_logo_prompt"), menu.withHome([]));
      }
      s.awaitingField = null;
      return showReview(ctx);
    case "overview":
      f.overview = cleanOverview(input);
      s.awaitingField = null;
      return showReview(ctx);
    case "website":
    case "twitter":
    case "telegram":
      if (!URL_RE.test(input)) return toast(ctx, tpl.render("invalid_url"));
      f[field] = input;
      s.awaitingField = null;
      return showReview(ctx);
    default:
      return; // no active field
  }
}

async function handlePhoto(ctx) {
  const s = ctx.session;
  if (!s || !s.form || s.awaitingField !== "logo") return;
  const id = getMediaFileId(ctx);
  if (!id) return;
  s.form.logoFileId = id;
  s.form.logoUrl = null; // uploaded photo wins over any autofill URL
  s.awaitingField = null;
  return showReview(ctx);
}

// ── Review card ──────────────────────────────────────────────────────────────
function reviewKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Name", "edit_name"), Markup.button.callback("✏️ Symbol", "edit_symbol")],
    [Markup.button.callback("🖼 Logo", "edit_logo"), Markup.button.callback("📝 Overview", "edit_overview")],
    [Markup.button.callback("🌐 Website", "edit_website"), Markup.button.callback("🐦 X", "edit_twitter")],
    [Markup.button.callback("💬 Telegram", "edit_telegram")],
    [Markup.button.callback("✅ Confirm", "approve_listing"), Markup.button.callback("🗑 Discard", "discard_listing")],
    [Markup.button.callback("🏠 Home", "home")],
  ]);
}

/**
 * "Still bonding" for a token that has not migrated yet, or "" for one that
 * has.
 *
 * Worth its own line on the review card because it changes what the buyer is
 * buying: a pre-migration token has no pool, so the chart link on its listing
 * post has nothing to plot and the market cap moves on a curve rather than on
 * trades. Saying so here is cheaper than the support message afterwards.
 *
 * Carries its OWN leading blank line so a migrated token leaves no gap — the
 * template has no line to drop, because the placeholder is not on one.
 */
function bondingLine(f) {
  const b = f.bonding;
  if (!b) return "";
  const premium = require("../premium");
  const pad = b.launchpad ? ` on ${premium.sanitizeVar(String(b.launchpad).slice(0, 30))}` : "";
  // No percentage rather than a made-up one: some pads state a progress figure
  // and some do not, and "0%" would read as a dead launch.
  const pct = Number.isFinite(b.progressPct) ? ` — **${b.progressPct.toFixed(0)}%** to graduation` : "";
  return `\n\n🚀 **Still bonding**${pad}${pct}\n_No DEX pool yet, so charts and liquidity stay empty until it migrates._`;
}

async function showReview(ctx) {
  const f = ctx.session.form;
  ctx.session.reviewShown = true;
  // Guarantee the listing has an overview — the bot writes one automatically if
  // none was fetched/typed, so nothing ever posts as "not set".
  if (!f.overview) f.overview = autoIntro(f);
  const premium = require("../premium");
  const v = (x) => (x ? premium.sanitizeVar(x) : "not set");
  const text = tpl.render("review_card", {
    chain: chainOf(f.chain).label,
    name: v(f.name),
    symbol: f.sym ? "$" + premium.sanitizeVar(f.sym) : "not set",
    address: premium.sanitizeVar(f.address),
    logo: f.logoFileId || f.logoUrl ? "added ✓" : "not set",
    bonding: bondingLine(f),
    overview: f.overview
      ? premium.sanitizeVar(Array.from(f.overview).length > 160 ? cpSlice(f.overview, 157).trimEnd() + "…" : f.overview)
      : "not set — a short intro is auto-written on the channel post",
    website: v(f.website),
    twitter: v(f.twitter),
    telegram: v(f.telegram),
  });
  const photo = f.logoFileId || (f.logoUrl && f.logoUrl.startsWith("http") ? f.logoUrl : null);
  if (photo) return sendPhotoCard(ctx, photo, text, reviewKb());
  return sendCard(ctx, text, reviewKb());
}

// ── Edit buttons ─────────────────────────────────────────────────────────────
async function editField(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const field = ctx.match[1];
  const labels = {
    name: "name",
    symbol: "symbol (ticker)",
    logo: "logo — send it as a photo, or /skip to remove",
    overview: "project overview — 1-3 sentences about your project (shown on the listing post), or /skip to remove",
    website: "website URL (https://…), or /skip",
    twitter: "X URL (https://…), or /skip",
    telegram: "Telegram URL (https://…), or /skip",
  };
  if (!labels[field]) return;
  ctx.session.awaitingField = field;
  await sendCard(ctx, tpl.render("edit_field_prompt", { field: labels[field] }), menu.withHome([]));
}

// ── Confirm → tier / payment ─────────────────────────────────────────────────
function buildListingInput(f, tier) {
  return {
    chain: f.chain,
    address: f.address,
    sym: f.sym,
    name: f.name,
    emoji: f.emoji || "🪙",
    tier,
    overview: f.overview || undefined,
    website: f.website || undefined,
    twitter: f.twitter || undefined,
    telegram: f.telegram || undefined,
    logoUrl: f.logoUrl && f.logoUrl.startsWith("http") ? f.logoUrl : undefined,
  };
}

async function goPay(ctx, tier) {
  const f = ctx.session.form;
  const chain = f.chain;
  const price = tierPrice(tier, chain);
  if (price == null) return toast(ctx, tpl.render("pricing_unavailable"));
  const kind = tier === "XPRESS" ? "xpress_listing" : "tiered_listing";
  const label =
    (tier === "XPRESS" ? "Xpress Listing" : `${tierLabel(tier)} Listing`) +
    ` — $${f.sym} on ${chainOf(chain).label}`;
  await pay.startPayment(ctx, {
    kind,
    chain: payChainOf(chain),
    native: payNativeOf(chain),
    humanAmount: price,
    // Every tier is priced per CURRENCY already, so handing the table over is
    // what lets the buyer settle in ETH instead — on Ethereum or on Robinhood
    // Chain, same amount either way. Without it there is no choice to offer and
    // startPayment arms the token's own chain exactly as it always did.
    prices: (tierMeta(tier) || {}).price,
    label,
    payload: {
      listingInput: buildListingInput(f, tier),
      logoFileId: f.logoFileId || null,
      trendHours: tierTrendingHours(tier),
    },
  });
}

async function approve(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const f = ctx.session.form;
  if (!f.chain || !f.address || !f.name || !f.sym) {
    await toast(ctx, tpl.render("listing_incomplete"));
    return showReview(ctx);
  }
  // The last gate before money changes hands. A ticker can still be bad here —
  // autofilled, or carried over from an older session — and the site would only
  // say so at fulfilment, with the payment already taken.
  if (!isValidTicker(f.sym)) {
    await toast(ctx, tpl.render("invalid_ticker"));
    ctx.session.awaitingField = "symbol";
    return sendCard(ctx, tpl.render("listing_symbol_prompt"), menu.withHome([]));
  }
  // Re-checked here, at the last gate before money moves: the contract step ran
  // minutes ago and the same token may have been listed in between. FAIL CLOSED
  // — unlike the earlier check, an unreachable listings API stops the sale
  // rather than risking a payment for a listing that would OVERWRITE an existing
  // one (see helpers/listedGuard.js), and fulfilment could not have created it
  // through that same API anyway.
  try {
    const dup = await listed.existingListing(f.address, f.chain);
    if (dup) return listed.sendAlreadyListed(ctx, dup);
  } catch (e) {
    log.warn(`[listing] duplicate re-check failed for ${f.chain}/${f.address}: ${e.message}`);
    return toast(ctx, tpl.render("trending_service_down"));
  }
  if (ctx.session.type === "xpress_listing") return goPay(ctx, "XPRESS");

  // Listing & Trending → tier chooser
  const chain = f.chain;
  const native = payNativeOf(chain);
  // Same badge the channel post will carry (plain char — a bot keyboard can't
  // render a premium emoji), so the buyer sees in the chooser what they get.
  const badge = (key) => require("../channels/format").tierBadgeChar(key) || tierEmoji(key);
  const rows = RANKED_TIERS.map((t) => [
    Markup.button.callback(`${badge(t.key)} ${t.label} · ${tierPrice(t.key, chain)} ${native}`, `lt_${t.key}`),
  ]);
  await sendCard(ctx, tpl.render("tier_chooser", { native }), menu.withHome(rows));
}

async function tierPick(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const tier = ctx.match[1];
  if (!RANKED_TIERS.find((t) => t.key === tier)) return toast(ctx, "Unknown tier.");
  ctx.session.form.tier = tier;
  return goPay(ctx, tier);
}

async function discard(ctx) {
  await answer(ctx);
  const { showHome } = require("./start");
  log.debug(`[listing] discarded by ${ctx.from && ctx.from.id}`);
  return showHome(ctx);
}

module.exports = {
  showReview,
  goPay,
  entryXpress,
  entryListingTrending,
  chainPick,
  tierPick,
  editField,
  approve,
  discard,
  handleText,
  handlePhoto,
  _lookups,
  _test: { bondingLine, emptyForm },
};
