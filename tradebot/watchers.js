'use strict';
/*
 * Background watchers for the Dexvra Trade Bot:
 *   • SNIPE  — new-launch auto-buy, from FOUR discovery sources into ONE fire
 *              path (_fireLaunch): the Robinhood factory log (TokenCreated), the
 *              EVM DEX scan (PairCreated on ETH/Base/BNB/Arbitrum), the pump.fun
 *              new-coins feed, and every OTHER launchpad in the shared registry
 *              (padSnipeCycle — Pons, LetsBonk, Moonshot, four.meme, Virtuals, …).
 *              A launch seen before its market opens parks in the retry ring
 *              (launchRetryCycle) instead of being dropped. Buys for every
 *              armed+funded user.
 *   • COPY   — mirror a followed wallet's buys. EVM watches ERC20 Transfer logs from
 *              the token's WETH pair; SOLANA polls the target's signatures and mirrors
 *              a SOL-funded SPL increase. DANGER-flagged tokens (GoPlus/RugCheck) skipped.
 *   • ORDERS — limit-buy / take-profit / stop-loss on any chain (Solana included via
 *              DexScreener pricing). Polls each order's live price, ONE-SHOT on cross.
 *
 * Fund-safety: a triggered order is REMOVED and persisted synchronously BEFORE the
 * trade is sent, so a crash/restart can never replay a fill (double-spend). Orders
 * are one-shot — a triggered order that fails is dropped with a DM, not retried
 * (retrying a possibly-half-executed trade is unsafe).
 */
const { ethers } = require('ethers');
const core = require('./core');
const goplus = require('./goplus');
const safety = require('./safety');   // chain-aware safety (GoPlus on EVM, RugCheck on Solana)
const solana = require('./solana');   // Solana snipe/copy helpers
const launchpads = require('./launchpads');   // the other pads a Solana token can be born on
const upstreams = require('./upstreams');   // are the third parties answering? (one list, shared with the preflight)
const report = require('./report');         // ops channel — never secrets

/**
 * Every AUTO-SNIPE purchase names its blast radius and carries the off switch.
 *
 * A user turned the copy-trading master switch ON — a different feature — and
 * watched the bot buy two launches "by itself". Auto-snipe had been armed on
 * Solana earlier and forgotten, and the receipt just said "Sniped", which does
 * not say WHICH of three snipe features fired or how to stop it. A message that
 * spends money has to answer both, on the message.
 */
const _autoSnipeKb = (chainKey) => ({ inline_keyboard: [[{ text: '🛑 Stop auto-snipe on this chain', callback_data: `sntog:${chainKey}` }]] });

let _notify = () => {};
function setNotifier(fn) { if (typeof fn === 'function') _notify = fn; }
const SNIPE_CHAIN = 'robinhood';

// Bounded-concurrency map: run `fn` over items, at most `limit` in flight. Keeps
// one slow trade/confirmation from stalling the whole shared cycle (a triggered
// order or snipe that waits up to 180s for a receipt no longer blocks everyone).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (_) {} } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}
const SNIPE_CONCURRENCY = Math.max(1, Number(process.env.SNIPE_CONCURRENCY || 4));

// ------------------------------------------------------------------ snipe
let _lastSnipeBlock = 0;
const SNIPE_MAX_SPAN = Math.max(200, Number(process.env.SNIPE_MAX_SPAN || 2000));
const _snipeFailAt = new Map();   // chatId -> last failure-DM ms (rate limit)
// Per-launch dedup for the "snipe ALL launches" EVM paths. Their block cursor can be
// pinned BACKWARD when a load-balanced RPC returns a lagging head (the cycles explicitly
// handle head < cursor), which re-scans a block range and would otherwise buy the same
// launch twice (core.buy has no on-chain idempotency). Marking each launch seen makes
// snipe-all one-shot. Dev-wallet snipe does NOT use this — it's already idempotent via
// its target's own `bought` map. (Audit #1 fix.)
const _snipeSeen = new Map();   // chainKey -> Set(token). PER-CHAIN: a high-volume chain
                                // must NOT be able to evict a slow chain's still-in-window
                                // launch (which would let a cursor regression re-buy it).
const SNIPE_SEEN_CAP = Math.max(4000, Number(process.env.SNIPE_SEEN_CAP || 20000));
/** One spelling of a token address per chain. EVM is case-insensitive; a Solana
 *  base58 mint is not, and lowercasing one is a collision waiting to happen. */
const _addrKey = (chainKey, addr) => (core.chains.isSvm(chainKey) ? String(addr || '').trim() : String(addr || '').trim().toLowerCase());
function _snipeMark(chainKey, token) {
  let set = _snipeSeen.get(chainKey);
  if (!set) { set = new Set(); _snipeSeen.set(chainKey, set); }
  // CASE MATTERS ON SOLANA. A base58 mint is case-SIGNIFICANT — the same rule
  // normalize.addrKey keeps in the launchpad registry — so lowercasing one
  // folds two different mints onto one key and drops the second launch as
  // "already sniped". It never fired here while Solana had its own seen-set;
  // it would the moment the pad feeds started marking Solana launches through
  // this function, which is a silent miss and the hardest kind to notice.
  const k = _addrKey(chainKey, token);
  if (set.has(k)) return false;
  set.add(k);
  // FIFO cap comfortably exceeds the most launches that can fall inside ONE chain's
  // re-scan window (SNIPE_MAX_SPAN blocks ≈ tens–hundreds of launches), so an in-window
  // launch is never evicted → no re-buy on a cursor regression. (Audit #1 fix.)
  if (set.size > SNIPE_SEEN_CAP) { const it = set.values().next().value; set.delete(it); }
  return true;
}
/**
 * Forget a launch that was marked and then NEVER SERVED.
 *
 * The mark's one job is "this launch was offered — do not offer it through
 * snipe-all twice". The pad loop marks a bonding-curve token at DISCOVERY,
 * minutes-to-days before anything can fill it; when the retry ring then gave
 * up on it, the mark stayed — so the graduation PairCreated event, which is
 * exactly where the pre-pad code bought these tokens, hit the dedup and
 * skipped everyone, dev followers included. A launchpad integration built to
 * widen discovery was silently DISABLING the one path that already worked.
 *
 * Only a launch NOBODY was served (no fill, no broadcast — `done` empty) is
 * unmarked: once anyone holds it, the mark is what stops the graduation event
 * buying it for them a second time, and a missed buy for the others is the
 * cost this repo always pays over a double one.
 */
function _snipeUnmark(chainKey, token) {
  const set = _snipeSeen.get(chainKey);
  if (set) set.delete(_addrKey(chainKey, token));
}
// What the launch feed has actually SEEN. Kept because the single most diagnostic
// number in this service was being thrown away: a loop that scanned tens of thousands
// of blocks and found zero launches is indistinguishable, from inside the process,
// from a quiet market — and eth_getLogs returns an EMPTY ARRAY (not an error) for a
// topic nothing emits. So a snipe pointed at the wrong launchpad ran forever, reported
// 🟢 on /health, and never fired. These counters are what make that state visible.
const _snipeStats = { scans: 0, blocksScanned: 0, launchesSeen: 0, lastLaunchAt: null, lastScanAt: null, ponsSeen: 0, ponsErr: null };
// The Solana twin. `lastFeedOkAt` and `lastLaunchAt` are BOTH needed and mean
// different things: the first says pump.fun answered, the second says it had
// something. With only the loop's own heartbeat, a feed that had been dead for
// days still rendered a green tick — the state that looks most like a healthy one.
// The OTHER Solana launchpads live in padSnipeCycle and report through
// `_padSnipeStats`: a secondary pad being down costs that pad's launches and
// nothing else, while `lastErr` here is pump.fun and turns this loop red.
// Folding them together would either hide a real outage or invent one.
const _solSnipeStats = { polls: 0, launchesSeen: 0, lastLaunchAt: null, lastFeedOkAt: null, lastErr: null, lastErrAt: null };

/** What a sell actually left in the wallet.
 *
 *  `proceedsEth` is the GROSS — the bot's cut is a separate transfer broadcast
 *  after the wallet delta is measured — so any message that says "received" or
 *  "recovered" and prints it is claiming the user kept more than they did.
 *  One helper, because three notifications here made the same mistake
 *  independently and a fourth would have too. */
const _kept = (r) => Number(r && (r.netEth != null ? r.netEth : r.proceedsEth)) || 0;
function snipeStats() { return { ..._snipeStats }; }

async function snipeCycle() {
  const prov = core.providerFor(SNIPE_CHAIN);
  let head;
  // Rethrow rather than swallow: runLoop marks the loop failed and /health turns 🔴.
  // Returning normally here made a dead RPC look like a healthy, quiet scan.
  try { head = await prov.getBlockNumber(); }
  catch (e) { console.error('[snipe] getBlockNumber:', e.message); throw e; }
  if (!_lastSnipeBlock || head < _lastSnipeBlock) _lastSnipeBlock = head;   // pin cursor near head always
  const armed = _armedOn(SNIPE_CHAIN);
  const devFollowers = launchFollowers('robinhood');   // users sniping specific dev wallets on Robinhood
  if (!armed.length && !devFollowers.length) { _lastSnipeBlock = head; return; }
  const factory = new ethers.Contract(core.chainOf(SNIPE_CHAIN).factory, core.FACTORY_ABI, prov);
  const from = Math.max(_lastSnipeBlock + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _lastSnipeBlock = head; return; }
  let evs = [];
  // Same reasoning as above — a getLogs failure is a real fault, not a quiet scan.
  // The cursor deliberately stays put so the range is re-scanned next cycle.
  try { evs = await factory.queryFilter(factory.filters.TokenCreated(), from, head); }
  catch (e) { console.error('[snipe] queryFilter:', e.message); throw e; }
  _lastSnipeBlock = head;
  _snipeStats.scans++;
  _snipeStats.blocksScanned += Math.max(0, head - from + 1);
  _snipeStats.lastScanAt = Date.now();
  if (evs.length) { _snipeStats.launchesSeen += evs.length; _snipeStats.lastLaunchAt = Date.now(); }
  // One line per scan, only while somebody is armed (the early return above means an
  // idle bot logs nothing). Without it, "is the snipe working?" had no answer short of
  // waiting for a fill that may never come.
  console.log(`[snipe] ${SNIPE_CHAIN} blocks ${from}-${head} · launches ${evs.length} · armed ${armed.length} · devFollowers ${devFollowers.length} · seen-total ${_snipeStats.launchesSeen}${_snipeStats.ponsSeen ? ` (pons ${_snipeStats.ponsSeen})` : ''}`);
  // The SECOND Robinhood launchpad, on its own cursor: a Pons outage or a
  // stale Pons ABI may cost Pons launches, never the primary scan's.
  await _ponsScan(prov, head, armed, devFollowers).catch((e) => { _snipeStats.ponsErr = 'Pons scan: ' + ((e && e.message) || String(e)).slice(0, 160); });
  for (const e of evs) {
    const ca = e.args && e.args.token;
    if (!ca) continue;
    // Record EVERY launch once — even in a dev-follower-only window with no armed
    // snipe-all user — so snipe-all stays forward-looking (a user who arms AFTER a
    // launch never retro-snipes it on a re-scan). Matches the Solana and launchpad
    // feeds, which mark unconditionally too. (Audit #2 fix.)
    const firstSee = _snipeMark(SNIPE_CHAIN, ca);
    // `armed` is EMPTIED on a re-scan rather than filtered: snipe-all has no
    // dedup of its own, so a re-scanned block range would buy the same launch
    // twice (audit #1). The dev snipe is exempt because each target's `bought`
    // map already makes it idempotent — and skipping it on a re-scan would drop
    // a launch whose first attempt was simply too early.
    //
    // No gate: a `TokenCreated` log means the curve exists in the block just
    // read, and spending a round trip to confirm what the log already said is
    // how a sniper arrives late. A buy that finds no market yet lands in the
    // retry ring instead.
    // On a re-scan, the emptied `armed` must ALSO ride as `skip`: if a dev
    // buy in this pass parks the launch in the retry ring, a done-set built
    // only from this invocation would let the ring re-buy it for snipe-all
    // users whose fill happened in the FIRST pass — the double spend the
    // emptying exists to prevent, one hop later.
    await _fireLaunch(SNIPE_CHAIN, {
      token: ca,
      sym: (e.args && e.args.symbol) || '',
      creator: (e.args && e.args.creator) || '',
      at: Date.now(),
      via: 'factory',
    }, { armed: firstSee ? armed : [], devFollowers, skip: firstSee ? null : new Set(armed.map((u) => u.chatId)) });
  }
}
// Can this user afford the snipe? Returns true when they CANNOT (skip them).
//
// The old code skipped silently — right idea — but the pre-check reserved
// CFG.gasBufferEth (0.0004) while buy() reserved ETH_GAS_BUFFER (0.006), so on
// Ethereum the skip never fired: the buy ran, threw "insufficient ETH — need
// ~0.016, have 0.01499", and that notice went out on every new pair, for ever,
// "muted 5 min" notwithstanding. Both now read core.gasBufferWei, so a wallet
// that is short lands here instead of in the failure handler.
//
// Told ONCE. Not once per hour, not once per balance — once. A wallet's balance
// drifts constantly (gas spent elsewhere, dust arriving), so keying the notice
// on the balance still produced a stream of them; keying it on a timer produces
// one per window for as long as the wallet stays small, which is for ever. The
// flag lives on the user record and is persisted, so a restart does not
// re-announce it either.
//
// It re-arms on exactly one event: the wallet becoming able to afford the snipe
// again. That is the problem being solved, and a problem that recurs later is a
// new problem worth one new notice.
function _affordCheck(u, chainKey, bal, need) {
  const flags = (u._shortAlert = u._shortAlert || {});
  if (bal >= need) {
    if (flags[chainKey]) { delete flags[chainKey]; core.saveStoreNow(); }   // fixed → arm for next time
    return false;
  }
  if (!flags[chainKey]) {
    flags[chainKey] = true;
    core.saveStoreNow();
    const ch = core.chainOf(chainKey);
    const native = (ch && ch.native) || 'ETH';
    // SOLANA COUNTS IN LAMPORTS (9dp), NOT WEI. This notice was EVM-only, and
    // wiring the Solana snipe into it with formatEther would have printed
    // "Need 0.000000002" for two SOL — a number that reads as a bug in the bot
    // rather than as an empty wallet, on the one message whose whole job is to
    // tell the user what to top up.
    const unit = (v) => ethers.formatUnits(v, core.chains.isSvm(chainKey) ? 9 : 18);
    _notify(
      u.chatId,
      `⏸ <b>Snipe skipped — not enough ${esc(native)}</b>\n` +
        `Need <b>${unit(need)}</b> (${u.snipe.ethAmount} + gas), wallet has <b>${Number(unit(bal)).toFixed(5)}</b>.\n` +
        `Sniping stays on. Top up or lower the amount — you will not be told about this again.`,
      undefined,
      'snipe',
    );
  }
  return true;
}

// Users with the master copy switch ON who follow ≥1 dev wallet (launch mode) on `chainKey`.
function launchFollowers(chainKey) {
  return core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.some((t) => t.mode === 'launches' && t.chain === chainKey));
}
// Crash-safe single buy for a copy/dev-snipe target — SAME budget+dedup commit as
// copyCycle: commit bought+spent (persisted) BEFORE the buy, and roll back ONLY when the
// buy clearly didn't spend (never on err.broadcast, so a tx that may still land can't be
// double-spent or blow the budget cap). Used by the dev-wallet snipe paths.
// Returns true if the buy HELD (succeeded, or was broadcast and may still land) — so the
// caller skips a redundant snipe-all buy of the same launch for that user. Returns false
// when nothing was spent: an early skip (dedup/budget/danger) OR a failed buy that rolled
// back — in which case a snipe-all fallback for that user is still allowed. (Audit #3 fix.)
async function _followerBuy(u, t, token, chainKey, out) {
  const svm = core.chains.isSvm(chainKey);
  const key = svm ? String(token) : String(token).toLowerCase();
  t.bought = t.bought || {};
  if (t.bought[key]) return false;                                                     // already sniped this launch for this target
  // The wallet SELECTION, resolved at fire time: '*' = every wallet, walletIds
  // = the subset picked on the panel (deleted wallets dropped), walletId = one
  // — and no selection at all keeps the old behavior, the active wallet. The
  // exit mirror sells each slice from the wallet that bought it (legs below).
  const wl = core.walletList(u);
  const wids = (t.walletId === '*'
    ? wl.map((w) => w.id)
    : Array.isArray(t.walletIds) && t.walletIds.length
      ? t.walletIds.filter((id) => wl.some((w) => w.id === id))
      : [(t.walletId && wl.some((w) => w.id === t.walletId) ? t.walletId : (core.activeWallet(u) || {}).id)]
  ).filter(Boolean);
  if (!wids.length) {
    // Every wallet this target was armed on is gone. A copy target has no
    // status to settle, so without a word it would sit on the Copy screen
    // reading as live and buy nothing, for ever — the inert-watch failure this
    // repo refuses. Muted like the other per-target notices.
    const nowW = Date.now(), wk = u.chatId + ':devnowallet:' + t.id;
    if (nowW - (_snipeFailAt.get(wk) || 0) > 3600000) {
      _snipeFailAt.set(wk, nowW);
      _notify(u.chatId, `⚠️ <b>Dev snipe can't buy</b> · <code>${short(t.address)}</code>\nEvery wallet it was set to buy with has been removed, so its launches are being skipped. Pick a wallet again from 🎯 Snipe, or remove the target.`, undefined, 'copy');
    }
    return false;
  }
  // The budget must cover the WHOLE fan-out: one launch on N wallets spends
  // N × buyEth, and partially filling a selection would make "which wallets
  // bought" a lottery. Fit whole, or skip whole.
  const fanOutEth = Number(t.buyEth) * wids.length;
  // ⚠️ A DEV SNIPE HAS NO CAP — the owner removed the budget feature outright,
  // so this watch buys every launch until it is switched off or the wallets run
  // dry. `spentEth` is still accumulated: it is the running total the Copy &
  // Snipe row prints, and dropping it would take away the only number that says
  // what an uncapped watch has actually spent. Copy TRADES keeps its cap.
  const capped = t.mode !== 'launches';
  if (capped && Number(t.spentEth) + fanOutEth > Number(t.maxEth) + 1e-12) return false;   // budget cap
  if (safety.supported(chainKey)) {
    const s = await safety.tokenSecurity(chainKey, token).catch(() => null);
    // A honeypot skip is the gate WORKING, and it is still an event the user
    // wants: their dev launched, and the bot deliberately stayed out.
    if (s && safety.verdict(chainKey, s).level === 'danger') { if (out) out.why = 'the safety scan flagged it as DANGER (honeypot / cannot sell) — skipped on purpose'; return false; }
  }
  // RE-CHECKED, because the safety call above is a NETWORK await and this
  // target is no longer fired by one loop only: the retry ring and the pad
  // loop run concurrently with the chain's discovery loop, so two launches by
  // one dev can both read a stale spentEth while one of them sits in that
  // await, both pass the cap, and both claim — spending past the user's budget
  // by a full fan-out. The claim below is synchronous after this line, which
  // is what makes the check-then-claim atomic in a single-threaded process.
  if (t.bought[key]) return false;
  if (capped && Number(t.spentEth) + fanOutEth > Number(t.maxEth) + 1e-12) return false;
  const bk = Object.keys(t.bought); if (bk.length >= 2000) delete t.bought[bk[0]];
  t.bought[key] = true;
  t.spentEth = Number(t.spentEth) + fanOutEth;   // claimed BEFORE the buys — a missed snipe beats spending twice
  core.saveStoreNow();
  const ch = core.chainOf(chainKey) || { emoji: '', name: chainKey, native: 'ETH' };
  const fills = [], broadcasts = [], fails = [];
  await mapLimit(wids, 3, async (wid) => {
    try {
      // Per-target slippage, same contract as the CA snipe: the bound the user
      // set for THIS launch replaces their normal one; unset means normal.
      const r = await core.buy(u.chatId, token, t.buyEth, chainKey, wid, { slipBps: t.slipBps || undefined });
      fills.push({ wid, r });
    } catch (err) {
      if (err && err.broadcast) broadcasts.push({ wid, err });
      else fails.push({ wid, err });
    }
  });
  // Roll back ONLY what clearly did not spend. A broadcast may still land and
  // stays committed — refunding it would let the next launch spend the same
  // allowance twice.
  if (fails.length) t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth) * fails.length);
  const held = fills.length > 0 || broadcasts.length > 0;
  if (!held) {
    delete t.bought[key];
    core.saveStoreNow();
  } else {
    if (fails.length) core.saveStoreNow();
    // A dev snipe is exit-mirrored too, and it is the case that needs it most:
    // the dev dumping their own launch is the single most informative sell a
    // followed wallet can make. One LEG per wallet that (possibly) holds —
    // fills carry the raw amount this mirror filled there; a broadcast leg's
    // fill is unknown ('', and the mirror refuses to guess with it).
    const legs = [...fills.map((f) => ({ wid: f.wid, own: f.r.gotRaw })), ...broadcasts.map((b) => ({ wid: b.wid, own: '' }))];
    core.copyHoldingAdd(t, token, await _targetBalance(chainKey, t.address, token), legs[0].wid, null, legs);
  }
  if (fills.length) {
    // The target's TP/SL become REAL orders at each fill, at ITS realised
    // entry (spent ÷ received), bound to the wallet that bought — the same
    // contract as the CA snipe's fill. A placement failure is SAID on the
    // message: a stop-loss the user believes exists is worse than none.
    let exits = '';
    if (t.tpPct > 0 || t.slPct > 0) {
      const parts = [];
      let exitErr = null;
      for (const { wid, r } of fills) {
        const entry = Number(r.spentEth) / (Number(r.gotTokens) || 1);
        if (!(entry > 0)) continue;
        try {
          if (t.tpPct > 0) { addOrder(u.chatId, { type: 'tp', ca: token, sym: r.sym, chain: chainKey, targetPriceEth: entry * (1 + t.tpPct / 100), sellPct: 100, auto: true }, wid); if (!parts.includes(`TP +${t.tpPct}%`)) parts.push(`TP +${t.tpPct}%`); }
          if (t.slPct > 0) { addOrder(u.chatId, { type: 'sl', ca: token, sym: r.sym, chain: chainKey, targetPriceEth: entry * (1 - t.slPct / 100), sellPct: 100, auto: true }, wid); if (!parts.includes(`SL −${t.slPct}%`)) parts.push(`SL −${t.slPct}%`); }
        } catch (e) { exitErr = e; }
      }
      if (parts.length) exits = `\nAuto-exit armed: <b>${parts.join(' · ')}</b>${fills.length > 1 ? ` · ${fills.length} wallets` : ''}`;
      if (exitErr) exits += `\n⚠️ <i>Couldn't place the auto-exit (${esc(String(exitErr.message || exitErr).slice(0, 80))}) — set TP/SL by hand from the Monitor.</i>`;
    }
    const r0 = fills[0].r;
    const totTok = fills.reduce((s, f) => s + (Number(f.r.gotTokens) || 0), 0);
    const spentStr = fills.length > 1 ? String(Number(fills.reduce((s, f) => s + (Number(f.r.spentEth) || 0), 0).toFixed(6))) : String(r0.spentEth);
    const wtag = wids.length > 1 ? ` · ${fills.length}/${wids.length} wallets` : '';
    _notify(u.chatId, `🎯 <b>Dev snipe</b> — $${esc(r0.sym)} on ${ch.emoji} ${esc(ch.name)}${wtag}\nDev <code>${short(t.address)}</code> just launched it · bought ${fmt(totTok)} for ${spentStr} ${r0.native}${t.copySell ? ' · <i>exit mirrored</i>' : ''}${exits}\n<code>${token}</code>\n${txLink(chainKey, r0.hash)}`, undefined, 'copy');
  }
  // "THERE IS NO MARKET YET" IS NOT A FAILED SNIPE — it is the normal first
  // answer for a dev's own launch, which this bot sees within seconds of the
  // mint and usually before the dev has opened the pool. Reported as a failure
  // it is a DM per launch that fills correctly twenty seconds later, which is
  // exactly how a user learns to swipe past the warnings that matter. The
  // caller reads `out.notYet` and parks the launch in the retry ring instead.
  const notYet = fails.length > 0 && fails.every((f) => _notYetTradeable(f.err));
  if (out && notYet) out.notYet = true;
  // The REASON travels, so the caller can tell the user rather than swallowing
  // it. A dev launch that is seen and not bought must never be silent.
  else if (out && fails.length) out.why = String((fails[0].err && fails[0].err.message) || fails[0].err);
  if ((fails.length && !notYet) || (broadcasts.length && !fills.length)) {
    const e0 = (fails[0] || broadcasts[0]).err;
    const now = Date.now(), fk = u.chatId + ':devsnipe:' + key;
    if (now - (_snipeFailAt.get(fk) || 0) > 300000) { _snipeFailAt.set(fk, now); _notify(u.chatId, `⚠️ Dev-snipe of ${short(token)} failed${wids.length > 1 ? ` on ${fails.length || broadcasts.length} wallet(s)` : ''}: ${esc((e0 && e0.message) || String(e0))} (muted 5 min)`, undefined, 'copy'); }
  }
  return held;
}

