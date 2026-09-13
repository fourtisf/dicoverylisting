// The board is EDITED IN PLACE, so the pinned message looks identical at 09:00
// and 15:00. A reader coming back to it cannot see what changed — and "what just
// entered trending" is the only thing they came for. A marker on the fresh
// entries, plus a legend saying what it means, is the whole fix.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-newmark-"));

const test = require("node:test");
const assert = require("node:assert");

const board = require("../src/services/trendingBoard");

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-07-27T12:00:00Z");

test("the default marker and window match what the board legend promises", () => {
  assert.strictEqual(board.DEFAULT_NEW_EMOJI, "🌩");
  assert.strictEqual(board.DEFAULT_NEW_HOURS, 3);
  assert.strictEqual(board.newEmoji(), "🌩");
  assert.strictEqual(board.newHours(), 3);
});

test("only a slot that started inside the window is marked", async () => {
  await board.setNewHours(3);
  assert.strictEqual(board.isNewlyTrending({ trendStart: NOW - HOUR }, NOW), true, "1h ago is new");
  assert.strictEqual(board.isNewlyTrending({ trendStart: NOW - 2.9 * HOUR }, NOW), true, "just inside");
  assert.strictEqual(board.isNewlyTrending({ trendStart: NOW - 3.1 * HOUR }, NOW), false, "just outside");
  assert.strictEqual(board.isNewlyTrending({ trendStart: NOW - 40 * HOUR }, NOW), false);
});

test("a listing with no trendStart is never marked — absent is not recent", async () => {
  // Old rows predate the field, and a missing timestamp read as 0 would make
  // every one of them "1970 — not new"… or, with a sloppier check, all new.
  for (const row of [{}, { trendStart: null }, { trendStart: 0 }, { trendStart: "soon" }, { trendStart: NaN }]) {
    assert.strictEqual(board.isNewlyTrending(row, NOW), false, JSON.stringify(row));
  }
});

test("the window is admin-settable, and the marker follows it", async () => {
  const six = await board.setNewHours(6);
  assert.strictEqual(six, 6);
  assert.strictEqual(board.isNewlyTrending({ trendStart: NOW - 5 * HOUR }, NOW), true, "5h is new at a 6h window");
  await board.setNewHours(3);
  assert.strictEqual(board.isNewlyTrending({ trendStart: NOW - 5 * HOUR }, NOW), false, "…and not at a 3h one");
});

test("a fat-fingered window is clamped, not stored", async () => {
  assert.strictEqual(await board.setNewHours(9999), board.NEW_HOURS_MAX);
  assert.strictEqual(await board.setNewHours(0), board.NEW_HOURS_MIN);
  assert.strictEqual(await board.setNewHours(-5), board.NEW_HOURS_MIN);
  // A mark that lasts a week stops meaning "just now" — the cap is the feature.
  assert.ok(board.NEW_HOURS_MAX <= 48);
  await board.setNewHours(3);
});

test("the marker can be a premium emoji, like every other slot on the board", async () => {
  // Premium markup is "[🌩](emoji/ID)" and is spliced verbatim into the board's
  // markup, so it has to survive storage intact.
  await board.setNewEmoji("[⚡](emoji/5445284980978621387)");
  assert.strictEqual(board.newEmoji(), "[⚡](emoji/5445284980978621387)");
  assert.strictEqual(board.isNewPremium(), true);
  assert.strictEqual(board.displayEmoji(board.newEmoji()), "⚡", "the editor shows the fallback char");
  assert.strictEqual(board.isNewCustom(), true);
  await board.setNewEmoji("");
  assert.strictEqual(board.newEmoji(), "🌩", "clearing restores the default");
  assert.strictEqual(board.isNewCustom(), false);
});

test("a stored marker cannot smuggle markup into a public channel post", async () => {
  // Everything here is spliced into the board's markup verbatim, so a value like
  // "[tap](https://evil)" would render as a LINK where an emoji belongs.
  await board.setNewEmoji("[tap](https://evil.example)");
  assert.ok(!/\]\(https?:/.test(board.newEmoji()), `markup survived: ${board.newEmoji()}`);
  await board.setNewEmoji("");
});

test("the board marks fresh entries and explains the mark — but only when there is one", () => {
  const src = fss.readFileSync(require.resolve("../src/services/trendingPoster.js"), "utf8");
  // The mark sits between the rank badge and the percentage.
  assert.match(src, /const isNew = board\.isNewlyTrending\(e\.r, now\);/);
  assert.match(src, /const segs = \[board\.rankBadge\(i \+ 1\), isNew \? board\.newEmoji\(\) : "", pct, "\|", link\];/);
  // The legend is conditional. Printing "🌩 = newly entered" on a board with no
  // 🌩 on it sends the reader hunting for a mark that is not there.
  assert.match(src, /if \(newCount > 0\) \{/);
  assert.match(src, /= Newly Entered Trending \(slot started in the last \$\{h\} hour/);
  // The legend quotes the SAME emoji and the SAME window the marks came from,
  // so the two can never describe different things.
  const legend = src.slice(src.indexOf("if (newCount > 0)"), src.indexOf("return lines.join"));
  assert.match(legend, /board\.newEmoji\(\)/);
  assert.match(legend, /const h = board\.newHours\(\);/);
  assert.ok(!/🌩/.test(legend), "the legend must not hardcode the default emoji");
});

test("both knobs are reachable from the admin bot", () => {
  const src = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  assert.match(src, /cb\(`⏱ \$\{trendingBoard\.newHours\(\)\}h window`, "tbnh"\)/);
  assert.match(src, /bot\.action\("tbn", async \(ctx\) => \{/, "the emoji editor");
  assert.match(src, /bot\.action\("tbnh", async \(ctx\) => \{/, "the window editor");
  assert.match(src, /if \(mode === "tbnew"\) \{/);
  assert.match(src, /if \(mode === "tbnewhours"\) \{/);
  // A clamped value must be reported as STORED, not as typed — otherwise the
  // admin walks away believing 99h took.
  assert.match(src, /clamped from \$\{n\}/);
});

test("Robinhood's chain logo takes a premium emoji too", async () => {
  // Same mechanism as the rank badges: the operator asked for this one
  // specifically, so it is pinned rather than assumed.
  assert.ok(board.chainList().some((c) => c.id === "robinhood"), "…and it is offered in the editor");
  await board.setChainLogo("robinhood", "[🪶](emoji/5449550323369623998)");
  assert.strictEqual(board.chainLogo("robinhood"), "[🪶](emoji/5449550323369623998)");
  assert.strictEqual(board.isChainPremium("robinhood"), true);
  assert.strictEqual(board.displayEmoji(board.chainLogo("robinhood")), "🪶");
  await board.setChainLogo("robinhood", "");
});
