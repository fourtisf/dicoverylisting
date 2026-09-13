// "bagaimana agar masalah ini tidak terjadi lgi" — asked after a paid Xpress
// card reached 12,523 subscribers reading `Market cap: TBA · Price: TBA` with
// the Dexvra mark where $WROTE's own logo belongs.
//
// `postFigures` watches both halves and alerts — but a watch fires AFTER a
// customer has paid for the degraded post. `post:check` is the half that runs
// BEFORE, on the box, where the causes can actually be told apart.
//
// ⚠️ THE VERDICT IS TESTED BY BEING CALLED, not by parsing terminal output.
// "A logoless listing is fine", "a token nobody indexes is honest" and "a logo
// that would not load is ours" are behavioural rules, and a source scan cannot
// tell a rule from a comment about one — the `logoWrite.ts` contract.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-postcheck-"));

const test = require("node:test");
const assert = require("node:assert");
const { verdict } = require("../scripts/post-check.js");
const pf = require("../src/postFigures");

const row = (over = {}) => ({ chain: "robinhood", address: "0xabc", sym: "WROTE", logoUrl: null, ...over });
const A = (over = {}) => ({ live: { priceUsd: 1, mcap: 2, liq: 3 }, why: null, holes: [], lostArt: false, ...over });

test("a post with every figure and its artwork is ok", () => {
  assert.equal(verdict(A()), "ok");
});

test("a listing that never had a logo is still ok — the mark is the DESIGN", () => {
  // ⚠️ Written as `verdict(A())` this was byte-identical to the test above it
  // and covered nothing. What is actually being asserted is the DERIVATION the
  // check makes from a row: no logoUrl means nothing was WANTED, so nothing was
  // lost. Paging here would be permanently red on every listing whose owner
  // uploaded nothing.
  const noLogo = row({ logoUrl: null });
  const lostArt = pf.artworkLost({ wanted: !!noLogo.logoUrl, got: false });
  assert.equal(lostArt, false, "nothing was lost — nothing was ever given");
  assert.equal(verdict(A({ lostArt })), "ok");

  const withLogo = row({ logoUrl: "https://ipfs.io/ipfs/bafk" });
  assert.equal(pf.artworkLost({ wanted: !!withLogo.logoUrl, got: false }), true);
});

test("a curve with no liquidity is ok — that is not a key figure", () => {
  // launchpads.js returns liquidityUsd null deliberately, because a 0 reads as
  // a rug. Reddening here would be red on every pre-migration listing.
  assert.equal(verdict(A({ holes: ["liquidity"], live: { priceUsd: 1, mcap: 2, liq: null } })), "ok");
});

test("⚠️ a token NOBODY indexes is HONEST, not a fault", () => {
  // The post is telling the truth. A check that reddened here would be
  // permanently red on this box — the state `chart:preview` sat in for weeks,
  // which trains the reader to ignore the red.
  const a = A({ live: null, why: null, holes: ["price", "market cap", "liquidity"] });
  assert.equal(verdict(a), "honest");
});

test("…but a read that DID NOT FINISH is ours", () => {
  // "We could not ask" is a budget or an outage on this box, and it renders
  // identically to the honest case on the card. That distinction IS the check.
  const a = A({ live: null, why: "the market read passed 8000ms", holes: ["price", "market cap"] });
  assert.equal(verdict(a), "fault");
});

test("…and so is an indexer that answered with no price", () => {
  const a = A({ live: { priceUsd: null, mcap: null, liq: 5 }, holes: ["price", "market cap"] });
  assert.equal(verdict(a), "fault");
});

test("⚠️ a LOST LOGO is a fault even when every figure published", () => {
  // The reported defect, and the one a watch on the figures alone could never
  // see: the banner draws a missing logo as a deliberate-looking fallback.
  assert.equal(verdict(A({ lostArt: true })), "fault");
});

test("⚠️ …and it outranks the honest-silence reading", () => {
  // A token nobody indexes CAN still have artwork we failed to fetch. Letting
  // "honest" win there would hide the logo half behind the figures half —
  // exactly the way this round's defect hid behind the last round's.
  const a = A({ live: null, why: null, holes: ["price", "market cap", "liquidity"], lostArt: true });
  assert.equal(verdict(a), "fault");
});

test("⚠️ a BLANK row the curve read could not fill is a fault too", () => {
  // `$ORCHFLOWS` went out drawing the Dexvra mark with its logo on its own pad
  // page, and every surface read it as a project that published none. The
  // derivation is the same one the ops alert makes — one owner, or two
  // plausible-looking sentences.
  const unreadArt = pf.artworkUnread({ wanted: false, absentWhy: "rpc 429 (rate limited)" });
  assert.equal(unreadArt, true);
  assert.equal(verdict(A({ unreadArt })), "fault");
  // ⚠️ AND IT OUTRANKS THE HONEST-SILENCE READING, which is the assertion that
  // is not free: with the figures also missing, a verdict that merely fell
  // through would answer "honest" — the post being truthful — over a blank
  // this box could have filled. Written without this the mutant that drops
  // `unreadArt` from the fault branch SURVIVED, reaching 'fault' by accident.
  assert.equal(
    verdict(A({ live: null, why: null, holes: ["price", "market cap", "liquidity"], unreadArt })),
    "fault",
  );
  // …and a row that is blank because the creator published nothing is not.
  assert.equal(verdict(A({ unreadArt: pf.artworkUnread({ wanted: false, absentWhy: null }) })), "ok");
});

