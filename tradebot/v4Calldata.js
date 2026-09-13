'use strict';
/*
 * READ A LAUNCHPAD ROUTER'S OWN CALLDATA, AND TAKE THE POOL OUT OF IT.
 *
 * WHY THIS EXISTS
 * `curveIface` reads a curve's interface off real trades by classifying FLAT
 * 32-byte words. That works for a bonding curve — `buy(token, minOut)` and its
 * cousins — and it cannot work for a ROUTER, whose arguments are a dynamic
 * path array. On the reported token the trades decode to
 *
 *   swap((uint8,address,address,address,uint24,int24,address,bytes,address,
 *         bytes32)[], address, uint256, uint256, uint256)
 *
 * and what `argsOf` sees in the first eight words is `0xa0`, `0x60`, `0x1c0` —
 * ABI OFFSETS into dynamic data, not values. It refuses, correctly: rebuilding
 * a call from half-read dynamic encoding emits malformed calldata, which is
 * what the `wide` flag already exists to prevent.
 *
 * So the token looked untradeable while a competitor traded it happily. The
 * difference is that the competitor hand-writes an integration per launchpad
 * and knows the ABI. This does better than that, and does it without trusting
 * anybody's word for the ABI.
 *
 * ⚠️ NOTHING FROM THAT CALLDATA IS EVER REPLAYED. This module extracts ONE
 * thing — the PoolKey — and hands it to `v4.bestPool`, which reads the pool's
 * own state from the chain and builds OUR swap through the router it discovers
 * and simulates. A stranger's calldata never reaches a signer, so a hostile or
 * malformed trade can at worst name a pool that does not exist, which the state
 * read then drops.
 *
 * THREE PROOFS, AND NONE OF THEM IS AN INFERENCE
 *
 *   1. SELECTOR. A candidate signature is used only when keccak of it equals
 *      the 4-byte selector the real trade actually carried. That is what makes
 *      the signature a fact rather than a guess — this repo's standing ban is
 *      on GUESSED ABIs, and a hash match is not a guess.
 *
 *   2. ROUND TRIP. The decoded arguments are RE-ENCODED and required to be
 *      byte-identical to the original calldata. A signature can collide with a
 *      selector and still describe a different layout; it cannot also reproduce
 *      the exact bytes. This is the step that turns "the name matches" into
 *      "the layout matches".
 *
 *   3. POOL ID. The tuple's fields are NOT read by position — that is precisely
 *      the trap, and the one place a plausible-looking mistake would put a
 *      wrong address on a money path. Every assignment of (currency0,
 *      currency1, fee, tickSpacing, hooks) is tried, and one is accepted only
 *      when `keccak(abi.encode(...))` equals a bytes32 the tuple itself
 *      carries. v4 derives a pool's id exactly that way, so a wrong assignment
 *      would have to produce a keccak collision.
 *
 * ⚠️ AND OUR TOKEN MUST BE ONE OF THE TWO CURRENCIES. A router path names every
 * hop, including pools that have nothing to do with us; taking one of those
 * would price and trade a stranger's pair under our token's ticker.
 */
const { ethers } = require('ethers');

const coder = ethers.AbiCoder.defaultAbiCoder();
const NATIVE = '0x0000000000000000000000000000000000000000';
const lc = (s) => String(s == null ? '' : s).toLowerCase();

/*
 * Candidate router signatures.
 *
 * ⚠️ THIS IS A LIST AND IT IS ENV-OVERRIDABLE, for the reason every host list in
 * this repo is: a launchpad that redeploys with a different router costs a line
 * in `.env` rather than a deploy. Being on this list buys a candidate NOTHING —
 * it still has to match the selector, round-trip byte-identically, and produce a
 * PoolKey whose id the tuple itself carries. An entry that is wrong is inert,
 * not dangerous, which is why adding one is cheap.
 *
 * The first was read off the chain: `abi:check` found selector 0x4d819a2a in six
 * real trades, and this signature's keccak is that selector.
 */
const MAX_HASHES = Math.max(1000, Number(process.env.V4_CALLDATA_MAX_HASHES || 20000));

const DEFAULT_SIGS = [
  'swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256)',
];

