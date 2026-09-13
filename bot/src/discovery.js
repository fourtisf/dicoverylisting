// Discovery + pricing for the auto-lister, across every source that indexes a
// chain Dexvra supports.
//
// The auto-lister used to call dexscreener.js directly. That was fine while
// DexScreener was the only source, but it does not index Robinhood Chain — so
// pools.trade launches, on a chain this repo otherwise supports end to end,
// were structurally invisible to auto-listing. This module is the seam: it
// merges every source into the two functions the service already calls, so
// adding a third source later touches this file and nothing else.
//
// Both functions preserve the fail-open contract the service depends on: a
// source that is down contributes nothing and the scan carries on with the
// rest. Only a total failure of ALL sources surfaces as an empty list, which
// the auto-lister already reports as a blocker.
const ds = require("./dexscreener");
const poolstrade = require("./poolstrade");
const launchpads = require("./launchpads");
const ponsChain = require("./ponsChain");
const log = require("./helpers/logger");

/**
 * Candidates from every source, interleaved and de-duplicated.
 *
 * INTERLEAVED for the same reason dexscreener.fetchDiscovery interleaves its
 * own three feeds: the caller prices only the first N candidates per scan
 * (maxLookupsPerRun, 40 by default). Concatenating would put every pools.trade
 * launch behind ~40 DexScreener entries and it would never be priced at all —
 * the exact bug the round-robin in dexscreener.js was written to fix, one level
 * up. Round-robin gives each SOURCE an even share of the budget; order within
 * a source is preserved.
 *
 * THE PRE-MIGRATION LAUNCHPADS ARE DELIBERATELY NOT A SOURCE HERE, even though
 * they are one for fetchTokenInfo below. Auto-listing gates on minimum
 * liquidity, minimum 24h volume and a minimum age (autoLister.rejectReason),
 * and a token on a bonding curve fails all three by definition — it has no
 * pool, so there is no liquidity to measure, and it is minutes old. Adding the
 * feed would hand a third of every scan's lookup budget (round-robin, 40 per
 * run) to candidates that are rejected on arrival, and take that budget away
 * from the boosted feeds where the $1M projects actually are. That is the exact
 * starvation the round-robin was written to fix, re-introduced one level up.
 *
 * Pre-migration data belongs in the MANUAL listing flow, where a project is
 * paying to be listed and the form needs prefilling — which is fetchTokenInfo.
 *
 * @returns {Promise<Array<{chain: string, address: string}>>}
 */