// ------------------------------------------------------------------ Pons — the SECOND launchpad on Robinhood, read from the chain itself
/*
 * pons.fun launches straight into a Uniswap v3 (V1) / v4-hook (V2) pool on
 * Robinhood Chain, announced by ITS OWN factory's `TokenLaunched` event — a
 * different contract and a different signature from the `TokenCreated` the
 * primary scan filters. eth_getLogs answers an unknown topic with an empty
 * array, so before this scan existed a Pons launch did not look like a missing
 * feature: it looked like a quiet chain.
 *
 * ON-CHAIN ON PURPOSE, not through the HTTP pad. pons.fun's API answers
 * neither from the production box (timeout) nor from anywhere this was built
 * (egress-blocked), and the chain is the one source the bot already reads for
 * every trade. The registry's HTTP pad for Pons stays — it can only ever add
 * display metadata — but DISCOVERY does not depend on it. The event's
 * `deployer` is the actual dev wallet, so the dev-wallet snipe matches here
 * with no extra read at all (better than the pool-opener inference the
 * PairCreated scan needs).
 *
 * ⚠️ THE FIRST TWO SHIPPED DEFAULTS WERE BOTH WRONG, AND NOTHING SAID SO.
 * The factory addresses and the `TokenLaunched(...)` signature came from Pons's
 * public integration docs and could not be checked against a live RPC from
 * where they were written. Measured on the box, neither address had contract
 * code, and the documented signature hashes to 0xdb51ea… while the launchpad
 * that really announces a Pons launch emits 0x8d4aad… — so the filter could
 * never have matched a log even had the address been right. Both defaults are
 * now what `npm run preflight:robinhood` READ OFF THE CHAIN, and the shape of
 * the fix is why they can be replaced without a deploy:
 *
 *   LAUNCHPAD_PONS=0   kills this scan AND the HTTP pad (one feature, one switch)
 *   PONS_FACTORY=0x…   a moved factory is a .env line
 *   PONS_EVENT=…       a rotated event is a .env line — EITHER a full
 *                      `event Foo(address indexed token, …)` signature, OR the
 *                      bare 32-byte topic0 an explorer shows
 *
 *   • factory has no CODE        → ponsErr says so (the wrong-address tell)
 *   • factory emits logs but none
 *     carry our topic0           → ponsErr says the EVENT is stale, not the host
 *   • a launch we cannot resolve → ponsErr names the candidates (never a guess)
 *   • nothing emitted at all     → ponsSeen stays 0 in /health, like every feed
 *
 * ⚠️ A TOPIC0 IS NOT AN ABI, AND THIS SCAN AIMS A BUY. Knowing which log
 * announces a launch says nothing about which of its words is the token, and
 * reading the wrong word buys a stranger's contract with somebody's money. So
 * in topic-only mode NOTHING IS GUESSED: the token is resolved by MEASUREMENT
 * (_ponsResolve — two independent facts about the launch transaction that have
 * to agree), and a launch that cannot be resolved is refused and diagnosed
 * rather than fired. A missed snipe is a shrug; the wrong token is not.
 *
 * Beyond that, nothing from the event reaches the money path: the buy is
 * priced, routed and gated by core.buy / canTradeNow exactly as for every other
 * discovery source.
 */
// TWO FACTORIES, not one — and these two were MEASURED, not guessed: both
// emitted a log for the same launch at Robinhood block 47496254, so which of
// them is the launchpad proper and which the token factory is not a question
// this scan has to answer. Watching both costs one getLogs each and _snipeMark
// collapses a token seen twice into one fire. Same rule as JUP_BASES: a LIST,
// current first, so a rollover in either direction needs no deploy.
// The launchpad's factory addresses, its topic0 and the config reader all live
// in `padFactory.js` now: core.js needs the same facts to find a SIBLING token
// on the pad (the learned-shape transfer), and two copies of a factory address
// is how the two modules would eventually disagree about where a pad announces
// from — on values the box already measured wrong twice.
const padFactory = require('./padFactory.js');
const { PONS_KNOWN_SIGS, PONS_TOPIC0_DEFAULT, PONS_FACTORY_DEFAULT } = padFactory;
const _ponsCfg = padFactory.ponsCfg;
const _sigTopic = padFactory.sigTopic;
const _envs = padFactory._envs;

// ---- resolving a launch whose ABI we do not have -------------------------
const _TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const _ZERO32 = '0x' + '0'.repeat(64);
const _TOKEN0_SELECTOR = '0x0dfe1681';          // token0() — a pair answers, an ERC-20 does not
const PONS_RESOLVE_MAX = 12;                    // receipts per scan; a launch is rare, a broken filter is not

/** Every address the log NAMES, order-independent — indexed topics plus every
 *  32-byte data word shaped like a left-padded address. Order-independent is
 *  the point: a layout guess is exactly what this avoids. */
function _logAddrs(log) {
  const out = new Set();
  const add = (w) => {
    if (typeof w !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(w)) return;
    const a = ('0x' + w.slice(26)).toLowerCase();
    if (a !== '0x' + '0'.repeat(40)) out.add(a);
  };
  const topics = log.topics || [];
  for (let i = 1; i < topics.length; i++) add(String(topics[i]).toLowerCase());
  const data = String(log.data || '0x').slice(2).toLowerCase();
  for (let i = 0; i + 64 <= data.length; i += 64) add('0x' + data.slice(i, i + 64));
  return out;
}

/** Which token did this launch create? TWO INDEPENDENT FACTS THAT MUST AGREE:
 *  the launch log NAMES the address, and the same transaction MINTED it (an
 *  ERC-20 `Transfer` out of the zero address). Either alone is guessable — the
 *  log names the pool and the quote token too, and a transaction can mint more
 *  than one thing — and their intersection is decided by the chain rather than
 *  by an assumed argument position.
 *
 *  ⚠️ It refuses rather than picks. Anything but exactly one survivor returns a
 *  `why` and fires nothing: the cost of refusing is a missed snipe, and the
 *  cost of picking wrong is buying a stranger's contract.
 *
 *  The deployer is the transaction's SENDER — the same inference the
 *  PairCreated scan already documents, and it only ever decides whether a dev
 *  follower matches, never what gets bought. A decodable PONS_EVENT skips all
 *  of this and uses the event's own `deployer`. */
async function _ponsResolve(prov, log, factories) {
  const named = _logAddrs(log);
  for (const f of factories) named.delete(String(f).toLowerCase());
  // …and the emitter itself, which `factories` may not name once an operator
  // has pinned a shorter PONS_FACTORY list than the chain actually runs.
  if (log.address) named.delete(String(log.address).toLowerCase());
  if (!named.size) return { why: 'the launch log names no address' };
  let rc;
  try { rc = await prov.getTransactionReceipt(log.transactionHash); }
  catch (e) { return { why: 'could not read the launch transaction (' + String((e && e.message) || e).slice(0, 80) + ')' }; }
  if (!rc || !rc.logs) return { why: 'the launch transaction has no readable receipt' };
  const minted = new Set();
  for (const l of rc.logs) {
    // 3 topics, not 4: an ERC-721 mint carries its id as a third indexed topic,
    // and a v3 position NFT is minted from the zero address in exactly these
    // transactions.
    if (!l || !l.topics || l.topics.length !== 3) continue;
    if (String(l.topics[0]).toLowerCase() !== _TRANSFER_TOPIC) continue;
    if (String(l.topics[1]).toLowerCase() !== _ZERO32) continue;
    minted.add(String(l.address).toLowerCase());
  }
  let cand = [...minted].filter((a) => named.has(a));
  if (cand.length > 1) {
    // The one predictable ambiguity: a v2-style launch mints its LP token too,
    // and the pair is named by the log as the pool. ELIMINATE by asking the
    // chain (a pair answers token0(), an ERC-20 does not) — never select by it.
    const pairish = await Promise.all(cand.map(async (a) => {
      try { const r = await prov.call({ to: a, data: _TOKEN0_SELECTOR }); return typeof r === 'string' && r.length >= 66; }
      catch (_) { return false; }
    }));
    cand = cand.filter((_, i) => !pairish[i]);
  }
  if (cand.length !== 1) {
    return { why: cand.length
      ? `${cand.length} of the launch log's addresses were minted in its own transaction (${cand.map((a) => a.slice(0, 10)).join(', ')}) — set PONS_EVENT to the real signature to decode it`
      : 'no address named by the launch log was minted in its own transaction — set PONS_EVENT to the real signature' };
  }
  let deployer = '';
  try { deployer = rc.from ? ethers.getAddress(rc.from) : ''; } catch (_) {}
  return { token: ethers.getAddress(cand[0]), deployer };
}
let _ponsCursor = 0;
let _ponsCode = null;            // { at, ok } — getCode re-checked hourly, so a fixed .env heals without a second thought
let _ponsRawCheckAt = 0;         // the decode-mismatch probe is rate-limited; see below
async function _ponsScan(prov, head, armed, devFollowers) {
  const cfg = _ponsCfg();
  if (!cfg.on) return;
  const now = Date.now();
  if (!cfg.factories.length) { _snipeStats.ponsErr = 'PONS_FACTORY holds no valid address'; return; }
  // An unparseable PONS_EVENT is neither a topic0 nor a signature, so there is
  // nothing to filter on. Say which two spellings are accepted rather than
  // scanning for ever against a filter that can never match.
  if (!cfg.topic0) { _snipeStats.ponsErr = `PONS_EVENT is neither a 32-byte topic0 nor an "event Foo(...)" signature — set one of those in .env`; return; }
  // A factory with no CODE is the wrong-address state, and it must be a
  // sentence in /health rather than an eternal empty scan. Re-checked hourly,
  // and keyed by the ADDRESS LIST it judged: a verdict about one deployment
  // must never answer for another. ONE live factory is enough to scan — the
  // legacy address is expected to be dead on a fresh chain and must not
  // condemn the current one.
  const fkey = cfg.factories.join(',');
  if (!_ponsCode || _ponsCode.factory !== fkey || now - _ponsCode.at > 3600000) {
    try {
      const codes = await Promise.all(cfg.factories.map((f) => prov.getCode(f).catch(() => null)));
      const live = cfg.factories.filter((f, i) => codes[i] && codes[i] !== '0x');
      _ponsCode = { at: now, factory: fkey, ok: live.length > 0, live };
    } catch (_) { _ponsCode = null; }   // an unreadable chain is not an answer
  }
  if (_ponsCode && !_ponsCode.ok) {
    _snipeStats.ponsErr = `no PONS_FACTORY address has contract code on this chain (${cfg.factories.join(', ')}) — set the real one in .env (npm run preflight:robinhood probes it)`;
    return;
  }
  const live = (_ponsCode && _ponsCode.live && _ponsCode.live.length) ? _ponsCode.live : cfg.factories;
  if (!_ponsCursor || head < _ponsCursor) { _ponsCursor = head; return; }   // pin near head first pass — the first look only seeds
  const from = Math.max(_ponsCursor + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _ponsCursor = head; return; }
  let evs = [];
  try {
    // Filtered by TOPIC0, never by a decoded ABI — the topic is the only part
    // of the event this chain has told us, and matching on it works whether or
    // not anybody ever learns the signature behind it. Every live factory, one
    // cursor: they are one launchpad to the user, and a per-factory cursor
    // would let a quiet deployment hold the busy one back.
    const per = await Promise.all(live.map((f) =>
      prov.getLogs({ address: f, topics: [cfg.topic0], fromBlock: from, toBlock: head })));
    evs = per.flat();
  } catch (e) {
    // Its own failure surface, and the PRIMARY scan's cursor is untouched: a
    // Pons outage may cost Pons launches, never pools.trade ones. The cursor
    // stays put so the range is retried — unless the range itself is the
    // problem, which is skipped forward like the DEX scan does.
    _snipeStats.ponsErr = 'Pons scan: ' + ((e && e.message) || String(e)).slice(0, 160);
    if (_isRangeError(e)) _ponsCursor = head;
    return;
  }
  _ponsCursor = head;
  _snipeStats.ponsErr = null;   // the chain ANSWERED — whatever was wrong is over (the raw check below may re-diagnose)
  if (evs.length) {
    _snipeStats.ponsSeen += evs.length;
    _snipeStats.launchesSeen += evs.length;
    _snipeStats.lastLaunchAt = now;
  } else if (now - _ponsRawCheckAt > 600000) {
    // Matched nothing. "Quiet launchpad" and "stale event" are different facts,
    // and only the chain can separate them: if the factory EMITTED logs in this
    // very range that our topic0 did not match, the event is the problem — a
    // .env line, and this sentence names it, WITH the topics it did see, since
    // one of them is the answer. Rate-limited to one raw look per 10 min; a
    // quiet pad costs nothing.
    _ponsRawCheckAt = now;
    try {
      const raw = (await Promise.all(live.map((f) => prov.getLogs({ address: f, fromBlock: from, toBlock: head }).catch(() => [])))).flat();
      if (raw.length) {
        const seen = [...new Set(raw.map((l) => String((l.topics || [])[0] || '')).filter(Boolean))].slice(0, 4);
        _snipeStats.ponsErr = `Pons factory emitted ${raw.length} log(s), none carrying our PONS_EVENT topic ${cfg.topic0.slice(0, 12)}… — it is stale. Topics seen: ${seen.join(', ')} — put one in PONS_EVENT`;
      }
    } catch (_) {}
  }
  // Resolve each launch to a token BEFORE firing. A decodable event answers
  // from the log itself; a bare topic0 costs one receipt read and may refuse.
  // Bounded, because a filter matching the wrong high-frequency event must cost
  // a diagnosis rather than a receipt read per log for ever.
  const iface = cfg.decodable ? (() => { try { return new ethers.Interface([cfg.eventSig]); } catch (_) { return null; } })() : null;
  const unresolved = [];
  let looked = 0;
  for (const e of evs) {
    let token = '', creator = '';
    if (iface) {
      try {
        const a = iface.parseLog({ topics: [...(e.topics || [])], data: e.data }).args;
        token = a.token || ''; creator = a.deployer || '';
      } catch (_) {}
    }
    if (!token) {
      if (looked >= PONS_RESOLVE_MAX) { unresolved.push('bounded at ' + PONS_RESOLVE_MAX + ' per scan'); continue; }
      looked++;
      const r = await _ponsResolve(prov, e, live);
      if (!r.token) { unresolved.push(r.why); continue; }
      token = r.token; creator = r.deployer || '';
    }
    const firstSee = _snipeMark(SNIPE_CHAIN, token);
    // The same fire path and the same re-sight shape as every other source:
    // snipe-all only on first sight (the emptied set riding as `skip`), dev
    // followers always — `deployer` IS the dev wallet here.
    await _fireLaunch(SNIPE_CHAIN, {
      token,
      sym: '',
      creator,
      at: Date.now(),
      via: 'pons',
    }, { armed: firstSee ? armed : [], devFollowers, skip: firstSee ? null : new Set(armed.map((u) => u.chatId)) });
  }
  // A launch seen and NOT fired is the state that most looks like a quiet
  // launchpad, so it is never silent — /health carries the reason and the knob.
  if (unresolved.length) _snipeStats.ponsErr = `${unresolved.length} Pons launch(es) could not be resolved to a token and were NOT bought: ${unresolved[0]}`;
}

// ------------------------------------------------------------------ one launch, every audience
/*
 * A LAUNCH IS DISCOVERED FOUR WAYS AND FIRED ONE WAY.
 *
 * The Robinhood factory scan, the EVM `PairCreated` scan, the pump.fun feed and
 * the launchpad registry's feeds all answer the same question — "a new token
 * exists" — and each of them used to carry its own copy of what to do about it:
 * match the dev followers, skip the users who just dev-bought, run the safety
 * gate, check the balance, buy, notify. Three copies had already drifted (only
 * one of them recorded the launch when nobody was armed; only one told a user
 * their wallet was short), and the fourth would have drifted further.
 *
 * `armed` is passed in rather than looked up here because the callers gate it
 * differently on purpose: the Robinhood scan records every launch once but only
 * lets snipe-all fire on the FIRST sighting, so a re-scanned block range cannot
 * buy the same launch twice.
 */
