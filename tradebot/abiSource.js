'use strict';
/*
 * THE PUBLISHED ABI, WHERE ONE EXISTS — because a guess must lose to an answer.
 *
 * `curveIface` + `curveRoute` infer a launchpad curve's interface from real
 * trades. That works on any contract, and it is the LAST resort, not the first:
 * inference can tell that a slot "tracks the amount", but it can never tell you
 * the slot is called `minTokensOut` rather than `maxSlippageBps`. Two readings
 * that produce the same calldata for the sample and different calldata for
 * ours.
 *
 * There are two places the real answer is simply published, and neither had
 * been asked:
 *
 *   1. THE CHAIN'S OWN EXPLORER. Robinhood Chain runs one
 *      (explorer.mainnet.chain.robinhood.com), and a verified contract there
 *      carries its ABI — function names, parameter names, parameter types.
 *      Authoritative, free, and one request.
 *   2. THE 4-BYTE REGISTRY. Even for an UNVERIFIED contract, the selector we
 *      discovered usually resolves to a known signature, which gives the types
 *      and often the intent.
 *
 * So the order is: published ABI → 4-byte signature → inference. And when a
 * published source answers, the inference does not become redundant — it
 * becomes the CROSS-CHECK. If the ABI says argument 1 is `uint256 minTokensOut`
 * and the samples say argument 1 scales with the amount, those agree and the
 * confidence is real. If they disagree, something is wrong and neither reading
 * may be signed.
 *
 * ⚠️ NOTHING HERE IS TRUSTED BECAUSE IT IS OFFICIAL-LOOKING. An explorer can
 * serve an ABI for a proxy, a different implementation, or an unrelated
 * contract someone verified at that address on a forked chain. The selector we
 * OBSERVED on-chain must appear in the ABI it returns; if it does not, the ABI
 * is about some other contract and is discarded.
 */
const { ethers } = require('ethers');

const TIMEOUT_MS = Number(process.env.ABI_SOURCE_TIMEOUT_MS) || 8000;
/** The public 4-byte registry. Overridable, and `ABI_4BYTE=0` turns it off —
 *  it is a third party on a path that informs a trade. */
const FOURBYTE = String(process.env.ABI_4BYTE_API || 'https://www.4byte.directory/api/v1/signatures/').replace(/\/+$/, '') + '/';
const fourByteOn = () => !/^(0|false|off|no)$/i.test(String(process.env.ABI_4BYTE ?? '').trim());