test("⚠️ assemble() derives the blank's reason from the RECORD, never re-asks", () => {
  // A check with its own copy of the question is how fonts:check printed nine
  // green ticks over a banner publishing boxes.
  const src = fss.readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  assert.match(src, /unreadArt: postFigures\.artworkUnread\(/, "the check grew its own idea of an unfilled blank");
  assert.match(src, /absentWhy: live && live\.logoWhy/, "…and its own idea of where the reason comes from");
});

test("⚠️ the check DRIVES the post's own functions rather than asking its own way", () => {
  // `fonts:check` printed nine green ticks over a banner publishing boxes
  // because it measured a font stack that renderer did not draw with, and
  // `trending:check` reported 44 refusals where the bot reported 25. A check
  // with a second copy of the question proves nothing about the post.
  const src = fss.readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /fulfil\._readPostMarket\(/, "the post's own bounded, DexScreener-first read");
  // The X form now — the same fetch, returning the facts beside the bytes. A
  // guard pinned to the old spelling went red over code that keeps the rule.
  assert.match(src, /fulfil\._fetchLogoUrlX\(/, "…and the post's own logo fetch, through /api/logo, with its facts");
  assert.ok(!/fulfil\._fetchLogoUrl\(/.test(src), "never the bare form — the check needs the why/via to say anything");
  assert.match(src, /postFigures\.missingFigures\(/, "…and the RENDERER's predicate for what publishes as TBA");
  assert.match(src, /postFigures\.artworkLost\(/);
  // The three ways it could grow its own idea of the question.
  assert.ok(!/require\(['"]\.\.\/src\/marketdata['"]\)/.test(src), "never its own market read");
  assert.ok(!/fetchMarket\(/.test(src), "never a second call into the indexers");
  assert.ok(!/api\/logo\?u=/.test(src), "never its own proxy url");
});

test("⚠️ the head prints ONE $, whichever spelling the store holds", () => {
  const src = fss.readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  // The row's `sym` is `$ORCHFLOWS` in the listing store, so `$${sym}` printed
  // `$$ORCHFLOWS` — on the one line that names the token.
  assert.ok(!/`\$\$\{(?:sym|row\.sym)/.test(src), "the check prepends a $ to a value that has one");
  assert.match(src, /ticker\(row\.sym/, "…and it does not spell the rule a seventh time");
  const { ticker } = require("../src/helpers/format");
  assert.equal(ticker("$ORCHFLOWS"), "$ORCHFLOWS");
  assert.equal(ticker("ORCHFLOWS"), "$ORCHFLOWS");
  assert.equal(ticker(null), "$?");
});

test("the build stamp is printed — every round began with a check read off a stale checkout", () => {
  const src = fss.readFileSync(require.resolve("../scripts/post-check.js"), "utf8");
  assert.match(src, /build\.stamp\(\)/);
});

test("⚠️ no pasteable command carries a bracketed blank", () => {
  // This repo has had a placeholder pasted into a live shell four times, and
  // bash reads `<` and `>` as redirects — the command dies before the script
  // runs, which reads as a broken tool rather than an unfilled blank. With no
  // arguments this script asks the SITE for real listings instead.
  const src = fss.readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const line of src.split("\n")) {
    if (!/npm run|node scripts/.test(line)) continue;
    assert.ok(!/<[a-zA-Z]|\[[a-zA-Z]+\]/.test(line), `a pasteable line with a blank in it: ${line.trim()}`);
  }
  assert.match(src, /api\.getListings\(\)/, "no argument means ask the site for REAL tokens");
});

test("⚠️ one argument is refused, never silently answered with other tokens", () => {
  // `post:check -- 0xabc` names a token and omits its chain. Falling through to
  // "the newest listings" would answer a question nobody asked, with nothing on
  // screen saying the argument was dropped — and the operator would read a
  // green result as being about THEIR token.
  //
  // Driven, because this is a CLI branch: it exits before any network call, so
  // spawning it costs nothing and a source scan could not tell the fallthrough
  // from the refusal.
  const { spawnSync } = require("node:child_process");
  const script = require.resolve("../scripts/post-check.js");
  const r = spawnSync(process.execPath, [script, "0xabc"], { encoding: "utf8", timeout: 30_000 });
  assert.strictEqual(r.status, 1, "a half-named token is a refusal, not a different answer");
  assert.match(r.stdout, /BOTH its chain and its address/);
  assert.ok(!/newest listing\(s\), assembled/.test(r.stdout), "it must NOT check other tokens instead");
});

test("⚠️ 'no launchpad HAD it' and 'no launchpad COVERS this chain' are different facts", () => {
  // `$JOVI` on Tron read `no indexer and no launchpad returned anything for
  // this token` — but `padsFor('tron')` is EMPTY, so no launchpad was asked at
  // all. That is "we could not ask" dressed as "nothing is there", in the one
  // sentence whose whole job is explaining a silence.
  const launchpads = require("../src/launchpads");
  assert.equal(launchpads.covers("solana"), true, "precondition: solana has pads");
  assert.equal(launchpads.covers("tron"), false, "precondition: tron has none — the reported case");

  const src = fss
    .readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /launchpads\.covers\(row\.chain\)/, "the sentence must ask whether a pad exists");
  assert.match(src, /no launchpad covers \$\{row\.chain\}/, "…and say so when none does");
  // ⚠️ And the reassuring line may not be printed over a chain we simply never
  // wired a source for: there IS something to fix there, just not on this box
  // today, and "nothing to fix here" would close the question.
  assert.match(src, /unknown && padded\) note\('nothing to fix here/);
});

test("…but a chain with no pad is still ⚠️, never a fault", () => {
  // It stays honest: this box genuinely cannot fill that hole, and reddening
  // would be permanently red on every chain with no pre-migration source —
  // the state `chart:preview` sat in for weeks.
  const a = A({ live: null, why: null, holes: ["price", "market cap", "liquidity"] });
  assert.equal(verdict(a), "honest");
});


// ── --pin: the ONE write a check may make, and only for a named token ────────

test("⚠️ --pin without a named token is REFUSED — five rows on one flag is the hazard", () => {
  const { spawnSync } = require("node:child_process");
  const script = require.resolve("../scripts/post-check.js");
  const r = spawnSync(process.execPath, [script, "--pin"], { encoding: "utf8", timeout: 30_000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /--pin needs the token named/);
  assert.ok(!/newest listing\(s\), assembled/.test(r.stdout), "it must NOT go on to assemble anything");
});

test("⚠️ the check never writes outside the --pin branch", () => {
  // A diagnostic must never write. `_pinLogo` may appear exactly once, inside
  // pinRow, and pinRow is only ever called under `wantPin`.
  const src = fss
    .readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const calls = src.match(/fulfil\._pinLogo\(/g) || [];
  assert.strictEqual(calls.length, 1, "one call site");
  const fn = src.slice(src.indexOf("async function pinRow("), src.indexOf("async function webBuild("));
  assert.match(fn, /fulfil\._pinLogo\(/, "…and it is inside pinRow");
  assert.match(src, /if \(wantPin\) await pinRow\(row, a\);/, "pinRow runs only under --pin");
  // …and a pin reads its result back through the X form's upload branch.
  assert.match(fn, /fulfil\._fetchLogoUrlX\(after\)/);
});

test("the header prints BOTH build stamps — bot and web can sit on different builds", () => {
  const src = fss.readFileSync(require.resolve("../scripts/post-check.js"), "utf8");
  assert.match(src, /async function webBuild\(\)/);
  assert.match(src, /\/api\/tokens/, "the same field deploy.sh verifies");
  assert.match(src, /web \$\{web \|\| 'unknown \(site cold\)'\}/);
  assert.match(src, /serving \$\{web\} but this checkout is \$\{botSha\}/, "a mismatch is said, not assumed");
});

test("a green external logo prints the real-valued --pin line; an upload does not", () => {
  const src = fss
    .readFileSync(require.resolve("../scripts/post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /a\.art\.source !== 'upload'/, "gated on the source the fetch reported");
  assert.match(src, /npm run post:check -- \$\{row\.chain\} \$\{row\.address\} --pin/, "real values from the row, never a bracketed blank");
  // …and a red row prints the proxy's verdict and the ONE owner's class, never its own copy.
  assert.match(src, /postFigures\.artFailure\(/);
  assert.match(src, /postFigures\.artRemedy\(/);
  assert.ok(!/served text\/html/.test(src), "the classification lives in postFigures, not here");
});

// ── The check measures the logo the POST renders, not the row's ─────────────
//
// A blank row takes the token contract's logo at creation (fulfillment's
// adoptChainLogo); a check reading `row.logoUrl` printed "no logo on file"
// over a post that draws the artwork — a guard measuring a stack the renderer
// does not use. Comment-stripped, ORDER pinned: adopt, then fetch.
test("⚠️ assemble() adopts the chain's logo through the post's own rule before it fetches", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "scripts", "post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const fn = src.slice(src.indexOf("async function assemble("), src.indexOf("\n}\n", src.indexOf("async function assemble(")));
  const adopt = fn.indexOf("fulfil._adoptChainLogo(");
  const fetch = fn.indexOf("fulfil._fetchLogoUrlX(");
  assert.ok(adopt > 0, "the check adopts through fulfillment's own rule — never a copy of it");
  assert.ok(fetch > adopt, "…and fetches what the adoption produced");
  assert.ok(!/_fetchLogoUrlX\(row\.logoUrl\)/.test(fn), "the fetch reads the adopted url, not the row's");
  assert.ok(!/wanted: !!row\.logoUrl/.test(fn), "…and so does the lost-artwork verdict");
});