async function _fireLaunch(chainKey, L, opts = {}) {
  const armed = opts.armed || [];
  const devFollowers = opts.devFollowers || [];
  const skip = opts.skip || null;
  const token = L.token;
  const held = new Set();          // chatIds that bought, or broadcast and may still land
  let waiting = false;             // somebody's buy found no market to fill against YET
  if (!token || (!armed.length && !devFollowers.length)) return { held, queued: false };

  /*
   * THE GATE, and it is only for the sources that can see a token BEFORE it has
   * a market.
   *
   * A launchpad feed names a token the second it is minted onto a bonding
   * curve, which on most chains is minutes-to-days before anything this bot can
   * route through exists. Firing a buy at it is a guaranteed failure, a wasted
   * quote and a "⚠️ A snipe failed" DM about a market that has simply not opened
   * yet. So a pad-discovered launch is asked `canTradeNow` first and parked in
   * the retry ring when the answer is no.
   *
   * The event-driven scans deliberately do NOT gate: a `PairCreated` log means
   * the pool exists in the block we just read, and a snipe that spends a round
   * trip confirming what the log already said arrives late. There the FAILURE is
   * the signal — see `_notYetTradeable` below.
   */
  if (opts.gate) {
    const ok = await core.canTradeNow(token, chainKey).catch(() => false);
    // `queued` is what _queueLaunch actually did, never an assumption: with the
    // ring disabled the queue is a no-op, and reporting true would leave the
    // caller believing a launch is parked that is in fact gone — the caller
    // unmarks on that answer so the graduation event can still offer it.
    if (!ok) {
      const q = _queueLaunch(chainKey, L, skip, opts.eligible);
      // With the ring OFF there is no later moment to speak at, so the notice
      // goes out now rather than never.
      if (!q && L.creator) {
        for (const u of devFollowers) {
          for (const t of u.copy.targets) {
            if (t.mode !== 'launches' || t.chain !== chainKey) continue;
            if (_addrKey(chainKey, t.address) !== _addrKey(chainKey, L.creator)) continue;
            _devLaunchMissed(u, t, chainKey, L, 'no market this bot can route through had opened yet', { follow: true }).catch(() => {});
          }
        }
      }
      return { held, queued: q };
    }
  }

  // ── Dev-wallet snipe: buy this launch for anyone following its creator.
  // Idempotent via each target's own `bought` map, so a re-scan or a retry can
  // never buy twice.
  if (devFollowers.length && L.creator) {
    const dev = _addrKey(chainKey, L.creator);
    const matches = [];
    for (const u of devFollowers) {
      if (skip && skip.has(u.chatId)) continue;
      for (const t of u.copy.targets) {
        if (t.mode !== 'launches' || t.chain !== chainKey) continue;
        if (_addrKey(chainKey, t.address) === dev) matches.push({ u, t });
      }
    }
    if (matches.length) {
      await mapLimit(matches, SNIPE_CONCURRENCY, async ({ u, t }) => {
        // `out.notYet` is how a dev snipe says "there was nothing to buy from
        // yet" rather than "it failed". Without it the single most valuable
        // snipe this bot has — the dev's own launch, seen within seconds —
        // was dropped on the floor at the one moment it is guaranteed to be
        // too early.
        const out = {};
        if (await _followerBuy(u, t, token, chainKey, out)) { held.add(u.chatId); return; }
        if (out.notYet) { waiting = true; return; }
        // NOT bought, and not merely early. Whatever the reason — an unroutable
        // venue, a danger flag, a dead wallet — the user hears it, because a
        // dev launch going by in silence is what this whole path is for.
        if (out.why) await _devLaunchMissed(u, t, chainKey, L, out.why, { follow: _mayBecomeTradeable(out.why) });
      });
    }
  }

  if (armed.length) {
    // Skip anything the safety provider flags as DANGER (honeypot, can't-sell,
    // owner-rug, blacklist, >10% tax). No data yet — the normal state for a
    // brand-new token — fails OPEN: sniping fresh launches is the whole point,
    // and the blind-buy risk is bounded by the amount.
    let danger = false;
    if (safety.supported(chainKey)) {
      const sec = await safety.tokenSecurity(chainKey, token).catch(() => null);
      danger = !!(sec && safety.verdict(chainKey, sec).level === 'danger');
    }
    if (!danger) {
      const ch = core.chainOf(chainKey) || { emoji: '', name: chainKey };
      await mapLimit(armed, SNIPE_CONCURRENCY, async (u) => {
        if (held.has(u.chatId)) return;             // already dev-sniped this exact launch
        if (skip && skip.has(u.chatId)) return;     // already served on an earlier pass
        if (!(await _canAfford(u, chainKey))) return;
        try {
          const r = await core.buy(u.chatId, token, u.snipe.ethAmount, chainKey);
          held.add(u.chatId);
          _notify(u.chatId, `🎯 <b>Auto-Snipe bought $${esc(r.sym || L.sym || '?')}</b> on ${ch.emoji} ${esc(ch.name)}\n<i>Auto-Snipe buys EVERY new launch on this chain while armed — this was not a CA or dev-wallet target.</i>\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n<code>${token}</code>\n${txLink(chainKey, r.hash)}`, _autoSnipeKb(chainKey), 'snipe');
        } catch (err) {
          // A buy that was BROADCAST may still land. It counts as HELD — the
          // CA snipe's rule, for the same reason: this launch can be re-offered
          // to OTHER users by the retry ring, and re-buying for a user whose
          // transaction then confirms is a double spend. The failure DM below
          // still goes out: a transaction in flight is worth knowing about.
          if (err && err.broadcast) held.add(u.chatId);
          // "There is no market yet" is not a failure to report — it is the
          // normal first answer for a token this fresh, and a DM for it would
          // be one per launch per armed user. It goes in the ring instead.
          else if (_notYetTradeable(err)) { waiting = true; return; }
          const now = Date.now(), key = u.chatId + ':' + chainKey;
          if (now - (_snipeFailAt.get(key) || 0) > 300000) {
            _snipeFailAt.set(key, now);
            _notify(u.chatId, `⚠️ A snipe on ${esc(ch.name)} failed: ${esc((err && err.message) || String(err))} (muted 5 min)`, undefined, 'snipe');
          }
        }
      });
    }
  }

  if (waiting) waiting = _queueLaunch(chainKey, L, new Set([...(skip || []), ...held]), opts.eligible);
  return { held, queued: waiting };
}

/**
 * A launch this bot SAW, matched to a dev target, and could not buy.
 *
 * "TOKEN SUDAH LAUNCH SNIPE ON TPI PAS TOKEN LAUNCH BOT MALA DIAM TIDAK ADA
 * EKSEKUSI — MINIMAL KALO GAGAL HARUS ADA PESANYA FAIL."
 *
 * The bot was not broken and it was not idle: the token launched onto a Pons
 * bonding curve, and this engine has no route through one — `canTradeNow` said
 * no, `_notYetTradeable` deliberately excludes "can't route through" from the
 * retry ring (retrying an unroutable venue is two minutes of RPC for an answer
 * that will not change), and the whole thing ended in SILENCE. Every state in
 * that chain was individually correct and the sum of them was a sniper that
 * watched a launch go by without a word.
 *
 * So: an armed follower whose dev launched something is TOLD, always, whatever
 * the outcome — and where the token will become buyable later (a curve that
 * graduates into a pool this engine can route), the launch is handed to the CA
 * snipe, which already polls `canTradeNow` for up to its TTL and fires the
 * moment it flips. That turns "never bought" into "bought at graduation" using
 * only paths that already work.
 */
async function _devLaunchMissed(u, t, chainKey, L, why, opts = {}) {
  const ch = core.chainOf(chainKey) || { emoji: '', name: chainKey, native: 'ETH' };
  const key = u.chatId + ':devmiss:' + _addrKey(chainKey, L.token);
  const now = Date.now();
  if (now - (_snipeFailAt.get(key) || 0) < 300000) return;   // one notice per launch per 5 min
  _snipeFailAt.set(key, now);
  let follow = '';
  if (opts.follow) {
    // Hand it to the CA snipe rather than inventing a second waiting room: that
    // loop already probes canTradeNow on a timer, buys on the first tick it can
    // fill, and carries the user's own slippage and TP/SL. A failure to arm it
    // is reported — a follow-up the user believes exists is worse than none.
    try {
      core.addSnipeTarget(u.chatId, {
        ca: L.token, chain: chainKey, amount: t.buyEth,
        walletId: t.walletId, walletIds: t.walletIds,
        slipBps: t.slipBps, tpPct: t.tpPct, slPct: t.slPct,
      });
      follow = '\n🎯 <i>Armed as a contract snipe — I will buy it the moment it becomes tradeable (when the curve graduates into a pool).</i>';
    } catch (e) {
      const m = String((e && e.message) || e);
      follow = /already armed/i.test(m)
        ? '\n🎯 <i>Already queued as a contract snipe — I will buy it the moment it becomes tradeable.</i>'
        : `\n⚠️ <i>Could not queue it as a contract snipe: ${esc(m)}</i>`;
    }
  }
  _notify(u.chatId, `⚠️ <b>Dev launched — NOT bought</b> on ${ch.emoji} ${esc(ch.name)}\n` +
    `Dev <code>${short(t.address)}</code> launched <code>${L.token}</code>\n` +
    `<b>Why:</b> ${esc(why)}${follow}`, {
      inline_keyboard: [[{ text: '📍 Open token', callback_data: `ca:${L.token}` }, { text: '👥 Copy & Snipe', callback_data: 'copy' }]],
    }, 'copy');
}

/** Can this token become buyable LATER? A bonding curve that graduates into a
 *  pool can; a token whose liquidity sits on a venue this engine will never
 *  route through cannot be distinguished from one that graduates, so both are
 *  followed — the CA snipe expires on its own TTL and costs one cheap probe. */
const _mayBecomeTradeable = (why) => /route through|no route|no liquidity|no pool|zero quote|not tradable|not tradeable|curve|bonding/i.test(String(why || ''));

/** Everyone with snipe-all armed on this chain, with a real amount set. */
const _armedOn = (chainKey) => core.allUsers().filter((u) => u.snipe && u.snipe.chains && u.snipe.chains[chainKey] && Number(u.snipe.ethAmount) > 0);

/**
 * Can this user's ACTIVE wallet pay for the snipe on this chain?
 *
 * One function for both worlds. The Solana branch used to be a silent inline
 * balance check while the EVM one told the user once — so a Solana snipe armed
 * on an empty wallet was an armed watch that could never fire and never said
 * why, which is the inert-watch failure this repo refuses everywhere else.
 */
async function _canAfford(u, chainKey) {
  try {
    // ethBalanceOrNull, NEVER ethBalance: the latter answers 0n for a dead RPC
    // and an empty wallet alike, and on Solana that 0n reached _affordCheck —
    // which then told a FUNDED user their wallet holds 0.00000 and latched the
    // told-once flag on a balance nobody read. An unreadable balance is a
    // silent skip; the launch is not missed for long, the loops come back.
    if (core.chains.isSvm(chainKey)) {
      const w = core.activeWallet(u); if (!w) return false;
      const bal = await core.ethBalanceOrNull(core.walletAddress(w, chainKey), chainKey);
      if (bal == null) return false;
      const need = solana.solToLamports(u.snipe.ethAmount) + solana.solToLamports(core.CFG.solGasBuffer);
      return !_affordCheck(u, chainKey, bal, need);
    }
    const addr = core.activeAddress(u); if (!addr) return false;
    const bal = await core.ethBalanceOrNull(addr, chainKey);
    if (bal == null) return false;
    const need = ethers.parseEther(String(u.snipe.ethAmount)) + core.gasBufferWei(chainKey);
    return !_affordCheck(u, chainKey, bal, need);
  } catch (_) { return false; }
}

/**
 * Did this buy fail because there is nothing to fill against YET?
 *
 * The distinction the whole retry ring rests on. "No route", "no liquidity",
 * "zero quote" and "no pool" all mean the market has not opened — the token is
 * real, the wallet is funded, and the same buy will work in ten seconds. Every
 * other failure (a short balance, a revert, a rate limit, a token that cannot
 * be routed at all) is a fact about this trade and is reported as one.
 *
 * Deliberately NOT matched: "Dexvra can't route through that yet", which names a
 * VENUE this engine has no path to. Retrying that for two minutes is two minutes
 * of RPC spent on an answer that will not change.
 */
const NOT_YET_RE = /no route|no liquidity|zero quote|no pool|not tradable|not tradeable|no market|not yet tradeable/i;
function _notYetTradeable(err) {
  const m = String((err && (err.message || err)) || '');
  if (/route through/i.test(m)) return false;
  return NOT_YET_RE.test(m);
}

// ------------------------------------------------------------------ the retry ring
/*
 * A LAUNCH SEEN TOO EARLY IS NOT A LAUNCH MISSED.
 *
 * This is the reason a dev-wallet snipe could be armed, correct, funded and
 * watching the right wallet — and still never buy anything.
 *
 * Every discovery source here sees a token at the earliest possible moment,
 * which is precisely the moment there is usually nothing to trade against: a
 * pump.fun mint is not on Jupiter for the first few seconds, a launchpad feed
 * names a token that is on a bonding curve with no pool at all, and a dev's
 * token can exist for a while before the dev opens its pool. The buy therefore
 * fails with "no route", and the launch was then dropped FOR EVER: the feed
 * cursor had already advanced past it and the seen-set had already marked it,
 * so the very next tick could not re-offer it. The comment on the Solana path
 * said "retried while it's fresh"; nothing in the code could do that.
 *
 * So a launch whose only problem is timing goes in this ring and is re-offered
 * until it becomes fillable or `LAUNCH_RETRY_MS` runs out. The gate is
 * `core.canTradeNow` — the single owner of "can a swap be filled right now" —
 * so a waiting launch costs one cheap probe per tick, not a failed buy.
 *
 * `done` is who must NOT be re-offered it: a user whose buy already held. A
 * ring that forgets that buys the same launch twice for one person, which is
 * strictly worse than the miss it exists to fix.
 */
const LAUNCH_RETRY_MS = Math.max(0, Number(process.env.LAUNCH_RETRY_MS || 180000));   // 0 disables the ring entirely
const LAUNCH_RETRY_CAP = Math.max(20, Number(process.env.LAUNCH_RETRY_CAP || 400));
// Probes per tick, and a much tighter budget for Solana — the same split
// caSnipeCycle makes, for the same reason: an EVM probe is an RPC read against a
// node we already own, a Solana probe is an aggregator QUOTE against the same
// keyless host that prices every real buy. Spending that budget here is how the
// snipe and ordinary trading start failing at the same time.
const LAUNCH_RETRY_PROBES = Math.max(1, Number(process.env.LAUNCH_RETRY_PROBES || 12));
const LAUNCH_RETRY_SVM_PROBES = Math.max(1, Number(process.env.LAUNCH_RETRY_SVM_PROBES || 4));
const LAUNCH_RETRY_POLL_MS = Math.max(2000, Number(process.env.LAUNCH_RETRY_POLL_MS || 5000));
const _launchRetry = new Map();   // `${chain}:${addrKey}` → { chainKey, L, done:Set, tries }
let _retryCursor = 0;
const _retryStats = { polls: 0, pending: 0, queued: 0, fired: 0, expired: 0, lastFiredAt: null };

function _queueLaunch(chainKey, L, done, eligible) {
  if (!LAUNCH_RETRY_MS || !L || !L.token) return false;
  const k = chainKey + ':' + _addrKey(chainKey, L.token);
  const e = _launchRetry.get(k) || { chainKey, L, done: new Set(), tries: 0 };
  // `L.at` is the DISCOVERY time and rides on the launch record, so a re-queue
  // after a retry cannot reset the clock — an entry that keeps failing must
  // still expire on schedule rather than living in the ring for ever.
  e.L = L;
  for (const id of (done || [])) e.done.add(id);
  // THE AUDIENCE IS FROZEN AT QUEUE TIME. The ring re-reads who is armed on
  // every fire, and without this a user who armed sixty seconds AFTER the
  // launch would be bought into it when the market opens — the retro-snipe
  // the audit-#2 rule in snipeCycle exists to forbid ("a user who arms AFTER
  // a launch never retro-snipes it"). A caller that already holds the frozen
  // set (the ring re-queueing) passes it through; a discovery loop lets it be
  // taken from who is armed right now, which IS the launch's audience.
  if (!e.eligible) {
    e.eligible = eligible || new Set([
      ..._armedOn(chainKey).map((u) => u.chatId),
      ...launchFollowers(chainKey).map((u) => u.chatId),
    ]);
  }
  if (!_launchRetry.has(k)) _retryStats.queued++;
  _launchRetry.set(k, e);
  if (_launchRetry.size > LAUNCH_RETRY_CAP) {
    const ek = _launchRetry.keys().next().value;
    const ev = _launchRetry.get(ek);
    _launchRetry.delete(ek);
    // An evicted launch nobody was served leaves no trace that could block its
    // own graduation event — same rule as expiry below.
    if (ev && !ev.done.size) _snipeUnmark(ev.chainKey, ev.L.token);
  }
  return true;
}

async function launchRetryCycle() {
  const now = Date.now();
  if (!_launchRetry.size) { _retryStats.pending = 0; return; }
  _retryStats.polls++;
  for (const [k, e] of [..._launchRetry]) {
    if (now - (e.L.at || 0) > LAUNCH_RETRY_MS) {
      _launchRetry.delete(k); _retryStats.expired++;
      // A launch that expired with NOBODY served must not stay marked, or the
      // pad loop's discovery mark permanently suppresses the graduation
      // (PairCreated) buy that predates this whole feature — a curve token's
      // pre-migration life is minutes-to-days, far past this ring's window.
      if (!e.done.size) _snipeUnmark(e.chainKey, e.L.token);
      // AND THE FOLLOWERS ARE TOLD. The ring giving up is the last moment
      // anybody could learn that a watched dev launched something the bot never
      // managed to buy; past it there is no event left to hang a word on. The
      // CA snipe picks the token up and keeps probing for its whole TTL, which
      // is the window a bonding curve actually graduates in.
      if (e.L.creator) {
        for (const u of launchFollowers(e.chainKey)) {
          if (e.done.has(u.chatId)) continue;
          for (const t of (u.copy.targets || [])) {
            if (t.mode !== 'launches' || t.chain !== e.chainKey) continue;
            if (_addrKey(e.chainKey, t.address) !== _addrKey(e.chainKey, e.L.creator)) continue;
            _devLaunchMissed(u, t, e.chainKey, e.L,
              `no market this bot can route through opened within ${Math.round(LAUNCH_RETRY_MS / 60000)} min of the launch`,
              { follow: true }).catch(() => {});
          }
        }
      }
    }
  }
  const live = [..._launchRetry];
  _retryStats.pending = live.length;
  if (!live.length) return;
  // Round-robin, so entry 40 is not starved by 1–39 while the ones in front of
  // it wait out the same two minutes.
  const off = live.length ? (_retryCursor++ % live.length) : 0;
  const order = live.slice(off).concat(live.slice(0, off));
  let probes = 0, svmProbes = 0;
  for (const [k, e] of order) {
    const svm = core.chains.isSvm(e.chainKey);
    if (svm ? svmProbes >= LAUNCH_RETRY_SVM_PROBES : probes >= LAUNCH_RETRY_PROBES) continue;
    // `eligible` bounds the audience to who was armed when the launch was
    // queued — arming is forward-looking, and a launch from before the arm is
    // not this user's to buy however soon the market opens.
    const may = (u) => !e.done.has(u.chatId) && (!e.eligible || e.eligible.has(u.chatId));
    const armed = _armedOn(e.chainKey).filter(may);
    const devFollowers = launchFollowers(e.chainKey).filter(may);
    // Nobody left to buy it for — the user disarmed, or everybody already
    // filled. Holding the entry would spend probes on a launch with no
    // audience — and if nobody was ever served, the mark goes with it.
    if (!armed.length && !devFollowers.length) {
      _launchRetry.delete(k);
      if (!e.done.size) _snipeUnmark(e.chainKey, e.L.token);
      continue;
    }
    if (svm) svmProbes++; else probes++;
    e.tries++;
    let ready = false;
    try { ready = await core.canTradeNow(e.L.token, e.chainKey); }
    catch (_) { continue; }   // an unreadable chain is not an answer; ask again next tick
    if (!ready) continue;
    // Removed BEFORE the fire, and re-queued by `_fireLaunch` only if somebody
    // still could not fill. Same commit order as every other spend in this file:
    // a missed retry is a shrug, a double buy is the user's money.
    _launchRetry.delete(k);
    _retryStats.fired++; _retryStats.lastFiredAt = Date.now();
    await _fireLaunch(e.chainKey, e.L, { armed, devFollowers, skip: e.done, eligible: e.eligible }).catch(() => {});
  }
}

// ------------------------------------------------------------------ multi-chain snipe (new DEX pairs)
const _dexSnipeCursor = {};   // chainKey -> last scanned block
const _dexFactory = {};       // chainKey -> DEX pair factory (cached)
const DEX_SNIPE_MAX_TOKENS = Math.max(1, Number(process.env.DEX_SNIPE_MAX_TOKENS || 15));   // cap tokens/chain/cycle
const PAIR_CREATED_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'];
const ROUTER_FACTORY_ABI = ['function factory() view returns (address)'];

async function dexFactoryOf(chainKey) {
  if (_dexFactory[chainKey]) return _dexFactory[chainKey];
  try {
    const f = await new ethers.Contract(core.chainOf(chainKey).router, ROUTER_FACTORY_ABI, core.providerFor(chainKey)).factory();
    if (f && f !== ethers.ZeroAddress) { _dexFactory[chainKey] = f; return f; }
  } catch (_) {}
  return null;
}
// A getLogs/queryFilter error that means "the block range is too wide" (as opposed
// to a transient timeout). On these we skip the cursor FORWARD rather than retrying
// the same doomed range forever (which would livelock that chain's loop).
function _isRangeError(e) {
  const m = String((e && (e.message || e.info || e)) || '').toLowerCase();
  if (/too many requests|rate.?limit|\b429\b/.test(m)) return false;   // transient → retry the range, don't skip past it
  return /(too many results|more than \d+ results|query returned more than|block range|range is too|range too (large|wide|big)|response size|limited to|logs? .*range|\b10000\b|max.*results)/.test(m);
}

// Snipe brand-new DEX pairs on ETH/Base/BNB/Arbitrum for users who opted in per
// chain. Honeypots are skipped; each armed user's ACTIVE wallet buys the amount.
// Each chain scans INDEPENDENTLY and CONCURRENTLY so one slow/flaky RPC can't delay
// sniping on the others.
async function dexSnipeCycle() {
  const list = core.chains.enabledChains().filter((ch) => !ch.curve);   // Robinhood is handled by snipeCycle
  await Promise.all(list.map((ch) => _dexSnipeChain(ch).catch((e) => console.error('dexsnipe', ch.key, (e && e.message) || e))));
}
/**
 * The wallet that OPENED this pool.
 *
 * The dev-wallet snipe used to be refused on every EVM chain, on the grounds
 * that there is no cheap deployer signal there. That is true of the DEPLOYER and
 * false of the signal that matters: this scan already has the `PairCreated` log,
 * and the sender of the transaction that emitted it is the wallet that opened
 * trading. One `getTransaction` per new pair — and it is only ever called when
 * somebody is actually following a dev on this chain, so a chain nobody watches
 * pays nothing for the capability.
 *
 * Pool-opener, not deployer. For a memecoin launch they are one wallet, because
 * the deploy and the `addLiquidityETH` come from the same key; when a team
 * splits them this follows the one that opens trading, which is the one a
 * sniper wants. The UI says "opens the pool" rather than "deploys", because a
 * feature that quietly means something other than its label is a feature that
 * will be reported as broken.
 *
 * Null on any failure — an unreadable transaction must not stop the snipe-all
 * pass that shares this loop.
 */
async function _devFromPair(prov, ev) {
  try {
    const hash = ev && ev.transactionHash;
    if (!hash) return null;
    const tx = await prov.getTransaction(hash);
    const from = tx && tx.from;
    return from ? String(from).toLowerCase() : null;
  } catch (_) { return null; }
}