async function getJson(url, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

/** Did we FAIL TO ASK, or did the explorer answer and have nothing?
 *
 *  ⚠️ These are opposite conclusions and they printed identically. A Cloudflare
 *  403 in front of an explorer would have read as "this contract is not
 *  verified", sending the caller down the inference path — with a published ABI
 *  sitting there unread. The rule this repo states about `pumpfunNewX`, on the
 *  source that decides how much a curve route can be trusted. A 4xx that is not
 *  a refusal (404: no such contract) IS an answer. */
const refused = (e) => !e || !e.status || e.status === 429 || e.status === 403 || e.status === 401 || e.status >= 500;

/** ⚠️ AN EXPLORER THAT ANSWERS **HTML** IS ITS OWN DIAGNOSIS. `Unexpected token
 *  < in JSON` is what a Cloudflare interstitial, a login wall or a wrong API
 *  path all look like from inside a JSON parser, and reporting it as a bare
 *  parse error sends the reader hunting through this code for a bug that is not
 *  here. It is still "could not ask" — but the operator needs to know it was
 *  the explorer talking, not us mis-parsing. */
// Both V8 spellings: `Unexpected token < in JSON at position 0` (node 18, which
// production runs) and `Unexpected token '<', "<!DOCTYPE"... is not valid JSON`
// (node 20+). A regex that only knew one would report the box's own message
// raw — which is the exact defect this exists to fix.
const htmlish = (e) => /Unexpected token\s*'?</i.test(String((e && e.message) || e)) || /<!DOCTYPE|<html/i.test(String((e && e.message) || e));
const explain = (e) => (htmlish(e)
  ? 'answered HTML rather than JSON (a Cloudflare page, a login wall, or this is not the API path)'
  : (e && e.message) || String(e));

/**
 * The 4-byte selector of a human-readable signature, e.g. "buy(address,uint256)".
 *
 * ⚠️ THE SHAPE IS CHECKED FIRST. `ethers.id()` hashes any string at all, so an
 * unvalidated call turns garbage into a perfectly plausible-looking selector —
 * and the 4-byte registry's entries are submitted by anyone, so garbage is a
 * realistic input rather than a hypothetical one. `null` for anything that is
 * not `name(types)`.
 */
const SIG_RE = /^[A-Za-z_$][A-Za-z0-9_$]*\([A-Za-z0-9_$,\[\]]*\)$/;
function selectorOf(sig) {
  const flat = String(sig == null ? '' : sig).replace(/\s+/g, '');
  if (!SIG_RE.test(flat)) return null;
  try { return ethers.id(flat).slice(0, 10).toLowerCase(); } catch (_) { return null; }
}

/**
 * A verified contract's ABI from the chain's explorer.
 *
 * Two shapes, because explorers come in two families and which one a chain runs
 * is not something this code should have an opinion about: Blockscout's v2 REST
 * and the Etherscan-compatible `?module=contract&action=getabi`. Tried in that
 * order; the first that parses wins.
 */
async function fetchVerifiedAbi(explorerBase, address, opts = {}) {
  const base = String(explorerBase || '').replace(/\/+$/, '');
  if (!base || !/^0x[a-fA-F0-9]{40}$/.test(String(address || ''))) return { ok: false, why: 'no explorer or bad address' };
  const f = opts.fetchImpl;
  const tried = [];
  let couldNotAsk = 0, attempts = 0;

  // Blockscout v2 — the shape most L2 explorers run today.
  try {
    const j = await getJson(`${base}/api/v2/smart-contracts/${address}`, f);
    if (j && Array.isArray(j.abi) && j.abi.length) return { ok: true, abi: j.abi, source: 'blockscout', name: j.name || null };
    tried.push('blockscout: no abi in the answer (contract not verified)');
    attempts++;
  } catch (e) { attempts++; if (refused(e) || htmlish(e)) couldNotAsk++; tried.push(`blockscout: ${explain(e)}`); }

  // Etherscan-compatible.
  try {
    const j = await getJson(`${base}/api?module=contract&action=getabi&address=${address}`, f);
    if (j && String(j.status) === '1' && j.result) {
      const abi = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
      if (Array.isArray(abi) && abi.length) return { ok: true, abi, source: 'etherscan-compatible', name: null };
    }
    tried.push(`etherscan-compatible: ${(j && j.result) || 'no abi'}`);
    attempts++;
  } catch (e) { attempts++; if (refused(e) || htmlish(e)) couldNotAsk++; tried.push(`etherscan-compatible: ${explain(e)}`); }

  // `reachable:false` means the explorer could not be ASKED. The caller must not
  // read that as "unverified" and fall through to inference as though the
  // question had been settled.
  const reachable = couldNotAsk < attempts;
  return {
    ok: false,
    reachable,
    why: reachable
      ? `no verified ABI at ${address} — ${tried.join(' · ')}`
      : `could not reach the explorer for ${address} — ${tried.join(' · ')}`,
  };
}

/**
 * The ABI entry whose selector matches one we OBSERVED on-chain.
 *
 * ⚠️ THE MATCH IS THE VERIFICATION. An explorer will happily serve an ABI for a
 * proxy, for a different implementation, or for whatever somebody verified at
 * that address — none of which need describe the call we watched happen. If the
 * observed selector is not in the ABI, the ABI is about some other contract.
 */
function entryForSelector(abi, selector) {
  if (!Array.isArray(abi) || !selector) return null;
  for (const e of abi) {
    if (!e || e.type !== 'function' || !Array.isArray(e.inputs)) continue;
    const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
    if (selectorOf(sig) === String(selector).toLowerCase()) return { ...e, signature: sig };
  }
  return null;
}

/** The public 4-byte registry's candidate signatures for a selector, newest id
 *  last — the registry is append-only and collisions are submitted by anyone,
 *  so this returns EVERY candidate rather than choosing one. */
async function fourByteSignatures(selector, opts = {}) {
  if (!fourByteOn()) return { ok: false, why: '4-byte lookup is off (ABI_4BYTE=0)' };
  if (!/^0x[a-fA-F0-9]{8}$/.test(String(selector || ''))) return { ok: false, why: 'not a 4-byte selector' };
  try {
    const j = await getJson(`${FOURBYTE}?hex_signature=${selector}`, opts.fetchImpl);
    const sigs = (j && Array.isArray(j.results) ? j.results : []).map((r) => r && r.text_signature).filter(Boolean);
    return sigs.length ? { ok: true, signatures: sigs } : { ok: false, why: 'the registry has no signature for this selector' };
  } catch (e) { return { ok: false, why: `4byte: ${(e && e.message) || e}` }; }
}

/**
 * What a PUBLISHED parameter is for, from its name and type.
 *
 * Names, because a launchpad's `buy(address token, uint256 minTokensOut)` says
 * in words what inference can only approximate. Deliberately conservative: an
 * unrecognised name is `unknown`, and unknown refuses — the same line
 * `classifySlots` draws. Guessing here would throw away the entire advantage of
 * having the real ABI.
 */
function roleOfParam(p) {
  const n = String((p && p.name) || '').toLowerCase();
  const t = String((p && p.type) || '').toLowerCase();
  if (t === 'address') {
    if (/token|coin|asset|mint/.test(n)) return 'token';
    if (/to|recipient|receiver|beneficiary|for|account/.test(n)) return 'sender';
    if (/ref|affiliate|partner/.test(n)) return 'constant';
    return 'unknown';
  }
  if (/^uint/.test(t)) {
    if (/deadline|expiry|expires|validuntil/.test(n)) return 'deadline';
    if (/min|amountout|tokensout|outmin|slippage/.test(n)) return 'scales';
    if (/amountin|amount|value|qty|quantity|tokens/.test(n)) return 'scales';
    if (/fee|tier|bps|nonce|id|index/.test(n)) return 'constant';
    return 'unknown';
  }
  return 'unknown';
}

/** Roles for every parameter of a published entry, in call order. */
const rolesOfEntry = (entry) => (entry && Array.isArray(entry.inputs) ? entry.inputs.map((p, i) => ({ i, role: roleOfParam(p), name: p.name || null, type: p.type })) : []);

/**
 * Does the PUBLISHED reading agree with what the trades showed?
 *
 * The point of having both. A slot the ABI calls `minTokensOut` should be the
 * slot the samples showed tracking the amount; if the ABI says `deadline` where
 * the samples say it scales with size, one of the two readings is about a
 * different function and nothing may be signed on either.
 *
 * `deadline` is exempt: it is a timestamp, so it legitimately differs between
 * samples with no relation to the amount — which is precisely what inference
 * alone calls `unknown` and refuses. Recovering that case is the single biggest
 * thing a published ABI buys.
 */
function reconcile(published, inferred) {
  const out = { ok: true, why: null, slots: [] };
  if (!published.length) return { ok: false, why: 'nothing published to reconcile', slots: [] };
  for (let i = 0; i < published.length; i++) {
    const p = published[i];
    const inf = inferred.find((s) => s.i === i);
    if (p.role === 'unknown') { out.ok = false; out.why = `the ABI names argument ${i} "${p.name || '?'}" (${p.type}), which Dexvra does not know how to fill`; out.slots.push({ ...p, agree: false }); continue; }
    if (!inf || inf.role === 'unknown' || p.role === 'deadline') { out.slots.push({ ...p, agree: true, inferred: inf ? inf.role : null }); continue; }
    if (inf.role !== p.role) {
      out.ok = false;
      out.why = `argument ${i}: the ABI calls it "${p.name || p.type}" (${p.role}) but the trades show it behaving as ${inf.role} — refusing rather than picking one`;
      out.slots.push({ ...p, agree: false, inferred: inf.role });
      continue;
    }
    out.slots.push({ ...p, agree: true, inferred: inf.role, ratioE18: inf.ratioE18 });
  }
  return out;
}

/**
 * Does a signature's parameter SHAPE match what we watched on-chain?
 *
 * The 4-byte registry gives types and no names, so `roleOfParam` can say very
 * little from it — but the shape is still a real, independent check. The live
 * box observed `args[num,num,addr]` and the registry answered
 * `buy(uint256,uint256,address)`: two sources that have never met, agreeing.
 * A registry entry whose arity or types disagree is about a COLLIDING selector
 * — the registry is anyone-submitted and collisions are routine — and must be
 * discarded rather than averaged in.
 *
 * ⚠️ IT MAY ONLY EVER DISCARD A CANDIDATE, never authorise one. Two readings
 * can share a shape and mean different things, which is the whole reason
 * `classifySlots` exists.
 *
 * ⚠️ AND AN ALL-ZERO WORD IS COMPATIBLE WITH EVERYTHING. `address(0)` and the
 * number 0 are the same 32 bytes, so a slot holding one must not be read as a
 * contradiction of either type — the first cut refused a correct signature over
 * a zero referrer address. `wordAddr` deliberately rejects a low number as an
 * address, so a word that IS address-shaped is a real signal in the other
 * direction: a uint256 large enough to look like one is ~2^128, which no
 * amount on any chain reaches.
 */
function shapeMatches(signature, observedArgs) {
  const m = /^[^(]+\((.*)\)$/.exec(String(signature || '').replace(/\s+/g, ''));
  if (!m) return { ok: false, why: 'not a signature' };
  const types = m[1] ? m[1].split(',') : [];
  const args = observedArgs || [];
  if (types.length !== args.length) return { ok: false, why: `signature takes ${types.length} argument(s); the trades show ${args.length}` };
  for (let i = 0; i < types.length; i++) {
    const t = types[i], a = args[i] || {};
    if (/^0*$/.test(String(a.word || ''))) continue;   // zero: address(0) and 0 are one word
    if (t === 'address' && !a.addr) return { ok: false, why: `argument ${i} is an address in the signature, but the trades put a plain number there` };
    if (/^u?int\d*$/.test(t) && a.addr) return { ok: false, why: `argument ${i} is a number in the signature, but the trades put an address there` };
  }
  return { ok: true, why: null, types };
}

module.exports = { fetchVerifiedAbi, entryForSelector, fourByteSignatures, roleOfParam, rolesOfEntry, reconcile, selectorOf, shapeMatches };
