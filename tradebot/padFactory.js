'use strict';
/*
 * WHERE A LAUNCHPAD'S LAUNCHES ARE ANNOUNCED ON-CHAIN — one owner.
 *
 * `watchers.js` reads these to SEE launches; `core.js` reads them to find a
 * SIBLING token on the same pad, which is how a fresh launch's curve interface
 * is learned without waiting for the fresh token to be traded. Two copies of a
 * factory address and a topic0 is how the two of them would eventually disagree
 * about which contract a pad announces from — the repo's own "one repo, two
 * answers" rule, on values that were already measured wrong twice before the
 * box settled them.
 *
 * Everything here is env-overridable and read PER CALL, so `--update-env` plus
 * a restart is the whole fix when a pad redeploys.
 */
const { ethers } = require('ethers');

// Both live Pons deployments, measured on the box (see CLAUDE.md — the two
// researched guesses that shipped before these were BOTH wrong).
const PONS_FACTORY_DEFAULT = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e,0xe33e9e479df8802cb0866d5d05258bec4cf62948';
// The topic0 the launchpad actually emits. It is a HASH with no name attached —
// 1050 candidate `name(argtypes)` spellings were hashed against it and none
// matched, so the event's ABI is genuinely unknown and every consumer must work
// without one. A human-readable PONS_EVENT still wins wherever somebody learns
// the real spelling; KNOWN_SIGS is where it lands so the decode path lights up
// again by itself.
const PONS_TOPIC0_DEFAULT = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const PONS_EVENT_DEFAULT = PONS_TOPIC0_DEFAULT;
const PONS_KNOWN_SIGS = [
  'event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)',
];

const envs = (k, d) => { const v = String(process.env[k] == null ? '' : process.env[k]).trim(); return v || d; };
const isTopic0 = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || '').trim());
/** topic0 for a human-readable `event Foo(...)` — the canonical `Foo(t1,t2)`
 *  form ethers hashes, with `indexed` and parameter names stripped. */
function sigTopic(sig) {
  try { return ethers.EventFragment.from(sig).topicHash; } catch (_) { return null; }
}

/** Read PER CALL, not at require time, so `--update-env` + restart is the whole
 *  fix — and so the kill switch shares LAUNCHPAD_PONS with the HTTP pad: an
 *  operator turning Pons off must not have to know it is two mechanisms. */
function ponsCfg() {
  const flag = envs('LAUNCHPAD_PONS', '').toLowerCase();
  const on = !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
  const raw = envs('PONS_EVENT', PONS_EVENT_DEFAULT);
  // Two spellings, one knob: an operator reading a topic0 off an explorer must
  // not have to invent an ABI to use it, and one who KNOWS the ABI must not
  // lose the named decode. Which one arrived is decided by shape, never by a
  // second env var that can disagree with the first.
  let eventSig = null, topic0 = null;
  if (isTopic0(raw)) {
    topic0 = raw.toLowerCase();
    eventSig = PONS_KNOWN_SIGS.find((s) => sigTopic(s) === topic0) || null;
  } else {
    eventSig = raw;
    topic0 = sigTopic(raw);
  }
  const name = eventSig ? (eventSig.match(/event\s+(\w+)/) || [])[1] || 'TokenLaunched' : '';
  const factories = envs('PONS_FACTORY', PONS_FACTORY_DEFAULT)
    .split(',').map((x) => x.trim()).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x));
  return { on, factories, factory: factories[0] || '', eventSig, topic0, name, decodable: !!(eventSig && topic0) };
}

/** Every launch-announcing factory a chain has, with the topic they emit.
 *  Chain-keyed so a second pad is a row here rather than a branch elsewhere. */
function announcersFor(chainKey) {
  if (chainKey !== 'robinhood') return [];
  const c = ponsCfg();
  if (!c.on || !c.topic0 || !c.factories.length) return [];
  return [{ pad: 'pons', factories: c.factories, topic0: c.topic0 }];
}

module.exports = {
  ponsCfg, announcersFor, sigTopic,
  PONS_FACTORY_DEFAULT, PONS_TOPIC0_DEFAULT, PONS_EVENT_DEFAULT, PONS_KNOWN_SIGS,
  _envs: envs, _isTopic0: isTopic0,
};
