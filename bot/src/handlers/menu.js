// Inline keyboards + welcome copy. Callback-data grammar (dexvra's own, kept
// short so it never exceeds Telegram's 64-byte limit):
//   submit_coin | listing_trend_coin | trend_coin | ad_banner | home
//   lc_<chain>            listing chain pick
//   lt_<TIER>             listing tier pick (Listing & Trending)
//   edit_<field> | approve_listing | discard_listing
//   td_<i>               trending duration index
//   bt_<key> | bd_<i>    banner type / duration index
//   bpay_<chain>         banner pay currency
//   yn_<field>_<yes|no>  banner optional-link yes/no
//   confirm_pay
const { Markup } = require("telegraf");
const { CHAIN_ORDER, chainOf } = require("../config/chains");

const homeBtn = () => Markup.button.callback("🏠 Home", "home");

/** Wrap rows (array of button-arrays) and append a Home row. */
function withHome(rows) {
  return Markup.inlineKeyboard([...rows, [homeBtn()]]);
}

function mainMenu() {
  // The group row is a URL button, not a callback: it opens Telegram's own
  // "choose a group" picker on the first tap.
  //
  // It used to open a how-to card whose only real content was another button
  // saying "➕ Add to your group" — a screen between the operator and the thing
  // they had already chosen. Nothing is lost by skipping it: ?startgroup= makes
  // Telegram deliver /start into the group the moment the bot lands there, and
  // that renders the `group_start` template — the same setup steps, in the place
  // they are actually carried out. The card itself is still reachable from the
  // "already listed" prompt (helpers/listedGuard.js).
  //
  // Required lazily: config/constants reads process.env at load time, and this
  // module is pulled in through handlers/registry.js.
  const { addToGroupUrl } = require("../config/constants");
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡ Xpress Listing", "submit_coin")],
    [Markup.button.callback("🏆 Listing & Trending", "listing_trend_coin")],
    [Markup.button.callback("🔥 Trending Token", "trend_coin")],
    [Markup.button.callback("📢 Banner Ads", "ad_banner")],
    [Markup.button.callback("📣 Mass DM Broadcast", "ad_massdm")],
    [Markup.button.url("➕ Add Buy Bot & Raid to your group", addToGroupUrl())],
  ]);
}

/** Chain picker → `<prefix>_<chain>` (e.g. lc_solana). `extraRows` (array of
 *  button-rows) are appended after the chain grid, before Home — used to offer a
 *  one-tap switch to the other package. */
function chainMenu(prefix, extraRows = []) {
  const rows = [];
  for (let i = 0; i < CHAIN_ORDER.length; i += 2) {
    const row = CHAIN_ORDER.slice(i, i + 2).map((id) =>
      Markup.button.callback(chainOf(id).label, `${prefix}_${id}`),
    );
    rows.push(row);
  }
  return withHome([...rows, ...extraRows]);
}

/** One button per item → `<prefix>_<index>`; label via labelFn(item, i). */
function idxButtons(prefix, items, labelFn) {
  const rows = items.map((it, i) => [Markup.button.callback(labelFn(it, i), `${prefix}_${i}`)]);
  return withHome(rows);
}

/** One-tap clipboard copy (Bot API 8.0 `copy_text`). Telegraf 4.16 has no
 *  builder for it, so the raw button object is used — Telegraf passes
 *  reply_markup through to Telegram untouched. Telegram copies the text
 *  client-side: no callback fires, nothing to handle. */
function copyBtn(label, text) {
  return { text: label, copy_text: { text: String(text) } };
}

/** The pay card's keyboard. The address is long enough that a mistyped
 *  character means lost funds, so copying it must not depend on the buyer
 *  finding the tap-to-copy monospace run. */
function confirmPayment(address, extraRows = []) {
  const rows = [];
  if (address) rows.push([copyBtn("📋 Copy Address", address)]);
  rows.push([Markup.button.callback("✅ I've Paid — Confirm", "confirm_pay")]);
  // Upsells (the broadcast add-on) sit BETWEEN Confirm and Home: below the
  // action the buyer came here for, above the way out.
  rows.push(...extraRows);
  rows.push([homeBtn()]);
  return Markup.inlineKeyboard(rows);
}

/** Standalone copy affordance for messages that re-show the address (the
 *  "payment not detected" nudge) without the full pay-card keyboard. */
function copyAddress(address) {
  return address ? Markup.inlineKeyboard([[copyBtn("📋 Copy Address", address)]]) : {};
}

function yesNo(field) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Yes", `yn_${field}_yes`),
      Markup.button.callback("⏭ Skip", `yn_${field}_no`),
    ],
    [homeBtn()],
  ]);
}

function postPurchase(siteUrl) {
  const rows = [];
  if (siteUrl) rows.push([Markup.button.url("🌐 View on Dexvra", siteUrl)]);
  rows.push([homeBtn()]);
  return Markup.inlineKeyboard(rows);
}

const WELCOME =
  "<b>🚀 Dexvra Bot</b> — Find the next Moonshot\n\n" +
  "List your token and get seen across the Dexvra network — website, Telegram channels, and X.\n\n" +
  "<b>Packages:</b>\n" +
  "⚡ <b>Xpress Listing</b> — instant listing, live on the board\n" +
  "🏆 <b>Listing &amp; Trending</b> — tiered (Diamond → Bronze) with announcement post\n" +
  "🔥 <b>Trending</b> — featured trending slot (3H–48H)\n" +
  "📢 <b>Banner Ads</b> — homepage banner takeover\n\n" +
  "Pick an option below 👇";

module.exports = {
  Markup,
  homeBtn,
  withHome,
  mainMenu,
  chainMenu,
  idxButtons,
  confirmPayment,
  copyAddress,
  copyBtn,
  yesNo,
  postPurchase,
  WELCOME,
};
