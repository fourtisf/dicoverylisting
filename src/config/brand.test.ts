// The footer shipped <a>X</a> and <a>Telegram</a> with no href — they looked
// like links, hovered like links, and went nowhere. Anyone who wanted to follow
// the project from the site simply could not.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BOT_URL, TELEGRAM_URL, TELEGRAM_LISTING_URL, TELEGRAM_TRENDING_URL, X_LISTING_URL, X_URL } from "./socials.ts";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

test("every social constant is an absolute https URL", () => {
  for (const [name, url] of Object.entries({ BOT_URL, TELEGRAM_URL, TELEGRAM_LISTING_URL, TELEGRAM_TRENDING_URL, X_LISTING_URL, X_URL })) {
    assert.match(url, /^https:\/\//, `${name} must be absolute — a relative one resolves against dexvra.io`);
    assert.doesNotMatch(url, /\s|@$/, `${name} looks malformed: ${url}`);
  }
});

test("the handles match the accounts the bot actually posts from", () => {
  // The bot's CHANNELS config and the channel artwork both name these. Three
  // places quoting one account is how a rename leaves a dead link behind.
  assert.strictEqual(TELEGRAM_URL, "https://t.me/dexvraio");
  assert.strictEqual(TELEGRAM_LISTING_URL, "https://t.me/dexvralisting");
  assert.strictEqual(TELEGRAM_TRENDING_URL, "https://t.me/dexvratrending");
  assert.strictEqual(BOT_URL, "https://t.me/dexvrabot");
  // @dexvra was never the account — the real one is @dexvraio, matching the
  // Telegram handle. A wrong X link sends every visitor to someone else's
  // profile, and on a listing site that someone is usually an impersonator.
  assert.strictEqual(X_URL, "https://x.com/dexvraio");
});

test("listing alerts on X point at the account that actually posts them", () => {
  // twitter.js sends every listing / trending / pump tweet through the `listing`
  // credential set, NOT the official one. Until this account was named, the
  // site and every channel post linked @dexvraio for "we also post on X" —
  // which does not carry the listing feed at all.
  // Renamed 2026-09-06: the X feed moved to @listingdexvra. The TELEGRAM
  // listing channel did NOT move and is still @dexvralisting — the two names
  // are one transposition apart, so they are asserted against each other.
  assert.strictEqual(X_LISTING_URL, "https://x.com/listingdexvra");
  assert.notStrictEqual(X_LISTING_URL, TELEGRAM_LISTING_URL.replace("t.me", "x.com"),
    "the X feed and the Telegram channel are different accounts");
  assert.notStrictEqual(X_LISTING_URL, X_URL, "the two accounts must stay distinct");
  const consts = fs.readFileSync(path.join(process.cwd(), "bot/src/config/constants.js"), "utf8");
  const m = consts.match(/const X_LISTING_HANDLE = \(env\.X_LISTING_HANDLE \|\| "([^"]+)"\)/);
  assert.ok(m, "X_LISTING_HANDLE default not found in the bot config");
  assert.strictEqual(`https://x.com/${m[1]}`, X_LISTING_URL, `bot links @${m[1]}, site links ${X_LISTING_URL}`);
});

test("every channel-link filler offers the same placeholders", () => {
  // Two places build the {site}/{listing}/{trending}/{announce}/{xlisting} set —
  // start.js for the bot's own cards, channels/format.js for every channel post.
  // A key added to one and not the other renders as a literal "{xlisting}" in
  // half the output, which is exactly how the X link would have gone missing.
  const start = fs.readFileSync(path.join(process.cwd(), "bot/src/handlers/start.js"), "utf8");
  const format = fs.readFileSync(path.join(process.cwd(), "bot/src/channels/format.js"), "utf8");
  for (const key of ["site", "listing", "trending", "announce", "xlisting"]) {
    assert.match(start, new RegExp(`\\b${key}:`), `start.js never fills {${key}}`);
    assert.match(format, new RegExp(`\\b${key}:`), `channels/format.js never fills {${key}}`);
  }
  // The welcome card links the account by name. Match the LINK, not the label —
  // the wording is the operator's to change from the editor.
  const tpl = fs.readFileSync(path.join(process.cwd(), "bot/src/templates.js"), "utf8");
  assert.match(tpl, /\[[^\]]*\]\(\{xlisting\}\)/, "no template links the X account at all");
  // The CHANNEL-POST footer row carries the full Dexvra destination set: the
  // three Telegram channels, the site, AND the X account the listing feed is
  // tweeted from. This assertion used to demand the opposite — that the row stay
  // Telegram-only, because the token's own social row already prints an X link.
  // templates.js reversed that and says why: the two are never the same account
  // (one is the PROJECT's X, this one is DEXVRA's), and the row is rendered
  // header-less on rank-up / pump posts, which carry no social row at all — so
  // there it was the only X link a reader could have followed. The test was left
  // behind by that change and had been failing ever since.
  const row = tpl.match(/const LINKS_ROW =[\s\S]*?;\n/);
  assert.ok(row, "LINKS_ROW not found — did templates.js move?");
  assert.ok(row[0].includes("{xlisting}"), "the Dexvra links row must reach the X account too");
  for (const key of ["site", "listing", "trending", "announce"]) {
    assert.ok(row[0].includes(`{${key}}`), `the Dexvra links row dropped {${key}}`);
  }
});

