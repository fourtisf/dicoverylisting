// Admin-configurable WHALE WALLET bar, persisted so the operator can tune it
// from @dexvraadminbot without editing .env or restarting the bot.
//
// Read FRESH on every check, deliberately — like pumpConfig, and for the same
// reason: the admin bot is a SEPARATE PROCESS (bot/adminbot.js), so an in-memory
// cache here would never see the operator's change. One sync read per qualifying
// buy is nothing next to the RPC call it is about to authorise.
//
// Three layers, most specific first:
//   1. the group's own `/setwhale 50000`  (per-project, groups.json)
//   2. this file                          (global, set in @dexvraadminbot)
//   3. .env / the built-in $50,000        (the shipped default)
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "whaleConfig.json";
// Used only if config/constants cannot be read (it never should be — this is
// belt-and-braces so a whale check can't throw its way into swallowing a buy).
const FALLBACK_WALLET_USD = 50000;
const FALLBACK_MIN_BUY_USD = 100;
// Sanity rails. The floor is what stops a fat-finger ($5) turning every buy into
// a pinned "whale" and burning an RPC call on dust; the ceiling stops a stray
// extra zero silencing whale alerts forever with no visible error.
const HARD_MIN_WALLET_USD = 100;
const HARD_MAX_WALLET_USD = 100_000_000;
const HARD_MAX_MIN_BUY_USD = 1_000_000;

/** The shipped defaults — .env when set, the built-ins otherwise. Required
 *  lazily: config/constants reads process.env at load time, and main.js loads
 *  .env before it. */
function defaults() {
  try {
    const c = require("../config/constants");
    return {
      walletUsd: Number(c.BUYBOT_WHALE_WALLET_USD) > 0 ? Number(c.BUYBOT_WHALE_WALLET_USD) : FALLBACK_WALLET_USD,
      minBuyUsd: Number.isFinite(Number(c.BUYBOT_WHALE_CHECK_MIN_USD)) ? Number(c.BUYBOT_WHALE_CHECK_MIN_USD) : FALLBACK_MIN_BUY_USD,
      enabled: c.BUYBOT_WHALE_WALLET_ENABLED !== false,
    };
  } catch {
    return { walletUsd: FALLBACK_WALLET_USD, minBuyUsd: FALLBACK_MIN_BUY_USD, enabled: true };
  }
}

function clampNum(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The live global settings:
 *   walletUsd  — hold at least this much OF THIS TOKEN and your buy is a whale
 *   minBuyUsd  — buys under this are never even looked up (dust ≠ an RPC call)
 *   enabled    — the whole whale-wallet class, on or off
 */
function get() {
  const d = defaults();
  const c = loadJSONSync(FILE, {}) || {};
  return {
    walletUsd: Number.isFinite(c.walletUsd) ? c.walletUsd : d.walletUsd,
    minBuyUsd: Number.isFinite(c.minBuyUsd) ? c.minBuyUsd : d.minBuyUsd,
    enabled: typeof c.enabled === "boolean" ? c.enabled : d.enabled,
  };
}

/** Patch any subset of the three. Returns the persisted settings.
 *
 *  walletUsd and minBuyUsd measure DIFFERENT things — what a wallet holds
 *  versus what it just spent — so they are deliberately not held in any order
 *  against each other: a whale topping up with $150 is exactly the event this
 *  feature exists to catch. */
async function set({ walletUsd, minBuyUsd, enabled } = {}) {
  const cur = get();
  const next = {
    walletUsd: walletUsd != null ? clampNum(walletUsd, HARD_MIN_WALLET_USD, HARD_MAX_WALLET_USD, cur.walletUsd) : cur.walletUsd,
    minBuyUsd: minBuyUsd != null ? clampNum(minBuyUsd, 0, HARD_MAX_MIN_BUY_USD, cur.minBuyUsd) : cur.minBuyUsd,
    enabled: enabled != null ? !!enabled : cur.enabled,
  };
  await saveJSON(FILE, next);
  return next;
}

/** Drop every admin override — back to .env / the shipped $50,000. */
async function reset() {
  await saveJSON(FILE, {});
  return get();
}

module.exports = {
  get,
  set,
  reset,
  defaults,
  HARD_MIN_WALLET_USD,
  HARD_MAX_WALLET_USD,
  HARD_MAX_MIN_BUY_USD,
};
