'use strict';
/*
 * READ A LAUNCHPAD CURVE'S BUY/SELL INTERFACE OFF THE CHAIN.
 *
 * WHY THIS EXISTS
 * A token still on a bonding curve has no AMM pool, so on EVM there is nothing
 * for a router to route: the card says "this token's liquidity is on Pons v2,
 * which Dexvra can't route through yet", and every buy is refused. On Solana
 * the same class of token trades fine, because Jupiter aggregates those curves
 * and `_solRoutable` asks it for a real quote. EVM has no such aggregator, so
 * each pad's curve has to be called directly — and calling it needs its ABI.
 *
 * ⚠️ AND A GUESSED ABI ON A MONEY PATH IS THE ONE THING THIS REPO REFUSES.
 * Pons shipped a researched factory address AND a researched event signature
 * once; the box measured both and BOTH WERE WRONG (see CLAUDE.md). Two guesses,
 * each individually enough to make the scan inert. A buy built the same way
 * does not go inert — it spends somebody's money into a contract nobody
 * verified.
 *
 * So nothing here is guessed. Every field below is READ FROM A REAL TRADE that
 * somebody already made on the pad's own website:
 *
 *   every trade on a curve moves the token to or from the curve contract,
 *   which emits a Transfer, which carries its transaction hash, from which
 *   the call — contract, 4-byte selector, argument words — is one read away.
 *
 * This was already true in `scripts/robinhood-preflight.js` section 4x, where
 * it printed the lines for an operator to send back. That is a round trip, and
 * the round trip is the thing in the way: the bot can read the chain itself.
 * One owner, used by both — the script keeps the human-readable report, this
 * keeps the decision.
 *
 * ⚠️ THIS MODULE DECIDES NOTHING ABOUT SPENDING. It returns what it observed
 * and how sure it is. Whether that is enough to sign a transaction is the
 * caller's call, and the answer must involve simulating the built call before
 * anybody's money moves — the line `poolstrade.js` and `curveSnapshot()`
 * already draw between knowing a price and being able to fill a swap.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/*
 * ⚠️ THE STEP SIZE IS FIXED, NEVER DERIVED FROM THE SPAN.
 *
 * The stepped walk existed because this node silently answers a too-wide
 * `eth_getLogs` with `[]` rather than an error — but its step was
 * `ceil(span / budget)`, so the wider the window, the wider each step: 209
 * blocks at 5,000, 2,500 at 60,000, **16,667** at 400,000. Every window past
 * the first therefore asked in ranges the node empties, and the ladder's whole
 * point — reaching a quiet token's older trades — could never work. The card
 * said "no trades found in the last 400000 blocks (also walked 24 smaller
 * ranges)" about a token whose launch buy is plainly on chain, and it said it
 * identically at 17:57, 18:09 and 18:19.
 *
 * The size a node serves is a property of the NODE, not of how far back we
 * want to look. The snipe loop reads this same chain in ~60-block ranges all
 * day, so a small fixed step is the known-good shape; how FAR we reach is the
 * budget's job. `CURVE_LOG_STEP` / `CURVE_LOG_STEPS` tune it per box.
 */
const LOG_STEP = Math.max(50, Number(process.env.CURVE_LOG_STEP || 500));
const LOG_STEPS = Math.max(1, Number(process.env.CURVE_LOG_STEPS || 48));

/**
 * Walk a log filter backwards from `head` in bounded, node-sized steps.
 *
 * NEWEST FIRST and stops as soon as `want` entries are in hand: on a live pad
 * the answer is usually within a step or two of the head, so the budget is
 * only ever spent by a token that genuinely has nothing recent.
 *
 * Reports what it actually WALKED, because a refusal quoting the window it
 * *wanted* rather than the range it *covered* is a diagnosis about a search
 * that did not happen — which is exactly what this file has been printing.
 */
async function steppedLogs(chain, filter, opts = {}) {
  const head = Number(opts.head);
  const span = Math.max(1, Number(opts.span) || 5000);
  const step = Math.max(1, Number(opts.step) || LOG_STEP);
  const budget = Math.max(1, Number(opts.budget) || LOG_STEPS);
  const want = Math.max(0, Number(opts.want) || 0);
  const floor = Math.max(0, head - span);
  const out = [];
  let stepped = 0, errs = 0, lastErr = null, lowest = head;
  for (let to = head; to > floor && stepped < budget; to -= step) {
    const lo = Math.max(floor, to - step + 1);
    stepped++;
    lowest = lo;
    try {
      const r = await chain.getLogs({ ...filter, fromBlock: lo, toBlock: to });
      if (Array.isArray(r) && r.length) out.push(...r);
    } catch (e) { errs++; lastErr = e; }   // one bad range must not abandon the walk
    if (want && out.length >= want) break;
  }
  return { logs: out, stepped, errs, lastErr, walked: Math.max(0, head - lowest) };
}

