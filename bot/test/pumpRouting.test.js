// Where a pump alert may appear, and when the once-per-token latch is spent.
//
// The rule is a BUSINESS rule: a token only gets a pump alert in a channel where
// it has a listing post to reply to. An Xpress buyer gets no @dexvraio
// announcement, so an Xpress token must never produce a pump alert there —
// posting one stand-alone would advertise a token that channel never listed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pump-"));

const test = require("node:test");
const assert = require("node:assert");
const { pumpTargets } = require("../src/services/pumpChecker");
const { CHANNELS } = require("../src/config/constants");

test("Xpress listing: the listing channel only", () => {
  const t = pumpTargets({ listingMsgId: 42 });
  assert.deepStrictEqual(t, [{ channel: CHANNELS.listing, replyTo: 42 }]);
});

test("Listing & Trending: both channels, each replying to ITS OWN post", () => {
  const t = pumpTargets({ listingMsgId: 42, annMsgId: 7 });
  assert.deepStrictEqual(t, [
    { channel: CHANNELS.listing, replyTo: 42 },
    { channel: CHANNELS.announce, replyTo: 7 },
  ]);
  assert.notStrictEqual(t[0].replyTo, t[1].replyTo, "a message id is per-channel — never reused across them");
});

test("no listing post anywhere → no alert at all (never stand-alone)", () => {
  assert.deepStrictEqual(pumpTargets({}), []);
  assert.deepStrictEqual(pumpTargets(), []);
  assert.deepStrictEqual(pumpTargets({ listingTweetId: "123" }), [], "a tweet id is not a reply target");
});

test("an announcement post without a listing post still can't post stand-alone", () => {
  // Shouldn't happen, but if it does the announcement reply is legitimate and
  // the listing channel gets nothing — rather than a loose post in both.
  assert.deepStrictEqual(pumpTargets({ annMsgId: 9 }), [{ channel: CHANNELS.announce, replyTo: 9 }]);
});

test("the latch is spent only after the alert posts", () => {
  // Latching at DETECTION time meant a failed post burned the token's step
  // forever, and the bug is invisible in normal operation — it only shows up as
  // an alert that never came.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iPost = src.indexOf("post.sendMedia");
  const iFailGuard = src.indexOf("if (!posted)");
  assert.ok(iPost > -1 && iFailGuard > iPost, "a failed post must skip the latch");

  // Retiring a pre-ladder token consumes steps WITHOUT posting, so it sits before
  // the post; the success path must sit after the !posted bail-out.
  const retire = [...src.matchAll(/absorbLegacy\(latch, key, milestone/g)].map((m) => m.index);
  const success = [...src.matchAll(/await latch\.addAll\(stepKeys\(key, milestone/g)].map((m) => m.index);
  assert.equal(retire.length, 1, `expected exactly one retire site, found ${retire.length}`);
  assert.equal(success.length, 1, `expected exactly one post-success consume, found ${success.length}`);
  assert.ok(retire[0] < iPost, "retiring belongs before the post");
  assert.ok(success[0] > iFailGuard, "the latch must be spent AFTER the post, not before it");

  // The branch is decided in one place, so the ordering is testable as behaviour
  // (see pumpMilestones.test.js) rather than inferred from the shape of the file.
  assert.match(src, /const action = decide\(latch, key, milestone\);/, "the poll must go through decide()");
});

test("an announce-only token latches after posting — it must not re-fire forever", () => {
  // `posted` used to be assigned ONLY for CHANNELS.listing. A token with an
  // @dexvraio announcement but no listing-channel post (its listing post failed,
  // or an admin force-posted just the announcement) therefore posted to
  // @dexvraio successfully, left `posted` null, skipped the latch, and alerted
  // again on EVERY poll — and once the tweet moved ahead of the post, it tweeted
  // again every poll too. The fix is that ANY target counts as posted.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const loop = src.slice(src.indexOf("for (const t of targets)"), src.indexOf("if (!posted)"));
  assert.ok(
    !/t\.channel === CHANNELS\.listing/.test(loop),
    `"did it post?" must not be scoped to one channel:\n${loop}`,
  );
  assert.match(loop, /if \(msg\) posted = posted \|\| msg/, "any successful target must count as posted");
});

test("the pump tweet is fired BEFORE the card is built, so the card can link it", () => {
  // post_pump carries an "Announce On X" line that reads coin.xUrl. A tweet
  // fired after fmt.pumpPost() can never reach it — the line silently strips
  // itself and the alert loses its X link, with nothing in the logs.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iTweet = src.indexOf("x.postPump");
  const iXUrl = src.indexOf("coin.xUrl =");
  const iCard = src.indexOf("fmt.pumpPost");
  assert.ok(iTweet > -1 && iXUrl > -1 && iCard > -1, "all three steps present");
  assert.ok(iTweet < iXUrl && iXUrl < iCard, "order must be: tweet → set xUrl → build card");
});