test("the bot tweets from the same account the site links to", () => {
  // The bot @-mentions X_HANDLE in its ad posts. If that default and the site's
  // X_URL name different accounts, half the audience is sent to the wrong one
  // and neither is obviously wrong on its own.
  const consts = fs.readFileSync(path.join(process.cwd(), "bot/src/config/constants.js"), "utf8");
  const m = consts.match(/const X_HANDLE = \(env\.X_HANDLE \|\| "([^"]+)"\)/);
  assert.ok(m, "X_HANDLE default not found — did constants.js move?");
  assert.strictEqual(`https://x.com/${m[1]}`, X_URL, `bot tweets as @${m[1]}, site links ${X_URL}`);
});

test("the footer's social links have a real href and open safely", () => {
  const src = read("src/app/(site)/layout.tsx");
  for (const v of ["TELEGRAM_URL", "X_URL", "X_LISTING_URL", "BOT_URL", "TELEGRAM_TRENDING_URL"]) {
    assert.ok(src.includes(`href={${v}}`), `the footer must link ${v}`);
  }
  // target=_blank without noopener hands the opened tab a window.opener handle.
  const anchors = src.match(/<a [^>]*target="_blank"[^>]*>/g) || [];
  assert.ok(anchors.length >= 4);
  for (const a of anchors) assert.match(a, /rel="noopener noreferrer"/, a);
});

