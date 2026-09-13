// /verified sold verification for "1.5 SOL / one-time" — a price that appears
// in no package on this site and in no product in the bot, so nothing could
// quote it and nothing could collect it. And the badge it was selling is
// already included in Diamond, Gold and Platinum: a project that had just paid
// 5 SOL for Diamond read that page and concluded it owed another 1.5 SOL.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { LISTING_TIERS, tierPrice } from "./packages.ts";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const page = () => read("src/app/(site)/verified/page.tsx");
/** The file with its comments removed. The comment above the fix quotes the old
 *  copy on purpose, to tell the next reader why it went — so every assertion
 *  about what a VISITOR sees has to read the code, not the explanation. */
const rendered = () =>
  page()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("no price on the page that the bot cannot charge", () => {
  const src = rendered();
  assert.ok(!/1\.5 SOL/.test(src), "the invented standalone price is gone");
  // Every number a buyer sees must come from the shared tier table.
  assert.match(src, /tierPrice\(/, "prices are read, not written");
  assert.ok(!/\d+(\.\d+)?\s*(SOL|BNB|ETH|TON|TRX)/.test(src), "no hardcoded amount survives");
});

test("the badge tiers are exactly the ones whose blurbs promise it", () => {
  const src = rendered();
  assert.match(src, /LISTING_TIERS\.filter\(\(t\) => t\.verified\)/);
  const withBadge = LISTING_TIERS.filter((t) => t.verified).map((t) => t.key);
  assert.deepStrictEqual(withBadge, ["DIAMOND", "GOLD", "PLATINUM"], "the tiers whose blurbs promise it");
  // Their own blurbs are the source this was checked against.
  for (const t of LISTING_TIERS.filter((x) => x.verified)) {
    assert.match(t.blurb, /verified badge/i, `${t.key} claims the badge in its blurb`);
  }
  for (const t of LISTING_TIERS.filter((x) => !x.verified && !x.instant)) {
    assert.ok(!/verified badge/i.test(t.blurb), `${t.key} must not promise a badge it does not include`);
  }
});

test("the page says plainly there is no separate fee", () => {
  // The whole defect was a buyer believing they owed twice. The subtitle has to
  // remove that belief before they read a single price.
  assert.match(rendered(), /no separate fee/i);
});

test("verification is data on the tier, not inferred from its rank", () => {
  // Two pages were each deciding it with `rank <= 3`. A sixth tier, or a
  // reordering, silently changes what both of them promise.
  assert.ok(!/rank <= 3 \? "Verified badge"/.test(read("src/app/(site)/advertise/page.tsx")));
  assert.match(read("src/app/(site)/advertise/page.tsx"), /tier\.verified \? "Verified badge"/);
  for (const t of LISTING_TIERS) assert.strictEqual(typeof t.verified, "boolean", `${t.key} needs the flag`);
});

test("the site and the bot charge the same for every tier on every chain", () => {
  // They are separate files in separate runtimes; a price edited in one and not
  // the other means the page quotes what the bot will refuse to take.
  const botSrc = read("bot/src/config/packages.js");
  for (const t of LISTING_TIERS) {
    if (t.key === "FREE") continue;
    const m = new RegExp(`key: "${t.key}"[\\s\\S]*?price: \\{([^}]*)\\}`).exec(botSrc);
    assert.ok(m, `${t.key} missing from the bot's packages`);
    for (const [sym, amount] of Object.entries(t.price)) {
      const bm = new RegExp(`${sym}:\\s*([\\d.]+)`).exec(m[1]);
      assert.ok(bm, `${t.key}/${sym} missing in the bot`);
      assert.strictEqual(Number(bm[1]), amount, `${t.key}/${sym}: site ${amount}, bot ${bm[1]}`);
    }
  }
});

test("every chain the page offers has a price for every badge tier", () => {
  // An empty price renders as "—", which on a pricing page reads as broken.
  for (const t of LISTING_TIERS.filter((x) => x.verified)) {
    for (const chain of ["solana", "bsc", "ethereum", "base"]) {
      assert.ok(tierPrice(t.key, chain) != null, `${t.key} has no price on ${chain}`);
    }
  }
});

test("Xpress is on the page, and its card says what it does not include", async () => {
  // Leaving the cheapest package off a pricing page sends a buyer to /advertise
  // to find it — and some of them just leave. It is shown, with the badge marked
  // as NOT included rather than that being left to a footnote below the fold.
  const src = rendered();
  assert.match(src, /const cards = xpress \? \[\.\.\.withBadge, xpress\] : withBadge/, "Xpress is a card, not a footnote");
  assert.match(src, /Priority verification — reviewed first|Instant activation — no review wait/);
  assert.match(src, /\{ label: "Verified badge", has: tier\.verified \}/, "the badge is included or excluded from the tier's own flag");
  assert.match(src, /className=\{p\.has \? "" : "no"\}/, "and rendered differently from an included perk");
  assert.match(read("src/app/globals.css"), /\.pkg-perks li\.no::before\{content:"×"/, "a ×, not a ✓");
});

test("no card ever claims a perk its tier does not have", async () => {
  // The whole page exists because a badge was promised in a place that did not
  // include it. The included/excluded split must come from the tier data.
  const src = rendered();
  assert.match(src, /has: tier\.verified/, "the perk list reads the tier's own flag");
  const xpress = LISTING_TIERS.find((t) => t.instant)!;
  assert.strictEqual(xpress.verified, false, "Xpress does not include the badge");
  assert.match(xpress.blurb, /priority verification/i, "…it includes priority REVIEW, which the card says");
});

test("the perks name everything a tier actually includes", () => {
  // The cards listed three things and the tiers deliver five. The strongest one
  // — Diamond carries two full days of trending — was not on the page at all.
  const src = rendered();
  assert.match(src, /Verified badge/);
  assert.match(src, /Announcement post in \$\{TELEGRAM_HANDLE\}/, "the channel is named, not just 'announcement post'");
  assert.match(src, /Auto trending \$\{hours\}h in \$\{TELEGRAM_TRENDING_HANDLE\}/, "the hours AND where it runs");
  assert.match(src, /Listing post in \$\{TELEGRAM_LISTING_HANDLE\}/, "the one post every package gets");
  assert.match(src, /Announcement on X/);
  assert.match(src, /tierTrendingHours\(tier\.key\)/, "read from data, never written per card");
});

test("each perk's included/excluded state comes from the tier, not the page", () => {
  const src = rendered();
  assert.match(src, /has: tier\.verified/);
  assert.match(src, /has: tier\.announce/, "only announce tiers get the @dexvraio post — fulfilment gates on this");
  assert.match(src, /has: hours > 0/);
});

test("Xpress shows what it does and does not get", async () => {
  const { LISTING_TIERS, tierTrendingHours } = await import("./packages.ts");
  const x = LISTING_TIERS.find((t) => t.instant)!;
  assert.strictEqual(x.verified, false, "no badge");
  assert.strictEqual(x.announce, false, "no @dexvraio post — fulfilment skips it, so the page must not promise it");
  assert.strictEqual(tierTrendingHours(x.key), 0, "no trending slot");
  // But it IS tweeted: fulfilment calls x.postListing for every listing.
  assert.match(rendered(), /\{ label: "Announcement on X", has: true \}/);
});

test("the top tier is flagged BEST SELLER", () => {
  const src = rendered();
  assert.match(src, /pkg-flag">BEST SELLER</);
  assert.ok(!/pkg-flag">TOP TIER</.test(src), "one flag per card — the rank is already printed beside the name");
});

test("the site and the bot agree on trending hours, not just on price", async () => {
  // The bot bills a Diamond buyer for 48h. If the page said 24 it would be
  // underselling; if it said 72 it would be a promise nothing keeps.
  const { TIER_TREND_HOURS } = await import("./packages.ts");
  const botSrc = read("bot/src/config/packages.js");
  const m = /const TIER_TREND_HOURS = \{([^}]*)\}/.exec(botSrc);
  assert.ok(m, "the bot's table moved — this check must follow it");
  for (const [key, hours] of Object.entries(TIER_TREND_HOURS)) {
    const bm = new RegExp(`${key}:\\s*(\\d+)`).exec(m[1]);
    assert.ok(bm, `${key} missing from the bot's table`);
    assert.strictEqual(Number(bm[1]), hours, `${key}: site ${hours}h, bot ${bm[1]}h`);
  }
});

test("/advertise lists the same five perks, from the same data", () => {
  // Two pricing pages describing one product must not disagree about what it
  // includes; a buyer who reads both and sees different lists trusts neither.
  const src = read("src/app/(site)/advertise/page.tsx");
  assert.match(src, /tierTrendingHours\(tier\.key\)/);
  assert.match(src, /Announcement post in \$\{TELEGRAM_HANDLE\}/);
  assert.match(src, /Announcement on X/);
  assert.ok(!/tier\.rank <= 3/.test(src), "nothing is inferred from rank any more");
});

test("every package's listing post is named — it is what all of them buy", async () => {
  // post.sendMedia(CHANNELS.listing) runs for EVERY package, Xpress included,
  // and no card was saying so. The one thing every buyer gets was the one thing
  // the pricing pages did not mention.
  const src = rendered();
  assert.match(src, /\{ label: `Listing post in \$\{TELEGRAM_LISTING_HANDLE\}`, has: true \}/);
  // Said once in prose too, so it is clear before a buyer compares columns.
  assert.match(src, /Every package, Xpress\s*\n?\s*included, is posted to/);
  const adv = read("src/app/(site)/advertise/page.tsx");
  assert.match(adv, /TELEGRAM_LISTING_HANDLE/, "/advertise says it as well");
  assert.match(adv, /Every package — Xpress included — is posted to/);
});

test("the perk lines name the channel, not just the action", async () => {
  // "Announcement post" left a buyer wondering where it lands. Every post perk
  // names the account it lands in, and those come from the socials list.
  const src = rendered();
  for (const h of ["TELEGRAM_HANDLE", "TELEGRAM_LISTING_HANDLE", "TELEGRAM_TRENDING_HANDLE"]) {
    assert.ok(src.includes(h), `${h} must appear in a perk label`);
  }
  assert.ok(!/@dexvra(io|listing|trending)/.test(src), "no handle is hardcoded on the page");
});

// ── The board's badge and the pricing pages' badge must be one decision ──────
//
// verifiedTier() in lib/listings.ts was a hardcoded list that included XPRESS,
// while packages.ts, /verified, /advertise and the tests above all say Xpress
// does NOT include the badge. That is the same class of defect this file was
// written for — a perk promised in one place and priced in another — and it had
// teeth: the bot's auto-lister hands out the XPRESS tier for FREE, so every free
// auto-listing was being flagged verified.
// listings.ts cannot be imported here — it pulls in "./score" extensionless,
// which Next resolves and node's strip-types loader does not. So the behaviour
// is pinned in two halves: this test fixes the ANSWER for every tier that can
// reach a real token, and the next one fixes that verifiedTier reads exactly
// this source rather than keeping its own copy.
test("every tier that can reach a token has a settled badge answer", async () => {
  const { LISTING_TIERS, FREE_TIER, tierMeta } = await import("./packages.ts");
  for (const t of LISTING_TIERS) {
    assert.strictEqual(tierMeta(t.key)?.verified, t.verified, `${t.key} is not its own source of truth`);
  }
  // The two the bot's auto-lister hands out for free — nobody paid for either,
  // so neither may carry the badge Diamond/Gold/Platinum are sold on.
  assert.strictEqual(tierMeta("XPRESS")?.verified, false, "Xpress does not include the badge — its own card says so");
  assert.strictEqual(tierMeta(FREE_TIER.key)?.verified, false, "a free auto-listing must never claim the badge");
  // An unknown tier must not fall through to "verified".
  assert.strictEqual(tierMeta("NOPE")?.verified ?? false, false);
});

test("verifiedTier is not a second hardcoded list", () => {
  // The whole point: one source. A literal here is how the two drift again.
  const src = read("src/lib/listings.ts");
  const fn = /export const verifiedTier[\s\S]*?;/.exec(src);
  assert.ok(fn, "verifiedTier moved — this guard must follow it");
  assert.ok(!/"DIAMOND"|"GOLD"|"PLATINUM"|"XPRESS"/.test(fn[0]), "verifiedTier hardcodes tier keys again");
  assert.match(fn[0], /tierMeta\(/, "it must read the tier's own flag");
});