async function _dexSnipeChain(ch) {
  const armed = _armedOn(ch.key);
  // Dev followers are a DIFFERENT set, and gating them on `armed` is what kept
  // dev-snipe off every EVM chain even after the chain check was relaxed:
  // following one developer does not mean wanting every launch on the chain,
  // and the early return below treated the second as a precondition for the
  // first.
  const devFollowers = launchFollowers(ch.key);
  if (!armed.length && !devFollowers.length) return;
  const prov = core.providerFor(ch.key);
  let head; try { head = await prov.getBlockNumber(); } catch (_) { return; }
  const cursor = _dexSnipeCursor[ch.key];
  if (!cursor || head < cursor) { _dexSnipeCursor[ch.key] = head; return; }   // pin near head first pass (no backfill flood)
  const factory = await dexFactoryOf(ch.key); if (!factory) { _dexSnipeCursor[ch.key] = head; return; }
  const from = Math.max(cursor + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _dexSnipeCursor[ch.key] = head; return; }
  let evs = [];
  try { const fc = new ethers.Contract(factory, PAIR_CREATED_ABI, prov); evs = await fc.queryFilter(fc.filters.PairCreated(), from, head); }
  catch (e) { if (_isRangeError(e)) _dexSnipeCursor[ch.key] = head; return; }   // range too wide → skip forward; else keep cursor, retry next cycle
  _dexSnipeCursor[ch.key] = head;
  const weth = ch.weth.toLowerCase();
  let processed = 0;
  for (const e of evs) {
    if (processed >= DEX_SNIPE_MAX_TOKENS) break;
    const a = e.args || {};
    const t0 = String(a.token0 || '').toLowerCase(), t1 = String(a.token1 || '').toLowerCase();
    let token = null;
    if (t0 === weth) token = a.token1; else if (t1 === weth) token = a.token0; else continue;   // only native-paired launches
    if (!token) continue;
    // A token already marked is emptied of its snipe-all audience, NEVER
    // skipped whole — snipeCycle's shape, for snipeCycle's reason. The mark is
    // routinely placed by the PAD loop at mint time, minutes-to-days before
    // this PairCreated ever fires; `continue` here made the graduation event —
    // the one place these tokens were always bought — silently inert for
    // snipe-all AND dev followers alike. Dev followers are idempotent through
    // their own `bought` map, so re-offering them is safe, and the emptied
    // `armed` rides as `skip` so a requeue cannot re-buy for a user served in
    // an earlier pass.
    const firstSee = _snipeMark(ch.key, token);
    if (firstSee) processed++;
    else if (!devFollowers.length) continue;   // nothing a re-sight can still do
    // ── The wallet that OPENED this pool, which is what makes a dev-wallet
    // snipe possible on an EVM chain at all. Resolved ONLY when somebody is
    // following a dev here, so the extra read is paid by the feature that needs
    // it and by nobody else.
    //
    // _fireLaunch owns everything after that — the follower match, the budget,
    // the dedup, the safety gate and the buy — and it is the SAME function the
    // Robinhood, Solana and launchpad-feed paths call, so four discovery
    // sources cannot drift into four ideas of what a snipe does.
    const dev = devFollowers.length ? await _devFromPair(prov, e) : '';
    await _fireLaunch(ch.key, { token, sym: '', creator: dev || '', at: Date.now(), via: 'pair' }, { armed: firstSee ? armed : [], devFollowers, skip: firstSee ? null : new Set(armed.map((u) => u.chatId)) });
  }
}

// ------------------------------------------------------------------ launchpad snipe (every pad, every chain)
/*
 * THE SNIPE USED TO BE ONE LAUNCHPAD PER CHAIN, AND ON MOST CHAINS IT WAS NONE.
 *
 * Discovery was: one hardcoded factory address on Robinhood, `PairCreated` on
 * the EVM chains, and pump.fun on Solana. Every one of those sees a token at a
 * particular MOMENT of its life — the moment a specific contract emits a
 * specific log — and a token born on any other launchpad is invisible until it
 * migrates to a DEX, which is hours-to-days after the window anybody wants to
 * snipe in.
 *
 *   • On Robinhood, a launch through any contract other than the configured
 *     factory is simply never seen. eth_getLogs answers an unknown topic with an
 *     EMPTY ARRAY, so that reads as a quiet chain rather than as a blind spot.
 *   • On BNB Chain and Base, a four.meme or Virtuals token has no pair at all
 *     while it is on its curve, so `PairCreated` cannot fire.
 *   • On Solana, the other pads were merged into the pump.fun tick by a helper
 *     that only ever ran there.
 *
 * So the registry's feeds get their own loop, for every chain any pad covers,
 * with the same fire path as the three event scans. Adding a launchpad is now a
 * row in shared/launchpads/pads.js and nothing else.
 *
 * ONE CURSOR PER PAD PER CHAIN. A single shared cursor over a merged feed means
 * one pad emitting a bad timestamp advances it past every real launch from every
 * OTHER pad, and the snipe then goes quiet for ever — which looks exactly like a
 * slow day on the launchpads. (The registry's toMs() already refuses a future
 * timestamp; this is the second line, and the first one has been wrong before.)
 *
 * THE FIRST LOOK ONLY SEEDS, the auto-raid cursor's rule: an empty cursor means
 * "never looked", so the first read records the head WITHOUT sniping it.
 * Otherwise a restart buys the last fifty launches at once.
 */
const PAD_FEED_LIMIT = Math.max(5, Math.min(200, Number(process.env.LAUNCHPAD_FEED_LIMIT || 50)));
/*
 * A FEED PATH THAT IS WRONG ANSWERS 404 FOR EVER, AND ASKING FASTER DOES NOT FIX IT.
 *
 * The registry's own breaker deliberately benches a pad only on a TRANSPORT
 * failure, because for a TOKEN lookup an HTTP status is the host answering — a
 * 404 there is a fact about the token. For a FEED it is the opposite: a 404 is a
 * fact about the PATH, it will be 404 on the next tick and the one after, and
 * this loop would re-ask every few seconds for the life of the process. So a
 * feed that answers with an error is backed off here, where the question is
 * "does this path work", and the reason is kept so `snipe:check` and /health can
 * say WHICH pad went quiet rather than leaving it to be noticed in a month.
 */
const PAD_FEED_TRIPS = Math.max(1, Number(process.env.LAUNCHPAD_FEED_TRIPS || 3));
const PAD_SNIPE_SVM_PER_TICK = Math.max(1, Number(process.env.PAD_SNIPE_SVM_PER_TICK || 5));
const PAD_LAUNCH_MAX_AGE_MS = Math.max(60000, Number(process.env.PAD_LAUNCH_MAX_AGE_MS || 600000));
const PAD_FEED_BACKOFF_MS = Math.max(60000, Number(process.env.LAUNCHPAD_FEED_BACKOFF_MS || 600000));
const _padCursors = new Map();    // `${chain}:${pad}` → newest createdAt already seen
const _padFeedFail = new Map();   // `${chain}:${pad}` → { n, until, why }
const _padSnipeStats = { polls: 0, launchesSeen: 0, lastLaunchAt: null, lastOkAt: null, lastErr: null, lastErrAt: null, pads: {} };

function _padBenched(key, now) {
  const f = _padFeedFail.get(key);
  return (f && f.until && now < f.until) ? f : null;
}
function _padFeedNoted(key, why, now) {
  const f = _padFeedFail.get(key) || { n: 0, until: 0, why: '' };
  f.n += 1; f.why = why;
  if (f.n >= PAD_FEED_TRIPS) f.until = now + PAD_FEED_BACKOFF_MS;
  _padFeedFail.set(key, f);
}
const _padFeedOk = (key) => { if (_padFeedFail.has(key)) _padFeedFail.delete(key); };

/** New launches from every pad on `chainKey` that has a feed, newest last, with
 *  each pad's cursor advanced. Never throws: a pad being down costs that pad's
 *  launches and nothing else. */
async function _padLaunches(chainKey, now) {
  const only = launchpads.padsFor(chainKey)
    .filter((p) => p.feedPath)
    // pump.fun has its OWN loop and its OWN cursor (solSnipeCycle). Polling it
    // from here too would be two pollers, two cursors and one feed — the shape
    // of every "one repo, two answers" defect this registry exists to end.
    .filter((p) => !(chainKey === 'solana' && p.key === 'pumpfun'))
    .filter((p) => !_padBenched(chainKey + ':' + p.key, now))
    .map((p) => p.key);
  if (!only.length) return [];
  const r = await launchpads.newLaunches(chainKey, PAD_FEED_LIMIT, { only }).catch(() => null);
  if (!r) return [];
  const out = [];
  for (const key of only) {
    const sk = chainKey + ':' + key;
    const res = r.byPad[key];
    const stat = (_padSnipeStats.pads[sk] = _padSnipeStats.pads[sk] || { ok: 0, fail: 0, seen: 0, why: null, lastOkAt: null });
    if (!res || !res.ok) {
      const why = (res && res.why) || r.why || 'feed unreachable';
      stat.why = why;
      // A registry-breaker SKIP means WE never asked — the host was not given a
      // chance to answer. Counting it as a feed failure benched the pad twice
      // (once in the registry, once here, each feeding the other's counter) and
      // recorded "we did not ask" as "it did not answer" — the two facts this
      // whole module exists to keep apart.
      if (!(res && res.skipped)) {
        stat.fail++;
        _padSnipeStats.lastErr = why; _padSnipeStats.lastErrAt = now;
        _padFeedNoted(sk, why, now);
      }
      continue;
    }
    // IT ANSWERED. That is worth recording even with an empty list — "the pad
    // said nothing is launching" and "the pad did not answer" are the two facts
    // this whole registry refuses to collapse.
    _padFeedOk(sk);
    stat.ok++; stat.why = null; stat.lastOkAt = now;
    _padSnipeStats.lastOkAt = now;
    if (!res.items.length) continue;
    const newest = Math.max(0, ...res.items.map((i) => i.createdAt || 0));
    // Items with NO readable createdAt leave `newest` at 0, the cursor never
    // seeds, and the "first look seeds only" rule then holds every single
    // cycle — a pad that answers, parses, and can never fire a launch, forever,
    // while everything above records it green. That state must carry a reason
    // an operator can read, and it is a PARSE problem (a `_FEED_PATH` or field
    // mapping fix), not a host one, so it must not bench anything.
    if (!newest) { stat.why = 'items have no readable createdAt — the cursor cannot advance, so no launch here can ever fire'; continue; }
    const cursor = _padCursors.get(sk) || 0;
    if (newest) _padCursors.set(sk, Math.max(cursor, newest));
    if (!cursor) continue;   // first look seeds only
    for (const i of res.items) {
      if (!((i.createdAt || 0) > cursor)) continue;
      if (i.graduated === true) continue;   // already migrated — the DEX scan's job, not a launch
      // The pump.fun loop's age bound, applied here too: a pad coming back from
      // a ten-minute bench replays everything newer than its stale cursor, and
      // "sniping" a launch that old is buying somebody's exit.
      if (now - (i.createdAt || 0) > PAD_LAUNCH_MAX_AGE_MS) continue;
      stat.seen++;
      out.push({
        token: i.address,
        sym: i.symbol || '',
        name: i.name || '',
        // Absent or renamed → '' → simply never matches a followed dev, which
        // fails safe. Same contract as the pump.fun feed's creator field.
        creator: i.creator || '',
        createdTs: i.createdAt || 0,
        at: now,
        via: 'pad:' + i.pad,
      });
    }
  }
  out.sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0));
  return out;
}

async function padSnipeCycle() {
  const now = Date.now();
  const chains = core.chains.enabledChains().map((c) => c.key).filter((k) => launchpads.covers(k));
  if (!chains.length) return;
  _padSnipeStats.polls++;
  // Chains run CONCURRENTLY: one slow launchpad host must not delay the snipe on
  // a chain whose pads are answering fine.
  await Promise.all(chains.map(async (chainKey) => {
    const armed = _armedOn(chainKey);
    const devFollowers = launchFollowers(chainKey);
    if (!armed.length && !devFollowers.length) return;   // nobody waiting → no request at all
    let launches = [];
    try { launches = await _padLaunches(chainKey, now); }
    catch (e) { _padSnipeStats.lastErr = (e && e.message) || String(e); _padSnipeStats.lastErrAt = now; return; }
    if (!launches.length) return;
    _padSnipeStats.launchesSeen += launches.length;
    _padSnipeStats.lastLaunchAt = now;
    console.log(`[padsnipe] ${chainKey} · ${launches.length} new launch(es) · armed ${armed.length} · devFollowers ${devFollowers.length}`);
    // Per-cycle fire budget, and a much tighter one for Solana: each gated fire
    // costs one aggregator QUOTE against the same keyless host every real buy
    // needs — the caSnipeCycle split, for the same reason.
    const cap = core.chains.isSvm(chainKey) ? Math.min(DEX_SNIPE_MAX_TOKENS, PAD_SNIPE_SVM_PER_TICK) : DEX_SNIPE_MAX_TOKENS;
    let processed = 0;
    for (const L of launches) {
      if (!_snipeMark(chainKey, L.token)) continue;   // the same per-chain dedup the event scans use
      // A launch past the budget is QUEUED, never silently dropped — the pad
      // cursor has already advanced past it, so nothing else can ever offer it
      // again. It is marked first, so the DEX scan cannot buy it a second time
      // when it later graduates into a PairCreated log — and if the queue
      // cannot hold it (ring disabled), the mark comes straight back off, so
      // that same graduation log stays able to offer it.
      if (processed >= cap) { if (!_queueLaunch(chainKey, L)) _snipeUnmark(chainKey, L.token); continue; }
      processed++;
      // GATED, unlike the event scans. A pad names a token the moment it is
      // minted onto a bonding curve — usually long before anything this engine
      // can route through exists — so firing a buy at it is a guaranteed
      // failure and a "snipe failed" DM about a market that has not opened.
      // canTradeNow answers that for one cheap probe, and the retry ring holds
      // the launch until it flips.
      const r = await _fireLaunch(chainKey, L, { armed, devFollowers, gate: true }).catch(() => null);
      // Nothing held and nothing parked — every outcome was terminal, and a
      // mark with no fill behind it only suppresses the graduation buy.
      if (r && !r.held.size && !r.queued) _snipeUnmark(chainKey, L.token);
    }
  }));
}

// ------------------------------------------------------------------ orders
// Orders live ON a wallet (wallet.orders) and are tagged with walletId so a
// TP/SL/limit set on one wallet always executes on THAT wallet, even after the
// user switches their active wallet.
let _oid = 1;
const MAX_ORDERS_PER_USER = Math.max(1, Number(process.env.MAX_ORDERS_PER_USER || 25));
const ORDER_MAX_READS = Math.max(20, Number(process.env.ORDER_MAX_READS || 300));
const ORDER_CONCURRENCY = Math.max(1, Number(process.env.ORDER_CONCURRENCY || 4));
const ORDER_READ_TIMEOUT_MS = Math.max(1000, Number(process.env.ORDER_READ_TIMEOUT_MS || 3500));

// Shared bounded SNAPSHOT reader: de-dups concurrent reads (caches the in-flight
// Promise), caps total distinct reads per cycle, and hard-times-out each read — so a
// hostile/unpriceable token can neither stall a cycle nor drain the RPC. Returns the
// full snapshot (price + mcap) so orders can target either metric.
// ---------------------------------------------------------------- order execution
//
// What a triggered order is allowed to spend to actually LAND.
//
// A stop-loss fires at precisely the moment the price is falling and every other
// holder is trying to leave: the worst conditions for the default gas price and
// the default slippage there are. Auto-protect has escalated since it was
// written (gasMult 2, slipAddBps 1500) — but the stop-loss the user set BY HAND,
// the one they are relying on, went out with no escalation at all. A stop-loss
// that does not fill is not a stop-loss, it is a notification that you lost the
// money anyway.
//
// The user's own gas priority is the floor in core.buy/core.sell, so these only
// ever raise it.
const ORDER_SPEED = {
  normal: { gasMult: 1, slipAddBps: 0 },
  fast: { gasMult: 2, slipAddBps: 500 },
  turbo: { gasMult: 3, slipAddBps: 1500 },
};
// Defaults by INTENT, not one setting for all four. Getting out of a falling
// position is urgent; taking profit into a rise is not; a limit buy that misses
// its price simply waits for the next one.
const ORDER_SPEED_DEFAULT = { sl: 'turbo', trail: 'turbo', tp: 'fast', limitbuy: 'fast' };
function orderSpeed(o) { return (o && ORDER_SPEED[o.speed]) ? o.speed : (ORDER_SPEED_DEFAULT[o && o.type] || 'fast'); }
function orderExec(o) { return { ...ORDER_SPEED[orderSpeed(o)] }; }

function snapReader(label) {
  const cache = new Map(); let reads = 0, capped = 0;
  const fn = (chain, ca) => {
    const k = chain + ':' + (core.chains.isSvm(chain) ? String(ca) : String(ca).toLowerCase());
    if (cache.has(k)) return cache.get(k);
    if (reads++ >= ORDER_MAX_READS) { capped++; const p = Promise.resolve(null); cache.set(k, p); return p; }
    const p = Promise.race([
      core.tokenSnapshot(ca, chain).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ORDER_READ_TIMEOUT_MS)),
    ]);
    cache.set(k, p);
    return p;
  };
  // A cap that bites SILENTLY reads as "everything was checked and nothing
  // triggered". Say it out loud instead.
  fn.report = () => {
    if (capped) console.warn(`${label || 'snapReader'}: read budget spent — ${capped} token(s) went unpriced this cycle (ORDER_MAX_READS=${ORDER_MAX_READS})`);
    return capped;
  };
  return fn;
}

// Rotate the start of a work list each cycle.
//
// The read budget above exists to protect the RPC, and that is fair. What is not
// fair is WHICH items pay for it: users are iterated in insertion order and the
// order never changes, so once there are more tokens than budget it is the same
// tail that goes unpriced every single cycle, for ever. A stop-loss that is never
// evaluated is not a saved round trip — it is a stop-loss that does not exist,
// and the user has no way of knowing. Rotating the start means the cap costs
// everyone a little latency instead of costing a few people the feature.
let _rotSeq = 0;
function rotated(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const off = (_rotSeq++ * ORDER_MAX_READS) % items.length;
  return off ? items.slice(off).concat(items.slice(0, off)) : items;
}

function addOrder(chatId, order, walletId) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); if (!w) throw new Error('no wallet');
  // DoS guard: cap total active orders per USER (across all wallets). Without this
  // a single free account could enqueue thousands of never-triggering orders on
  // junk tokens and force the shared ordersCycle to do unbounded serial RPC reads.
  const total = core.walletList(u).reduce((n, x) => n + ((x.orders && x.orders.length) || 0), 0);
  if (total >= MAX_ORDERS_PER_USER) throw new Error(`order limit reached (${MAX_ORDERS_PER_USER}). Cancel some first.`);
  order.id = (_oid++) + Date.now().toString(36);
  order.createdAt = Date.now();
  if (!order.chain) order.chain = core.userChain(u);
  order.walletId = w.id;
  w.orders = w.orders || [];
  w.orders.push(order);
  core.saveStore();
  return order;
}
function cancelOrder(chatId, id) {
  const u = core.getUser(chatId); if (!u) return false;
  let removed = false;
  for (const w of core.walletList(u)) {
    if (!Array.isArray(w.orders)) continue;
    const before = w.orders.length;
    w.orders = w.orders.filter((o) => o.id !== id);
    if (w.orders.length !== before) removed = true;
  }
  if (removed) core.saveStore();
  return removed;
}
async function ordersCycle() {
  // Flatten every wallet's orders into work items.
  const items = [];
  for (const u of core.allUsers()) {
    for (const w of core.walletList(u)) {
      for (const o of (w.orders || [])) items.push({ u, w, o });
    }
  }
  if (!items.length) return;
  const snapOf = snapReader('orders');   // bounded, de-duped, timeout-guarded snapshot reads
  let trailDirty = false;
  // Process concurrently (bounded) so one slow trade/user can't starve the rest.
  await mapLimit(rotated(items), ORDER_CONCURRENCY, async ({ u, w, o }) => {
    if (!Array.isArray(w.orders) || !w.orders.some((x) => x.id === o.id)) return;   // already filled/cancelled
    const chain = o.chain || SNIPE_CHAIN;
    let snap;
    try { snap = await snapOf(chain, o.ca); } catch (_) { return; }
    if (!snap) return;
    const px = snap.priceEth;
    if (!(px > 0)) return;
    // tp/sl/limitbuy compare either PRICE or MARKET CAP (o.metric), both in native units.
    const val = o.metric === 'mcap' ? (snap.mcapEth || 0) : px;
    let hit = false;
    if (o.type === 'trail') {
      // Trailing stop on PRICE: track the running peak; fire when price falls trailPct
      // below it. A rising price only ratchets the peak up (never triggers).
      if (!(o.peakEth > 0) || px > o.peakEth) { o.peakEth = px; trailDirty = true; }
      hit = px <= o.peakEth * (1 - (Number(o.trailPct) || 0) / 100);
    } else if (o.type === 'tp') hit = val >= o.targetPriceEth;
    else if (o.type === 'sl') hit = val <= o.targetPriceEth;
    else if (o.type === 'limitbuy') hit = val <= o.targetPriceEth;
    if (o.metric === 'mcap' && !(val > 0)) return;   // couldn't read mcap this cycle → wait
    if (!hit) return;
    // ONE-SHOT: remove + persist SYNCHRONOUSLY before the trade, so a crash can
    // never replay this fill on restart.
    w.orders = w.orders.filter((x) => x.id !== o.id);
    core.saveStoreNow();
    try {
      // Execute on the wallet the order LIVES ON (`w` is authoritative — the order
      // was pulled from w.orders), never on whatever wallet is merely active now.
      const exec = orderExec(o);
      if (o.type === 'limitbuy') {
        const r = await core.buy(u.chatId, o.ca, o.ethAmount, chain, w.id, exec);
        _notify(u.chatId, `✅ <b>Limit buy filled</b> $${esc(r.sym)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n${txLink(chain, r.hash)}`);
      } else {
        const r = await core.sell(u.chatId, o.ca, o.sellPct || 100, chain, w.id, exec);
        const label = o.type === 'tp' ? 'Take-profit' : o.type === 'trail' ? 'Trailing stop' : 'Stop-loss';
        // NET and ROUNDED. `${r.proceedsEth}` interpolated a raw float —
        // "0.000801724630395044 ETH", eighteen decimals where five carry the
        // information — and it is the GROSS, before the bot's cut, under the
        // word "for". The trade receipts were fixed for both of these; the
        // order-fill notification, which is the only message an automatic exit
        // ever sends, was not.
        _notify(u.chatId, `✅ <b>${label} filled</b> $${esc(o.sym || '')}\nSold ${r.soldPct}%${r.soldTokens > 0 ? ` (${fmt(r.soldTokens)})` : ''} for ${_kept(r).toFixed(5)} ${r.native}\n${txLink(chain, r.hash)}`);
      }
    } catch (err) {
      _notify(u.chatId, `⚠️ Order on $${esc(o.sym || '')} triggered but failed: ${esc(err.message || String(err))}\nIt was removed — re-create it if you still want it.`);
    }
  });
  snapOf.report();
  if (trailDirty) core.saveStore();   // persist ratcheted trailing peaks (debounced)
}

