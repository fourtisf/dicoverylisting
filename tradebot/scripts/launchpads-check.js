#!/usr/bin/env node
'use strict';
/*
 * launchpads:check — which launchpad APIs answer FROM THIS BOX, and what they
 * return.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A TEST
 * Whether a launchpad answers is a property of this server's egress today, not
 * of the code: pump.fun and Jupiter both block datacenter IP ranges, both have
 * retired hosts without warning, and none of these request shapes is a
 * published contract. A unit test asserts what we believe; this asserts what is
 * true right now, on the machine that has to make the call. Same reason
 * `raid:check` and `preflight:solana` exist.
 *
 *   node scripts/launchpads-check.js                     # every pad's feed
 *   node scripts/launchpads-check.js <mint|0xca> [chain] # one token, pad by pad
 *
 * When a pad fails here, the fix is usually config rather than code — every
 * pad's host and paths are env-overridable, so a launchpad that moved costs a
 * line in .env and a restart. The footer prints the exact variable names.
 */
try { if (!process.env.SKIP_DOTENV) require('dotenv').config(); } catch (_) {}

const lp = require('../../shared/launchpads');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 8 : 2 }));
const age = (ms) => (ms ? Math.round((Date.now() - ms) / 60000) + 'm ago' : '—');

function padHeader(p) {
  const flags = [];
  if (!p.enabled) flags.push(Y('disabled'));
  if (!p.verified) flags.push(D('shape unverified'));
  return `${p.key.padEnd(10)} ${p.label}${flags.length ? '  (' + flags.join(', ') + ')' : ''}`;
}

async function checkFeeds() {
  console.log('\n── new-launch feeds ──────────────────────────────────────────\n');
  const byChain = {};
  for (const p of lp.enabled()) for (const c of p.chains) (byChain[c] = byChain[c] || []).push(p);
  let any = false;
  // Named explicitly, because a pad with no feed endpoint cannot be probed
  // without an address and would otherwise be silently absent from this
  // report — which reads as "not configured" rather than "not checkable here".
  const noFeed = lp.enabled().filter((p) => !p.feedPath);
  if (noFeed.length) {
    console.log(D(`  ${noFeed.map((p) => p.key).join(', ')}: no launches feed — pass an address to check ${noFeed.length > 1 ? 'them' : 'it'}\n`));
  }
  for (const [chain, pads] of Object.entries(byChain)) {
    const withFeed = pads.filter((p) => p.feedPath);
    if (!withFeed.length) continue;
    // `force` so this measures the HOST, not our own circuit breaker: reporting
    // a locally benched pad as "down" would be the check confirming itself.
    const r = await lp.newLaunches(chain, 5, { only: withFeed.map((p) => p.key), force: true });
    for (const p of withFeed) {
      const res = r.byPad[p.key] || { ok: false, why: 'not run', items: [] };
      any = any || res.ok;
      if (!res.ok) { console.log(`  ${R('✗')} ${padHeader(p)}\n      ${R(res.why)}`); continue; }
      console.log(`  ${G('✓')} ${padHeader(p)}`);
      console.log(D(`      ${res.items.length} launches via ${lp.padBase(p.key) || '?'}`));
      for (const it of res.items.slice(0, 3)) {
        const curve = it.progressPct != null ? `${it.progressPct.toFixed(0)}% (${it.progressSource})` : (it.graduated ? 'graduated' : 'phase unknown');
        console.log(D(`      · $${it.symbol || '??'}  ${it.address}  ${money(it.mcapUsd)}  ${curve}  ${age(it.createdAt)}`));
      }
    }
  }
  return any;
}

