'use strict';
/*
 * upstreams.js — is every third party this bot depends on actually answering?
 *
 * WHY THIS EXISTS
 *
 * Over two days this bot broke three times in the same shape, and every time the
 * first person to find out was a user losing money:
 *
 *   • Jupiter retired quote-api.jup.ag/v6. Every Solana buy died with the words
 *     "fetch failed", five wallets at a time, under a green ✅ receipt.
 *   • pump.fun moved to frontend-api-v3. Solana snipe discovery went blind and
 *     /health kept printing 🟢, because an empty feed and a dead feed were the
 *     same empty array.
 *   • The swap-build call broke on its own, separately from the quote call, on
 *     a base that was answering fine.
 *
 * Each was found by a human typing `npm run preflight:solana` after a complaint.
 * The check existed, worked, and named the problem in one line — it just only
 * ran when somebody already suspected something. That is not monitoring; it is
 * a flashlight you have to remember to pick up.
 *
 * So the probes live HERE, and both the preflight script and the running bot use
 * this one list. Two copies of "is Jupiter up" would eventually disagree, which
 * is the same defect as the two pump.fun hosts this repo was carrying.
 *
 * DESIGN RULES, each one a way this could go wrong:
 *
 *   • Every probe is timeout-bounded and NEVER throws. A monitor that can crash
 *     the process it monitors is worse than no monitor.
 *   • A probe reports { ok, detail } — and `detail` is filled on success too, so
 *     the log says WHICH host answered, not merely that one did.
 *   • Probes are read-only and cost nothing: a quote is not a trade, and the
 *     swap-build probe uses a freshly generated address that is never signed for.
 *   • `critical` marks the ones that stop a user trading. A dead pump.fun feed
 *     costs discovery; a dead Jupiter costs every buy on the chain.
 */
const { Keypair } = require('@solana/web3.js');
const solana = require('./solana');
const launchpads = require('./launchpads');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // always-liquid, so a failure is never "no route"
const PROBE_LAMPORTS = 10000000n;                                // 0.01 SOL — priced, never sent
// How recent a refusal has to be to still count as "happening now". Wider than
// the default sweep (10 min), or a refusal landing just after a sweep is missed
// entirely and the alert never fires for an outage that is live.
const BUDGET_WINDOW_MS = Math.max(60000, Number(process.env.JUP_BUDGET_WINDOW_MS || 900000));

/** Wrap a probe so it always resolves, and always within `ms`. */
function guard(ms, fn) {
  return async () => {
    let timer = null;
    try {
      const out = await Promise.race([
        fn(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); }),
      ]);
      return { ok: true, detail: out || '' };
    } catch (e) {
      return { ok: false, detail: String((e && e.message) || e).slice(0, 220) };
    } finally { if (timer) clearTimeout(timer); }
  };
}

/**
 * The launchpad feeds, one probe each, contributed by the registry.
 *
 * They are BUILT rather than listed because the pad table is the single owner
 * of which pads exist — a hand-written list here would be a second answer to
 * that question, and this file exists precisely because two copies of "is X up"
 * eventually disagree.
 *
 * None is `critical`: a dead launchpad costs pre-migration DATA, not the
 * ability to trade — a buy still prices and routes through the aggregator with
 * every pad down. An alert where everything is critical has no priority in it.
 *
 * The registry's own timeout bounds each request; the guard here bounds the
 * probe, and a probe that can hang is a watchdog that can hang.
 */
// pump.fun is left out: `pumpfun.feed` below already probes that exact host and
// path, and two alerts for one outage is how a channel stops being read. Its
// `costs` line carries both losses instead.
const LAUNCHPAD_PROBES = launchpads.probes()
  .filter((p) => p.key !== 'launchpad.pumpfun')
  .map((p) => ({
    key: p.key, label: p.label, critical: p.critical, costs: p.costs,
    run: guard(15000, p.run),
  }));

