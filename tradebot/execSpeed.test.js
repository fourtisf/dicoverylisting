'use strict';
/*
 * Execution-latency regressions.
 *
 * Every assertion here guards a change that was worth WALL-CLOCK SECONDS on a
 * trade, and every one of them is the kind of thing a later refactor removes
 * without noticing — a default that looks harmless, an `await` that reads more
 * naturally on its own line. The point of this file is that the next person to
 * put the slow version back gets a red test instead of a slow bot.
 */
const test = require('node:test');
const assert = require('node:assert');

const chains = require('./chains');
const solana = require('./solana');

// ---------------------------------------------------------------- RPC provider
test('receipt polling is tuned per chain, never left at ethers 4000ms default', () => {
  // ethers polls for new blocks every 4s by default, and that interval is what
  // decides how late tx.wait() notices a receipt. A buy waits on two receipts,
  // so the default cost up to ~8s per fill on chains with sub-second blocks.
  for (const key of ['robinhood', 'ethereum', 'base', 'bsc', 'arbitrum']) {
    const p = chains.providerFor(key);
    assert.ok(p.pollingInterval < 4000, `${key} still polls at the ethers default (${p.pollingInterval}ms)`);
    assert.ok(p.pollingInterval >= 100, `${key} polls too aggressively (${p.pollingInterval}ms)`);
  }
});

test('fast L2s poll faster than Ethereum — the interval tracks block time', () => {
  // Polling Ethereum (12s blocks) at 250ms is wasted requests; polling an Orbit
  // L2 at 1s is wasted time. The defaults must not collapse to one number.
  assert.ok(chains.pollMsFor('robinhood') < chains.pollMsFor('ethereum'));
  assert.ok(chains.pollMsFor('arbitrum') < chains.pollMsFor('ethereum'));
});

test('JSON-RPC batching is on everywhere except the quirky Robinhood node', () => {
  // batchMaxCount:1 turns every Promise.all of reads into N HTTP round trips.
  for (const key of ['ethereum', 'base', 'bsc', 'arbitrum']) {
    assert.ok(chains.batchFor(key) > 1, `${key} is not batching JSON-RPC calls`);
  }
  // The Robinhood node already mis-frames single-call error envelopes (see
  // rawSend in core.js) — it is deliberately not handed an array.
  assert.equal(chains.batchFor('robinhood'), 1);
});

// ---------------------------------------------------------------- Solana swap
test('swap skips preflight by default — Jupiter already simulated the route', async () => {
  // Preflight is a second full simulation round trip on the hot path, for a
  // transaction Jupiter built and simulated itself.
  let sawOpts = null;
  const conn = fakeConn({ onSend: (raw, opts) => { sawOpts = opts; } });
  await solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64());
  assert.equal(sawOpts.skipPreflight, true);
});

test('the swap path needs no blockhash round trip to confirm at all', async () => {
  // It used to fetch one AFTER sendRawTransaction returned, purely to build
  // web3.js's confirmation strategy — a full extra round trip with the tx
  // already in flight. Polling getSignatureStatuses needs no blockhash, so that
  // call is gone rather than merely moved.
  const order = [];
  const conn = fakeConn({
    onBlockhash: () => order.push('blockhash-requested'),
    onSend: () => order.push('send-returned'),
    sendDelayMs: 20,
  });
  await solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64());
  assert.deepEqual(order, ['send-returned'], 'the swap still fetches a blockhash it does not need');
});

test('confirmation NEVER depends on the websocket', async () => {
  // The bug this replaces: web3.js confirmTransaction races a websocket
  // signatureSubscribe against a ~60s blockheight-expiry timer, and makes exactly
  // ONE http status check — issued before the tx can possibly have landed, so it
  // always finds nothing and is never repeated. On the public RPC this bot
  // defaults to, whose websocket is throttled, a swap that confirmed on-chain in
  // half a second went unnoticed for a minute and was then reported to the user
  // as "broadcast but not confirmed" — with their tokens already bought.
  //
  // fakeConn's confirmTransaction throws, so any reliance on it fails here.
  const conn = fakeConn();
  const sig = await solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64());
  assert.ok(sig, 'the swap did not confirm over http');
});

