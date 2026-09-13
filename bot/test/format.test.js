const test = require("node:test");
const assert = require("node:assert");
const { fmtPrice, fmtCap, formatNumber, escapeHtml } = require("../src/helpers/format");
const fmt = require("../src/channels/format");

test("price / cap / number formatting", () => {
  assert.strictEqual(fmtPrice(1.83), "$1.83");
  assert.strictEqual(fmtPrice(0.0000246), "$0.0000246"); // trailing zeros stripped
  assert.strictEqual(fmtPrice(0), "$0");
  assert.strictEqual(fmtCap(1.72e9), "$1.72B");
  assert.strictEqual(fmtCap(null), "—");
  assert.strictEqual(formatNumber(1720000000), "1.7B");
  assert.strictEqual(formatNumber("not a number"), "0"); // guarded, never throws
});

test("escapeHtml neutralizes markup", () => {
  assert.strictEqual(escapeHtml('<b>&"x'), "&lt;b&gt;&amp;\"x");
});

test("listing post payload contains the essentials + premium emoji entities", () => {
  const coin = {
    name: "Evil [x](https://scam.io)", // markup-injection attempt in a user value
    symbol: "$EVIL",
    chain: "solana",
    address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tier: "DIAMOND",
    price: 0.0000246,
    mcap: 1.72e9,
    links: { website: "https://x.io", twitter: null, telegram: null },
    siteUrl: "https://dexvra.io/token/solana/Dez",
  };
  const card = fmt.listingPost(coin); // → { text, entities }
  assert.ok(card.text.includes("New Listing on Dexvra"));
  assert.ok(card.text.includes("$EVIL"));
  assert.ok(card.text.includes("Diamond"));
  assert.ok(card.text.includes("Market cap:") && card.text.includes("Price:"), "Market cap + Price line");
  assert.ok(card.text.includes("Network:"), "Network line present");
  // The bare dexvra.io/token/… URL line was removed (read as spam) — the token
  // NAME is now the clickable link to its Dexvra page instead.
  assert.ok(!card.text.includes("dexvra.io/token"), "no raw dexvra URL printed in the body");
  assert.ok(card.entities.some((e) => e.type === "code"), "address as code");
  // the NAME links to the token page (the CTA target url is the coin's site url)
  assert.ok(card.entities.some((e) => e.type === "text_link" && e.url === coin.siteUrl), "name links to the token page");
  // the injected link in the name must NOT become a text_link entity
  assert.ok(!card.entities.some((e) => e.type === "text_link" && /scam\.io/.test(e.url || "")));
  // every entity stays inside the text bounds
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
});

test("listing post: clean layout, no overview paragraph, no stray blanks", () => {
  const base = {
    name: "Bull Cat",
    symbol: "$BULLCAT",
    chain: "solana",
    address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
    tier: "XPRESS",
    price: 0.000725,
    mcap: 725100,
    links: {},
    siteUrl: "https://dexvra.io/token/solana/G9j8",
  };
  // The channel post no longer renders the overview paragraph (operator layout):
  // even when a coin carries one, it must not appear in the post body.
  const withOv = fmt.listingPost({ ...base, overview: "The Bull Cat is a community-driven memecoin on Solana." });
  assert.ok(!withOv.text.includes("community-driven memecoin"), "overview must NOT render in the post");
  const noOv = fmt.listingPost(base);
  assert.ok(!noOv.text.includes("undefined"));
  assert.ok(!noOv.text.includes("null"));
  // empty socials never leave 3+ consecutive newlines
  assert.ok(!/\n{3,}/.test(noOv.text), `stray blank lines: ${JSON.stringify(noOv.text.slice(0, 200))}`);
  // a token with no socials drops the WHOLE social paragraph, header included
  assert.ok(!noOv.text.includes("social links"), noOv.text);
  // …but the footer still follows the market-cap line
  assert.ok(noOv.text.includes("📎 Dexvra"), noOv.text);
});

