// THE BROADCAST ADD-ON — the one owner of "may this order add a Mass DM, what
// does it cost, and what does the whole order then cost".
//
// "di bawahnya ada fitur add broadcast aturan dengan fee tambahan" — a project
// buying a listing can attach a Mass DM to the same order instead of buying it
// separately. It is ONE TAP on the pay card and there is nothing to write: the
// message is the LISTING CARD itself ("kalo listing ya template listing itu"),
// rendered by fulfilment from the same template the channel post uses and
// delivered by the main bot's existing Mass DM sender. Nothing here sends
// anything, and nothing here decides what it says.
//
// ⚠️ THE FEE IS MASS_DM_PRICE ITSELF, NOT A SECOND TABLE. "ikuti price mass dm"
// — so the add-on charges exactly what the standalone product charges, read
// from the same constant, which is already env-overridable
// (MASS_DM_PRICE_SOL / _BNB / _ETH). A private copy here would be a second
// price for one product, and the day the operator changed one of them the
// buyer would be quoted one number and charged the other.
//
// ⚠️ AND IT IS PAID IN THE ORDER'S OWN CURRENCY. "kalo client book chain bsc
// pembayaran harus bsc" — the add-on is part of one order with one amount, so
// it is priced in the coin that order already settles in and never in a second
// one. That is also why availability is decided HERE rather than assumed:
// MASS_DM_PRICE prices SOL, BNB and ETH only, so a token that pays in TRX or
// TON has no fee to charge and is never offered the button. Offering it and
// then failing at the pay step is the "row the engine ignores" this repo keeps
// paying for.
const { MASS_DM_PRICE, MASS_DM_ENABLED } = require("./constants");
const { payNativeOf } = require("./chains");

/**
 * What the add-on costs for a token on `tokenChain`, in that order's own
 * currency — or null when it cannot be offered at all.
 *
 * null means exactly one thing: no button. Callers must not fall back to
 * another currency, which is the rule the whole payment path now enforces.
 */
function addonPriceForNative(native) {
  if (!MASS_DM_ENABLED) return null;
  const p = Number(MASS_DM_PRICE[native]);
  return p > 0 ? p : null;
}

/**
 * The same question asked of an ARMED order, which knows its currency and has
 * no idea what chain the token lives on.
 *
 * That is the whole reason the add-on sits on the pay card rather than the
 * review card: by then the buyer may have picked a RAIL (a Robinhood order can
 * settle on Robinhood Chain or on Ethereum), and the fee has to be charged in
 * what this order actually settles in — which is `order.native`, not anything
 * derivable from the token.
 */
function addonPrice(tokenChain) {
  return addonPriceForNative(payNativeOf(tokenChain));
}

// ⚠️ THREE HELPERS WERE DELETED HERE, not left "in case". `canAddBroadcast`,
// `pricesWithAddon` and `totalWithAddon` folded the fee into the price table
// the NETWORK PICKER is built from — right while the button lived on the review
// card, and wrong now that the add-on is attached after a rail is chosen. A
// function that binds nothing is the row the engine ignores; one that binds the
// wrong thing is worse, and `pricesWithAddon` would have quoted every buyer the
// add-on price whether or not they wanted it.

module.exports = { addonPrice, addonPriceForNative };
