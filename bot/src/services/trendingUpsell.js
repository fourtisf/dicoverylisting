// Trending slot-expiry upsell. When a token's featured Trending slot is within
// UPSELL_WARN_HOURS of ending, DM the buyer a one-tap "extend at a discount"
// offer — the cheapest conversion there is (someone who already paid). The buyer
// is resolved from the order that booked the slot; the offer is persisted so the
// extend buttons survive a restart, and each specific slot is DM'd at most once.
//
// Best-effort throughout: a missing buyer id, a blocked-bot DM, or an API blip
// never throws — the sweeper and the board keep working regardless.
const crypto = require("node:crypto");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const { UPSELL_CHECK_MS, UPSELL_WARN_HOURS, RENEW_DISCOUNT_PCT } = require("../config/constants");
const { payNativeOf } = require("../config/chains");
const { trendingForChain, durationToHours, fmtAmount } = require("../config/packages");
const api = require("../api/dexvra");
const orders = require("../payments/orders");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const premium = require("../premium");
const log = require("../helpers/logger");

const FILE = "upsell.json";
const state = loadJSONSync(FILE, { sent: {}, offers: {} });

// Durations we offer to renew with (the popular, higher-value runs).
const RENEW_DURATIONS = ["24H", "48H"];

const refOf = (chain, address) =>
  crypto.createHash("sha1").update(`${chain}:${String(address).toLowerCase()}`).digest("hex").slice(0, 12);

/** Discounted renewal price for a duration on a token's pay chain, or null. */
function renewOffer(chain, duration) {
  const row = trendingForChain(chain).find((r) => r.duration === duration);
  if (!row) return null;
  const price = Number(row.price) * (1 - RENEW_DISCOUNT_PCT / 100);
  return { duration, hours: durationToHours(duration), price: Number(price.toFixed(6)), base: row.price };
}

/** Most recent order that paid for this token (trending preferred), for the DM target. */
function buyerFor(chain, address) {
  const addr = String(address).toLowerCase();
  const matches = orders.allOrders().filter((o) => {
    if (!o.buyerId) return false;
    if (o.status !== "fulfilled" && o.status !== "paid") return false;
    const p = o.payload || {};
    const oc = p.chain || (p.listingInput && p.listingInput.chain);
    const oa = p.address || (p.listingInput && p.listingInput.address);
    return oc === chain && String(oa || "").toLowerCase() === addr;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return matches[0];
}

async function persist() {
  await saveJSON(FILE, state).catch((e) => log.debug(`[upsell] persist: ${e.message}`));
}

/** Build the offer record + inline keyboard for a token whose slot is ending. */
function buildOffer(listing) {
  const chain = listing.chain;
  const ref = refOf(chain, listing.address);
  const native = payNativeOf(chain);
  const offers = RENEW_DURATIONS.map((d) => renewOffer(chain, d)).filter(Boolean);
  if (!offers.length) return null;
  state.offers[ref] = {
    chain,
    address: listing.address,
    sym: listing.sym,
    name: listing.name,
    website: listing.website,
    twitter: listing.twitter,
    telegram: listing.telegram,
    logoUrl: listing.logoUrl,
    ts: nowMs(),
  };
  const buttons = offers.map((o) => [
    { text: `🔁 Extend ${o.duration} — ${fmtAmount(o.price)} ${native} (-${RENEW_DISCOUNT_PCT}%)`, callback_data: `xtd_${ref}_${o.duration}` },
  ]);
  buttons.push([{ text: "Not now", callback_data: "home" }]);
  return { ref, native, offers, keyboard: { inline_keyboard: buttons } };
}

// Date.now() is fine at runtime (this module never runs inside a Workflow script).
function nowMs() {
  return Date.now();
}

async function scanOnce(tg) {
  const warnMs = UPSELL_WARN_HOURS * 3_600_000;
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    log.debug(`[upsell] getListings: ${e.message}`);
    return;
  }
  const now = nowMs();
  for (const l of listings || []) {
    const exp = Number(l.trendExp) || 0;
    if (!exp || exp <= now) continue; // no active slot / already ended
    if (exp - now > warnMs) continue; // not close enough yet
    const dedupKey = `${l.chain}:${String(l.address).toLowerCase()}:${exp}`;
    if (state.sent[dedupKey]) continue; // already offered for THIS slot

    const buyer = buyerFor(l.chain, l.address);
    // Mark as handled regardless — if we can't reach a buyer, retrying every
    // 5 min until the slot ends would just spam the scan; one attempt per slot.
    state.sent[dedupKey] = now;
    if (!buyer || !buyer.buyerId) {
      log.debug(`[upsell] ${l.sym || l.address}: slot ending, no buyer on record — skipped`);
      continue;
    }
    const offer = buildOffer(l);
    if (!offer) continue;

    const hoursLeft = Math.max(1, Math.round((exp - now) / 3_600_000));
    const payload = tpl.render("upsell_expiry", {
      symbol: premium.sanitizeVar(sym(l.sym)),
      hours: hoursLeft,
      discount: RENEW_DISCOUNT_PCT,
    });
    const { text, extra } = payloadArgs(payload, false);
    try {
      await tg.sendMessage(buyer.buyerId, text, { ...extra, reply_markup: offer.keyboard });
      log.info(`[upsell] offered renewal to ${buyer.buyerId} for ${l.sym || l.address} (${hoursLeft}h left)`);
    } catch (e) {
      log.debug(`[upsell] DM ${buyer.buyerId} failed: ${e.message}`); // buyer blocked the bot, etc.
    }
  }
  // prune old dedup marks + offers (14 days) so the file stays small
  const cutoff = now - 14 * 86_400_000;
  for (const k of Object.keys(state.sent)) if (state.sent[k] < cutoff) delete state.sent[k];
  for (const k of Object.keys(state.offers)) if ((state.offers[k].ts || 0) < cutoff) delete state.offers[k];
  await persist();
}

const sym = (s) => {
  const t = String(s || "").replace(/^\$+/, "");
  return t ? `$${t}` : "$TOKEN";
};

/** Look up a stored renewal offer by its ref (for the extend callback). */
function getOffer(ref) {
  return state.offers[ref] || null;
}

function start(tg) {
  const run = () => scanOnce(tg).catch((e) => log.debug(`[upsell] ${e.message}`));
  const iv = setInterval(run, UPSELL_CHECK_MS);
  const kick = setTimeout(run, 20_000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, getOffer, renewOffer, refOf, buyerFor, RENEW_DURATIONS };