test('confirmation keeps polling through a flaky RPC instead of giving up', async () => {
  // One failed status read is a hiccup, not an answer. web3.js gave up after its
  // single check; this must not.
  let calls = 0;
  const conn = {
    sendRawTransaction: async () => 'SIGflaky',
    getSignatureStatuses: async () => {
      calls++;
      if (calls === 1) throw new Error('429 rate limited');
      if (calls === 2) return { value: [null] };            // not landed yet
      return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    },
  };
  const sig = await solana.confirmSignature(conn, 'SIGflaky', { pollMs: 5 });
  assert.equal(sig, 'SIGflaky');
  assert.equal(calls, 3, 'it stopped polling too early');
});

test('an on-chain failure is a clean failure, a timeout is only "unconfirmed"', async () => {
  // These must not be conflated: a reverted swap spent nothing and callers may
  // roll back budget; an unobserved one may well have landed and they must not.
  const reverted = {
    sendRawTransaction: async () => 'SIGrevert',
    getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, 'x'] } }] }),
  };
  await assert.rejects(
    () => solana.sendJupiterSwap(reverted, fakeKeypair(), fakeSwapTxB64()),
    (e) => /reverted on-chain/.test(e.message) && !e.broadcast,
  );

  const silent = {
    sendRawTransaction: async () => 'SIGsilent',
    getSignatureStatuses: async () => ({ value: [null] }),   // never lands, never errors
  };
  await assert.rejects(
    () => solana.confirmSignature(silent, 'SIGsilent', { pollMs: 5, timeoutMs: 30 }),
    (e) => e.timedOut === true,
  );
});

test('a swap that broadcasts but cannot confirm is tagged, not reported as failed', async () => {
  // Unchanged safety property: the tx may still land, so callers must not roll
  // back committed budget. Guarded here because the confirm path was rewritten.
  // statusThrows makes every status read fail, so confirmSignature times out.
  const conn = fakeConn({ statusThrows: true, sig: 'unconf' });
  await assert.rejects(
    () => solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64()),
    (e) => e.broadcast === true && typeof e.sig === 'string',
  );
});

// ---------------------------------------------------------------- bot fee transfer
test('sendSol confirm:false returns as soon as it is broadcast', async () => {
  // This is what takes the bot's own 1% fee transfer off the trade's critical
  // path. Resolving before confirmation is the entire point.
  let released = null;
  const conn = fakeConn({ confirmGate: new Promise((r) => { released = r; }) });
  const out = await solana.sendSol(conn, fakeKeypair(), BASE58_ADDR, 1000n, { confirm: false });
  assert.ok(out.sig, 'no signature returned on broadcast');
  assert.ok(out.confirmed instanceof Promise, 'no confirmation handle returned');
  released({ value: { err: null } });
  assert.equal(await out.confirmed, out.sig);
});

test('sendSol still waits for confirmation by default (withdrawals must not lie)', async () => {
  // A withdrawal tells the user their funds have moved — it may only say so
  // once that is true. The deferral is opt-in, never the default.
  let confirmed = false;
  const conn = fakeConn({ onConfirm: () => { confirmed = true; } });
  const sig = await solana.sendSol(conn, fakeKeypair(), BASE58_ADDR, 1000n);
  assert.equal(typeof sig, 'string');
  assert.equal(confirmed, true);
});

test('a deferred transfer that reverts rejects its handle — the referral is not credited', async () => {
  // The money invariant: the referral share is gated on the fee actually
  // landing. Deferring the wait must not turn a revert into a silent success.
  const conn = fakeConn({ confirmErr: { InstructionError: 1 } });
  const out = await solana.sendSol(conn, fakeKeypair(), BASE58_ADDR, 1000n, { confirm: false });
  await assert.rejects(() => out.confirmed);
});

// ---------------------------------------------------------------- SPL metadata
test('splMeta runs its two independent lookups concurrently', async () => {
  // decimals (RPC) and name/symbol (Jupiter registry) know nothing about each
  // other. In series a mint cost the SUM of both; concurrently it costs the
  // slower one. This runs on the buy path.
  const gate = { decimals: false, registry: false };
  let bothInFlight = false;
  const conn = {
    getTokenSupply: async () => {
      gate.decimals = true; bothInFlight = bothInFlight || gate.registry;
      await tick(10);
      bothInFlight = bothInFlight || gate.registry;
      return { value: { decimals: 6, amount: '1' } };
    },
  };
  const realFetch = global.fetch;
  global.fetch = async () => {
    gate.registry = true; bothInFlight = bothInFlight || gate.decimals;
    await tick(10);
    return { ok: true, json: async () => ({ name: 'Tok', symbol: 'TOK', decimals: 6 }) };
  };
  try {
    const m = await solana.splMeta(conn, BASE58_ADDR);
    assert.equal(m.sym, 'TOK');
    assert.ok(bothInFlight, 'splMeta still awaits its two lookups one after the other');
  } finally { global.fetch = realFetch; }
});

