// Xpress and Listing & Trending are different products, so their receipts are
// separate templates. One shared "Success: listing" meant the tiered buyer was
// never told what the extra money bought — no tier named, no trending hours.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-succ-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

test("both receipts exist in the editor, under Bot Messages", () => {
  for (const key of ["success_listing", "success_listing_tiered"]) {
    assert.ok(tpl.keys().includes(key), `${key} missing`);
    assert.strictEqual(tpl.meta(key).group, "Bot Messages");
  }
  assert.match(tpl.meta("success_listing").label, /xpress/i, "labelled for the product it belongs to");
  assert.match(tpl.meta("success_listing_tiered").label, /listing & trending/i);
  // The key was kept so an operator's existing override survives the split.
  assert.ok(tpl.meta("success_listing").ph.includes("symbol"));
});

test("the tiered receipt accounts for what the extra money bought", () => {
  const ph = tpl.meta("success_listing_tiered").ph;
  for (const v of ["tier", "tierEmoji", "hours"]) {
    assert.ok(ph.includes(v), `{${v}} must be offered to the editor`);
  }
  const text = tpl.render("success_listing_tiered", {
    symbol: "$CUPSEY", name: "Cupsey", tier: "Diamond", tierEmoji: "💎", hours: 48,
    siteUrl: "https://dexvra.io/t", postLinks: "", announceX: "",
    site: "https://dexvra.io", listing: "https://t.me/l", trending: "https://t.me/t", announce: "https://t.me/a",
  }).text;
  assert.ok(text.includes("Diamond"), text);
  assert.ok(/48h/.test(text), `the trending run is stated: ${text}`);
  assert.ok(!/\{|\}/.test(text), "no unfilled placeholders");
});

test("every destination is its own editable line: label written in the template, url filled in", () => {
  // The reference shape the operator asked for: congrats line, the token page as
  // a BARE url, then one labelled raw link per destination. A markdown link
  // hides the url, and a buyer forwards these as proof of delivery. The LABEL
  // lives in the template (so it can be reworded); only the url is substituted.
  const vars = {
    symbol: "$CASHCAT", name: "Cash Cat", tier: "Diamond", tierEmoji: "💎", hours: 48,
    siteUrl: "https://dexvra.io/token/robinhood/0x020b",
    listingUrl: "https://t.me/dexvralisting/8733",
    xUrl: "https://x.com/listingdexvra/status/207487",
    announceUrl: "https://t.me/dexvraio/11993",
    trendingUrl: "https://t.me/dexvratrending/9106",
    postLinks: "", announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  };
  const text = tpl.render("success_listing_tiered", vars, { dropEmpty: true }).text;
  for (const line of [
    "🔔 Dexvra Listing: https://t.me/dexvralisting/8733",
    "🔔 Dexvra Listing (X): https://x.com/listingdexvra/status/207487",
    "🔔 Dexvra Announcement: https://t.me/dexvraio/11993",
    "🔔 Dexvra Trending: https://t.me/dexvratrending/9106",
  ]) assert.ok(text.includes(line), `missing: ${line}\n---\n${text}`);
  // Each url must land on its OWN line, not be swallowed by the line above.
  assert.match(text, /Dexvra Listing: \S+\n🔔 Dexvra Listing \(X\)/, text);
  assert.ok(text.includes("https://dexvra.io/token/robinhood/0x020b"), "the token page is a bare url");
  assert.ok(!/\]\(/.test(text), "no markdown links — the urls are visible");
  assert.ok(!/dexvra\.io\s*\|/.test(text), "no footer row: the links above already reach every channel");
  assert.ok(!/\n\s*$/.test(text), "no trailing blank line");
  // The label belongs to the editor, so a reworded template must still work.
  for (const v of ["listingUrl", "xUrl", "announceUrl", "trendingUrl"]) {
    assert.ok(tpl.meta("success_listing_tiered").ph.includes(v), `{${v}} must be offered to the editor`);
  }
});