const PROBES = [
  {
    key: 'jupiter.quote',
    label: 'Jupiter quote',
    critical: true,
    // What the user loses when this is down, in their words — so an alert says
    // what is broken FOR THEM and not only which host is unreachable.
    costs: 'no Solana buy or sell can be priced',
    run: guard(15000, async () => {
      const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: PROBE_LAMPORTS, slippageBps: 100 });
      if (!(q.outAmount > 0n)) throw new Error('quote returned no output');
      return `via ${solana.jupBase() || '?'}`;
    }),
  },
  {
    key: 'jupiter.swap',
    label: 'Jupiter swap-build',
    critical: true,
    costs: 'quotes work but no Solana trade can be built — buys fail after the user taps',
    // Its own probe, deliberately. These are two different endpoints on one host
    // and they have already failed independently: /quote answered while /swap
    // returned 500. Probing only the cheap one would have reported healthy
    // through the exact outage this file was written for.
    run: guard(20000, async () => {
      const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: PROBE_LAMPORTS, slippageBps: 100 });
      // A FRESH address every time. A reused one accumulates on-chain state that
      // strangers can shape — the shared BIP39 test key had a token account
      // created under a foreign owner, and Jupiter rightly refused to build for
      // it, which read as an outage that was never ours.
      const tx = await solana.getSwapTx(q.raw, Keypair.generate().publicKey.toBase58(), {});
      const n = Buffer.from(tx, 'base64').length;
      if (!(n > 100)) throw new Error('swap transaction too small to be real');
      return `tx ${n} bytes`;
    }),
  },
  {
    // ⚠️ THE PROBE ABOVE ASKS ONE QUESTION. THE BUY THAT FAILED ASKED FIFTEEN.
    //
    // A five-wallet buy fires five quotes, five token reads and five swap-builds
    // in one millisecond at a tier metered per IP — and `jupiter.quote` sails
    // through a budget that is refusing every one of them, because a single
    // probe request is exactly what a spent budget still has room for. So this
    // watchdog was, and would have remained, capable of printing 🟢 straight
    // through the reported outage. That is `fonts:check`'s nine green ticks over
    // a banner publishing boxes, one API over: a guard is only honest while it
    // measures the thing that actually runs.
    //
    // ⚠️ AND THE FIX IS NOT TO PROBE HARDER. A watchdog that fired five
    // concurrent quotes every sweep would be spending the budget it monitors —
    // the monitor causing the outage. It reads COUNTERS instead, taken from the
    // real traffic, which costs nothing and measures the users' requests rather
    // than its own.
    key: 'jupiter.budget',
    label: 'Jupiter request budget',
    critical: true,
    // What the USER loses, in their words. "lite-api.jup.ag 429" does not tell
    // an operator whether to stop the bot or finish dinner; this says the buys
    // are failing for a reason that is OURS.
    costs: 'buys fail with a red cross on every wallet — our own per-IP request budget, not the token',
    run: guard(2000, async () => {
      const s = solana.jupStats();
      // A REFUSAL IS THE SYMPTOM; AN ABSORBED 429 IS NOT. One that the retry got
      // past cost latency and nothing else, and alerting on it would be a
      // channel nobody reads by the second hour. Only a rate limit that REACHED
      // a caller cost somebody a trade.
      const fresh = s.sinceRefusedMs != null && s.sinceRefusedMs < BUDGET_WINDOW_MS;
      const tail = `${s.req} request(s) · ${s.r429} × 429 · ${s.absorbed} absorbed by retry`
        + (solana.jupKeyed() ? ' · KEYED' : ' · keyless tier');
      if (fresh) {
        throw new Error(`${s.refused} buy(s) refused by our own budget, last ${Math.round(s.sinceRefusedMs / 1000)}s ago`
          + ` — ${s.lastRefusedWhy || 'rate limited'}. ${tail}.`
          + ' Set JUP_API_KEY in tradebot/.env to raise the ceiling, or trade fewer wallets at once');
      }
      return tail;
    }),
  },
  {
    key: 'pumpfun.feed',
    label: 'pump.fun new-coins feed',
    critical: false,
    costs: 'Solana snipe discovery is blind — no new launch is seen, and pre-migration tokens lose their description and socials',
    run: guard(15000, async () => {
      const r = await solana.pumpfunNewX(5);
      if (!r.ok) throw new Error(r.why || 'feed unreachable');
      if (!r.coins.length) throw new Error('feed answered but returned nothing — check the response shape, not the network');
      return `${r.coins.length} launches via ${solana.pumpBase() || '?'}`;
    }),
  },
  {
    key: 'dexscreener',
    label: 'DexScreener pricing',
    critical: false,
    costs: 'Solana token cards lose their price, market cap and liquidity',
    run: guard(15000, async () => {
      const d = await solana.dexScreener(USDC);
      if (!d || !(d.priceUsd > 0)) throw new Error('no market data for a mint that always has one');
      return `$${d.priceUsd}`;
    }),
  },
  ...LAUNCHPAD_PROBES,
];

/** Run every probe concurrently. Always resolves; never throws. */
async function checkAll() {
  const out = await Promise.all(PROBES.map(async (p) => {
    const r = await p.run();
    return { key: p.key, label: p.label, critical: p.critical, costs: p.costs, ok: r.ok, detail: r.detail };
  }));
  return { at: Date.now(), results: out, ok: out.every((r) => r.ok), criticalOk: out.every((r) => r.ok || !r.critical) };
}

module.exports = { PROBES, checkAll, USDC };
