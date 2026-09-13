// "1 token = 1 listing." Once a contract is on dexvra.io it can never be listed
// a second time — the bot answers a repeat contract with the token's own page
// and sends it to Book Trending instead, which is the upsell it was going to be
// sold anyway.
//
// This is not only a UX rule. The site's addListing() OVERWRITES a row that
// already holds the same chain+address (src/lib/store.ts) rather than rejecting
// it, so a second listing of someone else's contract silently REPLACES their
// name, logo, overview and socials. Nothing upstream stopped that; this does.
//
// Three callers:
//   • the listing form, at the contract step — instant feedback
//   • the listing form again at approve(), the last gate before money moves
//   • a bare contract pasted with no flow running, which used to get no answer
//     at all (the text router returns early when the session has no type)
const api = require("../api/dexvra");
const { CHAIN_IDS, isValidAddress } = require("../config/chains");
const { SITE_URL } = require("../config/constants");
const tpl = require("../templates");
const log = require("./logger");

// A rejected row is not a listing — it was refused, so a fresh attempt has to be
// allowed through. approved and pending both occupy the slot.
const BLOCKING = new Set(["approved", "pending"]);
const sameAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/** The listing that already owns this contract, or null.
 *  `chain` is optional: a bare contract arrives with no chain context (the user
 *  just pastes it), so every chain is searched — which is also how the token's
 *  real chain gets discovered for the reply. Throws if the listings API is down;
 *  each caller decides what that means for it. */
async function existingListing(address, chain) {
  const addr = String(address || "").trim();
  if (!addr) return null;
  const rows = await api.getListings();
  return (
    rows.find(
      (r) => (!chain || r.chain === chain) && sameAddr(r.address, addr) && BLOCKING.has(r.status || "approved"),
    ) || null
  );
}

// Shortest real contract address across every supported chain: Solana base58
// bottoms out at 32, EVM is 42, Tron 34, TON 42+, Sui/Aptos 66 in full form.
// The Sui/Aptos pattern accepts 0x + 1..64 hex because those chains genuinely
// trim leading zeros — correct in the form, where the user has already picked
// the chain, but far too loose HERE: it would make "0x123" look like a contract
// and send every such message to the listings API.
const MIN_ADDR_LEN = 32;

/** Does this look like a contract address on ANY supported chain? Used to decide
 *  whether an unsolicited message is worth a listings lookup — without it every
 *  line of chatter in a DM would hit the API. */
function looksLikeAddress(text) {
  const s = String(text || "").trim();
  if (s.length < MIN_ADDR_LEN || /\s/.test(s)) return false;
  return CHAIN_IDS.some((c) => isValidAddress(c, s));
}

/** A contract address out of a raw message: the address itself, or a dexvra.io /
 *  explorer link containing one. Returns { address, chain } — chain only when
 *  the link said so. */
function extractAddress(text) {
  const s = String(text || "").trim();
  const link = s.match(/\/token\/([a-z0-9]+)\/([^/\s?#]+)/i);
  if (link && isValidAddress(link[1].toLowerCase(), link[2])) {
    return { address: link[2], chain: link[1].toLowerCase() };
  }
  if (looksLikeAddress(s)) return { address: s, chain: null };
  return null;
}

const tokenUrl = (row) => `${SITE_URL}/token/${row.chain}/${row.address}`;

/** Template vars for `already_listed`. Kept here so the form path and the bare
 *  contract path can never drift into describing the same row differently. */
function listedVars(row) {
  const { chainOf } = require("../config/chains");
  const ch = chainOf(row.chain);
  return {
    name: row.name || row.sym || "Your token",
    symbol: String(row.sym || "").replace(/^\$+/, ""),
    chain: (ch && ch.label) || row.chain || "",
    address: row.address,
    url: tokenUrl(row),
    site: SITE_URL,
  };
}

/** The reply. Book Trending first — it is the reason this message exists. */
function listedKeyboard(row) {
  const menu = require("../handlers/menu");
  const { Markup } = menu;
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 Book Trending", "trend_coin")],
    [Markup.button.url("🌐 View your token", tokenUrl(row))],
    // A URL button, NOT a callback. This used to open a how-to card whose one
    // piece of real content was another button saying "➕ Add to your group":
    // a screen between the operator and the thing they had already tapped. The
    // same trip the main menu already skipped — the two had simply drifted.
    [Markup.button.url("🤖 Add Buy Bot & Raid to your group", require("../config/constants").addToGroupUrl())],
    [Markup.button.callback("🏠 Home", "home")],
  ]);
}

/** Send the "already listed" card. Clears any half-built listing form so the
 *  next thing the user types isn't swallowed by a flow that cannot finish. */
async function sendAlreadyListed(ctx, row) {
  const { sendCard } = require("./message");
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev };
  return sendCard(ctx, tpl.render("already_listed", listedVars(row)), listedKeyboard(row));
}

/** Convenience for the form: returns true when it answered and the caller must
 *  stop. A lookup failure here is NOT fatal — the listings API being briefly
 *  unreachable should not cost a sale, and approve() re-checks before any money
 *  moves. */
async function blockIfListed(ctx, address, chain) {
  let row = null;
  try {
    row = await existingListing(address, chain);
  } catch (e) {
    log.warn(`[listed] lookup failed for ${chain || "?"}/${address}: ${e.message}`);
    return false;
  }
  if (!row) return false;
  await sendAlreadyListed(ctx, row);
  return true;
}

module.exports = {
  existingListing,
  looksLikeAddress,
  extractAddress,
  sendAlreadyListed,
  blockIfListed,
  listedVars,
  tokenUrl,
};
// Exposed for tests: the keyboard is where the "add the bot" button lives, and
// a button that costs an extra tap is invisible from anywhere else.
module.exports._test = { listedKeyboard };
