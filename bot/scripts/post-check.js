#!/usr/bin/env node
'use strict';
/*
 * post:check — WOULD THE NEXT PAID POST GO OUT COMPLETE, on this box, today?
 *
 * WHY THIS EXISTS. "bagaimana agar masalah ini tidak terjadi lgi", asked after
 * a paid Xpress card reached 12,523 subscribers reading `Market cap: TBA ·
 * Price: TBA` with the Dexvra mark where the token's own logo belongs. That was
 * the SECOND round of TBA and the FIRST of the artwork, and all of them were
 * detected the same way: a person opened the channel and screenshotted it.
 *
 * `postFigures` now watches both halves and alerts — but a watch fires AFTER a
 * customer has paid for the degraded post. This is the half that can be run
 * BEFORE: it assembles a post's market figures and its artwork for a real
 * token and reports what would publish.
 *
 * ⚠️ IT DRIVES THE POST'S OWN FUNCTIONS. `_readPostMarket` (the bounded,
 * DexScreener-first read, budget included) and `_fetchLogoUrl` (through
 * `/api/logo`, gateway failover included) are called here, never reimplemented.
 * A check with its own idea of the question is exactly how `fonts:check`
 * printed nine green ticks over a banner publishing boxes, and how
 * `trending:check` came to report 44 refusals where the bot reported 25.
 *
 * ⚠️ AND IT PRINTS THE BUILD STAMP, because every round of this has begun with
 * somebody reading a check as a statement about the fix they just deployed. The
 * server only ever runs `main`; a fix on a branch is not deployed however many
 * times `git pull` runs.
 *
 * Exits non-zero only when a post WOULD publish a hole it is OUR job to fill. A
 * token no indexer has ever heard of is the board being honest and exits zero —
 * a check that is always red trains the reader to ignore the red, which is the
 * state `chart:preview` sat in for weeks.
 */
// ⚠️ .env FIRST — `constants.js` freezes every value at require time, so a
// script that loads the env afterwards reports an unset token on a server where
// it is set, and the failure it invents points the operator at their own .env.
require('../src/config/loadEnv').loadEnv();

const fulfil = require('../src/fulfillment');
const postFigures = require('../src/postFigures');
const api = require('../src/api/dexvra');
const launchpads = require('../src/launchpads');
const build = require('../src/helpers/build');
const { chainOf } = require('../src/config/chains');
const { DEXVRA_API_BASE } = require('../src/config/constants');
const { ticker } = require('../src/helpers/format');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const ok = (m) => console.log(`  ${G}✓${X} ${m}`);
const bad = (m) => console.log(`  ${R}✗${X} ${m}`);
const warn = (m) => console.log(`  ${Y}⚠${X} ${m}`);
const note = (m) => console.log(`    ${D}${m}${X}`);

/** How many of the newest listings to assemble when no token was named. */
const DEFAULT_N = Math.max(1, Number(process.env.POST_CHECK_N) || 5);

/**
 * Assemble one post's figures and artwork, exactly as fulfilment does.
 *
 * Returns `{ holes, lostArt, live, logoBytes }` — `holes` is the renderer's own
 * verdict via `postFigures.missingFigures`, so this can never disagree with
 * what the card actually prints.
 */