test("a post that never happened takes its whole line with it, label included", () => {
  // An Xpress buyer gets no announcement and no trending post; a token with X
  // posting off gets no tweet. Those lines must vanish — printing a bare
  // "🔔 Dexvra Trending:" with nothing after it reads as a broken receipt.
  const text = tpl.render("success_listing_tiered", {
    symbol: "$X", name: "X", tier: "Bronze", tierEmoji: "🥉", hours: 6,
    siteUrl: "https://dexvra.io/t",
    listingUrl: "https://t.me/dexvralisting/1", xUrl: "", announceUrl: "", trendingUrl: "",
    postLinks: "", announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  }, { dropEmpty: true }).text;
  assert.ok(text.includes("🔔 Dexvra Listing: https://t.me/dexvralisting/1"), text);
  assert.ok(!/\(X\)/.test(text), `the X line is gone, label and all:\n${text}`);
  assert.ok(!/Announcement/.test(text), `the announcement line is gone:\n${text}`);
  assert.ok(!/🔔 Dexvra Trending/.test(text), `the trending line is gone:\n${text}`);
  assert.ok(!/\{|\}/.test(text), "no unfilled placeholders");
  assert.ok(!/:\s*$/m.test(text), "no dangling label with no url");
});

test("a receipt with no links at all ends on its last words, not on blank lines", () => {
  // Every link line gone (a GramJS post that failed leaves no urls) must also
  // take the blank separator that introduced the block — two tail cuts touch,
  // and an unmerged pair used to leave a stray newline behind.
  const text = tpl.render("success_trending", {
    symbol: "$X", hours: 6, siteUrl: "https://dexvra.io/t",
    trendingUrl: "", announceUrl: "", xUrl: "", postLinks: "", announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  }, { dropEmpty: true }).text;
  assert.ok(text.endsWith("https://dexvra.io/t"), JSON.stringify(text));
  assert.ok(!/🔔/.test(text), `no orphan labels:\n${text}`);
});

test("dropEmpty is opt-in — a template whose header holds a lone optional emoji survives", () => {
  // {logoEmoji} is empty for most tokens. Dropping "empty" lines by default
  // deleted the whole trending header line with it.
  const head = tpl.render("post_trending", {
    logoEmoji: "", symbol: "$X", name: "X", hours: 6,
    price: "$1", mcap: "$1M", vol: "$1", chg: "0%", chain: "eth", ca: "0x1",
    socials: "", footer: "", rank: 1, tier: "Bronze", tierEmoji: "🥉", siteUrl: "u",
  }).text;
  assert.ok(head.trim().length > 0, "the header line is still there");
  assert.ok(/\$X/.test(head), head);
});

test("the tweet sits under its own channel post, and only once", () => {
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const iListing = src.indexOf('label: "🔔 Dexvra Listing"');
  const iX = src.indexOf('label: "🔔 Dexvra Listing (X)"');
  const iAnn = src.indexOf('label: "🔔 Dexvra Announcement"');
  assert.ok(iListing > -1 && iX > iListing && iAnn > iX, "order: listing → X → announcement");
  // {announceX} is the legacy one-line "Announce on X" slot. The tweet now has
  // its own {xUrl} line, so repeating it here would print the tweet twice.
  assert.match(src, /announceX: "", \/\/ the tweet has its own line/, "…so {announceX} must not repeat it");
  // Links are keyed by an explicit `kind`, never by label text: "Dexvra Listing"
  // is a PREFIX of "Dexvra Listing (X)", so substring matching would hand the
  // listing line the tweet's url — and labels are the operator's to reword.
  assert.match(src, /\(links \|\| \[\]\)\.find\(\(l\) => l\.kind === kind\)/, "linkVars matches on kind");
  for (const k of ["listing", "x", "announce", "trending"]) {
    assert.ok(src.includes(`kind: "${k}"`), `no link is tagged kind: "${k}"`);
  }
});

test("the Xpress receipt promises nothing it doesn't deliver", () => {
  const text = tpl.render("success_listing", {
    symbol: "$X", name: "X", siteUrl: "u", postLinks: "", announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  }).text;
  // Xpress has no tier and no trending slot (TIER_TREND_HOURS.XPRESS = 0), so
  // the receipt must not mention either.
  assert.ok(!/tier/i.test(text), text);
  assert.ok(!/trending for/i.test(text), text);
  assert.match(text, /officially listed/i);
});

test("fulfilment picks the receipt from the tier, not from the flow", () => {
  // A tiered order that somehow arrives with tier XPRESS must still get the
  // Xpress receipt — the tier is what the buyer actually received.
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  assert.match(src, /String\(coin\.tier\)\.toUpperCase\(\) !== "XPRESS"/, "the choice is made on the tier");
  assert.match(src, /success_listing_tiered/, "…and both keys are reachable");
  assert.match(src, /successListing\(coin, links, \{ hours \}\)/, "the trending hours reach the receipt");
});
