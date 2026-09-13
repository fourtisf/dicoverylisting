// Repointing every SAVED template at the new X account, without resetting them.
//
// The rename landed in the code defaults, and templates.js's own header says a
// saved override BEATS the shipped copy — so on any box where a card was ever
// edited, the fix did nothing. The advice was "hit ♻️ Reset default", which
// throws away every other edit on that card to change one word.
//
// ⚠️ The danger is that the two accounts are one transposition apart and the
// intro cards name BOTH, on adjacent lines. Deciding by the LABEL would break
// every Telegram link on the box.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-retarget-"));

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");

const FILE = path.join(process.env.BOT_DATA_DIR, "templates.json");
const SCRIPT = path.join(__dirname, "../scripts/retarget-x-handle.js");

const run = (...extra) =>
  execFileSync(process.execPath, [SCRIPT, ...extra], {
    encoding: "utf8",
    env: { ...process.env, BOT_DATA_DIR: process.env.BOT_DATA_DIR, X_LISTING_HANDLE: "listingdexvra" },
  });

const write = (obj) => fss.writeFileSync(FILE, JSON.stringify(obj, null, 2));
const read = () => JSON.parse(fss.readFileSync(FILE, "utf8"));

// The real shape of the card that names both accounts.
const INTRO =
  "⚡ **Xpress Listing**\n\n" +
  "🚨 Launch post on [@dexvralisting](https://t.me/dexvralisting)\n" +
  "𝕏 Automatic post on X — [@dexvralisting]({xlisting})\n\n" +
  "MY OWN EDIT — do not lose this line";

test("the X link is repointed and the TELEGRAM link on the line above is not", () => {
  write({ intro_xpress: INTRO });
  run("--apply");
  const out = read().intro_xpress;

  assert.match(out, /\[@dexvralisting\]\(https:\/\/t\.me\/dexvralisting\)/, "the Telegram channel did NOT move");
  assert.match(out, /\[@listingdexvra\]\(\{xlisting\}\)/, "the X link must name the new account");
  assert.ok(!/\[@dexvralisting\]\(\{xlisting\}\)/.test(out), "the old X label survived");
  // The whole point: everything else the operator wrote is still there.
  assert.match(out, /MY OWN EDIT — do not lose this line/, "a reset would have destroyed this");
});

test("it is idempotent — a second run finds nothing", () => {
  const before = read().intro_xpress;
  const out = run("--apply");
  assert.match(out, /nothing to rename/, out);
  assert.strictEqual(read().intro_xpress, before, "a second run must not touch the file");
});

test("a dry run writes NOTHING", () => {
  write({ intro_xpress: INTRO });
  const out = run();
  assert.match(out, /DRY RUN/, out);
  assert.strictEqual(read().intro_xpress, INTRO, "the file must be untouched without --apply");
});

test("⚠️ an entity-bearing template keeps its offsets, because the swap is length-preserving", () => {
  // A saved template can be { text, entities } — the premium-markup editor
  // stores bold/link ranges as character OFFSETS. Any edit that changes the
  // length shifts every entity after it and silently corrupts the card.
  // `dexvralisting` and `listingdexvra` are both 13 characters, so this is safe
  // by construction rather than by nobody having used entities yet.
  const text = "𝕏 Post on X — [@dexvralisting]({xlisting})\nBOLD TAIL";
  const entities = [{ type: "bold", offset: text.indexOf("BOLD TAIL"), length: 9 }];
  write({ post_listing_xpress: { text, entities } });
  run("--apply");
  const out = read().post_listing_xpress;

  assert.strictEqual(out.text.length, text.length, "the length moved — every entity after it would shift");
  assert.match(out.text, /@listingdexvra/);
  assert.deepStrictEqual(out.entities, entities, "the entities must survive untouched");
  // …and the offset must still land on the same words.
  assert.strictEqual(out.text.substr(out.entities[0].offset, out.entities[0].length), "BOLD TAIL");
});

test("a hardcoded profile URL is repointed too, and a project's own X link is not", () => {
  write({
    welcome: "Follow https://x.com/dexvralisting for listings",
    // A token's own social row. Rewriting somebody else's account would be the
    // worst possible outcome of a rename script.
    post_listing_xpress: "𝕏 [X](https://x.com/someproject) · 💬 [TG](https://t.me/someproject)",
  });
  run("--apply");
  const out = read();
  assert.match(out.welcome, /https:\/\/x\.com\/listingdexvra/);
  assert.strictEqual(
    out.post_listing_xpress,
    "𝕏 [X](https://x.com/someproject) · 💬 [TG](https://t.me/someproject)",
    "a project's own links must be untouched",
  );
});