async function assemble(row) {
  const { live, why } = await fulfil._readPostMarket(row.chain, row.address, 'post:check');
  // THE LOGO THE POST WOULD RENDER, not the row's: a blank row takes the
  // token contract's logo off the market record at creation
  // (fulfillment.adoptChainLogo), and a check that read `row.logoUrl` reported
  // "no logo on file" over a post that draws the artwork — the guard measuring
  // a stack the renderer does not use, one field over from the `$MORTY` round.
  // Driven through the post's OWN rule, so the two cannot disagree.
  const wanted = { logoUrl: row.logoUrl || '' };
  const adopted = fulfil._adoptChainLogo(wanted, live);
  const logoUrl = wanted.logoUrl || null;
  // The X form: the bytes AND the facts behind them — which gateway served it
  // and how fast, or the proxy's per-gateway reason when none did. The check
  // drives the post's own fetch, never its own idea of one.
  const art = logoUrl ? await fulfil._fetchLogoUrlX(logoUrl) : null;
  const logoBytes = art ? art.bytes : null;
  return {
    live,
    why,
    holes: postFigures.missingFigures(live),
    lostArt: postFigures.artworkLost({ wanted: !!logoUrl, got: !!logoBytes }),
    // The third state: the row is blank because the CURVE READ could not
    // answer, not because the project published nothing. Same predicate the
    // ops alert uses — two copies of this classification would drift into two
    // plausible-looking sentences, which is what `fonts:check` cost.
    unreadArt: postFigures.artworkUnread({ wanted: !!logoUrl, absentWhy: live && live.logoWhy }),
    absentWhy: (live && live.logoWhy) || null,
    logoBytes,
    logoUrl,
    adopted,
    art,
  };
}

/**
 * The VERDICT, pure — so the test calls it instead of parsing terminal output.
 *
 * Three levels, and the middle one is the whole reason this script can be
 * trusted: `ok` · `honest` (nobody indexes this token, which is the post being
 * truthful and NOT our failure) · `fault` (a hole this box could have filled).
 * Only `fault` turns the exit code. A check that reddened on `honest` would be
 * permanently red here, and a permanently red check trains the reader to ignore
 * the red — the state `chart:preview` sat in for weeks.
 */
function verdict(a) {
  const keyHole = a.holes.some((h) => postFigures.KEY_FIGURES.has(h));
  if (!keyHole && !a.lostArt && !a.unreadArt) return 'ok';
  // ⚠️ A LOST LOGO IS ALWAYS OURS. The row asserts a picture and we could not
  // turn it into bytes — that is a fact about this box, never about the token,
  // so it outranks the honest-silence reading above it.
  //
  // …and so is a BLANK we could not fill: `absentWhy` is set only where the
  // chain read itself was refused, which is this box, never the creator.
  if (a.lostArt || a.unreadArt) return 'fault';
  // "We could not ask" (a `why`) and "an indexer answered with nothing" (a
  // record) are both ours to look at; only "nothing anywhere knows this token"
  // is the post being honest.
  return !a.live && !a.why ? 'honest' : 'fault';
}

