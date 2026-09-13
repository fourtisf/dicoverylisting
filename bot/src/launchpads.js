// Launchpad data for a token that has NOT migrated yet.
//
// A thin shim over ../../shared/launchpads. The registry, the hosts, the
// failover and the parsing live there because the trade bot needs exactly the
// same answers, and this repo has already paid once for two processes carrying
// separate ideas of which pump.fun host was current — marketdata.js was on v3
// while tradebot/solana.js was still on the retired host, and Solana snipe
// discovery was blind for days while /health printed green.
//
// What lives HERE is only the reshaping into what this bot's callers already
// read: `fetchTokenInfo` returns the exact shape dexscreener.fetchTokenInfo
// does, so listing autofill and the auto-lister work on a bonding-curve token
// without knowing where the data came from.
const lp = require("../../shared/launchpads");
const log = require("./helpers/logger");
const { httpsLogo } = require("./helpers/httpsLogo");

/** Does any enabled pad cover this chain? Callers skip the leg otherwise. */
const covers = (chain) => lp.padsFor(chain).length > 0;

/**
 * Token info in the shape dexscreener.fetchTokenInfo returns.
 *
 * FIELD NAMES AND THE ZERO-VS-NULL CONVENTION ARE NOT NEGOTIABLE HERE.
 * autoLister.rejectReason reads `liq`, `vol24` and `pairCreatedAt` by those
 * names and treats 0 as "no data" — a null would read as a PASSING score on a
 * gate the operator set, and auto-list a token with no liquidity at all. The
 * same note sits on poolstrade.fetchTokenInfo for the same reason.
 *
 * Returns null when no pad knows the token, which is the normal outcome for
 * anything that migrated long ago — the caller falls through to DexScreener.
 */
async function fetchTokenInfo(chain, address) {
  if (!covers(chain)) return null;
  let r;
  try {
    r = await lp.tokenRecord(chain, address);
  } catch (e) {
    log.debug(`[launchpads] ${chain}/${address}: ${e.message}`);
    return null;
  }
  // Worth one debug line: "no pad answered" and "no pad knows it" look
  // identical from here and need different answers from an operator.
  if (!r.ok && r.why) log.debug(`[launchpads] ${chain}/${address}: ${r.why}`);
  const rec = r.record;
  if (!rec) return null;
  return {
    name: rec.name,
    symbol: rec.symbol,
    priceUsd: rec.priceUsd,
    mcap: rec.mcapUsd,
    // ⚠️ REWRITTEN HERE, ONCE, FOR EVERY BOT CONSUMER. The registry publishes
    // what a pad actually said, and a launchpad pins its artwork on IPFS — the
    // one scheme `adminValidate`'s LOGO_RE refuses and no `<img>` can load. A
    // caller that got the raw URI would either fail the whole listing over its
    // picture or draw the fallback mark; both have happened, one layer up.
    logoUrl: httpsLogo(rec.logoUrl),
    website: rec.website,
    twitter: rec.twitter,
    telegram: rec.telegram,
    liq: Number(rec.liqUsd) || 0,
    vol24: Number(rec.vol24Usd) || 0,
    change24h: 0,
    pairCreatedAt: Number(rec.createdAt) || 0,
    pairCount: 1,
    // Launchpad-only extras. Callers that do not know them ignore them; the
    // listing review card uses them to say a token is still bonding, which is
    // the whole reason an operator asked for this.
    description: rec.description,
    graduated: rec.graduated,
    onCurve: rec.onCurve,
    progressPct: rec.progressPct,
    progressSource: rec.progressSource,
    holders: rec.holders,
    launchpad: rec.launchpad,
    launchUrl: rec.launchUrl,
    source: rec.source,
  };
}

/**
 * The project's own description, set at mint.
 *
 * marketdata.fetchTokenDescription used to hardcode a pump.fun URL for Solana,
 * so a token launched on bonk.fun, Believe, Boop or Moonshot got no overview at
 * all and the listing fell back to the auto-written intro. Routed through the
 * registry it works for every pad, and there is one place that knows pump.fun's
 * host instead of two.
 */
async function fetchDescription(chain, address) {
  const info = await fetchTokenInfo(chain, address).catch(() => null);
  return (info && info.description) || null;
}

module.exports = { covers, fetchTokenInfo, fetchDescription, chains: lp.chains, padsFor: lp.padsFor, all: lp.all, reload: lp.reload, tokenRecord: lp.tokenRecord };