/**
 * A 32-byte word that is an ABI-encoded address (12 zero bytes, then 20).
 *
 * ⚠️ A SMALL NUMBER IS SHAPE-IDENTICAL TO A LOW ADDRESS, and reading one as
 * the other is how a route writes the wrong value into the wrong argument
 * slot. `minTokensOut = 500` encodes as twelve zero bytes and then twenty more
 * that are "an address" — the first version of this accepted it, and a caller
 * building a buy from that layout would have put an amount where the contract
 * wanted a recipient.
 *
 * The 20 address bytes are therefore required to carry something in their TOP
 * four: a real address has a non-zero byte up there with overwhelming
 * probability, and a number small enough to look like an address does not.
 * `num` is computed for EVERY word regardless, so the ambiguity stays visible
 * to the caller instead of being silently resolved here.
 */
const wordAddr = (w) =>
  /^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{8}/.test(w.slice(24)) ? '0x' + w.slice(24).toLowerCase() : null;
const topicAddr = (t) => (typeof t === 'string' && t.length === 66 ? '0x' + t.slice(26).toLowerCase() : null);
const lc = (s) => String(s || '').toLowerCase();
/** A Transfer's `value` — the non-indexed uint256 in the log data. */
const logAmount = (lg) => { try { return BigInt(lg && lg.data ? lg.data : 0); } catch (_) { return 0n; } };

/**
 * Did the node REFUSE us, rather than cap a range?
 *
 * The walk below exists for a node that serves small spans and rejects big
 * ones. A 429/403/401 is about US and is waiting identically on every one of
 * its steps, so walking it turns one bad second into a coarse pass of refusals
 * — the shape CLAUDE.md records for the CoinGecko sweep ("a 429 now arms a
 * cooldown and the rest of the sweep is not asked at all"), on the path that
 * spends money.
 *
 * ⚠️ Matched on TEXT, and anything unrecognised is treated as a RANGE problem
 * so the walk still happens. That is the fail-safe direction: misreading a
 * refusal as a range error costs requests, misreading a range error as a
 * refusal would switch off the walk that is the fix for it.
 */
function _refusal(err) {
  if (!err) return false;
  const s = `${(err && (err.shortMessage || err.message)) || err} ${(err && (err.code || err.status)) || ''}`.toLowerCase();
  return /\b(429|403|401)\b|too many requests|rate.?limit|forbidden|unauthorized|quota/.test(s);
}

/**
 * ⚠️ THE WALK'S OUTPUT IS IN NEITHER ORDER, AND `.reverse()` CANNOT FIX IT.
 *
 * `steppedLogs` walks newest RANGE first while `getLogs` returns each range
 * oldest-first, so `found` is "chunks descending, items within a chunk
 * ascending" — sorted in neither direction. Reversing that flat array gives
 * "chunks ascending, items descending": still not sorted. The caller then takes
 * `slice(-maxTx).reverse()` believing it holds the NEWEST trades newest-first,
 * and on the walked path it held the OLDEST trades of the newest chunk,
 * oldest-first.
 *
 * Not cosmetic. `curvePrice.observedRate` is the last price tier and the only
 * one that answers when the pad's own host is unreachable — which is this
 * operator's box — and a curve's price rises as supply sells, so feeding it the
 * cheapest fills overstates tokens-per-unit on the number that authorises a
 * curve buy.
 *
 * A real sort, on the two fields that define log order. Both are optional on a
 * stub and ethers v6 spells the second `index`, so a missing one sorts as 0
 * rather than throwing.
 */
const _n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const _pos = (l) => (l && l.logIndex != null ? l.logIndex : (l && l.index));
const _chrono = (logs) => logs.slice().sort((a, b) => _n(a.blockNumber) - _n(b.blockNumber) || _n(_pos(a)) - _n(_pos(b)));


/** The calldata's argument words, classified. Bounded: a curve buy takes a
 *  handful of arguments, and a long tail is calldata we do not understand
 *  anyway. */
function argsOf(data, token) {
  const body = String(data || '').slice(10);
  const out = [];
  for (let i = 0; i < Math.min(8, Math.floor(body.length / 64)); i++) {
    const w = body.slice(i * 64, i * 64 + 64);
    const addr = wordAddr(w);
    // ALWAYS both readings. A word that is an address is also a number, and a
    // caller deciding what to put in this slot needs to see what it actually
    // held rather than this module's opinion of it.
    let n = null;
    try { n = BigInt('0x' + w); } catch (_) { n = null; }
    out.push({ i, word: w, addr, num: n, isToken: !!addr && addr === lc(token) });
  }
  return out;
}