function report(row, a) {
  // ⚠️ ONE `$`. The listing store's convention is `sym: "$BONK"`, so prepending
  // another printed `$$ORCHFLOWS` on the line whose whole job is naming the
  // token — the `From $1,000,0…` defect, on the check that reports it.
  const head = `${ticker(row.sym || row.symbol)}${row.name ? ` — ${row.name}` : ''}  ${D}${row.chain}/${row.address}${X}`;
  const keyHole = a.holes.some((h) => postFigures.KEY_FIGURES.has(h));
  const level = verdict(a);

  if (level === 'ok') {
    ok(head);
    const artLine = !a.logoUrl
      ? 'no logo on file — every source answered, and this project published none (the Dexvra mark is the design)'
      : a.art && a.art.source === 'upload'
        ? 'artwork loads (our own upload)'
        : `artwork loads${a.art && a.art.via ? ` via ${a.art.via}` : ''}${a.adopted ? " (the token contract's logo — the row is blank, the post adopts it)" : ''}`;
    note(`price ${a.live.priceUsd} · mcap ${a.live.mcap} · ${artLine}`);
    // A GREEN row whose artwork came from a public gateway is green TODAY. That
    // is the flip: the same url loaded on two deploys and failed on two with no
    // code change. Pinning it makes today's answer permanent.
    if (row.logoUrl && a.art && a.art.source !== 'upload') {
      note(`— from a public gateway; pin it so no post ever asks one again: npm run post:check -- ${row.chain} ${row.address} --pin`);
    }
    // A missing liquidity is normal on a curve and is never a failure here —
    // launchpads.js returns null deliberately, because a 0 reads as a rug.
    if (a.holes.length) note(`liquidity would print as — (a bonding curve has no pool depth)`);
    return true;
  }

  const unknown = level === 'honest';
  (unknown ? warn : bad)(head);
  if (keyHole) {
    note(`would publish: ${a.holes.join(' · ')} as TBA`);
    // ⚠️ "NO LAUNCHPAD HAD IT" AND "NO LAUNCHPAD COVERS THIS CHAIN" ARE
    // DIFFERENT FACTS, and this line asserted the first for both. `$JOVI` on
    // Tron read `no indexer and no launchpad returned anything for this token`
    // — but `padsFor('tron')` is EMPTY, so no launchpad was asked at all. That
    // is "we could not ask" dressed as "nothing is there", this repo's most
    // repeated rule, in the sentence written to explain a silence.
    //
    // It stays a ⚠️ rather than becoming a fault: this box genuinely cannot
    // fill that hole today, and reddening here would be permanently red on
    // every chain with no pre-migration source. What changes is that the
    // operator can now tell a token nobody has ever heard of from a CHAIN we
    // have no launchpad for — the second is a gap in this repo, not in the
    // market, and only one of them is worth acting on.
    const padded = launchpads.covers(row.chain);
    note(a.why
      ? `the read did not finish: ${a.why}`
      : a.live
        ? 'an indexer answered and publishes no price/cap for it'
        : padded
          ? 'no indexer and no launchpad returned anything for this token'
          : `no indexer had it, and no launchpad covers ${row.chain} — a token still on a bonding curve there has no source at all`);
    if (!unknown) note('→ npm run market:check -- ' + row.chain);
    if (unknown && padded) note('nothing to fix here — this is the post being honest');
    if (unknown && !padded) note(`honest about the token — but adding a ${row.chain} launchpad to shared/launchpads/pads.js is what would price a pre-migration one`);
  }
  if (a.lostArt) {
    note(a.adopted
      ? `the token contract publishes a logo, the post would adopt it, and it did not load — the banner would draw the Dexvra mark`
      : `the row HAS a logo and it did not load — the banner would draw the Dexvra mark`);
    note(a.logoUrl);
    if (a.art && (a.art.status || a.art.why)) note(`/api/logo answered ${a.art.status || '?'}${a.art.why ? `: ${a.art.why}` : ''}`);
    // ONE owner of the class — postFigures.artFailure — shared with the alert.
    const f = postFigures.artFailure(a.art || {});
    note(f.sentence);
    note('→ ' + postFigures.artRemedy(f.cls, row.chain, row.address));
  }
  if (a.unreadArt) {
    note(`the row is blank because the CURVE READ could not answer — ${a.absentWhy}`);
    note('this is NOT the project publishing no logo; the banner would draw the Dexvra mark');
    note('→ ' + postFigures.artRemedy('unread', row.chain, row.address));
  }
  return level !== 'fault';
}

/**
 * --pin: the ONE write this check may make, and only for a token named on the
 * command line. It DRIVES fulfil._pinLogo with the bytes that just loaded in
 * this run — never a guess — then re-reads the new url through the X form,
 * which for an upload is a localhost read with no gateway anywhere in it.
 */
async function pinRow(row, a) {
  if (!row.logoUrl) return note('nothing to pin — no logo on file');
  if (a.art && a.art.source === 'upload') return note('nothing to pin — already our own upload');
  if (!a.logoBytes) return note('nothing to pin — the artwork did not load in this run, so there are no bytes to keep');
  const before = row.logoUrl;
  const after = await fulfil._pinLogo(row, before, a.logoBytes);
  if (after === before) return bad(`not pinned — the row no longer holds that url, the upload was declined, or INTERNAL_API_TOKEN is unset (see the [fulfil] line above)`);
  const check = await fulfil._fetchLogoUrlX(after);
  if (check.bytes && check.source === 'upload') return ok(`pinned — artwork now served from this box: ${after}`);
  bad(`pinned to ${after} but it did not read back (${check.status || 'no answer'}) — check data/uploads and the media route`);
}