// ---------------------------------------------------------------- helpers
const BASE58_ADDR = 'So11111111111111111111111111111111111111112';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeKeypair() {
  // A real keypair: sendJupiterSwap actually signs, so this cannot be a stub.
  return solana.deriveKeypair('0x' + '11'.repeat(32));
}

// A minimal signed VersionedTransaction, base64 — the shape sendJupiterSwap
// deserializes. Built from web3.js so it stays valid if the wire format moves.
function fakeSwapTxB64() {
  const web3 = require('@solana/web3.js');
  const kp = fakeKeypair();
  const msg = new web3.TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: BASE58_ADDR,   // any base58 32-byte value is a valid blockhash here
    instructions: [web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new web3.VersionedTransaction(msg).serialize()).toString('base64');
}

function fakeConn(o = {}) {
  return {
    getLatestBlockhash: async () => {
      if (o.onBlockhash) o.onBlockhash();
      return { blockhash: BASE58_ADDR, lastValidBlockHeight: 1 };
    },
    sendRawTransaction: async (raw, opts) => {
      if (o.sendDelayMs) await tick(o.sendDelayMs);
      if (o.onSend) o.onSend(raw, opts);
      return 'SIG_' + (o.sig || 'test');
    },
    // Confirmation is polled over http now (see confirmSignature in solana.js), so
    // the fake node answers getSignatureStatuses rather than confirmTransaction.
    getSignatureStatuses: async () => {
      if (o.onConfirm) o.onConfirm();
      if (o.statusThrows) throw new Error('rpc unavailable');
      if (o.confirmGate) await o.confirmGate;
      return { value: [{ err: o.confirmErr || null, confirmationStatus: o.confirmErr ? null : 'confirmed' }] };
    },
    // Present but deliberately unusable: nothing may depend on the websocket path.
    confirmTransaction: async () => { throw new Error('confirmTransaction must not be used — it depends on a websocket'); },
  };
}

// ---------------------------------------------------------------- broadcast feedback
test('the swap reports its signature the moment it is broadcast, not on confirmation', async () => {
  // This is the difference between a bot that feels alive and one that looks
  // hung: on a slow chain the user gets a live explorer link in ~0.5s instead of
  // staring at "Buying…" for a whole block.
  let sentAt = null, confirmDone = false;
  const conn = fakeConn({
    onConfirm: () => { confirmDone = true; },
    confirmGate: new Promise((r) => setTimeout(() => r({ value: { err: null } }), 80)),
  });
  const p = solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64(), (sig) => {
    sentAt = { sig, confirmedYet: confirmDone };
  });
  await p;
  assert.ok(sentAt, 'onSent never fired');
  assert.ok(sentAt.sig, 'onSent fired without a signature');
  assert.equal(sentAt.confirmedYet, false, 'onSent waited for confirmation — that defeats the point');
});

test('a throwing onSent hook can never break a trade', async () => {
  // The hook edits a Telegram message. Telegram failing is not a reason to fail
  // a transaction that is already on-chain.
  const conn = fakeConn();
  const sig = await solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64(), () => { throw new Error('telegram down'); });
  assert.ok(sig, 'a failing UI hook took the swap down with it');
});

test('the UI upgrades the progress message in place, and the receipt always wins', () => {
  const fs = require('node:fs'), path = require('node:path');
  const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(TG, /core\.buy\(chatId, ca, amt, chain, wid, \{ onSent \}\)/, 'buy does not ask for broadcast feedback');
  assert.match(TG, /\{ \.\.\.SELL_ESCALATION\[i\], onSent \}/, 'sell does not ask for broadcast feedback');
  // The late-edit guard: without it a fast chain can confirm while the "sent"
  // edit is still in flight, and the completed receipt gets overwritten.
  assert.match(TG, /if \(!progressId \|\| settled\) return;/, 'the sent/receipt edit race is unguarded');
  assert.ok((TG.match(/settled = true;/g) || []).length >= 2, 'the guard is not set on both buy and sell');
});