/**
 * What the chain says about how this token is traded.
 *
 * `chain` is anything with `getLogs` and `getTransaction` — an ethers provider
 * in production, a counting stub in the tests. Injected rather than imported so
 * this is provable without a node, which is the only way it CAN be proved from
 * a sandbox with no egress.
 *
 * Returns `{ ok, why, curve, buy, sell, samples }`. `ok:false` always means
 * "could not look" or "nothing to look at" — never "this token cannot be
 * traded", because those are different facts and the second one is not ours to
 * assert from a quiet block window.
 */
async function decodeCurveIface(chain, token, opts = {}) {
  const span = Math.max(100, Number(opts.blocks) || 5000);
  const maxTx = Math.max(1, Number(opts.maxTx) || 12);
  const head = Number(opts.head);
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(token || ''))) return { ok: false, why: 'not an EVM token address' };

  /*
   * ⚠️ AN EMPTY ANSWER FROM A WIDE RANGE IS NOT "NOBODY TRADED".
   *
   * Public RPCs cap `eth_getLogs`. Some reject a wide range with an error;
   * others answer [] — and that empty array is about the CAP, not about the
   * token. The live box reported "nobody has traded this token in the last
   * 50000 blocks" for a token whose own card showed $320 of 24h volume, which
   * is the two facts refusing to both be true.
   *
   * `scripts/robinhood-preflight.js` §4x already knew this and walks the tail
   * in steps. That half did not come across when the decode was promoted into
   * the bot — so the port carried the logic and dropped the lesson, which is
   * the shape this repo keeps paying for.
   *
   * So: ask wide, and if that comes back empty, WALK THE TAIL in bounded steps
   * before believing it. A step that errors must not abandon the walk — a
   * range-capped node fails some ranges and serves others.
   */
  const from = Math.max(0, head - span);
  const budget = Math.max(1, Number(opts.steps) || 24);
  /*
   * `opts.logs` BYPASSES THE WALK: the caller already holds this token's trade
   * Transfers — read from transaction RECEIPTS, i.e. the same chain the walk
   * asks — and only the decode is wanted. The seed path in curveTrade uses it
   * for tokens whose trades are older than any window a range-capped node will
   * serve; see `ifaceFor`.
   */
  let logs = Array.isArray(opts.logs) ? opts.logs : null;
  let stepped = 0;
  let stepErrs = 0;
  let lastErr = null;

  if (!logs) {
    try { logs = await chain.getLogs({ address: token, topics: [TRANSFER_TOPIC], fromBlock: opts.full ? 0 : from, toBlock: head }); }
    catch (e) { lastErr = e; }
  }

  /*
   * ⚠️ ONE REQUEST FOR THE WHOLE HISTORY — this is what the 12s refusal was.
   *
   * The ladder below plus its coarse/fine walk is tens of SERIAL round trips on
   * a chain deliberately exempt from JSON-RPC batching, against a ceiling that
   * only ever bought a bounded refusal. A bonding-curve token's history is short
   * and this filter is narrow (one address, one topic) — the shape a node
   * answers over a wide range; `v4.js:180` already issues `fromBlock: 0` on this
   * very chain for the same reason.
   *
   * ⚠️ AN EMPTY ANSWER HERE IS INCONCLUSIVE, NOT A VERDICT. A first cut read it
   * as "this token has never traded" and cached that, reasoning the whole chain
   * cannot be too narrow. Wrong objection: narrowness was never the issue, the
   * CAP is — and `fromBlock: 0` is the WIDEST range a capping node can be
   * handed, so it is the request most likely to come back silently empty. That
   * turned one request into a false verdict where the ladder finds the trades.
   * Only an explicit refusal suppresses the ladder.
   */
  if (opts.full) {
    if (!logs) return { ok: false, retry: !_refusal(lastErr), why: `could not read this token's transfers (${(lastErr && lastErr.message) || lastErr})` };
    if (!logs.length) return { ok: false, retry: true, why: 'no trades found for this token in one whole-chain look — the node may be capping the range' };
  }

  let walked = 0;
  if ((!logs || !logs.length) && !Array.isArray(opts.logs)) {
    const filter = { address: token, topics: [TRANSFER_TOPIC] };
    /*
     * TWO PASSES, COARSE THEN FINE — because "the range this node serves" is a
     * fact about the node and we do not get to know it.
     *
     * COARSE covers the whole span in `budget` steps: on a node that serves
     * wide ranges it is the cheap answer, and it is what reaches a trade far
     * back in the window.
     *
     * FINE re-walks NEAR THE HEAD in fixed, small, node-sized asks. On the box
     * this feature is for, every coarse step past the first window is wider
     * than the node will serve and comes back silently empty — so the coarse
     * pass reports "nothing" over a token whose launch buy is plainly on
     * chain. Running fine only after coarse found nothing keeps the cheap path
     * cheap and makes the answer honest on a capped node.
     */
    /*
     * ⚠️ A REFUSAL IS NOT A RANGE CAP, AND WALKING ONE BUYS A WHOLE COARSE PASS
     * OF THE SAME ANSWER — once per window. See `_refusal`.
     *
     * ⚠️ And the skip belongs HERE, around the passes, not around this whole
     * block: the "could not read" return below lives inside it, so guarding the
     * block would send a refused node to the "no trades found" sentence — a
     * verdict about the TOKEN produced by a host refusing US, which is the
     * exact confusion this file exists to prevent. Measured: it did.
     */
    const refused = _refusal(lastErr);
    const coarse = refused
      ? { logs: [], stepped: 0, errs: 0, lastErr: null, walked: 0 }
      : await steppedLogs(chain, filter,
        { head, span, budget, want: maxTx * 2, step: Math.max(200, Math.ceil(span / budget)) });
    stepped = coarse.stepped; stepErrs = coarse.errs; walked = coarse.walked;
    if (coarse.lastErr) lastErr = coarse.lastErr;
    let found = coarse.logs;
    // ⚠️ A NODE THAT ANSWERED NOTHING AT ALL IS NOT RE-WALKED. When every
    // coarse step threw, the fine pass is the same silence 48 more times —
    // this file's own rule about a dead node, which the second pass would
    // otherwise triple the cost of.
    const coarseDead = coarse.stepped > 0 && coarse.errs === coarse.stepped;
    if (!found.length && !coarseDead && !refused) {
      const fine = await steppedLogs(chain, filter, { head, span, want: maxTx * 2, step: opts.step });
      stepped += fine.stepped; stepErrs += fine.errs;
      walked = Math.max(walked, fine.walked);
      if (fine.lastErr) lastErr = fine.lastErr;
      found = fine.logs;
    }
    if (found.length) logs = _chrono(found);   // see _chrono: neither `found` nor its reverse is sorted
    else if (!logs && (stepErrs > 0 || !stepped || refused)) {
      // A range with holes in it. "We could not look" — never cached, never
      // rendered as a fact about the token.
      return { ok: false, why: `could not read this token's transfers (${(lastErr && lastErr.message) || lastErr})` };
    }
    /*
     * ⚠️ …but a wide ask that FAILED over a stepped walk that cleanly covered
     * the whole span is an ANSWER about the span, not an outage. A range-capped
     * node rejects the wide request and serves every step (the exact shape
     * fbf33e2 was about, one probe over) — and reporting that as "could not
     * read" did two quiet harms at once: `ifaceFor` only ESCALATES to the wider
     * windows on "no trades found", and only CACHES a non-transport verdict, so
     * a quiet pad's token on a capped node was re-walked from scratch on every
     * attempt and never once looked in the window its trades were actually in.
     * The step size always covers the span within the budget (step is
     * ceil(span/budget), floored at 200 only where fewer steps than the budget
     * suffice), so zero step errors means zero holes. Fall through to
     * "no trades found", which escalates and caches.
     */
  }

  if (!logs || !logs.length) {
    // ⚠️ NO `--blocks` HERE. This string reaches a Telegram user through
    // curveTrade → core.buy, and there is no flag they can pass: prepareBuy
    // never populates `opts`, so the window is whatever this module chose.
    // Telling somebody to add a CLI flag to a chat message is the placeholder
    // defect wearing a different hat.
    // ⚠️ THE RANGE WALKED, NOT THE RANGE WANTED. Quoting `span` described a
    // search that did not happen: the old walk's steps were wider than this
    // node serves, so "the last 400000 blocks" covered nothing at all, and the
    // same sentence came back three times over an hour while the real reach
    // never changed.
    const reach = walked || span;
    return { ok: false, why: `no trades found for this token in the last ${reach} blocks${stepped ? ` (walked ${stepped} range(s) the node will serve)` : ''} — nothing to read its interface from yet` };
  }

  // Newest first: a curve's interface can change between deployments, and the
  // most recent trades are the ones a route built now has to match.
  const newest = logs.slice(-maxTx).reverse();

  /*
   * ⚠️ ONE SAMPLE PER TRANSACTION, NEVER PER LOG.
   *
   * The first cut pushed a sample for every Transfer it walked. A curve that
   * emits a FEE transfer alongside the trade transfer therefore produced TWO
   * samples for one trade — identical calldata, identical `value`, and one of
   * them carrying the FEE as its `amount`. Two consequences, both quiet:
   *
   *   · `classifySlots` needs `minSamples` (2) before it will assign meaning to
   *     an argument. Two logs from ONE trade satisfied that count, so a single
   *     trade could be read as if it were two independent ones.
   *   · anything reading `amount` as "what this trade paid out" could pick the
   *     fee log and price the trade at its own fee.
   *
   * So: group by transaction, ask the chain once per transaction, and keep the
   * ONE log that is the trade itself — the one that moves the token between the
   * curve and the TRADER. A payout to somebody who is not the trader is kept
   * only as a marked fallback, because that is a fact worth seeing rather than
   * one worth hiding: it is what a recipient ARGUMENT looks like from outside.
   */
  const byTx = new Map();
  for (const lg of newest) {
    const h = lg.transactionHash;
    if (!byTx.has(h)) byTx.set(h, []);
    byTx.get(h).push(lg);
  }

  /*
   * ⚠️ THE TRANSACTIONS ARE FETCHED TOGETHER, NOT ONE PER LOOP TURN.
   *
   * This loop awaited `getTransaction(hash)` inside itself, so a dozen samples
   * were a dozen SERIAL round trips — measured at 50ms simulated latency, the
   * card's whole tail was this: getBlockNumber → getLogs → tx → tx → tx …, and
   * on a real public RPC that is seconds on the one screen a user stares at
   * after pasting an address. They do not depend on each other; the only reason
   * they were serial is that the fetch sat in the loop that consumes them.
   *
   * The PROCESSING stays ordered and sequential — sample order decides which
   * trade defines the route — so only the waiting is collapsed.
   */
  const hashes = [...byTx.keys()];
  const fetched = await Promise.all(hashes.map((h) => chain.getTransaction(h).catch(() => null)));
  const txByHash = new Map(hashes.map((h, i) => [h, fetched[i]]));

  const calls = new Map(); // `${to}|${selector}` → record
  for (const [hash, group] of byTx) {
    const tx = txByHash.get(hash);
    if (!tx || !tx.to || !tx.data || tx.data.length < 10) continue;
    const to = lc(tx.to);
    const trader = lc(tx.from);
    const sel = tx.data.slice(0, 10).toLowerCase();
    const key = `${to}|${sel}`;
    const args = argsOf(tx.data, token);
    // ⚠️ `argsOf` READS AT MOST 8 WORDS, and a call we only half-read is a call
    // we cannot rebuild: `buildCurveCall` emits exactly the classified slots, so
    // a wider call would be silently TRUNCATED into malformed calldata. Usually
    // the decoder reverts and `simulate` catches it — caught by luck rather than
    // by rule, and a dynamic trailing argument can decode as empty and go
    // through. Recorded here so the build can refuse it outright.
    const wide = Math.floor((String(tx.data).length - 10) / 64) > args.length;

    const rec = calls.get(key) || { to, sel, n: 0, value: 0n, hash, args, from: null, into: null, samples: [], wide: false };
    rec.wide = rec.wide || wide;
    const v = BigInt(tx.value || 0);

    // The token moving OUT of the curve is a buy; INTO it is a sell. Direction
    // comes from the Transfer, never from `value` — a pad whose buy takes a
    // quote token has `value === 0` and judging by it alone calls every buy a
    // sell.
    const payout = group.filter((l) => topicAddr(l.topics && l.topics[1]) === to);
    const intake = group.filter((l) => topicAddr(l.topics && l.topics[2]) === to);
    const toTrader = payout.find((l) => topicAddr(l.topics && l.topics[2]) === trader);
    const fromTrader = intake.find((l) => topicAddr(l.topics && l.topics[1]) === trader);

    let lg = null, dir = null, exact = true;
    if (toTrader) { lg = toTrader; dir = 'buy'; }
    else if (fromTrader) { lg = fromTrader; dir = 'sell'; }
    else if (payout.length) {
      // The curve paid SOMEBODY ELSE. Kept, and marked: this is exactly what a
      // recipient argument looks like from outside, and dropping it would hide
      // the one shape a route must never reproduce blindly.
      lg = payout.reduce((a, b) => (logAmount(b) > logAmount(a) ? b : a));
      dir = 'buy'; exact = false;
    } else if (intake.length) {
      lg = intake.reduce((a, b) => (logAmount(b) > logAmount(a) ? b : a));
      dir = 'sell'; exact = false;
    } else { continue; }   // the token moved, but not to or from this contract

    /*
     * ⚠️ A BUY WITH NO `msg.value` IS PAID IN A QUOTE TOKEN — and which one is
     * in neither the calldata nor this token's own logs.
     *
     * `getLogs` was filtered to OUR token, so the quote leg is invisible here.
     * It is in the transaction's OTHER Transfer logs: the trader moved
     * something to the curve. One extra read, and only for the pads that need
     * it — a native-quoted buy never pays for this.
     *
     * Without it a quote-token pad is not merely unsupported, it is MIS-SIZED:
     * `value` is 0, so every slot correlates against the wrong number and the
     * amount-scaled argument reads as unexplained. The pad looks broken rather
     * than different.
     */
    let quote = null;
    const needQuote = (dir === 'buy' && v === 0n) || dir === 'sell';
    if (needQuote && typeof chain.getTransactionReceipt === 'function') {
      const rcpt = await chain.getTransactionReceipt(hash).catch(() => null);
      const other = ((rcpt && rcpt.logs) || []).filter((l) =>
        l && l.topics && l.topics[0] === TRANSFER_TOPIC && lc(l.address) !== lc(token));
      // A buy: the TRADER paid the curve. A sell: the CURVE paid the trader.
      let leg = dir === 'buy'
        ? other.find((l) => topicAddr(l.topics[1]) === trader && topicAddr(l.topics[2]) === to)
        : other.find((l) => topicAddr(l.topics[1]) === to && topicAddr(l.topics[2]) === trader);
      /*
       * ⚠️ AND WHEN A ROUTER SITS IN BETWEEN, THE TRADER IS NOT ON THE LEG.
       *
       * A pad whose website routes the buy (user → router → curve) pays the
       * curve from the ROUTER's address, so the trader-to-curve match finds
       * nothing and `quoteOf` — which requires every sample to carry one — went
       * null. The live refusal was exactly that: "this pad's buy is not paid in
       * the native coin, and its trades do not show what it IS paid in", about
       * a pad that plainly charges something.
       *
       * The FACT is what the curve RECEIVED (a buy) or PAID OUT (a sell) in
       * this transaction; who forwarded it does not change what the pad charges
       * in. Still read from the chain, still one token or none — `quoteOf`
       * refuses samples that disagree, which is what keeps a router's own fee
       * transfer from being read as the price.
       */
      if (!leg) {
        leg = dir === 'buy'
          ? other.find((l) => topicAddr(l.topics[2]) === to)
          : other.find((l) => topicAddr(l.topics[1]) === to);
      }
      if (leg) quote = { token: lc(leg.address), amount: logAmount(leg) };
    }

    /*
     * THE SIZE THIS SAMPLE IS DENOMINATED IN, decided where the direction is
     * known rather than guessed downstream.
     *
     * A buy's size is what was PAID — native, or the quote token. A sell's is
     * what was HANDED OVER, which is our token. Deriving it later from `value`
     * alone can never explain a sell (value is always 0 there), and deriving it
     * from `amount` alone reads a quote-token BUY's size as the tokens it
     * RECEIVED — the output, not the input.
     */
    const size = dir === 'buy'
      ? (v > 0n ? v : (quote ? quote.amount : 0n))
      : logAmount(lg);

    rec.n++;
    // ⚠️ EVERY SAMPLE IS KEPT, not just the biggest. One trade shows the SHAPE
    // of a call; it cannot show what any argument MEANS. A slot that holds 500
    // in one buy is a mystery — the same slot across three buys of different
    // sizes is either a constant, or a number that scales with the amount, and
    // those need opposite treatment when we build our own call.
    // ⚠️ THE TOKEN AMOUNT, TOO — because on a SELL `msg.value` is always zero.
    // The size a sell is denominated in lives in an argument, not in the value
    // field, so correlating slots against `value` alone can never explain a
    // sell's arguments.
    rec.samples.push({
      value: v,
      amount: logAmount(lg),
      size,
      quote,
      args,
      from: trader,
      to: topicAddr(lg.topics && lg.topics[2]),
      exact,
      hash,
    });
    // The largest value seen for this shape, so one dust trade does not hide a
    // real one.
    if (v > rec.value) { rec.value = v; rec.hash = hash; rec.args = args; }
    if (dir === 'buy') rec.from = to;
    if (dir === 'sell') rec.into = to;
    calls.set(key, rec);
  }
  if (!calls.size) return { ok: false, why: 'no decodable calls behind those transfers — they may all be plain wallet-to-wallet sends' };

  // THE CURVE IS THE CONTRACT THE TOKEN ITSELF MOVES TO AND FROM. A router or a
  // wallet that merely appears in the calldata does not; this is the one
  // property that separates the curve from every other address in the trace.
  const score = new Map();
  for (const r of calls.values()) {
    if (!r.from && !r.into) continue;
    score.set(r.to, (score.get(r.to) || 0) + r.n);
  }
  const curve = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (!curve) {
    return { ok: false, why: 'the token moved, but never to or from the contract that was called — no curve in these trades' };
  }

  /*
   * ⚠️ ONE QUOTE TOKEN, OR NONE. A leg whose samples disagree about what was
   * paid is a leg we do not understand — two pads behind one selector, a
   * router in the middle, or a read that went wrong. Picking the commonest
   * would put a guessed token address on a money path, which is the one thing
   * this module exists to refuse.
   */
  const quoteOf = (r) => {
    const q = r.samples.map((x) => x.quote).filter(Boolean);
    if (!q.length || q.length !== r.samples.length) return null;
    return q.every((x) => x.token === q[0].token) ? q[0].token : null;
  };

  const mine = [...calls.values()].filter((r) => r.to === curve);
  const buy = mine.filter((r) => r.from).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : b.n - a.n))[0] || null;
  const sell = mine.filter((r) => r.into && (!buy || r.sel !== buy.sel)).sort((a, b) => b.n - a.n)[0] || null;

  return {
    // ⚠️ `ok` USED TO MEAN "a BUY was observed", and prepareSell gated on it —
    // so a curve whose recent trades are all SELLS could not be sold, which is
    // exactly the market in which somebody wants out. A decoded sell leg is a
    // complete answer to the sell question; the buy question refuses on its own.
    ok: !!(buy || sell),
    why: (buy || sell) ? null : 'these trades show neither a buy nor a sell through the curve',
    curve,
    buy: buy && { selector: buy.sel, value: buy.value, args: buy.args, hash: buy.hash, seen: buy.n, native: buy.value > 0n, quote: quoteOf(buy), wide: buy.wide, samples: buy.samples },
    sell: sell && { selector: sell.sel, args: sell.args, hash: sell.hash, seen: sell.n, quote: quoteOf(sell), wide: sell.wide, samples: sell.samples },
    samples: newest.length,
  };
}