/** The web app's build, off the same field deploy.sh verifies, or null. */
async function webBuild() {
  try {
    const r = await fetch(`${DEXVRA_API_BASE}/api/tokens`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return j && typeof j.build === 'string' ? j.build.replace(/\+dirty$/, '') : null;
  } catch {
    return null;
  }
}

async function main() {
  // ⚠️ BOTH STAMPS. This fix is bot AND src, and the two processes can sit on
  // different builds — a check run mid-`npm run build` reads a Next server on
  // a replaced build, which answers every request with a 400 that used to
  // print as "no gateway served it". That was the one cause of run 4's line
  // nothing in the log could rule out.
  const web = await webBuild();
  const botSha = build.stamp().replace(/\+dirty$/, '');
  console.log(`\nWould the next paid post publish complete?   ${D}build ${build.stamp()} · web ${web || 'unknown (site cold)'}${X}\n`);
  if (web && web !== botSha) bad(`the web app is serving ${web} but this checkout is ${botSha} — a run mid-deploy is about the deploy, not the artwork`);

  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const wantPin = process.argv.slice(2).includes('--pin');
  let rows;

  if (argv.length >= 2) {
    const [chain, address] = argv;
    if (!chainOf(chain)) {
      // ⚠️ DIAGNOSED, never bounced to a usage screen with a bracketed blank in
      // it — this repo has had a placeholder pasted into a live shell four
      // times, and bash reads `<` and `>` as redirects.
      bad(`"${chain}" is not a chain this bot knows.`);
      note('Run it with no arguments to check the newest real listings instead.');
      process.exit(1);
    }
    const found = await api.findListing(chain, address).catch(() => null);
    rows = [found || { chain, address, sym: null, name: null, logoUrl: null }];
    if (!found) note('not a listing on the site — checking the market read for that address anyway');
  } else if (wantPin) {
    // ⚠️ --pin WRITES, and it writes to a listing somebody may have paid for.
    // Five rows on one flag is the hazard; a named token is the contract.
    bad('--pin needs the token named: its chain AND its address.');
    note('Run it with no arguments first — the green rows print the exact --pin line for each.');
    process.exit(1);
  } else if (argv.length === 1) {
    // ⚠️ ONE ARGUMENT IS NOT "no argument". Falling through to the newest
    // listings here would silently answer a question nobody asked — the
    // operator named a token and got a different set of tokens back, with
    // nothing saying their argument was dropped.
    bad('a token needs BOTH its chain and its address.');
    note('The chain is the one the listing is on (robinhood, solana, bsc, base, ethereum, tron).');
    note('Run it with no arguments at all to check the newest real listings instead.');
    process.exit(1);
  } else {
    // NO ARGUMENT MEANS ASK THE SITE FOR REAL ONES. The alternative is printing
    // a command with a blank in it, which is this file's oldest rule.
    let all;
    try {
      all = await api.getListings();
    } catch (e) {
      bad(`could not read the listings API: ${e.message}`);
      note('That is the same credential fulfilment uses — check INTERNAL_API_TOKEN in bot/.env on the box.');
      process.exit(1);
    }
    rows = all.filter((r) => r && r.address && r.chain).slice(0, DEFAULT_N);
    if (!rows.length) {
      warn('no listings on the site yet — nothing to assemble.');
      process.exit(0);
    }
    console.log(`${D}  the ${rows.length} newest listing(s), assembled the way a paid post assembles them${X}\n`);
  }

  let bad_ = 0;
  for (const row of rows) {
    let a;
    try {
      a = await assemble(row);
    } catch (e) {
      bad(`${ticker(row.sym)} ${row.chain}/${row.address}: ${e.message}`);
      bad_++;
      continue;
    }
    if (!report(row, a)) bad_++;
    if (wantPin) await pinRow(row, a);
  }

  console.log('');
  if (bad_) {
    console.log(`${R}${bad_} of ${rows.length} would publish a hole this box could have filled.${X}\n`);
    process.exit(1);
  }
  console.log(`${G}Every post assembled here would publish its figures and its artwork.${X}\n`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    bad(`post:check crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
}

module.exports = { verdict, assemble };