// ------------------------------------------------------------------ price alerts (notify-only)
let _aid = 1;
const MAX_ALERTS_PER_USER = Math.max(1, Number(process.env.MAX_ALERTS_PER_USER || 25));
function addAlert(chatId, alert) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  u.alerts = u.alerts || [];
  if (u.alerts.length >= MAX_ALERTS_PER_USER) throw new Error(`alert limit reached (${MAX_ALERTS_PER_USER}). Cancel some first.`);
  alert.id = 'al' + (_aid++) + Date.now().toString(36);
  alert.createdAt = Date.now();
  if (!alert.chain) alert.chain = core.userChain(u);
  u.alerts.push(alert);
  core.saveStore();
  return alert;
}
function cancelAlert(chatId, id) {
  const u = core.getUser(chatId); if (!u || !Array.isArray(u.alerts)) return false;
  const before = u.alerts.length;
  u.alerts = u.alerts.filter((a) => a.id !== id);
  if (u.alerts.length !== before) { core.saveStore(); return true; }
  return false;
}
async function alertsCycle() {
  const items = [];
  for (const u of core.allUsers()) for (const a of (u.alerts || [])) items.push({ u, a });
  if (!items.length) return;
  const snapOf = snapReader('alerts');
  await mapLimit(rotated(items), ORDER_CONCURRENCY, async ({ u, a }) => {
    if (!Array.isArray(u.alerts) || !u.alerts.some((x) => x.id === a.id)) return;   // cancelled since
    const chain = a.chain || SNIPE_CHAIN;
    let snap; try { snap = await snapOf(chain, a.ca); } catch (_) { return; }
    const px = snap ? snap.priceEth : null;
    if (px == null || !(px > 0)) return;
    const hit = (a.dir === 'above' && px >= a.targetPriceEth) || (a.dir === 'below' && px <= a.targetPriceEth);
    if (!hit) return;
    // ONE-SHOT: remove + persist BEFORE notifying, so a crash can't double-fire.
    u.alerts = u.alerts.filter((x) => x.id !== a.id);
    core.saveStoreNow();
    const c = core.chainOf(chain) || { native: 'ETH', name: chain, emoji: '' };
    const wi = ((u.wallets || []).findIndex((w) => w.id === u.activeWalletId) + 1) || 1;   // active wallet (1-based), not a hardcoded #1
    const kb = { inline_keyboard: [[{ text: '📈 Trade', callback_data: `tok:${chain}:${wi}:${a.ca}` }]] };
    _notify(u.chatId, `🔔 <b>Price alert</b> — $${esc(a.sym || '')} is now <b>${a.dir === 'above' ? 'above' : 'below'}</b> your target${a.targetUsd ? ' of $' + a.targetUsd : ''} on ${c.emoji ? c.emoji + ' ' : ''}${esc(c.name || chain)}.`, kb);   // user-created one-shot signal → always deliver (never gated)
  });
  snapOf.report();
}

// ------------------------------------------------------------------ held-position alerts
// Watch every open position and ping the holder on big moves — profit milestones (2×, 5×,
// …). Uses the bot-tracked bag (p.tokens) so it's cheap; notified milestones are
// remembered per position to avoid spam. Gated by the user's 🔔 alerts toggle.
//
// There was a second alert here, "Possible rug / dump", keyed off a high-water
// mark. It is gone — see the note where it used to fire, at the foot of the
// cycle. Auto-protect below is the guard that remains, and it never used a peak.
const POS_MILESTONES = [2, 5, 10, 25, 50, 100];
// The floor under auto-protect: never force-sell a dust position. Named for the
// alert it once shared, and the env var keeps that name because an operator may
// already have set it — it gates on COST now, not on any peak.
const RUG_MIN_PEAK = Math.max(0, Number(process.env.POS_RUG_MIN_PEAK || 0.01));   // native; ignore dust positions
// Auto-protect (rug guard) — opt-in per user. Sells 100% ONLY to protect capital:
// when the bag is deep in LOSS versus your ENTRY (a dump/rug), or the contract turned
// into a honeypot / sell-tax trap. Deliberately measured against COST, not the all-time
// peak — a winner that merely retraces from its high is never force-sold.
const AUTO_PROTECT_DROP = Math.min(0.95, Math.max(0.3, Number(process.env.AUTO_PROTECT_DROP_PCT || 60) / 100));   // sell if down ≥60% on your entry
const AUTO_PROTECT_COOLDOWN_MS = 5 * 60 * 1000;   // min gap between auto-sell attempts on one bag (honeypot retry guard)
const AUTO_PROTECT_CHECK_MS = 3 * 60 * 1000;      // min gap between safety re-checks on one bag (API rate guard)
async function positionsCycle() {
  const items = [];
  for (const u of core.allUsers()) {
    const wantProtect = !!(u.settings && u.settings.autoProtect);
    // Process a user's positions if they want alerts OR have the rug guard on. (The
    // milestone/rug ALERTS self-gate on the 'alerts' toggle inside _notify; the
    // auto-protect SELL runs whenever the guard is on, and its DM is never muted.)
    if (!core.notifyOn(u.chatId, 'alerts') && !wantProtect) continue;
    for (const w of core.walletList(u)) {
      for (const key of Object.keys(w.positions || {})) {
        const p = w.positions[key];
        if (!p || p.closed || !(Number(p.ethIn) > 0)) continue;
        let heldRaw = 0n; try { heldRaw = BigInt(p.tokens || '0'); } catch (_) {}
        if (heldRaw <= 0n) continue;
        items.push({ u, w, p, heldRaw, wantProtect });
      }
    }
  }
  if (!items.length) return;
  const snapOf = snapReader('positions');
  let dirty = false;
  await mapLimit(rotated(items), ORDER_CONCURRENCY, async ({ u, w, p, heldRaw, wantProtect }) => {
    let snap; try { snap = await snapOf(p.chain, p.ca); } catch (_) { return; }
    if (!snap || !(snap.priceEth > 0)) return;
    const c = core.chainOf(p.chain) || { native: 'ETH', emoji: '' };
    const held = Number(ethers.formatUnits(heldRaw, p.dec || 18));
    const valueEth = held * snap.priceEth;
    p.notified = (p.notified && typeof p.notified === 'object') ? p.notified : {};
    // The peak is no longer tracked: the only reader was the rug alert, and a
    // value written to the store on every cycle for nobody is disk churn plus a
    // field the next person has to work out is dead. Auto-protect measures
    // against the ENTRY and never wanted it.
    const wi = (core.walletList(u).findIndex((x) => x.id === w.id) + 1) || 1;
    const kb = { inline_keyboard: [[{ text: '📈 Trade', callback_data: `tok:${p.chain}:${wi}:${p.ca}` }]] };
    // profit milestone: notify the HIGHEST newly-crossed multiple, marking all below it seen.
    const mult = (valueEth + Number(p.ethOut || 0)) / Number(p.ethIn);
    let hi = 0; for (const m of POS_MILESTONES) if (mult >= m) hi = m;
    if (hi && !p.notified['x' + hi]) {
      for (const m of POS_MILESTONES) if (m <= hi) p.notified['x' + m] = true;
      dirty = true;
      _notify(u.chatId, `🚀 <b>$${esc(p.sym || '')} is up ${hi}×</b> on your entry!\nBag ≈ <b>${valueEth.toFixed(4)} ${c.native}</b> · consider taking profit.`, kb, 'alerts');
    }
    // ── Auto-protect (rug guard): sell 100% ONLY to protect capital — when the bag is
    // deep in LOSS vs your ENTRY (a dump/rug), or the contract turned into a honeypot /
    // sell-tax trap. NOT peak-based, so a winner that retraces from its high is never
    // dumped. Best-effort — a genuine honeypot may still block the exit.
    if (wantProtect) {
      const cost = (p.costEth != null) ? Number(p.costEth) : Math.max(0, Number(p.ethIn || 0) - Number(p.ethOut || 0));
      if (cost >= RUG_MIN_PEAK) {
        const cooled = (Date.now() - (p.notified.protectAt || 0)) > AUTO_PROTECT_COOLDOWN_MS;
        const lossFrac = cost > 0 ? 1 - (valueEth / cost) : 0;
        let reason = '';
        if (lossFrac >= AUTO_PROTECT_DROP) {
          reason = `it's down ${Math.round(lossFrac * 100)}% on your entry`;
        } else if (safety.supported(p.chain) && (Date.now() - (p.notified.protectCheckAt || 0)) > AUTO_PROTECT_CHECK_MS) {
          // Re-check the CONTRACT regardless of price — a honeypot can be switched on while
          // you're still in profit. Only the unambiguous "can't sell" signals trigger a
          // sale (honeypot flag, or a sell-tax spike) — NOT broad warnings like pausable /
          // blacklist / high buy-tax, which many legitimate tokens carry.
          p.notified.protectCheckAt = Date.now(); dirty = true;
          const sec = await safety.tokenSecurity(p.chain, p.ca).catch(() => null);
          if (sec && (sec.honeypot === true || Number(sec.sellTaxPct) >= 50)) reason = 'it turned into a honeypot (you can no longer sell it normally)';
        }
        if (reason && cooled) {
          p.notified.protectAt = Date.now(); dirty = true; core.saveStoreNow();   // write-through the cooldown so a crash can't retry the sell
          try {
            const r = await core.sell(u.chatId, p.ca, 100, p.chain, w.id, { slipAddBps: 1500, gasMult: 2 });   // exit aggressively (wide slippage)
            _notify(u.chatId, `🛡 <b>Auto-protect sold $${esc(p.sym || '')}</b>\nReason: ${reason}.\nRecovered <b>${_kept(r).toFixed(5)} ${c.native}</b>.\n${txLink(p.chain, r.hash)}`);
          } catch (err) {
            _notify(u.chatId, `🛡 <b>Auto-protect couldn't exit $${esc(p.sym || '')}</b>\n${esc((err && (err.message || err)) || 'sell failed')}\nThe token may be blocking sells (honeypot). I'll try again shortly.`);
          }
          return;   // handled — skip the passive rug alert this cycle
        }
      }
    }
    // THE "Possible rug / dump" ALERT IS GONE, on the owner's call.
    //
    // It compared the bag's value against a PEAK, and a peak is not a fact about
    // the token — it is a fact about the highest number this bot happened to
    // observe. That made it wrong in both directions: it fired on a token that
    // had merely retraced from a spike, it fired on a brand-new bag whenever the
    // peak survived a previous holding (the 2026-08-16 report: "value fell to
    // 0.0131 from a peak of 0.1004", four times, on a token bought sixty seconds
    // earlier), and it stayed silent on a token that rugged before it ever had a
    // peak worth measuring. A warning that cries wolf is worse than no warning:
    // it trains the reader to swipe the next one away.
    //
    // WHAT REPLACES IT: nothing passive, deliberately. 🛡 Auto-protect above is
    // the real guard and it is untouched — it measures against YOUR ENTRY, not
    // against a high-water mark, and it acts instead of narrating. The Monitor
    // card already shows live P/L for anyone who wants to watch.
  });
  snapOf.report();
  if (dirty) core.saveStore();
}

// ------------------------------------------------------------------ copy-trading (copy-BUY only)
// Mirror a followed wallet's BUYS: watch ERC20 Transfer logs TO the target, and
// only mirror when the token came FROM its own WETH pair (i.e. a real swap-buy,
// not an airdrop/transfer). Honeypots skipped. Total spend per target is HARD-
// capped at maxEth for copy TRADES (a dev snipe is uncapped by design — see
// _followerBuy), so a mirrored bad token is bounded on the path that has a cap.
// Sells are the user's job (TP/SL/manual) — we never auto-sell someone else's exit.
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const COPY_MAX_MIRRORS_PER_CYCLE = Math.max(1, Number(process.env.COPY_MAX_MIRRORS || 5));
// How many candidate TRANSACTIONS may be probed per target per cycle. Separate
// from the mirror cap because a probe costs an RPC call whether or not it turns
// into a trade, and an address that collects dust airdrops generates them
// without limit.
const COPY_MAX_PROBES_PER_CYCLE = Math.max(1, Number(process.env.COPY_MAX_PROBES || 25));
// Stablecoins a buy can be funded with, per chain. A target who swaps USDC for a
// token spent money on it just as surely as one who spent ETH.
const STABLES = {
  ethereum: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f'],
  base: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'],
  bsc: ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x55d398326f99059ff775485246999027b3197955'],
  arbitrum: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
  robinhood: [],
};

/** Did `target` PAY for the tokens they received in `txHash`?
 *
 *  This replaces matching the Transfer's sender against getPair(token, WETH).
 *  That test only ever recognised a Uniswap V2 pool, so a target buying through
 *  V3, V4, Aerodrome, 1inch, 0x, CoW, or another Telegram bot's router was
 *  invisible — which on Ethereum and Base in 2026 is most of the volume. The
 *  bot could already ROUTE through V3; it just could not SEE anyone else do it.
 *
 *  Keyed on the money instead of on the venue: the target signed a transaction,
 *  tokens arrived, and value left. That is a buy however it was routed.
 *
 *    • native-funded — tx.from is the target and tx.value > 0
 *    • token-funded  — the receipt carries a Transfer of WETH or a stablecoin
 *                      FROM the target
 *
 *  Cheap on the common path: one getTransaction, and the receipt only when the
 *  value is zero. Returns false when it cannot tell — mirroring an airdrop
 *  spends real money on a token nobody bought. */
async function _targetPaid(chainKey, target, txHash) {
  const prov = core.providerFor(chainKey);
  const tgt = String(target).toLowerCase();
  let tx = null;
  try { tx = await prov.getTransaction(txHash); } catch (_) { return false; }
  if (!tx) return false;
  if (String(tx.from || '').toLowerCase() !== tgt) return false;   // somebody else's transaction — not their buy
  try { if (BigInt(tx.value || 0) > 0n) return true; } catch (_) {}
  // Zero value: they paid in WETH or a stablecoin, so look for it leaving them.
  const ch = core.chainOf(chainKey) || {};
  const pay = new Set([String(ch.weth || '').toLowerCase(), ...(STABLES[chainKey] || [])].filter(Boolean));
  if (!pay.size) return false;
  let rc = null;
  try { rc = await prov.getTransactionReceipt(txHash); } catch (_) { return false; }
  if (!rc || !Array.isArray(rc.logs)) return false;
  for (const l of rc.logs) {
    if (!l.topics || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    if (!pay.has(String(l.address || '').toLowerCase())) continue;
    if (('0x' + l.topics[1].slice(26)).toLowerCase() === tgt) return true;   // they sent the money
  }
  return false;
}

// ---------------------------------------------------------------- copy: exits
//
// Following a wallet IN and never OUT is half a strategy: you take all of the
// downside with none of its exit signal. This mirrors the exit.
//
// It works off the target's BALANCE, not off swap logs, and that is deliberate.
// The copy-BUY detector watches Transfers INTO the target, so it cannot see a
// sale at all — the tokens leave, and a log filtered on "to = target" never
// fires. Missing an entry costs an opportunity; missing an EXIT costs the
// position. A balance that fell is a balance that fell, whatever route it took.
//
// Cost is one balance read per copy-held token per cycle, and that set is
// bounded by the target's own budget.
const COPY_EXIT_DROP_PCT = Math.min(100, Math.max(1, Number(process.env.COPY_EXIT_DROP_PCT || 10)));

/** The target's live balance of `token`, raw. null when it could not be read —
 *  never 0, because a failed read must not look like a wallet that just sold. */
async function _targetBalance(chainKey, target, token) {
  try {
    if (core.chains.isSvm(chainKey)) {
      const { raw } = await solana.splBalance(core.providerFor(chainKey), target, token);
      return raw;
    }
    return await core.tokenBalanceOrNull(token, target, chainKey);
  } catch (_) { return null; }
}

// Give up after this many failed exit attempts and tell the user plainly. An
// exit that keeps reverting (a honeypot, a dead pool) must not be retried
// forever in silence, and must not be forgotten either.
const COPY_EXIT_MAX_TRIES = Math.max(1, Number(process.env.COPY_EXIT_MAX_TRIES || 5));
const COPY_EXIT_RETRY_MS = Math.max(5000, Number(process.env.COPY_EXIT_RETRY_MS || 60000));

/** Which of the user's wallets should sell `token`.
 *
 *  Returns { id, known }. `known:false` means we could not READ the wallets, and
 *  that is not the same answer as "nobody holds it" — collapsing the two is how
 *  a position gets silently forgotten during an RPC blip. The caller must leave
 *  an unknown on the ledger and try again; only a known answer is safe to act on.
 *
 *  An unknown answer therefore carries NO id at all. It used to fall back to the
 *  pinned wallet, which quietly undid the whole guard: every position opened by
 *  copy has a pinned wallet, so `known` was false and `id` was truthy on the
 *  exact path it was written to protect. The caller sold from a wallet the read
 *  had just failed to vouch for, got "token balance is 0" — which is on the
 *  swallow list — and dropped the position for good while another, unreadable,
 *  wallet was still holding the bag.
 *
 *  The wallet the position was opened on wins when it still holds something;
 *  otherwise we find whichever wallet does, because the user may have moved the
 *  tokens or removed that wallet. */
/** Resolve one leg's wallet from an already-fetched balances sweep.
 *
 *  ONLY the wallet this slice was opened on. There used to be a fallback to
 *  whichever wallet held the MOST of the token, for the case where the user had
 *  moved their bag — and that fallback is how a 0.01 ETH mirror could reach a
 *  20 ETH position the user opened themselves a year earlier, on a different
 *  wallet, and market-sell it. Convenience on one hand, somebody else's money
 *  on the other. */
function _exitWalletFromRows(rows, readable, preferredId) {
  if (preferredId) {
    const pin = rows.find((r) => r.id === preferredId);
    if (!pin) return { id: null, known: true };              // that wallet is gone
    if (pin.raw == null) return { id: null, known: false };    // unreadable → retry
    return { id: pin.raw > 0n ? pin.id : null, known: true };  // empty → the slice was closed by hand
  }
  // No pin at all. We cannot know which wallet this mirror traded on, and
  // guessing is precisely what the largest-holder fallback did — so there is
  // nothing to act on. A partial read is still not proof of an empty position.
  if (readable.length < rows.length) return { id: null, known: false };
  return { id: null, known: true };
}
async function _exitWalletId(chatId, token, chainKey, preferredId) {
  let rows = [];
  try { rows = await core.tokenBalancesAcross(chatId, token, chainKey); }
  catch (_) { return { id: null, known: false }; }
  const readable = rows.filter((r) => r.raw != null);
  if (!readable.length) return { id: null, known: false };   // read failed everywhere → retry
  return _exitWalletFromRows(rows, readable, preferredId);
}

// How many target-balance reads may be in flight at once. The reads used to run
// strictly one after another — one RPC round trip per held token, per cycle,
// across every user on the box. Twenty positions at ~400ms is already the whole
// 8s loop, and the loop only sleeps AFTER the cycle returns, so the exit that
// matters simply arrives later and later as the bot gets more users. They are
// independent reads; they go out together.
const COPY_EXIT_CONCURRENCY = Math.max(1, Number(process.env.COPY_EXIT_CONCURRENCY || 8));

const sym0 = (ca) => short(String(ca));
async function copyExitCycle() {
  const users = core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.length);
  // Gather everything due a check first, read all the balances together, and only
  // then act. Selling stays serial — it is the rare path, and two sells from one
  // wallet are serialized by the wallet lock anyway.
  const due = [];
  for (const u of users) {
    for (const t of u.copy.targets) {
      if (!t.copySell || !t.holding) continue;
      const ch = core.chainOf(t.chain); if (!ch) continue;
      for (const token of Object.keys(t.holding)) {
        const h = t.holding[token] || {};
        // Back off between retries so a position that cannot be sold does not
        // hammer the chain every cycle.
        if (h.tries > 0 && Date.now() - (h.lastTryAt || 0) < COPY_EXIT_RETRY_MS) continue;
        due.push({ u, t, ch, token, h, now: null });
      }
    }
  }
  if (!due.length) return;
  await mapLimit(due, COPY_EXIT_CONCURRENCY, async (d) => { d.now = await _targetBalance(d.t.chain, d.t.address, d.token); });

  for (const d of due) {
    const { u, t, ch, token, h, now } = d;
    if (!t.holding || !t.holding[token]) continue;    // ledger moved under us while the reads were in flight
    if (now == null) continue;                        // unreadable ≠ sold
    let base = 0n; try { base = BigInt(h.bal || '0'); } catch (_) { base = 0n; }
    if (!h.tries) {
      // A followed wallet holding NONE of it is an exit, and it needs no
      // baseline to be one. This used to be unreachable: a zero read fell into
      // the "no baseline yet — adopt this one" branch, copyHoldingBump refused
      // to lower a baseline, so base stayed 0 and the very same branch caught it
      // again on every cycle, for ever. A target that had already dumped by the
      // time we recorded the baseline — the fastest rug there is, and the one
      // case copy-sell exists for — parked the position permanently.
      if (now > 0n) {
        if (base <= 0n) { core.copyHoldingBump(t, token, now); continue; }   // first positive read — adopt it
        if (now > base) { core.copyHoldingBump(t, token, now); continue; }   // they bought more: raise the peak
        // "Started selling" = the peak fell by more than the trigger. A dust
        // change is not an exit, and neither is a rounding artefact.
        if ((base - now) * 100n < base * BigInt(COPY_EXIT_DROP_PCT)) continue;
      }
    }
    const dropped = base > now ? base - now : 0n;

    // Sell from the wallet that OPENED each slice, not from whatever is active
    // right now — see copyHoldingAdd. A multi-wallet fill recorded one LEG per
    // wallet ({wid, own}); a record from before legs existed is one leg.
    const legs = (Array.isArray(h.legs) && h.legs.length) ? h.legs : [{ wid: h.wid, own: h.own }];
    // Resolve EVERY leg's wallet BEFORE touching the ledger — dropping first
    // and then discovering we cannot act would forget the position outright —
    // and from ONE balances sweep: N legs must not cost N sweeps.
    // "We could not read your wallets" is not an answer, and must never be
    // acted on: selling on it lands on a wallet the read failed to vouch for,
    // throws "token balance is 0", and that message is on the swallow list
    // below — so one bad read would retire a position the user still holds.
    let rows = null;
    try { rows = await core.tokenBalancesAcross(u.chatId, token, t.chain); } catch (_) { rows = null; }
    const readable = rows ? rows.filter((r) => r.raw != null) : [];
    if (!rows || !readable.length) continue;          // read failed everywhere → retry next cycle
    const resolved = [];
    let unreadable = false;
    for (const leg of legs) {
      const wal = _exitWalletFromRows(rows, readable, leg.wid);
      if (!wal.known) { unreadable = true; break; }
      if (wal.id) resolved.push({ leg, wid: wal.id });
    }
    if (unreadable) continue;                         // leave it on the ledger, read again next cycle

    if (!resolved.length) { core.copyHoldingDrop(t, token); continue; }   // nobody holds it — already exited by hand

    const why = base > 0n
      ? `cut its bag by ~${Number((dropped * 100n) / base)}%`
      : 'holds none of it';
    let neverRecorded = false;
    let soldAny = false;
    const failedLegs = [];
    let lastErr = '';
    // LEG BY LEG, and the ledger is rewritten before each one.
    //
    // Dropping the whole record up front is right for ONE leg — a crash
    // mid-sell must not leave it eligible to be sold twice — but with several
    // legs it also discards the legs whose sells had not started, and those are
    // unambiguous: nothing was broadcast for them. So each leg is removed from
    // the record immediately BEFORE its own sell, leaving the untouched ones on
    // the ledger for the next cycle.
    let pending = resolved.map(({ leg, wid }) => ({ wid, own: String(leg.own || '') }));
    for (let i = 0; i < resolved.length; i++) {
      const { leg, wid } = resolved[i];
      // ONLY WHAT COPY BOUGHT. `own` is the raw amount this mirror actually
      // filled on THIS wallet; selling 100% closed whatever the wallet held,
      // which on a token the user also owns is their money, not copy's.
      let own = 0n; try { own = BigInt(leg.own || '0'); } catch (_) { own = 0n; }
      pending = pending.slice(1);
      if (own <= 0n) { neverRecorded = true; continue; }
      // This leg is off the ledger for the duration of its own sell; the rest
      // stay on it, so a crash here strands nothing that was never attempted.
      if (pending.length) core.copyHoldingSet(t, token, { ...h, bal: String(base), own: pending[0].own, wid: pending[0].wid, legs: pending });
      else core.copyHoldingDrop(t, token);
      try {
        const r = await core.sell(u.chatId, token, 100, t.chain, wid, { exactTokens: own.toString() });
        soldAny = true;
        _notify(u.chatId,
          `👥 <b>Copy-sell</b> $${esc(r.sym)} on ${ch.emoji} ${esc(ch.name)}\n` +
          `<code>${short(t.address)}</code> ${why} — you exited <b>100%</b>\n` +
          `Received ${_kept(r).toFixed(5)} ${r.native}\n<code>${token}</code>\n${txLink(t.chain, r.hash)}`,
          undefined, 'copy');
      } catch (err) {
        const msg = String((err && err.message) || err);
        // Already empty is not a failure — the user got out by hand.
        if (/token balance is 0|no wallet/i.test(msg)) continue;
        // A BROADCAST sell is never retried, for the reason the buy path
        // already keeps: the transaction may still land, and a retry would sell
        // the same slice twice. Say it and let it go.
        if (err && err.broadcast) {
          soldAny = true;
          _notify(u.chatId,
            `👥 <b>Copy-sell sent</b> on <code>${short(token)}</code> — broadcast but not confirmed yet.\n` +
            `<i>Not retried: it may still land. Check your wallet before selling by hand.</i>`,
            undefined, 'copy');
          continue;
        }
        failedLegs.push({ wid, own: own.toString() });
        lastErr = msg;
      }
    }
    if (neverRecorded) {
      // A fill that was never recorded — a mirror whose buy was broadcast but
      // never confirmed, or a position from before this was tracked. We do not
      // know which part of that bag is ours, so we do not guess with it. On a
      // MIXED record other legs did sell, so the sentence may not claim that
      // nothing moved: two adjacent messages contradicting each other about
      // whether the user is out is worse than either one alone.
      _notify(u.chatId,
        `👥 <b>Copy-sell skipped</b>${soldAny ? ' (one wallet)' : ''} — <code>${short(t.address)}</code> is selling $${esc(sym0(token))}, but I never recorded how much of your bag this mirror filled${soldAny ? ' on that wallet' : ''}.\n` +
        `${soldAny ? '<b>That wallet was not sold.</b>' : '<b>Nothing was sold.</b>'} Close it yourself if you want out: /monitor`,
        undefined, 'copy');
    }
    if (failedLegs.length) {
      const tries = core.copyHoldingRetry(t, token, { ...h, bal: String(base), own: failedLegs[0].own, wid: failedLegs[0].wid, legs: failedLegs });
      if (tries >= COPY_EXIT_MAX_TRIES) {
        core.copyHoldingDrop(t, token);
        _notify(u.chatId,
          `🔻 <b>Copy-sell gave up</b> on <code>${short(token)}</code> after ${tries} attempts\n` +
          `Last error: ${esc(lastErr)}\n<b>You still hold this — sell it yourself if you want out.</b>`,
          undefined, 'copy');
      } else {
        const now2 = Date.now(), key = u.chatId + ':copysell:' + token;
        if (now2 - (_snipeFailAt.get(key) || 0) > 300000) {
          _snipeFailAt.set(key, now2);
          _notify(u.chatId, `⚠️ Copy-sell of ${short(token)} failed (attempt ${tries}/${COPY_EXIT_MAX_TRIES}): ${esc(lastErr)} — retrying (muted 5 min)`, undefined, 'copy');
        }
      }
    }
  }
}