/** One line for the ops log / the card. Never a claim that a route EXISTS —
 *  only that an interface was observed. */
function describeIface(r) {
  if (!r || !r.ok) return (r && r.why) || 'no curve interface found';
  const shape = (leg) => (leg.args || []).map((x) => (x.isToken ? 'TOKEN' : x.addr ? 'addr' : x.num === null ? '?' : 'num')).join(',');
  // `ok` no longer implies a buy leg — a sell-only history is a complete answer
  // to the sell question, and this line has to survive that.
  const b = r.buy ? `buy ${r.buy.selector}${r.buy.native ? ' (payable)' : r.buy.quote ? ` (paid in ${r.buy.quote.slice(0, 10)}…)` : ''} args[${shape(r.buy)}]` : 'buy not seen';
  const sl = r.sell ? `sell ${r.sell.selector} args[${shape(r.sell)}]` : 'sell not seen';
  return `curve ${r.curve} · ${b} · ${sl}`;
}

module.exports = { decodeCurveIface, describeIface, steppedLogs, TRANSFER_TOPIC, LOG_STEP, LOG_STEPS, _argsOf: argsOf, _wordAddr: wordAddr };

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT DOES EACH ARGUMENT MEAN?
 *
 * Knowing a call's SHAPE is not knowing how to make one. `buy(address,uint256)`
 * with the observed words `[TOKEN, 500]` says nothing about whether 500 is a
 * minimum-out, a deadline, a referrer code or a slippage bound — and building
 * our own buy means putting OUR number in that slot. Guessing there is the same
 * class of mistake as guessing the contract address, with the same consequence.
 *
 * One trade cannot answer it. SEVERAL CAN, because the samples differ:
 *
 *   • a slot equal to the token, in every sample            → the token
 *   • a slot equal to that sample's SENDER                  → the recipient
 *   • a slot whose value/msg.value ratio holds across
 *     samples of different sizes                            → scales with the trade
 *   • a slot identical in every sample                      → a constant
 *   • anything else                                         → UNKNOWN
 *
 * ⚠️ AND UNKNOWN IS A REFUSAL, NOT A DEFAULT. A slot nobody can explain is the
 * one that must stop the buy: filling it with the value from somebody else's
 * trade is how a bot sends a stranger's referrer code, an expired deadline, or
 * a minimum-out computed for an amount 100× ours. "A missed trade is a shrug;
 * spending wrongly is not" — this repo's own rule, one module over.
 */