test("nothing that is not a link still looks like one", () => {
  // Docs and API have no page yet. They stay as plain text rather than as
  // anchors that do nothing when clicked.
  const src = read("src/app/(site)/layout.tsx");
  assert.ok(!/<a>\s*(Docs|API|X|Telegram)\s*<\/a>/.test(src), "an <a> with no href is a lie");
  assert.match(src, /foot-soon">Docs</);
  assert.match(src, /foot-soon">API</);
  assert.match(read("src/app/globals.css"), /\.foot \.foot-soon\{/, "…and it is styled as inert");
});

test("the sidebar carries the community links too", () => {
  // The footer sits below the fold on every long board; the sidebar is where
  // someone looks for "where do I follow this".
  const src = read("src/components/Sidebar.tsx");
  assert.ok(src.includes("href={TELEGRAM_URL}"));
  assert.ok(src.includes("href={X_URL}"));
  assert.match(src, /className="side-soc"/);
  assert.match(read("src/app/globals.css"), /\.side-soc\{/, "the row must be styled, not inherit nav spacing");
});

test("Get Verified sends the applicant somewhere real", () => {
  // It was a button that popped "Verification request sent ✓ — reviewed within
  // 24h" and sent nothing anywhere. The applicant walked away believing they
  // had applied, and nobody was ever told.
  const src = read("src/app/(site)/verified/page.tsx");
  // The comment above the fix quotes the old string on purpose, so match the
  // CALL, not the words.
  assert.ok(!/toast\(["'][^"']*Verification request sent/.test(src), "the page must not claim something it did not do");
  assert.ok(!src.includes("useApp"), "…and no longer needs the toast at all");
  assert.match(src, /href=\{BOT_URL\}/, "the CTA goes to the bot, exactly like /advertise");
  assert.match(src, /href=\{TELEGRAM_URL\}/, "and Dexvra is reachable before paying 1.5 SOL");
  assert.match(src, /href=\{X_URL\}/);
});

test("no page fakes an action with a toast", () => {
  // One page doing it is a bug; the pattern spreading is a habit. This fails
  // the moment another "sent ✓" button appears anywhere under (site).
  const dir = path.join(process.cwd(), "src/app/(site)");
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
    });
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(
      !/onClick=\{\(\) => toast\(["'][^"']*(sent|submitted|request)/i.test(src),
      `${path.relative(process.cwd(), file)} pretends an action succeeded without doing it`,
    );
  }
});

test("/community lists every channel, from the one shared list", () => {
  // The same accounts are named by the bot's CHANNELS config, printed on the
  // channel artwork, and linked from the footer and sidebar. The page must read
  // the list, not restate it — a hand-written copy is what goes stale.
  const src = read("src/app/(site)/community/page.tsx");
  assert.match(src, /from "@\/config\/socials"/);
  assert.match(src, /SOCIALS\.map/);
  assert.ok(!/t\.me\/|x\.com\//.test(src), "no URL is hardcoded on the page itself");
});

test("every channel entry is complete and reachable", async () => {
  const { SOCIALS } = await import("./socials.ts");
  const keys = new Set<string>();
  for (const s of SOCIALS) {
    assert.ok(!keys.has(s.key), `duplicate key ${s.key}`);
    keys.add(s.key);
    assert.match(s.url, /^https:\/\/(t\.me|x\.com)\//, `${s.key}: ${s.url}`);
    assert.match(s.handle, /^@\w+$/, `${s.key} handle looks wrong: ${s.handle}`);
    assert.ok(s.blurb.length > 20, `${s.key} needs a reason to tap, not just a name`);
    assert.ok(["telegram", "group", "x", "bot"].includes(s.kind), `${s.key}: unknown kind ${s.kind}`);
    // The handle and the URL must name the SAME account, or the card lies.
    assert.ok(s.url.toLowerCase().endsWith(s.handle.slice(1).toLowerCase()), `${s.key}: ${s.handle} vs ${s.url}`);
  }
  assert.ok(SOCIALS.some((s) => s.primary), "at least one must be marked as where to start");
  // START HERE on more than a third of the cards stops meaning anything.
  assert.ok(SOCIALS.filter((s) => s.primary).length <= 2, "too many are marked primary to be a signal");
  // A group is a two-way chat and a bot is a tool; both are mislabelled the
  // moment they are filed as broadcast channels.
  assert.strictEqual(SOCIALS.find((s) => s.key === "group")?.kind, "group");
  assert.strictEqual(SOCIALS.find((s) => s.key === "tradebot")?.kind, "bot");
});

test("the page is reachable — a page nobody can find is not a page", () => {
  assert.match(read("src/components/Sidebar.tsx"), /href: "\/community"/, "it is in the sidebar nav");
  // The FOOTER link was removed at the operator's request (2026-08-22, "all
  // channel … hapus aja ini") — the footer's socials are the real
  // destinations and /community stays reachable through the ⋮ menu. This
  // asserts the removal so it cannot quietly creep back as a "fix".
  assert.ok(!/href="\/community"/.test(read("src/app/(site)/layout.tsx")), "the footer link stays removed");
});

test("the page warns about impersonation, because a listing site attracts it", () => {
  // A lookalike channel DMing a project mid-listing to ask for a "fee" is the
  // standard scam here. Naming the real handles in one place is the defence.
  const src = read("src/app/(site)/community/page.tsx");
  assert.match(src, /never sends the first direct message/);
  assert.match(src, /seed\s*\n?\s*phrase/);
  assert.match(src, /@dexvrabot/);
  // The scope bug the copy panel caught: folding "outside @dexvrabot" into the
  // list of things Dexvra never asks for reads as "inside the bot, we do".
  assert.ok(!/never (take payment|ask)[^.]*outside <b>@dexvrabot/.test(src), "the two claims must stay separate sentences");
});

test("every blurb survives the constraints the copy was written to", async () => {
  const { SOCIALS } = await import("./socials.ts");
  // Hype and in-group jargon: a project founder reading English as a second
  // language stops dead on these, and they make the product sound like every
  // other listing site.
  const banned = [
    "moon", "gem", "alpha", "degen", "ape", "100x", "don't miss", "join now",
    "stay tuned", "gateway", "one-stop", "revolution", "pump alert", "shill",
    "calls", "the whole shop", "tell apart", "as it stands", "mirrored",
  ];
  for (const s of SOCIALS) {
    const low = s.blurb.toLowerCase();
    for (const w of banned) assert.ok(!low.includes(w), `${s.key}: "${w}" — ${s.blurb}`);
    assert.ok(!s.blurb.includes("!"), `${s.key} uses an exclamation mark`);
    const words = s.blurb.split(/\s+/).length;
    assert.ok(words >= 8 && words <= 18, `${s.key}: ${words} words — ${s.blurb}`);
    // A blurb that repeats the card's own name says nothing the reader cannot
    // already see one line above it.
    assert.notStrictEqual(low.trim(), s.name.toLowerCase().trim());
  }
});

test("the two bots can never be mistaken for each other", async () => {
  // One sells placement, the other trades tokens. A reader who confuses them
  // either pays for an ad expecting a trade, or waits for a listing that is
  // actually a swap. Each line leads with its own verb.
  const { SOCIALS } = await import("./socials.ts");
  const shop = SOCIALS.find((s) => s.key === "bot")!;
  const trade = SOCIALS.find((s) => s.key === "tradebot")!;
  assert.match(shop.blurb, /^Book /, `the shop bot must lead with what it sells: ${shop.blurb}`);
  assert.match(trade.blurb, /^Buy and sell /, `the trading bot must lead with trading: ${trade.blurb}`);
  assert.ok(!shop.blurb.toLowerCase().includes("trade"), "the shop bot must not mention trading");
  assert.ok(!trade.blurb.toLowerCase().includes("banner"), "the trading bot must not mention placement");
});

test("the group reads as two-way without needing the word 'channel'", async () => {
  const { SOCIALS } = await import("./socials.ts");
  const g = SOCIALS.find((s) => s.key === "group")!;
  // Behaviour, not a label: "anyone can post" is understood by a reader who has
  // never thought about the difference between a group and a channel.
  assert.match(g.blurb, /Anyone can post/i, g.blurb);
});

// ── The support inbox ───────────────────────────────────────────────────────
//
// "tambahin email supported di website" (2026-09-02). One address, defined
// once beside the accounts, printed by the footer, /community and the
// Organization record. The tests below read the surfaces rather than the
// constant alone: a constant nobody renders is an address nobody can find.

test("the support address is one well-formed mailbox on the brand domain", async () => {
  const { SUPPORT_EMAIL, SUPPORT_MAILTO } = await import("./socials.ts");
  assert.strictEqual(SUPPORT_EMAIL, "supported@dexvra.io");
  assert.match(SUPPORT_EMAIL, /^[a-z0-9._-]+@dexvra\.io$/, "an address off the brand domain reads as an impersonator's");
  assert.strictEqual(SUPPORT_MAILTO, `mailto:${SUPPORT_EMAIL}`);
  // The address lives in socials.ts and nowhere else. A second literal is the
  // copy that goes stale when the mailbox moves.
  for (const f of ["src/app/(site)/layout.tsx", "src/app/(site)/community/page.tsx", "src/lib/seo.ts", "src/config/brand.ts"]) {
    assert.ok(!read(f).includes("supported@"), `${f} hardcodes the address instead of reading SUPPORT_EMAIL`);
  }
});

test("the footer links the support address, and the address itself is the label", () => {
  const src = read("src/app/(site)/layout.tsx");
  // A mailto whose label is the word "Support" is useless on a phone with no
  // mail client and on a locked-down desk; the address as the label can at
  // least be read and copied.
  assert.match(src, /<a href=\{SUPPORT_MAILTO\}>\{SUPPORT_EMAIL\}<\/a>/, "footer must render <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a>");
  // A mailto opens no tab; target=_blank on one pops a blank window in some
  // browsers before the mail client takes over.
  assert.ok(!/SUPPORT_MAILTO\}[^>]*target=/.test(src), "no target=_blank on a mailto");
});

test("/community shows the support address as a card IN the grid", () => {
  const src = read("src/app/(site)/community/page.tsx");
  // The first cut rendered it as a note under the grid, and on a laptop the
  // grid fills the screen — so the report was that the email was not on the
  // page at all. It is a card beside the accounts now, and stays one.
  const grid = src.slice(src.indexOf('className="soc-grid"'), src.indexOf("soc-note"));
  assert.match(grid, /className="soc-card email" href=\{SUPPORT_MAILTO\}/, "the support card must be inside .soc-grid");
  assert.match(grid, /\{SUPPORT_EMAIL\}/, "the address itself must be printed on the card");
  // A mailto opens no tab.
  assert.ok(!/SUPPORT_MAILTO\}[^>]*target=/.test(src), "no target=_blank on a mailto");
  // …but it is NOT an entry in SOCIALS: that list feeds `sameAs`, where a
  // mailto is wrong, and every entry there must be a followable account.
  const socials = read("src/config/socials.ts");
  const list = socials.slice(socials.indexOf("export const SOCIALS"), socials.indexOf("];", socials.indexOf("export const SOCIALS")));
  assert.ok(!/mailto|SUPPORT_/.test(list), "the support address must not be a SOCIALS entry");
  assert.match(read("src/app/globals.css"), /\.soc-card\.email/, "the card needs its own icon colour");
  // The impersonation note has to cover it — an official mailbox left out of
  // "the only official ones" is one a lookalike can claim.
  assert.match(src, /support address beside them/);
});

test("the Organization record carries the support address", async () => {
  const { organizationLd } = await import("../lib/seo.ts");
  const { SUPPORT_EMAIL } = await import("./socials.ts");
  const org = organizationLd() as Record<string, unknown>;
  assert.strictEqual(org.email, SUPPORT_EMAIL);
  const cp = org.contactPoint as Record<string, unknown>;
  assert.strictEqual(cp["@type"], "ContactPoint");
  assert.strictEqual(cp.email, SUPPORT_EMAIL);
  assert.strictEqual(cp.contactType, "customer support");
});