function sigs() {
  const raw = String(process.env.V4_ROUTER_SIGS || '').trim();
  const extra = raw ? raw.split('|').map((x) => x.trim()).filter(Boolean) : [];
  // The operator's entries lead: an override exists to be tried first.
  return [...extra, ...DEFAULT_SIGS];
}

/** The 4-byte selector a signature hashes to. */
const selectorOf = (sig) => ethers.id(sig).slice(0, 10);

/**
 * Decode calldata with a signature PROVEN to describe it, or null.
 *
 * Proof 1 (selector) and proof 2 (round trip) both live here. The re-encode is
 * the load-bearing half: a selector match alone says a name hashed the same way,
 * and says nothing about whether the arguments are laid out as claimed.
 */
function decodeVerified(data, opts = {}) {
  const hex = lc(data);
  if (!/^0x[0-9a-f]{8,}$/.test(hex)) return null;
  const sel = hex.slice(0, 10);
  for (const sig of (opts.sigs || sigs())) {
    if (selectorOf(sig) !== sel) continue;            // proof 1
    try {
      const iface = new ethers.Interface([`function ${sig}`]);
      const name = sig.slice(0, sig.indexOf('('));
      const args = iface.decodeFunctionData(name, hex);
      // proof 2 — the layout, not just the name.
      if (lc(iface.encodeFunctionData(name, args)) !== hex) continue;
      return { sig, name, args };
    } catch (_) { /* this candidate does not describe these bytes */ }
  }
  return null;
}

/** Every value of a given shape anywhere inside a decoded argument tree.
 *  Positions are deliberately NOT used — see proof 3. */
function _harvest(node, out, depth = 0) {
  if (node == null || depth > 6) return out;
  if (typeof node === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(node)) out.addrs.add(lc(node));
    else if (/^0x[0-9a-fA-F]{64}$/.test(node)) out.ids.add(lc(node));
    return out;
  }
  if (typeof node === 'bigint' || typeof node === 'number') {
    const n = BigInt(node);
    /*
     * A fee is a uint24 and a tickSpacing an int24, so both are small — but a
     * NEGATIVE tick spacing has two spellings and only one of them is ethers'.
     * ethers decodes `int24` to a real negative BigInt (`-120n`); a raw word
     * lifted straight out of calldata would instead be the two's-complement
     * value near 2^256. Offering only the unsigned reading silently failed to
     * prove a perfectly ordinary hooked pool, so both are offered and the
     * poolId check decides which is real.
     */
    if (n >= 0n && n < 0x1000000n) out.small.add(Number(n));
    else if (n < 0n && n > -0x800000n) out.small.add(Number(n));
    else if (n > (1n << 255n)) { const neg = n - (1n << 256n); if (neg > -0x800000n) out.small.add(Number(neg)); }
    return out;
  }
  if (Array.isArray(node) || (node && typeof node[Symbol.iterator] === 'function' && typeof node !== 'string')) {
    for (const v of node) _harvest(v, out, depth + 1);
  }
  return out;
}

/**
 * The PoolKeys this calldata PROVES, for `token`.
 *
 * Proof 3. Nothing is read by position: every plausible assignment is hashed and
 * kept only when the result is a bytes32 the calldata already carried. v4 is
 * defined so that `poolId = keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing, hooks))`, so a wrong assignment would need a keccak collision.
 *
 * `poolId` is injected rather than imported to keep this module free of the
 * chain — one owner for the hash lives in `v4.js`, and two would eventually
 * disagree about the very thing being proved.
 */
/*
 * Every 32-byte WORD of the raw calldata, without decoding anything.
 *
 * ⚠️ THIS IS WHY THE SIGNATURE LIST STOPPED BEING A REQUIREMENT, and it is the
 * whole difference between working on one launchpad and working on all of them.
 * The first cut could only read a router whose signature was already known —
 * which is hand-writing an integration per pad, the very thing this was supposed
 * to beat. A pad we had not met (flap.sh) decoded to nothing and its token read
 * as unroutable.
 *
 * ABI encoding lays EVERYTHING out in 32-byte words — a tuple array's contents,
 * a nested dynamic tail, all of it — so reading the words is strictly MORE
 * complete than decoding, not less. And it costs no safety: proofs 1 and 2 exist
 * to justify UNDERSTANDING a call, and nothing here understands one. Exactly one
 * value is extracted — a PoolKey — and it is kept only when the chain's own
 * `poolId` hash of it matches a word the calldata already carried, which a wrong
 * reading cannot fake.
 */