async function copyCycle() {
  const users = core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.length);
  if (!users.length) return;
  for (const u of users) {
    for (const t of u.copy.targets) {
      if (t.mode === 'launches') continue;   // dev-wallet snipe is driven by the snipe cycles, not swap-buy logs
      const ch = core.chainOf(t.chain); if (!ch) continue;
      // Solana copy-buy uses signature polling (no EVM logs) — dedicated path.
      if (core.chains.isSvm(t.chain)) { await _copySolTarget(u, t).catch((e) => console.error('copysol', (e && e.message) || e)); continue; }
      const prov = core.providerFor(t.chain);
      let head; try { head = await prov.getBlockNumber(); } catch (_) { continue; }
      if (!t.cursor || head < t.cursor) { t.cursor = head; core.saveStore(); continue; }   // pin near head first pass
      const from = Math.max(t.cursor + 1, head - SNIPE_MAX_SPAN);
      if (from > head) { t.cursor = head; continue; }
      let logs = [];
      try { logs = await prov.getLogs({ fromBlock: from, toBlock: head, topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(t.address.toLowerCase(), 32)] }); }
      catch (e) { if (_isRangeError(e)) { t.cursor = head; core.saveStore(); }  continue; }   // range too wide → skip forward (don't livelock); else keep cursor, retry
      t.cursor = head;

      // GROUP BY TRANSACTION, and reduce each to the token that was BOUGHT.
      //
      // Three things go wrong reading the log list straight:
      //
      //  1. ERC-721 shares the ERC-20 Transfer signature hash and differs only
      //     in indexing the token id as a FOURTH topic. An NFT mint paid for in
      //     ETH is therefore a Transfer to the target in a transaction they
      //     signed and sent value with — indistinguishable from a token buy, and
      //     it would spend real money calling swap on an NFT contract. The old
      //     V2-pair test excluded these by accident (getPair on an NFT returns
      //     the zero address); nothing excluded them once that test went.
      //
      //  2. One transaction can deliver SEVERAL different tokens — the marketing
      //     or scam pattern where buying X also airdrops Y to the buyer. Mirrored
      //     blind, the bot buys Y too, on the strength of somebody else's token
      //     contract. When more than one non-money token arrives we cannot tell
      //     which was bought, so we buy neither.
      //
      //  3. Probing per LOG rather than per TRANSACTION meant a reflection token
      //     (several Transfers per swap) cost several getTransaction calls for
      //     one trade.
      const money = new Set([String(ch.weth || '').toLowerCase(), ...(STABLES[t.chain] || [])].filter(Boolean));
      const byTx = new Map();
      for (const log of logs) {
        if (!log.topics || log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) continue;   // ERC-20 only
        const token = String(log.address || '').toLowerCase();
        const hash = log.transactionHash;
        if (!token || !hash || money.has(token)) continue;
        let set = byTx.get(hash); if (!set) { set = new Set(); byTx.set(hash, set); }
        set.add(token);
      }

      // WHEN THE CAPS BITE, DROP THE OLDEST — never the newest.
      //
      // t.cursor is already at head by this point, so anything the caps stop us
      // reaching is gone rather than deferred. Walking oldest-first therefore
      // spent the whole budget on the stalest candidates and discarded the
      // freshest: on a busy wallet the bot would mirror what it did four minutes
      // ago and silently miss what it did four seconds ago, which is the exact
      // inversion of what copy-trading is for.
      //
      // Deferring instead (rewinding the cursor) livelocks: an address spammed
      // with dust airdrops regenerates more candidates than the cap every cycle
      // and would pin the scan to the same stale window for ever.
      const entries = [...byTx.entries()];
      const room = COPY_MAX_PROBES_PER_CYCLE;
      if (entries.length > room) {
        // Never silently. A cap that drops work reads as "nothing happened".
        console.warn(`copy: ${entries.length - room} older candidate tx skipped for ${short(t.address)} on ${t.chain} (COPY_MAX_PROBES=${room})`);
      }
      // Newest FIRST, not merely newest-selected. Taking the last `room` entries
      // and then walking them in chronological order let the mirror cap (which
      // stops after 5 BUYS) consume the oldest of the survivors and drop the
      // rest — so the freshest trade was still the one lost.
      let mirrors = 0, probes = 0;
      for (const [hash, tokens] of entries.slice(-room).reverse()) {
        if (mirrors >= COPY_MAX_MIRRORS_PER_CYCLE) break;
        // Bound the RPC too, not only the buys. A wallet that collects dust
        // airdrops produces candidate transactions without limit, and every one
        // of them used to cost a getTransaction whether or not it could ever
        // become a trade.
        if (probes >= COPY_MAX_PROBES_PER_CYCLE) break;
        if (tokens.size !== 1) continue;                                   // ambiguous — see (2)
        const token = tokens.values().next().value;
        if (t.bought && t.bought[token]) continue;                         // already mirrored this token
        if (Number(t.spentEth) + Number(t.buyEth) > Number(t.maxEth) + 1e-12) continue;   // budget cap
        // Was this a BUY, or did the tokens simply arrive? Keyed on the target
        // having PAID — not on which pool the sender happens to be.
        probes++;
        if (!(await _targetPaid(t.chain, t.address, hash))) continue;
        // Skip anything GoPlus flags as DANGER (honeypot/pausable/owner-rug/high-tax…);
        // when GoPlus has no data we still mirror — worst-case loss stays bounded by maxEth.
        if (safety.supported(t.chain)) { const s = await safety.tokenSecurity(t.chain, token).catch(() => null); if (s && safety.verdict(t.chain, s).level === 'danger') continue; }
        // Commit budget + dedup BEFORE spending (crash-safe: no double-mirror, budget can't be exceeded on restart).
        t.bought = t.bought || {};
        const boughtKeys = Object.keys(t.bought);
        if (boughtKeys.length >= 2000) delete t.bought[boughtKeys[0]];   // hard cap the dedup map (drop oldest)
        t.bought[token] = true;
        t.spentEth = Number(t.spentEth) + Number(t.buyEth);
        core.saveStoreNow();
        mirrors++;
        // Decide the wallet HERE and pass it explicitly, so the exit can sell
        // from the same one. Left implicit, both the buy and the sell would
        // each land on whatever wallet happened to be active at that moment.
        const wid = (core.activeWallet(u) || {}).id || undefined;
        try {
          const r = await core.buy(u.chatId, token, t.buyEth, t.chain, wid);
          // Record what the TARGET holds now — the baseline the exit watcher
          // measures against. Only tokens entered through copy are ever exited
          // through copy; a bag the user bought themselves is not copy's to sell.
          core.copyHoldingAdd(t, token, await _targetBalance(t.chain, t.address, token), wid, r.gotRaw);
          _notify(u.chatId, `👥 <b>Copy-buy</b> $${esc(r.sym)} on ${ch.emoji} ${esc(ch.name)}\nFollowed <code>${short(t.address)}</code> · ${r.spentEth} ${r.native}${t.copySell ? ' · <i>exit mirrored</i>' : ''}\n<code>${token}</code>\n${txLink(t.chain, r.hash)}`, undefined, 'copy');
        } catch (err) {
          // Only give the budget/dedup back when the buy CLEARLY didn't spend. If the tx
          // was broadcast but couldn't be confirmed (err.broadcast), it may still land —
          // keep the commit so we never double-spend the budget on the next cycle.
          if (!err || !err.broadcast) {
            t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth));   // buy didn't spend → give the budget back
            delete t.bought[token];                                            // and forget it (nothing bought → no dedup leak)
            core.saveStoreNow();
          } else {
            // Broadcast but unconfirmed: the budget stays committed because the
            // tx may still land — so the POSITION has to be tracked on the same
            // terms. Leaving it off the ledger made a fill we had already paid
            // for the one bag copy would never watch leave. If the tx never
            // lands, the exit cycle reads a clean zero across every wallet and
            // retires the entry by itself. The FILL is unknown here — the buy
            // threw, so there is no result to read it from.
            core.copyHoldingAdd(t, token, await _targetBalance(t.chain, t.address, token), wid);
          }
          const now = Date.now(), key = u.chatId + ':copy:' + token;
          if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ Copy-buy of ${short(token)} failed: ${esc(err.message || String(err))} (muted 5 min)`, undefined, 'copy'); }
        }
      }
    }
    core.saveStore();
  }
}

// ------------------------------------------------------------------ Solana copy-buy
// Mirror a followed SOLANA wallet's BUYS. We can't watch ERC20 logs, so we poll the
// target's recent signatures, parse each tx, and mirror when the target's SPL balance
// INCREASED while its SOL balance DROPPED (a real SOL-funded swap-buy, not an airdrop
// or a transfer-in). Same crash-safe budget/dedup commit as the EVM path; sells stay
// the user's job. Stablecoins + WSOL are ignored.
const COPY_SOL_SIG_LIMIT = Math.max(5, Number(process.env.COPY_SOL_SIG_LIMIT || 25));
// The target must have spent MORE SOL than mere fees + a new token-account rent
// (~0.00204 SOL) for a token increase to count as a real SOL-funded BUY. Below this we
// treat it as an airdrop / token→token swap / claim (target signed & paid only rent) and
// do NOT mirror. 0.005 SOL cleanly clears rent+priority-fees while still catching any
// meaningful buy. Override via COPY_SOL_MIN_SPEND_LAMPORTS.
const COPY_SOL_MIN_SPEND = BigInt(process.env.COPY_SOL_MIN_SPEND_LAMPORTS || 5000000);
// Minimum QUOTE-asset spend (USDC/USDT are 6-decimal, WSOL 9) for a token-funded
// buy to count. Without a floor, one raw unit ticking down anywhere was proof of
// payment — which is how an LP withdrawal read as a purchase.
const SOL_QUOTE_MIN_SPEND = BigInt(process.env.COPY_SOL_MIN_QUOTE || 1000000);
const _solStable = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KConky11Mc6mzwtQKPa',    // USDT
  solana.WSOL_MINT,
]);
// The mint the target BOUGHT in tx `sig` (largest SPL increase for the target owner),
// but only if the target also spent SOL. null when it's not a SOL-funded buy.
async function _solBuyMintFromTx(conn, sig, targetAddr) {
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx || !tx.meta) return null;

  // DID THE TARGET SIGN THIS?
  //
  // getSignaturesForAddress returns every transaction that so much as MENTIONS
  // the address — including one a stranger built, which is enough to hand an
  // attacker the bot's wallet: airdrop a scam mint to a followed wallet, arrange
  // for something of theirs to tick down, and every follower buys it. The EVM
  // side has refused anything where tx.from is not the target since the rewrite;
  // Solana had no equivalent check at all.
  const keys = tx.transaction.message.accountKeys || [];
  const keyOf = (k) => (k && (k.pubkey ? k.pubkey.toString() : String(k))) || '';
  let idx = -1, signed = false;
  for (let i = 0; i < keys.length; i++) {
    if (keyOf(keys[i]) !== targetAddr) continue;
    idx = i;
    // A parsed account key carries `signer`. When the RPC omits it, index 0 is
    // the fee payer by construction — fail closed on anything else.
    signed = keys[i] && typeof keys[i].signer === 'boolean' ? keys[i].signer : i === 0;
    break;
  }
  if (!signed) return null;

  const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
  // Pre balances for the target owner, keyed by TOKEN ACCOUNT rather than mint:
  // a wallet can hold one mint in two accounts, and keying by mint let the last
  // entry overwrite the first while the post lookup found the other one — which
  // reads a flat balance as a spend.
  const acctKey = (b) => `${b.accountIndex != null ? b.accountIndex : keyOf(keys[b.accountIndex])}|${b.mint}`;
  const preAcct = new Map(), preByMint = new Map();
  for (const b of pre) {
    if (!b || b.owner !== targetAddr || !b.uiTokenAmount) continue;
    let v = 0n; try { v = BigInt(b.uiTokenAmount.amount); } catch (_) { continue; }
    preAcct.set(acctKey(b), v);
    preByMint.set(b.mint, (preByMint.get(b.mint) || 0n) + v);
  }
  const postByMint = new Map();
  for (const b of post) {
    if (!b || b.owner !== targetAddr || !b.uiTokenAmount) continue;
    let v = 0n; try { v = BigInt(b.uiTokenAmount.amount); } catch (_) { continue; }
    postByMint.set(b.mint, (postByMint.get(b.mint) || 0n) + v);
  }

  // Which mints GREW, net across every account the target holds them in.
  const decOf = new Map();
  for (const b of post.concat(pre)) { if (b && b.uiTokenAmount && !decOf.has(b.mint)) decOf.set(b.mint, Number(b.uiTokenAmount.decimals) || 0); }
  const gained = [];
  for (const [mint, now] of postByMint) {
    const delta = now - (preByMint.get(mint) || 0n);
    if (delta > 0n && !_solStable.has(mint)) gained.push({ mint, delta, dec: decOf.get(mint) || 0 });
  }
  if (!gained.length) return null;
  // MORE THAN ONE non-money mint arrived: the marketing and scam pattern where
  // buying X also drops Y on the buyer. Picking the largest was ranking by unit
  // COUNT, which is supply and not value — a scam mint issuing ten million units
  // outranks a real 1,200-unit acquisition every time. The EVM path refuses this
  // ambiguity outright; so does this one now.
  if (gained.length > 1) return null;
  const boughtMint = gained[0].mint;

  // Did they PAY? Two ways, and both have to be a real spend rather than any
  // balance ticking down.
  if (idx >= 0 && Array.isArray(tx.meta.preBalances) && Array.isArray(tx.meta.postBalances)) {
    let solDelta = 0n;
    try { solDelta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]); } catch (_) { solDelta = 0n; }
    if (solDelta < -COPY_SOL_MIN_SPEND) return boughtMint;   // SOL-funded buy
  }
  // Token-funded — but ONLY in a quote asset. "Any token of theirs fell" turned
  // every position-REDUCING transaction into a buy: withdrawing an LP position
  // burns the receipt token and credits two mints, unstaking returns the staked
  // asset, and closing an ATA makes the mint vanish from postTokenBalances
  // entirely, which read as a decrease to zero. In each of those the target
  // acquired nothing — they exited — and the bot bought.
  for (const mint of _solStable) {
    const before = preByMint.get(mint) || 0n;
    if (before <= 0n) continue;
    const now = postByMint.get(mint) || 0n;
    if (before - now >= SOL_QUOTE_MIN_SPEND) return boughtMint;   // they paid, in money
  }
  // Nothing left them. FAIL CLOSED: tokens that merely arrived are an airdrop,
  // and mirroring one spends real money on something nobody bought.
  return null;
}
async function _copySolTarget(u, t) {
  const conn = core.providerFor(t.chain);
  const { PublicKey } = require('@solana/web3.js');
  let sigs;
  try { sigs = await conn.getSignaturesForAddress(new PublicKey(t.address), { limit: COPY_SOL_SIG_LIMIT }); } catch (_) { return; }
  if (!Array.isArray(sigs) || !sigs.length) return;
  if (!t.cursorSig) { t.cursorSig = sigs[0].signature; core.saveStore(); return; }   // pin near head first pass
  let fresh = [];
  for (const s of sigs) { if (s.signature === t.cursorSig) break; if (!s.err) fresh.push(s.signature); }
  t.cursorSig = sigs[0].signature; core.saveStore();   // advance to head regardless
  if (!fresh.length) return;
  // Same rule as the EVM side: cursorSig is already at head, so whatever the
  // mirror cap stops us reaching is gone. Keep the NEWEST, drop the oldest.
  if (fresh.length > COPY_MAX_MIRRORS_PER_CYCLE) {
    console.warn(`copysol: ${fresh.length - COPY_MAX_MIRRORS_PER_CYCLE} older signatures skipped for ${short(t.address)} (COPY_MAX_MIRRORS=${COPY_MAX_MIRRORS_PER_CYCLE})`);
    fresh = fresh.slice(0, COPY_MAX_MIRRORS_PER_CYCLE);   // fresh is newest-first here
  }
  fresh.reverse();   // oldest-first → mirror in the target's order
  let mirrors = 0;
  for (const sig of fresh) {
    if (mirrors >= COPY_MAX_MIRRORS_PER_CYCLE) break;
    let mint; try { mint = await _solBuyMintFromTx(conn, sig, t.address); } catch (_) { continue; }
    if (!mint || _solStable.has(mint)) continue;
    if (t.bought && t.bought[mint]) continue;
    if (Number(t.spentEth) + Number(t.buyEth) > Number(t.maxEth) + 1e-12) continue;   // budget cap
    if (safety.supported(t.chain)) { const s = await safety.tokenSecurity(t.chain, mint).catch(() => null); if (s && safety.verdict(t.chain, s).level === 'danger') continue; }
    // Commit budget + dedup BEFORE spending (crash-safe).
    t.bought = t.bought || {};
    const bk = Object.keys(t.bought); if (bk.length >= 2000) delete t.bought[bk[0]];
    t.bought[mint] = true;
    t.spentEth = Number(t.spentEth) + Number(t.buyEth);
    core.saveStoreNow();
    mirrors++;
    const swid = (core.activeWallet(u) || {}).id || undefined;
    try {
      const r = await core.buy(u.chatId, mint, t.buyEth, t.chain, swid);
      core.copyHoldingAdd(t, mint, await _targetBalance(t.chain, t.address, mint), swid, r.gotRaw);
      _notify(u.chatId, `👥 <b>Copy-buy</b> $${esc(r.sym)} on 🟣 Solana\nFollowed <code>${short(t.address)}</code> · ${r.spentEth} ${r.native}${t.copySell ? ' · <i>exit mirrored</i>' : ''}\n<code>${mint}</code>\n${txLink(t.chain, r.hash)}`, undefined, 'copy');
    } catch (err) {
      if (!err || !err.broadcast) { t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth)); delete t.bought[mint]; core.saveStoreNow(); }
      else core.copyHoldingAdd(t, mint, await _targetBalance(t.chain, t.address, mint), swid);   // budget held → track it, but the FILL is unknown
      const now = Date.now(), key = u.chatId + ':copysol:' + mint;
      if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ Copy-buy of ${short(mint)} failed: ${esc(err.message || String(err))} (muted 5 min)`, undefined, 'copy'); }
    }
  }
}