test("social lines drop individually; tier badge line drops without a tier", () => {
  const base = {
    name: "Bull Cat",
    symbol: "$BULLCAT",
    chain: "solana",
    address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
    price: 0.000725,
    mcap: 725100,
    siteUrl: "https://dexvra.io/token/solana/G9j8",
  };
  // only a website → X + Telegram SEGMENTS cut from the row, header + Website kept
  const partial = fmt.listingPost({ ...base, tier: "XPRESS", links: { website: "https://bullcat.io" } });
  assert.ok(partial.text.includes("social links\n🌐 Website\n"), partial.text);
  // Scoped to the TOKEN's social row. The footer legitimately carries Dexvra's
  // own X account, so a whole-text "no ❌ X" check would now be testing the
  // wrong thing — and the token's link is what has to disappear here.
  const socialRow = (t) => (t.match(/social links\n(.*)/) || ["", ""])[1];
  assert.ok(!/❌/.test(socialRow(partial.text)), partial.text);
  assert.ok(!socialRow(partial.text).includes("Telegram"), partial.text);
  // two present, one missing → the row keeps its separator between survivors
  const two = fmt.listingPost({ ...base, tier: "XPRESS", links: { twitter: "https://x.com/bc", website: "https://bullcat.io" } });
  assert.ok(two.text.includes("❌ X · 🌐 Website\n"), two.text);
  // The Dexvra row now carries Dexvra's OWN X account alongside the three
  // Telegram channels (operator's rule, 2026-07-31: every post links the feed
  // it was announced on). It is a DIFFERENT account from the token's ❌ X above,
  // so both belong — but the token's link must still be the only ❌ in the post.
  const dexvraRow = (two.text.match(/📎 Dexvra\n(.*)/) || ["", ""])[1];
  assert.ok(dexvraRow.includes("X Alerts"), `the Dexvra row must link Dexvra's X: ${dexvraRow}`);
  assert.strictEqual((two.text.match(/❌/g) || []).length, 1, "exactly one ❌ — the token's own X");
  // …and it must be a real link, not a dead label.
  const xAlertsAt = two.text.indexOf("X Alerts");
  const xAlertsLink = two.entities.find((e) => e.type === "text_link" && e.offset === xAlertsAt);
  assert.ok(xAlertsLink, "the 'X Alerts' label is not linked");
  assert.match(xAlertsLink.url, /^https:\/\/x\.com\//, xAlertsLink.url);
  // tiered template without a tier → no orphan " tier" badge line
  const noTier = fmt.listingPost({ ...base, tier: null, links: {} });
  assert.ok(noTier.text.includes("New Listing on Dexvra"));
  assert.ok(!/ tier\b/.test(noTier.text), noTier.text);
  assert.ok(!/\n{3,}/.test(noTier.text));
});

test("overview with ** cannot break markup parsing (bold-injection regression)", () => {
  const base = {
    name: "T",
    symbol: "$T",
    chain: "solana",
    address: "So1anaAddr111111111111111111111111111111111",
    tier: "XPRESS",
    price: 0.01,
    mcap: 1000,
    links: {},
    siteUrl: "https://dexvra.io/token/solana/So1",
  };
  for (const overview of ["100** community owned memecoin", "**bold** attempt", "a ** b ** c"]) {
    const card = fmt.listingPost({ ...base, overview });
    // raw markup must never leak into the final text
    assert.ok(!card.text.includes("(emoji/"), `emoji markup leaked for ${JSON.stringify(overview)}`);
    assert.ok(!/\]\(http/.test(card.text), "link markup leaked");
    // the CA keeps its code entity and the CTA keeps its link entity
    assert.ok(card.entities.some((e) => e.type === "code"), "code entity survived");
    assert.ok(card.entities.some((e) => e.type === "text_link" && e.url === base.siteUrl), "CTA link survived");
  }
});

test("xpress listing post matches the operator's reference layout", () => {
  const coin = {
    name: "The Golden Whale",
    symbol: "WHALE",
    chain: "solana",
    tier: "XPRESS",
    address: "4rABHLfm7BDkkjrkyPYtRadg2BZTEZVoEy3MzrFQpump",
    price: 0.0000842,
    mcap: 84400,
    liq: 22300,
    links: { twitter: "https://x.com/gw", website: "https://gw.io", telegram: "https://t.me/gw" },
  };
  const { text, entities } = fmt.listingPost(coin);
  assert.ok(text.startsWith("⚡ Xpress Listing — The Golden Whale live on Dexvra"), "header line");
  // The token name IS the link now — visible text unchanged, links to the page.
  assert.ok(text.includes("💲 The Golden Whale ($WHALE)"), "💲 token line");
  const nameLink = entities.find((e) => e.type === "text_link" && e.url === `https://dexvra.io/token/solana/${coin.address}`);
  assert.ok(nameLink, "the name links to the Dexvra token page");
  // ONLY the name is linked — the ($WHALE) ticker stays plain text.
  assert.strictEqual(text.substr(nameLink.offset, nameLink.length), "The Golden Whale", "link covers just the name");
  // …and the bare dexvra.io/token/… URL line is gone (it read as spam).
  assert.ok(!text.includes("dexvra.io/token/"), "no raw dexvra token URL printed");
  assert.ok(text.includes("Network: Solana"), "network line");
  assert.ok(text.includes("📄 Contract address:\n4rABHLfm7BDkkjrkyPYtRadg2BZTEZVoEy3MzrFQpump"), "contract block");
  // Market cap and Price share ONE line, side by side — no liquidity row.
  assert.ok(text.includes("🏦 Market cap: $84.4K · 📊 Price: $0.0000842"), "market cap · price on one line");
  assert.ok(!text.includes("Liquidity:"), "no liquidity row");
  assert.ok(text.includes("🔗 $WHALE social links\n❌ X · 🌐 Website · ✈️ Telegram"), "socials side-by-side row");
  assert.ok(text.includes("📎 Dexvra\n💎 Dexvra.io · 🚨 Listings · 🔥 Trending · 📢 Announcements"), "footer block");
});

test("Announce On X line: shown with a tweet link, dropped without one", () => {
  const base = {
    name: "T",
    symbol: "$T",
    chain: "solana",
    tier: "XPRESS",
    address: "So1anaAddr111111111111111111111111111111111",
    price: 0.01,
    mcap: 1000,
    links: {},
    siteUrl: "https://dexvra.io/token/solana/So1",
  };
  const withX = fmt.listingPost({ ...base, xUrl: "https://x.com/i/status/123" });
  assert.ok(withX.text.includes("Announce On X"), withX.text);
  assert.ok(
    withX.entities.some((e) => e.type === "text_link" && e.url === "https://x.com/i/status/123"),
    "tweet link entity present",
  );
  const withoutX = fmt.listingPost(base);
  assert.ok(!withoutX.text.includes("Announce On X"), withoutX.text);
  assert.ok(!/\n{3,}/.test(withoutX.text));
});

test("pump post is a short ticker: multiple, MC move, CA", () => {
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  const card = fmt.pumpPost(coin, 137.6, 310000, 128400000);
  assert.ok(card.text.includes("$T"), card.text);
  assert.ok(card.text.includes("2.4×"), "shows the × multiple"); // 1 + 137.6/100 = 2.376 → 2.4×
  assert.ok(card.text.includes("🚀"), "rocket emoji present (unicode fallback)");
  assert.ok(card.text.includes("$310K") && card.text.includes("$128.4M"), "the market-cap move");
  assert.ok(card.text.includes("0xabc"), "the contract address");
  assert.ok(card.entities.some((e) => e.type === "code"), "CA is copyable");
  // The clip carries the hype — the caption stays a ticker, not an article.
  assert.ok(card.text.length < 400, `caption should stay short, got ${card.text.length}`);
  assert.ok(!/since it listed|still climbing/.test(card.text), "no long-form copy");
});

// A short post is not an excuse to link fewer places: the pump alert once ended
// with Trending + Dexvra.io only, and a reader had no way to reach the listings
// or announcements channel from it.
test("pump post links EVERY Dexvra destination", () => {
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  const urls = fmt.pumpPost(coin, 137.6, 310000, 128400000).entities
    .filter((e) => e.type === "text_link")
    .map((e) => e.url);
  // The four DESTINATIONS by name — channelLinks() also carries the sales bot,
  // which belongs in the auto-spotlight card, not here.
  const links = fmt.channelLinks();
  for (const name of ["site", "listing", "trending", "announce"]) {
    assert.ok(urls.includes(links[name]), `${name} (${links[name]}) missing from the pump post: ${urls}`);
  }
});

test("pump: {percent} stays available for admins who want the number", async () => {
  const tpl = require("../src/templates");
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  await tpl.setTemplate("post_pump", "{symbol} +{percent}%");
  try {
    assert.ok(fmt.pumpPost(coin, 137.6, 310000, 128400000).text.includes("+138%"));
  } finally {
    await tpl.resetTemplate("post_pump");
  }
});

test("overview truncation never splits surrogate pairs (no U+FFFD)", () => {
  const base = {
    name: "T", symbol: "$T", chain: "solana",
    address: "So1anaAddr111111111111111111111111111111111",
    tier: "XPRESS", price: 0.01, mcap: 1000, links: {},
    siteUrl: "https://dexvra.io/token/solana/So1",
  };
  // 299 ascii chars then an astral emoji straddling the 300-code-point cut
  const overview = "a".repeat(299) + "🚀🔥💎 and more text to force truncation beyond the boundary";
  const card = fmt.listingPost({ ...base, overview });
  assert.ok(!card.text.includes("�"), "replacement char leaked (split surrogate)");
  // emoji-heavy overview truncated purely inside emoji runs
  const emojiOnly = "🚀".repeat(400);
  const card2 = fmt.listingPost({ ...base, overview: emojiOnly });
  assert.ok(!card2.text.includes("�"));
});

// The tier used to be stacked on its own line UNDER the header, and the token's
// emoji sat before it — the operator wants one line: header · tier, token emoji
// last. The untiered case is the trap: "drop every line whose placeholders are
// all empty" would have deleted the post's title along with the tier.
test("listing header: tier beside the title, token emoji last", () => {
  const coin = {
    name: "Floki", symbol: "$FLOKI", chain: "bsc", address: "0xfb5",
    tier: "PLATINUM", links: {}, siteUrl: "u",
  };
  const first = fmt.listingPost(coin).text.split("\n")[0];
  assert.ok(/New Listing on Dexvra/.test(first), first);
  assert.ok(/Platinum tier/i.test(first), `tier must be on the SAME line: ${first}`);
  assert.ok(first.indexOf("tier") < first.length - 1, "…and the token emoji closes the line");
  assert.ok(!/\n\s*\S*\s*Platinum tier/.test(fmt.listingPost(coin).text), "never stacked below");
});

test("listing header: an untiered listing keeps its title, loses only the tier", () => {
  const coin = { name: "Auto", symbol: "$AUTO", chain: "bsc", address: "0xa", links: {}, siteUrl: "u" };
  const text = fmt.listingPost(coin).text;
  const first = text.split("\n")[0];
  assert.ok(/New Listing on Dexvra/.test(first), `the header must survive: ${JSON.stringify(first)}`);
  assert.ok(!/tier/i.test(text), `no empty tier badge left behind: ${first}`);
  assert.ok(!/·\s*$/.test(first), "…and no dangling separator");
});

test("a socials row with no links at all still drops entirely", () => {
  // The same strip path — this is the behaviour the header fix must not break.
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xa", tier: "GOLD", links: {}, siteUrl: "u" };
  const text = fmt.listingPost(coin).text;
  assert.ok(!/social links/i.test(text), text);
  assert.ok(!/Website|Telegram/.test(text.split("Dexvra\n").pop() || ""), "no orphan labels");
  assert.ok(!/\n{3,}/.test(text), "no hole where the paragraph was");
});

// ── Banner ad post (NTM-style: description → CA → socials → Dexvra links) ───
test("banner post follows the advertiser's own copy, in order", () => {
  const card = fmt.bannerPost(
    {
      title: "IDLE Protocol",
      slot: "Wide Banner",
      linkUrl: "https://idle.io",
      description: "IDLE Protocol is the first universal earnings layer for idle resources.",
      address: "8sQ2xk9pump",
      twitter: "https://x.com/idle",
      telegram: "https://t.me/idle",
    },
    "https://x.com/i/status/1",
  );
  const t = card.text;
  // The order the operator asked for — description, then CA, then socials, then
  // the Dexvra links.
  const iDesc = t.indexOf("universal earnings layer");
  const iCa = t.indexOf("8sQ2xk9pump");
  const iSoc = t.indexOf("Socials");
  const iDex = t.indexOf("Dexvra.io");
  assert.ok(iDesc > 0 && iDesc < iCa, `description above the CA: ${t}`);
  assert.ok(iCa < iSoc, "CA above the socials");
  assert.ok(iSoc < iDex, "socials above the Dexvra links");
  assert.ok(card.entities.some((e) => e.type === "code"), "the CA is copyable");
  assert.ok(!/\*\*|\]\(/.test(t), "no raw markup leaks (a bold-inside-link did exactly that)");
  const urls = card.entities.filter((e) => e.type === "text_link").map((e) => e.url);
  assert.ok(urls.includes("https://idle.io"), "the title links to the campaign");
  assert.ok(urls.includes("https://x.com/idle") && urls.includes("https://t.me/idle"), "socials linked");
  assert.ok(urls.includes("https://x.com/i/status/1"), "Announce On X present");
});

test("banner post: an advertiser with no token or socials still gets a clean card", () => {
  // A service or an event has neither — the blocks must vanish with their
  // header lines rather than leaving "📄 CA" over an empty line.
  const t = fmt.bannerPost({ title: "Nine Hood", slot: "Standard Banner", linkUrl: "https://ninehood.io" }).text;
  assert.ok(!/CA/.test(t), t);
  assert.ok(!/Announce On X/.test(t), "no tweet → no X line");
  assert.ok(!/\n{3,}/.test(t), "no hole where a block was");
  assert.ok(t.includes("Nine Hood"), t);
});

// An admin can rewrite ANY channel post from @dexvraadminbot by pasting a
// message — including one with PREMIUM custom emoji, which is stored as
// {text, entities} rather than markup. The banner post strips blocks the
// advertiser didn't fill in, and stripping the entity form means re-mapping
// every entity offset: get that wrong and the premium emoji slide onto the
// wrong characters, or the post comes out corrupted.
test("banner post: an admin's premium-emoji template survives the strip pass", async () => {
  const tpl = require("../src/templates");
  // "🔥 BANNER LIVE" where 🔥 is a premium custom emoji, plus the blocks that
  // drop when a booking doesn't carry them.
  const text = "🔥 BANNER LIVE\n\n▶️ {title}\n\n{description}\n\n📄 CA\n{address}\n\n🔗 {twitter}\n\n💎 {site}";
  const entities = [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "5445284980978621387" }];
  await tpl.setTemplate("post_banner", { text, entities });
  try {
    // Full booking: everything renders, the emoji stays on the fire.
    const full = fmt.bannerPost({
      title: "IDLE", slot: "Wide Banner", linkUrl: "https://idle.io",
      description: "An earnings layer for idle resources.", address: "8sQ2xk9pump", twitter: "https://x.com/idle",
    });
    const ce = full.entities.find((e) => e.type === "custom_emoji");
    assert.ok(ce, "the premium emoji survived rendering");
    assert.strictEqual(full.text.substr(ce.offset, ce.length), "🔥", "…and still sits on ITS character");
    assert.ok(full.text.includes("8sQ2xk9pump"), full.text);

    // Minimal booking: the description and CA blocks are cut out of the middle,
    // which is exactly where offset re-mapping goes wrong.
    const min = fmt.bannerPost({ title: "Nine Hood", slot: "Standard Banner", linkUrl: "https://ninehood.io" });
    const ce2 = min.entities.find((e) => e.type === "custom_emoji");
    assert.ok(ce2, "still there after two blocks were removed");
    assert.strictEqual(min.text.substr(ce2.offset, ce2.length), "🔥", `emoji drifted: ${JSON.stringify(min.text)}`);
    assert.ok(!min.text.includes("CA"), "the CA block went with its header");
    assert.ok(!/\{|\}/.test(min.text), `no unfilled placeholders left: ${min.text}`);
    for (const e of min.entities) assert.ok(e.offset + e.length <= min.text.length, "every entity stays in bounds");
  } finally {
    await tpl.resetTemplate("post_banner");
  }
});