test("a bare mention with no link is REPORTED, never guessed at", () => {
  // On every shipped card `@dexvralisting` with no link is the Telegram
  // channel. On a card an operator rewrote it might mean X. The code cannot
  // tell, so it hands those lines to a human instead of picking.
  write({ tier_chooser: "Every tier includes a launch post on @dexvralisting and an automatic X post." });
  const out = run();
  assert.match(out, /Read these yourself/, out);
  assert.match(out, /launch post on @dexvralisting/, out);
  assert.match(out, /nothing to rename/, "it must not silently rewrite an ambiguous mention");
});

test("⚠️ it follows the url into a formatting ENTITY, where the text never names it", () => {
  // The reported card: welcome → Official Links → "Dexvra Listing" opened
  // https://x.com/dexvralisting?s=11. That url is in NO part of the text — a
  // pasted, formatted message stores its links as text_link entities, and the
  // first cut of this script scanned the text only and answered "nothing to
  // rename" over it. A rename tool reporting a clean box while the link is
  // still wrong is worse than no tool: it ends the search.
  const text = "🔗 Official Links\nDexvra Listing\nDexvra Announcement";
  const entities = [
    { type: "text_link", offset: text.indexOf("Dexvra Listing"), length: 14, url: "https://x.com/dexvralisting?s=11" },
    // The ANNOUNCEMENT account is a different account and must not move.
    { type: "text_link", offset: text.indexOf("Dexvra Announcement"), length: 19, url: "https://x.com/dexvraio" },
    { type: "bold", offset: 0, length: 16 },
  ];
  write({ welcome: { text, entities } });
  run("--apply");
  const out = read().welcome;

  assert.strictEqual(out.entities[0].url, "https://x.com/listingdexvra?s=11", "the entity url must be repointed");
  // The ?s= suffix is the operator's own — copied from the X app — and is not
  // ours to tidy away.
  assert.match(out.entities[0].url, /\?s=11$/);
  assert.strictEqual(out.entities[1].url, "https://x.com/dexvraio", "@dexvraio is a different account");
  assert.strictEqual(out.text, text, "the text carries no url, so it must not change at all");
  // Nothing moved, so every offset is still correct.
  assert.deepStrictEqual(
    out.entities.map((e) => [e.offset, e.length]),
    entities.map((e) => [e.offset, e.length]),
  );
});

test("a label that spells the handle out is fixed inside its own entity range", () => {
  // A link whose visible text IS the handle, carried by an entity rather than
  // markdown. The swap is bounded to that entity's range, so a mention of the
  // Telegram channel elsewhere on the card is untouched.
  const text = "Follow @dexvralisting on X\nLaunch post on @dexvralisting";
  const entities = [{ type: "text_link", offset: 7, length: 14, url: "https://x.com/dexvralisting" }];
  write({ welcome: { text, entities } });
  run("--apply");
  const out = read().welcome;

  assert.strictEqual(out.text.slice(7, 21), "@listingdexvra", "the linked label follows its url");
  assert.match(out.text, /Launch post on @dexvralisting$/, "the unlinked Telegram mention is untouched");
  assert.strictEqual(out.text.length, text.length);
  assert.strictEqual(out.entities[0].url, "https://x.com/listingdexvra");
});

test("in a TWEET a bare mention is swapped — there is no Telegram inside a tweet", () => {
  // The general rule punts on a bare @mention because on every card this repo
  // ships that is the Telegram channel. The X Posts group is the one place that
  // ambiguity does not exist: the copy goes out as a tweet, so the only account
  // it can mean is the X one. Leaving those in the "read these yourself" pile
  // is exactly the manual work this script exists to end.
  write({ x_banner: "📢 Banner Live on Dexvra\n{title} is now featured on @dexvralisting\n{url}" });
  run("--apply");
  assert.match(read().x_banner, /featured on @listingdexvra/);
  assert.ok(!/@dexvralisting/.test(read().x_banner));
});

test("…and the same bare mention in a TELEGRAM card is still only reported", () => {
  // The other half of the same rule, and the one that would break links if it
  // ever became a swap: on a Telegram card @dexvralisting is the channel, which
  // did not move.
  write({ tier_chooser: "Every tier includes a launch post on @dexvralisting." });
  const out = run();
  assert.match(out, /Read these yourself/, out);
  assert.match(out, /nothing to rename/, "a Telegram card must never be guessed at");
  assert.match(read().tier_chooser, /@dexvralisting/, "…and it must be left exactly as it was");
});