// ------------------------------------------------------------------ Solana snipe (new pump.fun launches)
// New-launch auto-buy on Solana. Discovery is pump.fun's new-coins feed (the canonical
// launchpad); the actual buy goes through Jupiter, so a token that isn't routable yet
// (still on the raw bonding curve) is skipped quietly and retried while it's fresh.
// RugCheck DANGER-flagged tokens are skipped; brand-new ones usually aren't indexed yet
// (gate fails open, like the EVM snipe). Best-effort — first-second curve sniping would
// need a pump.fun program integration (future add-on).
let _solSnipeCursorTs = 0;
const SOL_SNIPE_MAX_AGE_MS = Math.max(60000, Number(process.env.SOL_SNIPE_MAX_AGE_MS || 600000));   // ignore launches older than 10 min

async function solSnipeCycle() {
  if (!core.chains.isEnabled('solana')) return;
  const armed = _armedOn('solana');
  const devFollowers = launchFollowers('solana');   // users sniping specific dev wallets on Solana
  if (!armed.length && !devFollowers.length) return;
  // A FEED THAT DID NOT ANSWER IS NOT A QUIET LAUNCHPAD.
  //
  // This used to be `pumpfunNew()`, which returned [] for both, and the early
  // `return` below counted as a SUCCESSFUL tick — so /health printed a green
  // solSnipe while discovery had been blind for days. The same rule the EVM
  // snipe loop has carried since it was written ("a loop that RAN is not a loop
  // that WORKS"), finally applied to its Solana twin.
  const feed = await solana.pumpfunNewX(50);
  _solSnipeStats.polls++;
  if (!feed.ok) { _solSnipeStats.lastErr = feed.why || 'feed unreachable'; _solSnipeStats.lastErrAt = Date.now(); throw new Error('pump.fun feed: ' + _solSnipeStats.lastErr); }
  _solSnipeStats.lastFeedOkAt = Date.now();
  const coins = feed.coins;
  // pump.fun ONLY. Every other Solana pad is polled by padSnipeCycle, which
  // carries a cursor per pad — letting another pad's timestamps advance THIS
  // cursor is how one pad reporting a bad clock takes the pump.fun snipe
  // offline permanently, silently, because a cursor parked ahead of the feed is
  // indistinguishable from a quiet launchpad.
  const seenNow = coins.length;
  if (seenNow) { _solSnipeStats.launchesSeen += seenNow; _solSnipeStats.lastLaunchAt = Date.now(); }
  if (!seenNow) return;
  const newestTs = Math.max(0, ...coins.map((c) => c.createdTs || 0));
  if (!_solSnipeCursorTs && newestTs) { _solSnipeCursorTs = newestTs; return; }   // pin near head first pass (no startup flood)
  const now = Date.now();
  const fresh = coins
    .filter((c) => c.createdTs > _solSnipeCursorTs)
    .filter((c) => (now - c.createdTs) < SOL_SNIPE_MAX_AGE_MS)
    .sort((a, b) => a.createdTs - b.createdTs);
  if (newestTs) _solSnipeCursorTs = Math.max(_solSnipeCursorTs, newestTs);
  let processed = 0;
  for (const c of fresh) {
    // ONE dedup per chain, shared with the launchpad feeds. This used to be a
    // private `_solSnipeSeen`, which was fine while pump.fun was the only Solana
    // source; the moment a second feed can name the same mint, two seen-sets
    // means two buys of one launch for one user. A re-sighted mint (a pad feed
    // saw it first) still serves DEV followers — the _dexSnipeChain shape.
    const firstSee = _snipeMark('solana', c.mint);
    if (!firstSee && !devFollowers.length) continue;
    const L = { token: c.mint, sym: c.symbol || '', creator: c.creator || '', at: Date.now(), via: 'pump.fun' };
    if (firstSee) {
      // Past the per-cycle budget, a launch is QUEUED, never dropped — the
      // cursor has already advanced past it, so nothing else can ever offer it
      // again. The exact defect padSnipeCycle was fixed for, one loop up.
      if (processed >= DEX_SNIPE_MAX_TOKENS) {
        if (!_queueLaunch('solana', L)) _snipeUnmark('solana', c.mint);
        continue;
      }
      processed++;
    }
    // A fresh mint is routinely not on Jupiter yet — that is the NORMAL first
    // answer here, not a failure — so a buy that finds no route parks in the
    // retry ring and is re-offered the moment a route exists. The old code
    // swallowed that error with a comment claiming it would "retry while it's
    // fresh"; the cursor and the seen-set had both already moved past it, so
    // nothing could ever offer it again.
    await _fireLaunch('solana', L, { armed: firstSee ? armed : [], devFollowers, skip: firstSee ? null : new Set(armed.map((u) => u.chatId)) });
  }
}

// ------------------------------------------------------------------ snipe by CA
/*
 * "Buy THIS contract the moment it can be bought."
 *
 * The two snipes above answer a different question — every new launch on a
 * chain, or whatever a followed dev launches. Neither can express the most
 * common request there is: somebody has the contract address before the pool
 * opens and wants to be in the first block that has one.
 *
 * The loop is a poll and not an event subscription on purpose. "Tradeable" is
 * not one event: it is a V2 pair gaining a reserve, or a V3 pool being
 * initialised, or a v4 pool appearing inside a singleton with no pair contract
 * at all, or an aggregator finally routing a Solana mint. core.canTradeNow is
 * the single owner of that question; this only decides how often to ask.
 */
const CA_SNIPE_POLL_MS = Math.max(2000, Number(process.env.CA_SNIPE_POLL_MS || 4000));
// How many armed targets are probed per tick, across all users. A probe is one
// to three RPC reads, so an unbounded fan-out over every armed target on every
// tick is a self-inflicted rate limit — and the RPC it would exhaust is the same
// one the buy needs a second later.
const CA_SNIPE_MAX_PROBES = Math.max(1, Number(process.env.CA_SNIPE_MAX_PROBES || 24));
const CA_SNIPE_CONCURRENCY = Math.max(1, Number(process.env.CA_SNIPE_CONCURRENCY || 6));
/*
 * A SEPARATE, MUCH TIGHTER BUDGET FOR SOLANA.
 *
 * Every other chain's probe is an RPC read against a node this bot already
 * hammers. Solana's is an aggregator QUOTE — against the same keyless host that
 * prices and builds every real buy. At the shared budget above this loop alone
 * would issue several quotes a second, get itself rate-limited, and then two
 * things fail at once: the snipe never fires, and ordinary trading starts
 * failing too.
 *
 * Worse, it would fail INVISIBLY. canTradeNow returns a boolean, so a throttled
 * probe and "no pool yet" are the same `false` — the exact shape of the pump.fun
 * outage that sat behind a green health tick for days. The fix is to not
 * generate the load: bound the quotes, and dedupe them.
 */
const CA_SNIPE_SVM_PER_TICK = Math.max(1, Number(process.env.CA_SNIPE_SVM_PER_TICK || 4));
const _caSnipeStats = { polls: 0, probes: 0, armed: 0, contracts: 0, fired: 0, lastFiredAt: null, lastErr: null, lastErrAt: null };

/** Round-robin cursor over armed targets, so target 25 is not starved by 1–24. */
let _caSnipeCursor = 0;

async function caSnipeCycle() {
  const now = Date.now();
  // Expire first, so an abandoned address stops costing RPC the moment it is
  // stale rather than the next time somebody happens to look at the list.
  const jobs = [];
  for (const u of core.allUsers()) {
    for (const t of core.snipeTargets(u)) {
      if (t.status !== 'armed') continue;
      if (t.expiresAt && t.expiresAt <= now) {
        core.expireSnipeTarget(u, t.id);
        _notify(u.chatId, `⌛ <b>Snipe expired</b> · ${esc(chainName(t.chain))}\n<code>${t.ca}</code>\nIt never became tradeable within the window. Re-arm it if the launch is still coming.`, undefined, 'snipe');
        continue;
      }
      if (!core.chains.isEnabled(t.chain)) continue;   // chain turned off under it — leave armed, do not fire
      jobs.push({ u, t });
    }
  }
  _caSnipeStats.polls++;
  _caSnipeStats.armed = jobs.length;
  if (!jobs.length) return;

  // ONE PROBE PER CONTRACT, not per target.
  //
  // "Is this contract tradeable yet" is a fact about the chain, not about the
  // user — so fifty people sniping the same launch is one question asked once.
  // Probing per target made the busiest case (everyone armed on the same hot
  // address) the most expensive one, which is exactly backwards, and on Solana
  // it multiplied a rate-limited aggregator call by the number of subscribers.
  const byKey = new Map();
  for (const j of jobs) {
    const svm = core.chains.isSvm(j.t.chain);
    const key = j.t.chain + ':' + (svm ? j.t.ca : String(j.t.ca).toLowerCase());
    const g = byKey.get(key) || { chain: j.t.chain, ca: j.t.ca, svm, jobs: [] };
    g.jobs.push(j);
    byKey.set(key, g);
  }
  const groups = [...byKey.values()];
  _caSnipeStats.contracts = groups.length;

  // A window over the ring, so contract 25 is not starved by 1–24 no matter how
  // many are armed. Solana groups draw from their own, much smaller budget.
  const slice = [];
  let svmLeft = CA_SNIPE_SVM_PER_TICK;
  for (let i = 0; i < groups.length && slice.length < CA_SNIPE_MAX_PROBES; i++) {
    const g = groups[(_caSnipeCursor + i) % groups.length];
    if (g.svm) { if (svmLeft <= 0) continue; svmLeft--; }
    slice.push(g);
  }
  // Advance by the WINDOW, not by what was taken: skipping a Solana group over
  // budget must still move the cursor past it, or the same over-budget groups
  // are reconsidered first every tick and the ones behind them never come up.
  _caSnipeCursor = groups.length ? (_caSnipeCursor + Math.min(groups.length, CA_SNIPE_MAX_PROBES)) % groups.length : 0;

  await mapLimit(slice, CA_SNIPE_CONCURRENCY, async (g) => {
    let ready = false;
    try { ready = await core.canTradeNow(g.ca, g.chain); }
    catch (_) { return; }   // an unreadable chain is not a launch; try again next tick
    _caSnipeStats.probes++;
    for (const { t } of g.jobs) t.checks = (Number(t.checks) || 0) + 1;
    if (!ready) return;
    // Everyone armed on this contract fires, in parallel — they are separate
    // wallets making separate trades, and serialising them would hand the first
    // block to whoever happened to be first in the list.
    await mapLimit(g.jobs, CA_SNIPE_CONCURRENCY, async ({ u, t }) => {
      // CLAIMED BEFORE THE BUY, and persisted synchronously. This poll runs
      // every few seconds; a target left `armed` while its buy is in flight is
      // picked up again by the very next tick and bought twice. A missed snipe
      // is a shrug — spending twice is not.
      if (!core.claimSnipeTarget(u, t.id)) return;
      await _fireCaSnipe(u, t);
    });
  });
}

async function _fireCaSnipe(u, t) {
  const ch = core.chainOf(t.chain) || { emoji: '', name: t.chain, native: 'ETH' };
  // The safety gate the other snipes already keep: a DANGER verdict is skipped,
  // and no verdict at all is not a veto — a token that has existed for one block
  // has no verdict yet, and refusing those would refuse every snipe.
  try {
    if (safety.supported(t.chain)) {
      const s = await safety.tokenSecurity(t.chain, t.ca).catch(() => null);
      if (s && safety.verdict(t.chain, s).level === 'danger') {
        core.settleSnipeTarget(u, t.id, { ok: false, err: 'blocked by the safety check' });
        _notify(u.chatId, `🛡 <b>Snipe blocked</b> · ${esc(ch.name)}\n<code>${t.ca}</code>\nIt became tradeable, and the safety check flagged it as high risk — nothing was bought.`, undefined, 'snipe');
        return;
      }
    }
  } catch (_) { /* an unreadable safety check is not a veto */ }
  // The wallet SELECTION: '*' = every wallet, resolved at FIRE time so a
  // wallet added after arming still snipes; walletIds = the subset picked on
  // the panel (deleted wallets dropped); walletId = one. The amount is PER
  // WALLET — the armed message said so. Wallets buy in parallel: they are
  // separate trades from separate addresses, and serialising them would hand
  // the first block to whoever is first in the list.
  const wl = core.walletList(u);
  const wids = t.walletId === '*'
    ? wl.map((w) => w.id)
    : Array.isArray(t.walletIds) && t.walletIds.length
      ? t.walletIds.filter((id) => wl.some((w) => w.id === id))
      : [t.walletId];
  if (!wids.length) {
    // '*' resolves against the CURRENT wallet list, and the documented promise
    // is that a wallet added after arming still snipes — so an empty list there
    // is a transient state, and disarming would break that promise. A named
    // selection whose wallets are all gone cannot come back: that one is
    // settled, with a reason.
    if (t.walletId === '*') {
      core.rearmSnipeTarget(u, t.id, 'no wallet to buy with right now');
      return;
    }
    core.settleSnipeTarget(u, t.id, { ok: false, err: 'no wallet' });
    _notify(u.chatId, `⚠️ <b>Snipe failed</b> · ${esc(ch.name)}\n<code>${t.ca}</code>\nEvery wallet this target was armed on has been removed — re-arm it on a current wallet.`, undefined, 'snipe');
    return;
  }
  const fills = [], fails = [];
  await mapLimit(wids, CA_SNIPE_CONCURRENCY, async (wid) => {
    try {
      const r = await core.buy(u.chatId, t.ca, t.amount, t.chain, wid, { slipBps: t.slipBps || undefined });
      fills.push({ wid, r });
    } catch (err) { fails.push({ wid, err }); }
  });

  if (fills.length) {
    core.settleSnipeTarget(u, t.id, { ok: true, hash: fills[0].r.hash });
    _caSnipeStats.fired++; _caSnipeStats.lastFiredAt = Date.now();
    // The target's TP/SL become REAL orders at the moment there is a bag to
    // sell — PER FILLED WALLET, each measured off ITS OWN realised entry
    // (spent ÷ received), because the whole point of a snipe is that the card
    // price and the fill differ, and five wallets fill five different ways.
    // Each order binds to the wallet that sniped, never whatever is active.
    let exits = '';
    if (t.tpPct > 0 || t.slPct > 0) {
      const parts = [];
      let exitErr = null;
      for (const { wid, r } of fills) {
        const entry = Number(r.spentEth) / (Number(r.gotTokens) || 1);
        if (!(entry > 0)) continue;
        try {
          if (t.tpPct > 0) { addOrder(u.chatId, { type: 'tp', ca: t.ca, sym: r.sym, chain: t.chain, targetPriceEth: entry * (1 + t.tpPct / 100), sellPct: 100, auto: true }, wid); if (!parts.includes(`TP +${t.tpPct}%`)) parts.push(`TP +${t.tpPct}%`); }
          if (t.slPct > 0) { addOrder(u.chatId, { type: 'sl', ca: t.ca, sym: r.sym, chain: t.chain, targetPriceEth: entry * (1 - t.slPct / 100), sellPct: 100, auto: true }, wid); if (!parts.includes(`SL −${t.slPct}%`)) parts.push(`SL −${t.slPct}%`); }
        } catch (e) {
          // Order cap reached is the realistic failure. The BUY succeeded — say
          // the exits did not, or the user believes a stop-loss exists.
          exitErr = e;
        }
      }
      if (parts.length) exits = `\nAuto-exit armed: <b>${parts.join(' · ')}</b>${fills.length > 1 ? ` · ${fills.length} wallets` : ''}`;
      if (exitErr) exits += `\n⚠️ <i>Couldn't place the auto-exit (${esc(String(exitErr.message || exitErr).slice(0, 80))}) — set TP/SL by hand from the Monitor.</i>`;
    }
    const r0 = fills[0].r;
    // Single-wallet keeps its exact original wording; multi adds the count and
    // sums the fills — a total is the only honest number for five wallets.
    const totTok = fills.reduce((s, f) => s + (Number(f.r.gotTokens) || 0), 0);
    const spentStr = fills.length > 1 ? String(Number(fills.reduce((s, f) => s + (Number(f.r.spentEth) || 0), 0).toFixed(6))) : String(r0.spentEth);
    const wtag = wids.length > 1 ? ` · ${fills.length}/${wids.length} wallets` : '';
    const failTag = (wids.length > 1 && fails.length) ? `\n⚠️ ${fails.length} wallet(s) did not fill: ${esc(String((fails[0].err && fails[0].err.message) || fails[0].err).slice(0, 80))}` : '';
    _notify(u.chatId, `🎯 <b>CA snipe filled: $${esc(r0.sym || '')}</b> on ${ch.emoji} ${esc(ch.name)}${wtag}\n<i>This was YOUR armed target.</i>\nBought ${fmt(totTok)} for ${spentStr} ${r0.native}${exits}${failTag}\n<code>${t.ca}</code>\n${txLink(t.chain, r0.hash)}`, undefined, 'snipe');
    return;
  }

  // No wallet filled. Classified exactly as the single-wallet path always was —
  // BROADCAST dominates (it may still land; re-arming risks a second buy), then
  // every-wallet-empty disarms, anything else re-arms for the next tick because
  // a launch that reverted in its first block is exactly the one worth retrying.
  const msgs = fails.map((f) => String((f.err && f.err.message) || f.err));
  _caSnipeStats.lastErr = (msgs[0] || '').slice(0, 180); _caSnipeStats.lastErrAt = Date.now();
  const b = fails.find((f) => f.err && f.err.broadcast);
  if (b) {
    core.settleSnipeTarget(u, t.id, { ok: true, hash: b.err.sig || null, err: 'broadcast but not confirmed' });
    _notify(u.chatId, `🎯 <b>Snipe broadcast</b> on ${ch.emoji} ${esc(ch.name)}\n<code>${t.ca}</code>\nIt was sent but not confirmed yet — check your wallet before buying again.`, undefined, 'snipe');
    return;
  }
  const skint = (m) => /insufficient funds|no wallet|balance/i.test(m);
  if (msgs.length && msgs.every(skint)) {
    core.settleSnipeTarget(u, t.id, { ok: false, err: msgs[0] });
    _notify(u.chatId, `⚠️ <b>Snipe failed</b> · ${esc(ch.name)}\n<code>${t.ca}</code>\n${esc(msgs[0])}\nThe target was disarmed — top up and re-arm it.`, undefined, 'snipe');
    return;
  }
  const msg = msgs.find((m) => !skint(m)) || msgs[0] || 'buy failed';
  core.rearmSnipeTarget(u, t.id, msg);
  const now = Date.now(), key = u.chatId + ':casnipe:' + t.id;
  if (now - (_snipeFailAt.get(key) || 0) > 300000) {
    _snipeFailAt.set(key, now);
    _notify(u.chatId, `⚠️ <b>Snipe attempt failed</b> · ${esc(ch.name)}\n<code>${t.ca}</code>\n${esc(msg)}\nStill armed — retrying. (muted 5 min)`, undefined, 'snipe');
  }
}

const chainName = (k) => ((core.chainOf(k) || {}).name || k);