function _words(data) {
  const out = { addrs: new Set(), ids: new Set(), small: new Set() };
  const body = lc(data).slice(10);                         // past the selector
  for (let i = 0; i + 64 <= body.length; i += 64) {
    const w = body.slice(i, i + 64);
    out.ids.add('0x' + w);
    // An address is 12 zero bytes then 20 non-zero-ish bytes. The zero address
    // is deliberately NOT collected as an address: it is the same 32 bytes as
    // the number 0, and it is offered as a `hooks` candidate regardless.
    if (/^0{24}[0-9a-f]{40}$/.test(w) && !/^0{64}$/.test(w)) out.addrs.add('0x' + w.slice(24));
    // A fee is a uint24 and a tickSpacing an int24 — so both are small, in one
    // of two spellings. Negative ticks arrive as two's complement in raw words.
    const n = BigInt('0x' + w);
    if (n < 0x1000000n) out.small.add(Number(n));
    else if (n > (1n << 255n)) { const neg = n - (1n << 256n); if (neg > -0x800000n) out.small.add(Number(neg)); }
  }
  return out;
}

/** Merge b's three sets into a. */
function _merge(a, b) {
  for (const k of ['addrs', 'ids', 'small']) for (const v of b[k]) a[k].add(v);
  return a;
}

function poolKeysFrom(data, token, poolId, opts = {}) {
  const hex = lc(data);
  if (!/^0x[0-9a-f]{8,}$/.test(hex)) return [];
  const tok = lc(token);
  if (!/^0x[0-9a-f]{40}$/.test(tok)) return [];

  // The raw words are the floor — they work for a router nobody has met. A
  // signature we DO know is merged on top: it costs one decode and can only add
  // candidates, never remove one.
  const h = _words(hex);
  const dec = decodeVerified(hex, opts);
  if (dec) _merge(h, _harvest(dec.args, { addrs: new Set(), ids: new Set(), small: new Set() }));
  if (!h.ids.size) return [];               // nothing to check an assignment against
  // ⚠️ OUR TOKEN MUST BE IN THERE. A router path names every hop; a pool that
  // does not contain this token is somebody else's pair.
  if (!h.addrs.has(tok)) return [];

  // v4 requires currency0 < currency1, so the pair is ORDERED rather than
  // permuted — which also halves the search.
  const others = [...h.addrs].filter((a) => a !== tok);
  const hooksC = [NATIVE, ...h.addrs];
  const smalls = [...h.small];
  const out = [];
  const seen = new Set();
  /*
   * ⚠️ BOUNDED. Reading raw words instead of a decoded tree makes the candidate
   * sets as large as the calldata, and this runs on the card's critical path —
   * an unbounded search here would be the 12s refusal in a third disguise. It
   * is MEASURED, not guessed: `v4.poolId` costs ~23µs, so 20,000 is ~0.45s of
   * worst case, and a real router call (a dozen addresses, a handful of small
   * ints) is an order of magnitude under it.
   */
  /*
   * ⚠️ THE BUDGET IS THE CALLER'S, NOT THIS CALL'S. `tradePoolKeys` reads up to
   * six transactions, so a per-call cap is six times the ceiling it claims to
   * be — 120,000 hashes is ~2.8s of pure CPU on the card's critical path and on
   * every snipe poll. A caller that reads several calls passes ONE budget and
   * they share it.
   */
  const budget = opts.budget || { left: MAX_HASHES };
  for (const other of others) {
    const [c0, c1] = tok < other ? [tok, other] : [other, tok];
    for (const fee of smalls) {
      if (fee < 0) continue;                                  // a fee is unsigned
      for (const ts of smalls) {
        for (const hooks of hooksC) {
          if (budget.left-- <= 0) return out;
          let id;
          try { id = lc(poolId(c0, c1, fee, ts, hooks)); } catch (_) { continue; }
          if (!h.ids.has(id) || seen.has(id)) continue;
          seen.add(id);
          out.push({ id, currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks, quote: other, tokenIsZero: c0 === tok, from: 'calldata' });
        }
      }
    }
  }
  return out;
}

module.exports = { decodeVerified, poolKeysFrom, selectorOf, DEFAULT_SIGS, sigs, _harvest, _words, MAX_HASHES };
