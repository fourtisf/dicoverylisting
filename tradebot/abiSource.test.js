'use strict';
/*
 * The published ABI, and why it outranks inference — plus the ways an
 * official-looking answer can still be about the wrong contract.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./abiSource.js');

const ADDR = '0xc0000000000000000000000000000000000000c0';
const BUY = { type: 'function', name: 'buy', inputs: [{ name: 'token', type: 'address' }, { name: 'minTokensOut', type: 'uint256' }] };
const SEL_BUY = A.selectorOf('buy(address,uint256)');

const fetchOk = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const fetchSeq = (...answers) => { let i = 0; return async () => { const a = answers[Math.min(i++, answers.length - 1)]; if (a instanceof Error) throw a; return { ok: true, status: 200, async json() { return a; } }; }; };

test('a Blockscout v2 answer is read', async () => {
  const r = await A.fetchVerifiedAbi('https://explorer.example', ADDR, { fetchImpl: fetchOk({ abi: [BUY], name: 'PonsCurve' }) });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.source, 'blockscout');
  assert.equal(r.name, 'PonsCurve');
});

test('an Etherscan-compatible explorer is tried when Blockscout has nothing', async () => {
  const r = await A.fetchVerifiedAbi('https://explorer.example', ADDR, {
    fetchImpl: fetchSeq({ abi: [] }, { status: '1', result: JSON.stringify([BUY]) }),
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.source, 'etherscan-compatible');
});

test('an unverified contract is a clear no, and says both attempts', async () => {
  const r = await A.fetchVerifiedAbi('https://explorer.example', ADDR, { fetchImpl: fetchSeq({ abi: [] }, { status: '0', result: 'Contract source code not verified' }) });
  assert.equal(r.ok, false);
  assert.match(r.why, /blockscout/);
  assert.match(r.why, /not verified/);
});

test('⚠️ THE OBSERVED SELECTOR MUST BE IN THE ABI — otherwise it describes another contract', () => {
  // An explorer will serve an ABI for a proxy, for a different implementation,
  // or for whatever somebody verified at that address. Matching the selector we
  // actually watched execute is what turns "official-looking" into "about this
  // call".
  assert.equal(A.entryForSelector([BUY], SEL_BUY).name, 'buy');
  assert.equal(A.entryForSelector([BUY], '0xdeadbeef'), null);
  assert.equal(A.entryForSelector([], SEL_BUY), null);
});

test('parameter roles come from NAMES, and an unrecognised name stays unknown', () => {
  assert.equal(A.roleOfParam({ name: 'token', type: 'address' }), 'token');
  assert.equal(A.roleOfParam({ name: 'recipient', type: 'address' }), 'sender');
  assert.equal(A.roleOfParam({ name: 'minTokensOut', type: 'uint256' }), 'scales');
  assert.equal(A.roleOfParam({ name: 'deadline', type: 'uint256' }), 'deadline');
  assert.equal(A.roleOfParam({ name: 'feeBps', type: 'uint256' }), 'constant');
  // Guessing here would throw away the whole advantage of having the real ABI.
  assert.equal(A.roleOfParam({ name: 'wharrgarbl', type: 'uint256' }), 'unknown');
  assert.equal(A.roleOfParam({ name: 'data', type: 'bytes' }), 'unknown');
});

test('⚠️ a DEADLINE is the case inference alone can never recover', () => {
  // A timestamp differs between samples and does not track the amount, so
  // `classifySlots` calls it unknown and refuses the whole trade. The published
  // name rescues it, and that is the single biggest thing the ABI buys.
  const published = A.rolesOfEntry({ inputs: [{ name: 'token', type: 'address' }, { name: 'deadline', type: 'uint256' }] });
  const r = A.reconcile(published, [{ i: 0, role: 'token' }, { i: 1, role: 'unknown' }]);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.slots[1].role, 'deadline');
});

test('⚠️ when the ABI and the trades DISAGREE, neither may be signed', () => {
  // One of the two readings is about a different function. Picking either is
  // how a bot puts an amount where a contract wanted a timestamp.
  const published = A.rolesOfEntry({ inputs: [{ name: 'feeTier', type: 'uint256' }] });
  const r = A.reconcile(published, [{ i: 0, role: 'scales' }]);
  assert.equal(r.ok, false);
  assert.match(r.why, /refusing rather than picking one/);
});

test('an ABI naming an argument we cannot fill refuses, and names it', () => {
  const published = A.rolesOfEntry({ inputs: [{ name: 'permitSig', type: 'bytes' }] });
  const r = A.reconcile(published, [{ i: 0, role: 'constant' }]);
  assert.equal(r.ok, false);
  assert.match(r.why, /permitSig/);
});

test('the 4-byte registry returns EVERY candidate — collisions are anyone-submitted', async () => {
  const r = await A.fourByteSignatures('0xcce7ec13', {
    fetchImpl: fetchOk({ results: [{ text_signature: 'buy(address,uint256)' }, { text_signature: 'nonsense_x(uint256,bytes)' }] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.signatures.length, 2, 'choosing one here would be the guess this module exists to avoid');
});

test('4-byte can be switched off, and a bad selector never reaches the network', async () => {
  let called = 0;
  const f = async () => { called++; return { ok: true, async json() { return { results: [] }; } }; };
  assert.equal((await A.fourByteSignatures('nope', { fetchImpl: f })).ok, false);
  assert.equal(called, 0);
  process.env.ABI_4BYTE = '0';
  assert.match((await A.fourByteSignatures('0xcce7ec13', { fetchImpl: f })).why, /is off/);
  delete process.env.ABI_4BYTE;
});

test('a selector is computed from the signature, whitespace and all', () => {
  assert.equal(A.selectorOf('buy(address, uint256)'), A.selectorOf('buy(address,uint256)'));
  assert.equal(A.selectorOf('not a signature'), null);
});

test('⚠️ "could not ask" and "not verified" are opposite conclusions', async () => {
  // A Cloudflare 403 in front of an explorer would otherwise read as "this
  // contract is not verified" and send the caller down the inference path with
  // a published ABI sitting there unread.
  const refuse = async () => ({ ok: false, status: 403, async json() { return {}; } });
  const blocked = await A.fetchVerifiedAbi('https://explorer.example', ADDR, { fetchImpl: refuse });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reachable, false);
  assert.match(blocked.why, /could not reach/);

  // A 404 IS an answer: the explorer is there and has no such contract.
  const answered = async () => ({ ok: false, status: 404, async json() { return {}; } });
  const missing = await A.fetchVerifiedAbi('https://explorer.example', ADDR, { fetchImpl: answered });
  assert.equal(missing.reachable, true);
  assert.match(missing.why, /no verified ABI/);
});

test('⚠️ an explorer that answers HTML says so, instead of reading as our own parse bug', async () => {
  // What the live box actually got: `Unexpected token < in JSON at position 0`,
  // twice, from a Cloudflare page in front of the Robinhood explorer. Reported
  // verbatim it reads as a bug in this file, and the operator goes looking for
  // one — the reason is the explorer talking, and the report has to say that.
  const cloudflare = async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token < in JSON at position 0'); } });
  const r = await A.fetchVerifiedAbi('https://explorer.example', ADDR, { fetchImpl: cloudflare });
  assert.equal(r.ok, false);
  assert.equal(r.reachable, false, 'HTML is not an answer about whether the contract is verified');
  assert.match(r.why, /Cloudflare|HTML/i);
  assert.doesNotMatch(r.why, /Unexpected token/, 'a raw parser message is not a diagnosis');
});

test('⚠️ a 4-byte candidate whose SHAPE disagrees with the trades is discarded', () => {
  // The registry is append-only and anyone-submitted, so selector collisions
  // are routine. The shape is a second, independent source: the box observed
  // args[num,num,addr] and the registry answered buy(uint256,uint256,address).
  const w = (h) => h.padStart(64, '0');
  const num = { word: w('1f4'), addr: null, num: 500n };
  const addr = { word: w('1234567890abcdef1234567890abcdef12345678'), addr: '0x1234567890abcdef1234567890abcdef12345678', num: 1n };
  const observed = [num, num, addr];

  assert.equal(A.shapeMatches('buy(uint256,uint256,address)', observed).ok, true);
  assert.match(A.shapeMatches('buy(uint256)', observed).why, /takes 1 argument/);
  assert.match(A.shapeMatches('buy(address,uint256,address)', observed).why, /argument 0 is an address/);
  assert.match(A.shapeMatches('buy(uint256,uint256,uint256)', observed).why, /argument 2 is a number/);
  assert.equal(A.shapeMatches('not a signature', observed).ok, false);
});

test('⚠️ an all-zero word is compatible with EVERY type', () => {
  // `address(0)` and the number 0 are the same 32 bytes. The first cut refused
  // a correct signature over a zero referrer address — discarding the right
  // candidate, quietly, which is the failure this check exists to prevent in
  // the other direction.
  const zero = { word: '0'.repeat(64), addr: null, num: 0n };
  assert.equal(A.shapeMatches('buy(address)', [zero]).ok, true);
  assert.equal(A.shapeMatches('buy(uint256)', [zero]).ok, true);
});

test('shapeMatches may only ever DISCARD — a match is not a licence to sign', () => {
  // Two readings can share a shape and mean different things, which is the
  // whole reason classifySlots exists. Everything this returns on a match is
  // the types it parsed; nothing here says "safe".
  const w = (h) => h.padStart(64, '0');
  const r = A.shapeMatches('buy(uint256,uint256,address)', [
    { word: w('1f4'), addr: null, num: 500n },
    { word: w('2ee'), addr: null, num: 750n },
    { word: w('1234567890abcdef1234567890abcdef12345678'), addr: '0x1234567890abcdef1234567890abcdef12345678', num: 1n },
  ]);
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'types', 'why']);
});