async function fetchDiscoveryX() {
  const sources = [
    { name: "dexscreener", fn: () => ds.fetchDiscoveryX() },
    // ⚠️ This entry used to WRAP a plain `fetchDiscovery()` and assert
    // `ok: true` on the reasoning that "a throw is the only failure it
    // reports". That was simply untrue — `fetchLaunches` catches its own page
    // failures and returns `[]` at debug level — so an unreachable launchpad
    // and a quiet one were the same answer, and the operator's own
    // `listing:check` printed `⚠ pools.trade → 0 candidate(s)` with nothing
    // able to say which. A comment asserting a contract the module does not
    // keep is worse than no comment: it is the reassuring reading, written down.
    { name: "poolstrade", fn: () => poolstrade.fetchDiscoveryX() },
  ];
  const answers = await Promise.all(
    sources.map(async (s) => {
      try {
        const r = await s.fn();
        return { name: s.name, items: Array.isArray(r.items) ? r.items : [], ok: r.ok !== false, why: r.why || null };
      } catch (e) {
        // One source failing must not take the scan down — that is the whole
        // reason this is a Promise.all over guarded thunks and not a bare one.
        const why = `${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`;
        log.debug(`[discovery] ${s.name}: ${why}`);
        return { name: s.name, items: [], ok: false, why };
      }
    }),
  );
  const lists = answers.map((a) => a.items);

  const seen = new Set();
  const out = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c || !c.chain || !c.address) continue;
      const key = `${c.chain}:${String(c.address).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chain: c.chain, address: c.address });
    }
  }
  // ⚠️ "EVERY SOURCE EMPTY" AND "NO SOURCE ANSWERED" ARE DIFFERENT FACTS, and
  // the auto-lister's blocker used to assert the first about the second — which
  // sends an operator to look for a quiet market while a host is refusing the
  // box. `ok` is "at least one source answered".
  const ok = answers.some((a) => a.ok);
  return {
    items: out,
    ok,
    why: ok ? null : answers.map((a) => `${a.name}: ${a.why || "no answer"}`).join(" · "),
    sources: answers.map((a) => ({ name: a.name, n: a.items.length, ok: a.ok, why: a.why })),
  };
}

/** The long-standing array shape, for callers that do not need the reason. */
async function fetchDiscovery() {
  return (await fetchDiscoveryX()).items;
}

/**
 * Merge a launchpad record UNDER an indexer record.
 *
 * `base` wins on every field it actually has, because a pool-backed indexer
 * reading a live market beats a launchpad's copy of the same numbers. The
 * launchpad fills the holes, and on a pre-migration token the holes are most of
 * the form: DexScreener has no `info` block to hang socials on until a pool
 * exists, so the project's X, Telegram, website, logo and description — set at
 * mint, and the only ones that exist yet — were unreachable.
 *
 * ZERO IS A VALUE HERE, NOT A HOLE. autoLister.rejectReason reads `liq`,
 * `vol24` and `pairCreatedAt` and treats 0 as "no data"; if a launchpad's
 * numbers could overwrite a real 0 from DexScreener the auto-lister would be
 * scoring a gate against a different source than the one it thinks it is
 * reading. Only null/undefined/'' are treated as missing.
 */
function mergeInfo(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const have = out[k];
    if (have === null || have === undefined || have === "") out[k] = v;
  }
  // Provenance, so a caller (and a log line) can tell a merged record from a
  // plain DexScreener one without guessing from which fields are populated.
  out.source = base.source ? `${base.source}+${extra.source || "launchpad"}` : extra.source;
  return out;
}

/**
 * Market data for one token, from whichever source knows it.
 *
 * pools.trade is asked FIRST for its own chain and only its own chain: it is
 * the launchpad the token was created on, so it holds the socials, the logo and
 * the curve state that no general indexer has. It returns null for every other
 * chain, and null for a Robinhood token that was not launched through it —
 * either way the DexScreener/GeckoTerminal path below still runs.
 *
 * The pre-migration pads run CONCURRENTLY with DexScreener and are merged
 * under it, rather than being a fallback. A fallback would have been wrong in
 * both directions: pump.fun-style launches usually DO have a DexScreener pair
 * (so the pads would never be asked, and the socials stay missing), while the
 * numbers on that pair are the ones worth keeping (so the pads must not
 * overwrite them). Filling holes is the only combination that gets both.
 */
async function fetchTokenInfoX(chain, address) {
  const dsP = ds.fetchTokenInfoX(chain, address);
  // The launchpads that know this token, most specific first. `mergeInfo` only
  // ever fills holes, so this order is precedence among them — and the indexer
  // below outranks all of them on the fields it answers for.
  const extras = [];
  if (chain === poolstrade.OUR_CHAIN) {
    // ⚠️ A MERGE, NOT AN OVERRIDE, and that changed the day DexScreener started
    // indexing Robinhood Chain (July 2026 — see config/chains.js
    // DEXSCREENER_SLUG). This used to `return` the pools.trade record and never
    // ask the indexer at all, which was right while pools.trade was the only
    // source for the chain and became wrong the moment it was not: the
    // auto-lister's gates read `liq` / `vol24` / `pairCreatedAt`, a bonding-curve
    // envelope coerces the ones it does not publish to 0, and the result was
    // `thin liquidity ($0)` for EVERY Robinhood token on every scan — including
    // graduated ones with a real pair and real depth. One chain structurally
    // unlistable, with the panel asserting a measured $0 for a market nobody had
    // looked at. Now the indexer's live numbers win and the pad fills the holes
    // it is actually good for: the socials, the logo and the curve state.
    extras.push(poolstrade.fetchTokenInfo(chain, address).catch(() => null));
  }
  if (launchpads.covers(chain)) {
    extras.push(
      launchpads.fetchTokenInfo(chain, address).catch((e) => {
        log.debug(`[discovery] launchpads ${chain}/${address}: ${e.message}`);
        return null;
      }),
    );
  }
  // LAST, and that is the whole safety of it: mergeInfo only ever fills holes,
  // so the chain answers exactly what no indexer and no pad did — which for a
  // token still on its curve is everything, and for anything else is nothing.
  // It is also the only source here that cannot go stale or move: the others
  // are third-party HTTP, and the Pons pad's host and path are still a guess.
  if (ponsChain.covers(chain)) {
    extras.push(
      ponsChain.fetchTokenInfo(chain, address).catch((e) => {
        log.debug(`[discovery] pons-chain ${chain}/${address}: ${e.message}`);
        return null;
      }),
    );
  }
  if (!extras.length) return dsP;
  const [dsAns, ...rest] = await Promise.all([dsP, ...extras]);
  let info = dsAns.info;
  for (const e of rest) info = mergeInfo(info, e);
  // ⚠️ A LAUNCHPAD RECORD DOES NOT MAKE A REFUSAL INTO AN ANSWER on the fields
  // the gates read. The pads carry socials and a logo; `liq`, `vol24` and
  // `pairCreatedAt` come from the indexer, and scoring those gates against a
  // record whose indexer half we could not read is judging a token by numbers
  // nobody measured. `ok` therefore still follows DexScreener — the caller can
  // use the merged record for display and must not treat it as priced.
  return { info, ok: dsAns.ok, why: dsAns.why };
}

/** The long-standing shape, for callers that only ever wanted the record. */
async function fetchTokenInfo(chain, address) {
  return (await fetchTokenInfoX(chain, address)).info;
}

module.exports = { fetchDiscovery, fetchDiscoveryX, fetchTokenInfo, fetchTokenInfoX, mergeInfo };