/** Two ratios agree if they are within `tolBps` of each other. Curves are not
 *  linear, so a minimum-out does NOT scale exactly with the amount — the test
 *  is that it tracks, not that it matches. */
const ratioClose = (a, b, tolBps) => {
  if (a === 0n || b === 0n) return a === b;
  const hi = a > b ? a : b, lo = a > b ? b : a;
  return (hi - lo) * 10000n <= hi * BigInt(tolBps);
};

/**
 * Per-slot roles for a decoded leg, from its samples.
 *
 * `minSamples` is 2 by default: with one sample every slot is "constant", which
 * is true and useless — and would let a referrer code be reused as a constant
 * while a minimum-out is frozen at somebody else's number.
 */
function classifySlots(leg, token, opts = {}) {
  const minSamples = Math.max(1, Number(opts.minSamples) || 2);
  const tolBps = Number(opts.tolBps) || 4000;      // curves bend; 40% is "tracks", not "equals"
  const samples = (leg && leg.samples) || [];
  const width = leg && leg.args ? leg.args.length : 0;
  const out = { ok: false, why: null, slots: [], samples: samples.length };

  if (!width) { out.ok = true; out.why = null; return out; }   // no arguments at all is a complete answer
  if (samples.length < minSamples) {
    out.why = `only ${samples.length} sample${samples.length === 1 ? '' : 's'} of this call — at least ${minSamples} are needed before an argument's meaning can be inferred`;
    out.slots = leg.args.map((a, i) => ({ i, role: 'unknown', value: a.word }));
    return out;
  }

  for (let i = 0; i < width; i++) {
    const words = samples.map((s) => (s.args[i] ? s.args[i].word : null));
    if (words.some((w) => w === null)) { out.slots.push({ i, role: 'unknown', why: 'not present in every sample' }); continue; }
    const first = samples[0].args[i];

    if (samples.every((s) => s.args[i].isToken)) { out.slots.push({ i, role: 'token' }); continue; }
    if (samples.every((s) => s.args[i].addr && s.from && s.args[i].addr === s.from)) { out.slots.push({ i, role: 'sender' }); continue; }

    const same = words.every((w) => w === words[0]);
    /*
     * ⚠️ A CONSTANT ADDRESS IS THE ONE SLOT THAT MOVES SOMEBODY ELSE'S MONEY.
     *
     * The token and the sender are already handled above, so an address slot
     * that is identical across every sample is a STRANGER'S address — a
     * recipient, a referrer, a router; nothing here can tell which. Replayed as
     * a 'constant' it would go into our calldata verbatim, and the recipient
     * reading is the ordinary one when the only trades on file are the dev's,
     * from one wallet into another.
     *
     * That failure is invisible to every gate downstream: `estimateGas`
     * succeeds (the call is perfectly valid) and the price check succeeds (the
     * AMOUNT is right — it is the destination that is wrong), so the buy lands
     * on-chain with the tokens minted to somebody else and the only thing that
     * notices is a balance read after the money is gone.
     *
     * So it is UNKNOWN, which is a refusal. The zero address is exempt: it is
     * the same 32 bytes as the number 0, it is what an unused optional slot
     * holds, and sending it to nobody is not sending it to a stranger.
     */
    if (same && first.addr && !/^0+$/.test(first.word)) {
      out.slots.push({ i, role: 'unknown', addr: first.addr, why: `every sample puts the same address (${first.addr}) here and it is neither the token nor the trader — replaying a stranger's address is how a buy pays out to somebody else` });
      continue;
    }
    // A slot that scales BEFORE one that is merely constant: on a run of
    // equal-sized samples an amount slot is also constant, and freezing it
    // would send a minimum-out computed for a trade that is not ours.
    const values = samples.map((s) => s.args[i].num);
    // The SIZE this leg is denominated in: what was paid on a buy, what was
    // handed over on a sell. Without the second half a sell explains nothing.
    // `size` is decided at collection time, where the direction is known. The
    // fallback keeps older shapes (and the unit tests' hand-built legs) working.
    const vals = samples.map((s) => (s.size != null ? BigInt(s.size) : (s.value > 0n ? s.value : BigInt(s.amount || 0))));
    const varied = vals.some((v) => v !== vals[0]);
    if (varied && values.every((n) => n !== null && n > 0n) && vals.every((v) => v > 0n)) {
      const r0 = (values[0] * 10n ** 18n) / vals[0];
      if (samples.every((s, k) => ratioClose((values[k] * 10n ** 18n) / vals[k], r0, tolBps))) {
        out.slots.push({ i, role: 'scales', ratioE18: r0 });
        continue;
      }
    }
    if (same) { out.slots.push({ i, role: 'constant', value: first.word }); continue; }
    out.slots.push({ i, role: 'unknown', why: 'differs between samples with no relationship to the amount' });
  }

  const bad = out.slots.filter((s) => s.role === 'unknown');
  out.ok = bad.length === 0;
  // ⚠️ Never "the token cannot be traded" — only "we cannot build this call
  // safely yet". A wider window, or one more trade on the pad, changes it.
  if (!out.ok) out.why = `argument${bad.length === 1 ? '' : 's'} ${bad.map((s) => s.i).join(', ')} could not be explained from ${samples.length} samples`;
  return out;
}

module.exports.classifySlots = classifySlots;
module.exports._ratioClose = ratioClose;