async function checkToken(address, chain) {
  console.log(`\n── ${address} on ${chain} ─────────────────────────────────\n`);
  const pads = lp.padsFor(chain);
  if (!pads.length) { console.log(R(`  no enabled pad covers ${chain}`)); return false; }
  const r = await lp.tokenRecord(chain, address);
  for (const t of r.tried) {
    const p = pads.find((x) => x.key === t.pad) || { key: t.pad, label: t.pad, enabled: true, verified: true, chains: [] };
    const mark = t.skipped ? Y('•') : t.found ? G('✓') : t.ok ? D('·') : R('✗');
    const note = t.skipped ? Y(t.why)
      : t.found ? G('knows it')
        : t.ok ? D(t.status === 404 ? 'answered: never heard of it' : 'answered, no record')
          : R(t.why);
    console.log(`  ${mark} ${padHeader(p)}\n      ${note}`);
  }
  if (!r.record) {
    console.log(`\n  ${r.ok ? Y('No pad knows this token.') : R('No pad answered — this is a network/host problem, not a token problem.')}`);
    if (!r.ok) console.log(`  ${R(r.why)}`);
    // The distinction that matters: a token every pad answered about and none
    // recognised is simply not a launchpad token, and that is a fine answer.
    return r.ok;
  }
  const m = r.record;
  console.log('\n  ' + G('merged record') + '\n');
  const row = (k, v) => console.log(`    ${k.padEnd(14)} ${v === null || v === undefined ? D('—') : v}`);
  row('name', m.name);
  row('symbol', m.symbol);
  row('launchpad', m.launchpad);
  row('price', money(m.priceUsd));
  row('market cap', money(m.mcapUsd));
  row('liquidity', money(m.liqUsd));
  row('24h volume', money(m.vol24Usd));
  row('holders', m.holders);
  row('created', age(m.createdAt));
  row('phase', m.onCurve === true ? `bonding · ${m.progressPct != null ? m.progressPct.toFixed(1) + '%' : '?'} (${m.progressSource || '?'})`
    : m.graduated === true ? 'graduated' + (m.migratedPool ? ' → ' + m.migratedPool : '')
      : Y('unknown — no pad said'));
  if (m.raisedNative != null) row('raised', `${m.raisedNative} / ${m.targetNative} ${m.nativeSym || ''}`);
  row('socials', [m.website && 'web', m.twitter && 'x', m.telegram && 'tg'].filter(Boolean).join(' ') || null);
  row('description', m.description ? m.description.slice(0, 60) + '…' : null);
  row('from', m.source);
  if (m.progressDisagreement) console.log(`\n  ${Y('pads disagree on progress: ' + m.progressDisagreement)}`);
  return true;
}

(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  console.log('\nDexvra — launchpad APIs, measured from this box\n');
  console.log(D('pads: ' + lp.all().map((p) => p.key + (p.enabled ? '' : '(off)')).join(', ') || 'none'));

  let ok;
  if (args.length) {
    const address = args[0];
    const chain = args[1] || (/^0x[a-fA-F0-9]{40}$/.test(address) ? 'bsc' : 'solana');
    ok = await checkToken(address, chain);
  } else {
    ok = await checkFeeds();
    console.log(D('\n  (pass a mint or contract address to check one token across every pad)'));
  }

  console.log(`
${D('If a pad failed above, it is almost always config rather than code — every')}
${D('host and path here is overridable, so a launchpad that moved needs a line in')}
${D('.env and a restart, not a deploy:')}

    LAUNCHPADS=0                     ${D('turn the whole registry off')}
    LAUNCHPAD_<PAD>=0                ${D('turn one pad off (blank/absent = on)')}
    LAUNCHPAD_<PAD>_API=<base>       ${D('pin one host and skip the base list')}
    LAUNCHPAD_<PAD>_TOKEN_PATH=…     ${D('per-token path, {id} placeholder')}
    LAUNCHPAD_<PAD>_FEED_PATH=…      ${D('new-launches path, {n} placeholder')}

${D('<PAD> is the key in the left column. Restart with --update-env or the new')}
${D('value is not read.')}
`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(R('check crashed: ' + (e && e.stack || e))); process.exit(1); });