// ------------------------------------------------------------------ DCA (scheduled buys)
// A DCA plan buys `amount` of a token every `intervalMin` minutes for `rounds` rounds
// (and/or until an optional budget is spent), on the wallet it was created with. Each
// round advances the schedule + persists BEFORE the buy, so a crash can't double-buy.
let _did = 1;
const MAX_DCA_PER_USER = Math.max(1, Number(process.env.MAX_DCA_PER_USER || 10));
function addDca(chatId, plan, walletId) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); if (!w) throw new Error('no wallet');
  u.dca = Array.isArray(u.dca) ? u.dca : [];
  if (u.dca.length >= MAX_DCA_PER_USER) throw new Error(`DCA plan limit (${MAX_DCA_PER_USER}) reached — cancel one first`);
  const amount = Number(plan.amount), intervalMin = Math.max(1, Math.round(Number(plan.intervalMin) || 0)), rounds = Math.max(1, Math.round(Number(plan.rounds) || 0));
  if (!(amount > 0)) throw new Error('amount must be > 0');
  const p = {
    id: 'dca' + (_did++) + Date.now().toString(36),
    ca: plan.ca, sym: plan.sym || '', chain: plan.chain || core.userChain(u), walletId: w.id,
    amount: String(amount), intervalMin, roundsLeft: rounds, rounds,
    budget: Number(plan.budget) > 0 ? Number(plan.budget) : 0, spent: 0,
    nextAt: Date.now(), createdAt: Date.now(),   // first buy on the next cycle
  };
  u.dca.push(p); core.saveStoreNow();
  return p;
}
function cancelDca(chatId, id) {
  const u = core.getUser(chatId); if (!u || !Array.isArray(u.dca)) return false;
  const before = u.dca.length;
  u.dca = u.dca.filter((p) => p.id !== id);
  if (u.dca.length !== before) { core.saveStore(); return true; }
  return false;
}
async function dcaCycle() {
  const now = Date.now();
  const due = [];
  for (const u of core.allUsers()) for (const p of (u.dca || [])) if ((p.nextAt || 0) <= now) due.push({ u, p });
  if (!due.length) return;
  await mapLimit(due, SNIPE_CONCURRENCY, async ({ u, p }) => {
    if (!Array.isArray(u.dca) || !u.dca.some((x) => x.id === p.id)) return;   // cancelled since
    // Advance the schedule + decrement the round + persist BEFORE the buy (crash-safe:
    // a restart can't replay this round). Remove the plan when it's exhausted.
    p.roundsLeft = Math.max(0, (p.roundsLeft || 0) - 1);
    p.nextAt = Date.now() + p.intervalMin * 60000;
    // The budget is a CEILING, so the last round buys what is left of it, not a
    // full-size clip. This used to only decide whether the plan was finished
    // AFTER this buy — the round still went out at full size, so a 0.1 budget
    // with 0.03 clips spent 0.12. Over budget is not a rounding error on
    // somebody's money.
    let amount = Number(p.amount);
    if (p.budget > 0) {
      const left = p.budget - Number(p.spent || 0);
      if (left <= 1e-12) { u.dca = u.dca.filter((x) => x.id !== p.id); core.saveStoreNow(); return; }
      if (left < amount) amount = left;
    }
    const willFinish = p.roundsLeft <= 0 || (p.budget > 0 && (Number(p.spent) + amount) >= p.budget - 1e-12);
    if (willFinish) u.dca = u.dca.filter((x) => x.id !== p.id);
    core.saveStoreNow();
    try {
      const r = await core.buy(u.chatId, p.ca, amount, p.chain, p.walletId);
      p.spent = Number(p.spent) + Number(r.spentEth || amount);
      core.saveStoreNow();   // the money already moved — don't leave the tally in a debounce window
      const left = willFinish ? 'plan complete' : `${p.roundsLeft} round${p.roundsLeft === 1 ? '' : 's'} left`;
      _notify(u.chatId, `🔁 <b>DCA buy</b> $${esc(r.sym || p.sym || '')}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native} · ${left}\n${txLink(p.chain, r.hash)}`, undefined, 'copy');
    } catch (err) {
      const now2 = Date.now(), key = u.chatId + ':dca:' + p.id;
      if (now2 - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now2); _notify(u.chatId, `⚠️ A DCA buy of $${esc(p.sym || '')} failed: ${esc(err.message || String(err))} (round skipped; muted 5 min)`, undefined, 'copy'); }
    }
  });
}

// ------------------------------------------------------------------ referral auto-payout (opt-in)
const REF_PAYOUT_MIN = Math.max(0, Number(process.env.REF_PAYOUT_MIN_ETH || 0.005));   // min owed before paying (dust/gas guard)
async function payoutCycle() {
  if (!core.feePayoutEnabled()) return;
  const minWei = ethers.parseEther(String(REF_PAYOUT_MIN));
  for (const u of core.allUsers()) {
    const owed = u.refOwed; if (!owed || typeof owed !== 'object') continue;
    const dest = core.activeAddress(u); if (!dest) continue;
    for (const ck of Object.keys(owed)) {
      const ch = core.chainOf(ck); if (!ch) continue;
      // Auto-payout is an EVM hot-key feature (ethers). Solana referral debt accrues in
      // lamports and is settled MANUALLY — never try to pay it with an ethers wallet
      // (that would throw) and never compare lamports against a wei threshold.
      if (core.chains.isSvm(ck)) continue;
      let wei; try { wei = BigInt(owed[ck] || '0'); } catch (_) { continue; }
      if (wei < minWei) continue;
      // Deduct BEFORE paying so a crash can never overpay.
      owed[ck] = '0';
      core.saveStoreNow();
      try {
        const r = await core.payFromFeeWallet(ck, dest, wei);
        _notify(u.chatId, `💸 <b>Referral payout</b> — ${Number(ethers.formatEther(wei)).toFixed(5)} ${ch.native} sent to your wallet${r.confirmed ? '' : ' (confirming)'}.\n${txLink(ck, r.hash)}`);
      } catch (err) {
        if (err && err.ambiguous) {
          // The tx MAY have been accepted on-chain (broadcast errored after the node saw
          // it). Re-paying could double-send real funds, so we do NOT restore — the debt
          // stays cleared and we log it for manual review. Under-paying a small referral
          // credit is far safer than double-paying from a hot wallet.
          console.error('payout AMBIGUOUS (left cleared, verify manually)', ck, dest, wei.toString(), (err && err.message) || err);
        } else {
          // Nothing moved (pre-broadcast failure or clean revert) → give the debt back.
          // ADDITIVELY: a concurrent referral credit may have landed since we zeroed it.
          try { owed[ck] = (BigInt(owed[ck] || '0') + wei).toString(); } catch (_) { owed[ck] = wei.toString(); }
          core.saveStoreNow();
          console.error('payout', ck, (err && (err.message || err)) || 'unknown');
        }
      }
    }
  }
}

// ------------------------------------------------------------------ health / loop runner
// Each background loop records a heartbeat (last run + last success + last error) so a
// silently-dead loop is visible via /health (admin). `stale` flags a loop that hasn't
// run in > 3× its interval.
const _health = {};
function _beat(name, ok, err, ms) {
  const h = _health[name] || (_health[name] = { intervalMs: ms });
  h.at = Date.now(); h.intervalMs = ms;
  if (ok) { h.okAt = Date.now(); h.err = null; } else if (err) { h.err = String((err && (err.message || err)) || 'error').slice(0, 200); h.errAt = Date.now(); }
}
function runLoop(name, cycle, ms) {
  (async function loop() { for (;;) { try { await cycle(); _beat(name, true, null, ms); } catch (e) { _beat(name, false, e, ms); console.error(name, e.message); } await sleep(ms); } })();
}
function health() {
  const now = Date.now();
  const out = {};
  for (const [name, h] of Object.entries(_health)) {
    out[name] = { ageMs: h.at ? now - h.at : null, okAgeMs: h.okAt ? now - h.okAt : null, err: h.err || null, intervalMs: h.intervalMs, stale: h.at ? (now - h.at) > (h.intervalMs * 3 + 5000) : true };
  }
  // "Ran recently" is not the same as "working". The snipe loop can run every 6s
  // forever against a launchpad that emits nothing it recognises, so the loop's own
  // liveness says nothing about whether the feed is real. These two numbers do.
  if (out.snipe) {
    out.snipe.launchesSeen = _snipeStats.launchesSeen;
    out.snipe.sinceLastLaunchMs = _snipeStats.lastLaunchAt ? now - _snipeStats.lastLaunchAt : null;
    out.snipe.blocksScanned = _snipeStats.blocksScanned;
    // The Pons factory scan rides this loop but fails on its own: zero seen
    // with a null error is a quiet launchpad; zero seen with an error is a
    // wrong address or a stale signature, and the sentence says which.
    out.snipe.ponsSeen = _snipeStats.ponsSeen;
    out.snipe.ponsErr = _snipeStats.ponsErr || null;
  }
  // The same two numbers for Solana. They were only ever wired to the EVM loop,
  // which is precisely why a dead pump.fun host could sit behind a green tick:
  // `lastFeedOkAt` is the only field that says the FEED answered, as opposed to
  // the loop having run.
  if (out.solSnipe) {
    out.solSnipe.launchesSeen = _solSnipeStats.launchesSeen;
    out.solSnipe.sinceFeedOkMs = _solSnipeStats.lastFeedOkAt ? now - _solSnipeStats.lastFeedOkAt : null;
    out.solSnipe.sinceLastLaunchMs = _solSnipeStats.lastLaunchAt ? now - _solSnipeStats.lastLaunchAt : null;
    out.solSnipe.feedErr = _solSnipeStats.lastErr || null;
  }
  // The launchpad feeds — every pad on every covered chain. A secondary pad
  // being down does NOT turn any loop red (it costs that pad's launches and
  // nothing more), so without these numbers "which launchpads is this bot
  // actually watching today" has no answer at all, and silently narrowing that
  // set is the kind of degradation nobody notices for a month.
  //
  // `sinceOkMs` is the one that matters: it says a pad ANSWERED, as opposed to
  // the loop having run. That distinction is the whole reason a dead pump.fun
  // host once sat behind a green tick for days.
  if (out.padSnipe) {
    out.padSnipe.launchesSeen = _padSnipeStats.launchesSeen;
    out.padSnipe.sinceOkMs = _padSnipeStats.lastOkAt ? now - _padSnipeStats.lastOkAt : null;
    out.padSnipe.sinceLastLaunchMs = _padSnipeStats.lastLaunchAt ? now - _padSnipeStats.lastLaunchAt : null;
    // The error rides with its AGE. `lastErr` is deliberately never blanked —
    // it answers "what was the last thing that went wrong here" — so without
    // the age a pad error from Tuesday reads as a pad error NOW, and a healthy
    // screen shows a standing fault. The per-pad `why` below is the live one:
    // it clears the moment that pad answers.
    out.padSnipe.err = _padSnipeStats.lastErr || null;
    out.padSnipe.errAgeMs = _padSnipeStats.lastErrAt ? now - _padSnipeStats.lastErrAt : null;
    // Per pad, because "a launchpad is down" and "every launchpad is down" need
    // different answers from an operator.
    out.padSnipe.pads = Object.fromEntries(Object.entries(_padSnipeStats.pads).map(([k, v]) => [k, { ok: v.ok, fail: v.fail, seen: v.seen, why: v.why }]));
  }
  // The retry ring. A launch parked here is one the bot HAS seen and cannot buy
  // yet — the single most misread state in this service, because from outside it
  // is indistinguishable from a snipe that is not watching at all.
  //
  // MERGED onto the loop's own heartbeat, never assigned over it: `out.launchRetry`
  // already carries runLoop's ageMs/stale/err for this loop, and replacing the
  // object threw exactly the fields that say whether the ring is RUNNING — a
  // stuck or disabled ring rendered green because its counters still existed.
  out.launchRetry = { ...(out.launchRetry || {}), enabled: LAUNCH_RETRY_MS > 0,
    pending: _retryStats.pending, queued: _retryStats.queued, fired: _retryStats.fired, expired: _retryStats.expired,
    sinceFiredMs: _retryStats.lastFiredAt ? now - _retryStats.lastFiredAt : null };
  // A CA snipe that is armed and never probed is the failure mode here — the
  // loop ticking says nothing about whether the targets are being looked at, so
  // both numbers are needed. `armed` with `probes` stuck is a starved ring;
  // `armed: 0` is simply nobody waiting on a launch.
  if (out.caSnipe) {
    out.caSnipe.armed = _caSnipeStats.armed;
    // Targets and contracts are different numbers: fifty users on one launch is
    // fifty armed and one probe. Seeing only one of them makes a busy day and a
    // starved ring look the same.
    out.caSnipe.contracts = _caSnipeStats.contracts;
    out.caSnipe.probes = _caSnipeStats.probes;
    out.caSnipe.fired = _caSnipeStats.fired;
    out.caSnipe.sinceFiredMs = _caSnipeStats.lastFiredAt ? now - _caSnipeStats.lastFiredAt : null;
    out.caSnipe.err = _caSnipeStats.lastErr || null;
  }
  // OUR OWN REQUEST BUDGET, which is a different question from "is Jupiter up"
  // and was the answer to five red crosses on one buy. The watchdog sweeps every
  // ten minutes; an operator looking at a failing buy right now should not have
  // to wait for it. `refused` is the only number that means a trade was lost —
  // `absorbed` is a 429 the retry got past, which cost latency and nothing else,
  // and collapsing the two would make a healthy budget read as a broken one.
  if (core.chains.isEnabled('solana')) {
    const j = solana.jupStats();
    out.jupiter = {
      tier: solana.jupKeyed() ? 'keyed' : 'keyless (metered per IP)',
      requests: j.req, rateLimited: j.r429, absorbedByRetry: j.absorbed,
      refusedTrades: j.refused, sinceRefusedMs: j.sinceRefusedMs, lastRefusedWhy: j.lastRefusedWhy || null,
    };
  }
  // Third parties, as of the last watchdog sweep. `/health` answering "the loops
  // are running" while every Solana buy fails at Jupiter is the gap this closes.
  if (_lastUpstream) {
    out.upstreams = { ageMs: now - _lastUpstream.at, ok: _lastUpstream.ok, criticalOk: _lastUpstream.criticalOk,
      failing: _lastUpstream.results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.detail}`) };
  }
  return out;
}
// ------------------------------------------------------------------ upstream watchdog
//
// Every outage in this bot's short history was found by a human typing
// `npm run preflight:solana` AFTER a user complained: Jupiter's retired host,
// pump.fun's move to v3, the swap-build failing while quotes worked. The check
// existed and named each one in a line. It just only ran when somebody already
// suspected something.
//
// This runs it on a timer and says so out loud. Two rules keep it worth reading:
//
//   • Alert on the TRANSITION, not the state. A broken upstream that posts every
//     sweep is a channel nobody reads by the second hour, and the alert that
//     matters is buried in its own repetitions.
//   • A RECOVERY is an alert too. "It is broken" with no matching "it is back"
//     leaves the operator unable to tell a fixed outage from a forgotten one,
//     and that is how a stale alarm becomes furniture.
let _lastUpstream = null;
let _upFirstDone = false;     // so the boot sweep is provable in the log
const _upState = new Map();   // key -> ok, so only changes are announced
async function upstreamCycle() {
  const snap = await upstreams.checkAll();
  _lastUpstream = snap;
  const broke = [], fixed = [];
  for (const r of snap.results) {
    const was = _upState.get(r.key);
    _upState.set(r.key, r.ok);
    if (was === undefined) {
      // First sweep after a restart. Report a problem, because a bot that boots
      // into an outage must not wait for a transition that already happened —
      // but say nothing about the things that are simply fine.
      if (!r.ok) broke.push(r);
      continue;
    }
    if (was && !r.ok) broke.push(r);
    else if (!was && r.ok) fixed.push(r);
  }
  for (const r of broke) console.error(`[upstream] DOWN ${r.label} — ${r.detail}`);
  for (const r of fixed) console.log(`[upstream] recovered ${r.label} — ${r.detail}`);
  if (broke.length || fixed.length) report.upstreamChange(broke, fixed).catch(() => {});
  // The FIRST sweep always prints, even when everything is fine.
  //
  // Silence afterwards is the design — a healthy watchdog says nothing. But
  // silence is also what a watchdog that never started looks like, and an
  // operator grepping the log for it cannot tell those apart. One line at boot
  // makes the quiet afterwards mean something. This is the same rule as
  // lastFeedOkAt: "it did not report a problem" and "it did not run" are
  // different facts.
  if (!_upFirstDone) {
    _upFirstDone = true;
    const ok = snap.results.filter((r) => r.ok).length;
    console.log(`[upstream] first sweep: ${ok}/${snap.results.length} ok — ` +
      snap.results.map((r) => `${r.label}=${r.ok ? 'ok' : 'DOWN'}`).join(' · '));
  }
}

function start() {
  // Default 10 minutes. Each sweep is four read-only calls; the cost of missing
  // an outage for hours is a user's money, so this is not the knob to save on.
  const upMs = Math.max(60000, Number(process.env.UPSTREAM_CHECK_MS || 600000));
  if (core.chains.isEnabled('solana') && String(process.env.UPSTREAM_CHECK || '1') !== '0') {
    // Announced BEFORE the first sweep, not after it.
    //
    // The sweep itself can take ~20s (four probes, one of which builds a real
    // swap transaction), and an operator runs `pm2 logs | grep upstream`
    // seconds after `pm2 restart`. They saw nothing, which is exactly what a
    // watchdog that failed to start looks like. This line is instant, so the
    // grep answers "is it armed?" immediately and the sweep result follows.
    console.log(`[upstream] watchdog armed — sweeping every ${Math.round(upMs / 1000)}s · alerts ${report.enabled() ? 'to the ops channel' : 'DISABLED (log only)'}`);
    runLoop('upstreams', upstreamCycle, upMs);
  } else if (core.chains.isEnabled('solana')) {
    console.log('[upstream] watchdog OFF (UPSTREAM_CHECK=0) — a third party going down will not be reported');
  }
  const snipeMs = Math.max(4000, Number(process.env.SNIPE_POLL_MS || 6000));
  const orderMs = Math.max(8000, Number(process.env.ORDER_POLL_MS || 15000));
  const alertMs = Math.max(8000, Number(process.env.ALERT_POLL_MS || 20000));
  const dexSnipeMs = Math.max(5000, Number(process.env.DEX_SNIPE_POLL_MS || 8000));
  runLoop('snipe', snipeCycle, snipeMs);
  runLoop('dexSnipe', dexSnipeCycle, dexSnipeMs);
  // The launchpad feeds, for every chain any pad covers. Its own loop and its
  // own cadence: the two above read block logs from nodes this bot owns, this
  // one polls third-party HTTP hosts that rate-limit and go down, and folding an
  // HTTP poll into a block scan means one slow launchpad delaying every snipe on
  // the chain. It costs nothing while nobody is armed — the cycle takes its
  // early return before making a request.
  runLoop('padSnipe', padSnipeCycle, Math.max(5000, Number(process.env.PAD_SNIPE_POLL_MS || 12000)));
  // The retry ring: launches this bot saw before their market existed. Without
  // it a dev snipe that arrives first — the whole point of a dev snipe — is a
  // buy that fails with "no route" and a launch that is then dropped for ever.
  if (LAUNCH_RETRY_MS) runLoop('launchRetry', launchRetryCycle, LAUNCH_RETRY_POLL_MS);
  else console.log('[snipe] retry ring OFF (LAUNCH_RETRY_MS=0) — a launch seen before its pool opens is dropped, not retried');
  // Solana snipe runs only when the chain is enabled (its own cadence; pump.fun poll).
  if (core.chains.isEnabled('solana')) runLoop('solSnipe', solSnipeCycle, Math.max(5000, Number(process.env.SOL_SNIPE_POLL_MS || 8000)));
  runLoop('orders', ordersCycle, orderMs);
  // Snipe-by-CA. Its own loop rather than a leg of the launch snipes: those poll
  // a feed for tokens nobody has named yet, this polls named contracts for a
  // pool. Different cadence, different failure, different thing to say when it
  // goes quiet.
  runLoop('caSnipe', caSnipeCycle, CA_SNIPE_POLL_MS);
  runLoop('alerts', alertsCycle, alertMs);
  runLoop('positions', positionsCycle, Math.max(20000, Number(process.env.POS_POLL_MS || 60000)));
  runLoop('copy', copyCycle, Math.max(6000, Number(process.env.COPY_POLL_MS || 10000)));
  // Exits get their own loop: an exit that arrives late is worth more than an
  // entry that arrives late, so it must not queue behind the log scan.
  runLoop('copyExit', copyExitCycle, Math.max(5000, Number(process.env.COPY_EXIT_POLL_MS || 8000)));
  runLoop('dca', dcaCycle, Math.max(15000, Number(process.env.DCA_POLL_MS || 30000)));
  if (core.feePayoutEnabled()) {
    console.log('referral auto-payout ENABLED (fee wallet key present)');
    runLoop('payout', payoutCycle, Math.max(60000, Number(process.env.REF_PAYOUT_POLL_MS || 300000)));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
const txLink = (chain, h) => { const c = core.chainOf(chain); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };

module.exports = { copyExitCycle, setNotifier, start, _targetPaid, caSnipeCycle, addOrder, cancelOrder, addAlert, cancelAlert, addDca, cancelDca, health, snipeStats, orderSpeed, orderExec, ORDER_SPEED, ORDER_SPEED_DEFAULT, _test: { ordersCycleExec: orderExec, solSnipeCycle, snipeCycle, copyCycle, _copySolTarget, _solBuyMintFromTx, ordersCycle, dcaCycle, positionsCycle, _followerBuy, launchFollowers, _snipeMark, _snipeStats, caSnipeCycle, _caSnipeStats, _devFromPair, padSnipeCycle, launchRetryCycle, _fireLaunch, _notYetTradeable, _padLaunches, _padSnipeStats, _retryStats, _launchRetry, _padCursors, _padFeedFail, _armedOn, _ponsScan, _ponsCfg, _ponsResolve, _logAddrs, PONS_KNOWN_SIGS,
  // The raw-mismatch probe is rate-limited to one look per 10 min, which is
  // right in production and is inherited state in a suite: one test consuming
  // it leaves the next reading a null `ponsErr`, which looks exactly like the
  // diagnosis being broken. Stated by reset(), never inherited.
  // (the CURSOR is deliberately left alone — a test that seeds it is testing
  // the seeding rule, and clearing it here would silently turn those into
  // first-look-only passes that assert nothing.)
  _ponsResetProbe: () => { _ponsRawCheckAt = 0; } } };
