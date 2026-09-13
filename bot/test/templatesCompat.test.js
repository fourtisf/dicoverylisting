// Back-compat: templates saved by admins BEFORE the self-spacing {socials}/
// {overview} vars must keep rendering clean (no doubled blank lines, no raw
// leftovers). Isolated data dir — set BEFORE requiring any src module.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tplc-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

test("old string template with explicit blank line after {socials} stays clean", async () => {
  // pre-diff layout: template writes its own \n\n after the placeholder
  await tpl.setTemplate("post_listing", "X\n\n{socials}\n\nCTA [go]({coinUrl})");
  const r = tpl.render("post_listing", {
    socials: "🌐 [Website](https://a.io)\n\n", // new self-spacing var
    coinUrl: "https://dexvra.io/t",
  });
  assert.ok(!/\n{3,}/.test(r.text), `doubled blank lines: ${JSON.stringify(r.text)}`);
  await tpl.resetTemplate("post_listing");
});

test("old ENTITY-saved template: trailing newlines of self-spacing vars are trimmed", async () => {
  // entity-mode save (admin pasted a message): {socials} followed by the
  // template's own blank line — the var's trailing \n\n must be trimmed.
  await tpl.setTemplate("post_trending", {
    text: "HEAD\n\n{socials}\n\nCTA",
    entities: [{ type: "bold", offset: 0, length: 4 }],
  });
  const r = tpl.render("post_trending", {
    socials: "Website · X\n\n",
    overview: "",
  });
  assert.ok(!/\n{3,}/.test(r.text), `doubled blank lines: ${JSON.stringify(r.text)}`);
  assert.ok(r.text.includes("Website · X\n\nCTA"), r.text);
  await tpl.resetTemplate("post_trending");
});

test("resetAllTemplates wipes every custom override in one shot", async () => {
  await tpl.setTemplate("intro_tiered", "custom A");
  await tpl.setTemplate("pay_card", "custom B");
  assert.ok(tpl.isCustom("intro_tiered") && tpl.isCustom("pay_card"));
  const n = await tpl.resetAllTemplates();
  assert.ok(n >= 2, `expected ≥2 cleared, got ${n}`);
  assert.strictEqual(tpl.isCustom("intro_tiered"), false);
  assert.strictEqual(tpl.isCustom("pay_card"), false);
  // second call is a no-op → 0 cleared, never throws
  assert.strictEqual(await tpl.resetAllTemplates(), 0);
});

test("overrideCount sees orphaned keys from older template generations", async () => {
  assert.strictEqual(tpl.overrideCount(), 0);
  // a key saved under the OLD template structure, no longer in DEFAULTS —
  // reset-all must still offer to clear it instead of "nothing to reset"
  await tpl.setTemplate("post_listing", "old orphaned layout");
  assert.ok(!tpl.keys().includes("post_listing"), "sanity: key really is orphaned");
  assert.strictEqual(tpl.overrideCount(), 1);
  assert.strictEqual(await tpl.resetAllTemplates(), 1);
  assert.strictEqual(tpl.overrideCount(), 0);
});

test("plain-pasted custom template: social/footer/announce labels get auto-linked", async () => {
  const fmt = require("../src/channels/format");
  await tpl.setTemplate(
    "post_trending",
    "HEAD {name}\n\n🔗 {symbol} social links\n𝕏 X · 🌐 Website · ✈️ Telegram\n\nAnnounce On X\n\n📎 Dexvra\n💎 Dexvra.io · 🚨 Listings · 🔥 Trending · 📢 Announcements",
  );
  const coin = {
    name: "T", symbol: "T", chain: "solana", address: "So1",
    xUrl: "https://x.com/i/status/9",
    links: { twitter: "https://x.com/t", telegram: "https://t.me/t" }, // no website
  };
  const card = fmt.trendingPost(coin);
  const linkOf = (label) =>
    card.entities.find((e) => e.type === "text_link" && card.text.slice(e.offset, e.offset + e.length) === label);
  assert.strictEqual(linkOf("X") && linkOf("X").url, "https://x.com/t", "X label linked");
  assert.strictEqual(linkOf("Telegram") && linkOf("Telegram").url, "https://t.me/t", "Telegram label linked");
  assert.ok(!card.text.includes("Website"), "missing link → its segment cut: " + card.text);
  assert.strictEqual(linkOf("Announce On X") && linkOf("Announce On X").url, "https://x.com/i/status/9");
  assert.ok(linkOf("Dexvra.io") && linkOf("Listings") && linkOf("Trending") && linkOf("Announcements"), "footer labels linked");
  // pasted token-page line (bare "dexvra.io/…" text, markup lost) → real link
  await tpl.setTemplate("post_trending", "HEAD\n\n✅ {coinUrlLabel}\n\n📎 Dexvra");
  const bareUrl = fmt.trendingPost(coin);
  const pathLink = bareUrl.entities.find(
    (e) => e.type === "text_link" && bareUrl.text.slice(e.offset, e.offset + e.length).startsWith("dexvra.io/token/"),
  );
  assert.ok(pathLink, "token-page label linked: " + JSON.stringify(bareUrl.entities));
  assert.ok(pathLink.url.startsWith("https://dexvra.io/token/solana/So1"), pathLink.url);
  // no tweet → the whole Announce line disappears
  const noX = fmt.trendingPost({ ...coin, xUrl: "" });
  assert.ok(!/announce on x/i.test(noX.text), noX.text);
  // token with NO socials at all → the whole social paragraph goes, header too
  const bare = fmt.trendingPost({ ...coin, xUrl: "", links: {} });
  assert.ok(!/social links/i.test(bare.text), bare.text);
  await tpl.resetTemplate("post_trending");
});

test("CA is tap-to-copy (code entity) no matter how the admin writes the template", async () => {
  const fmt = require("../src/channels/format");
  const coin = { name: "T", symbol: "T", chain: "solana", address: "So1CopyMe111", links: {} };
  const codeOn = (card, addr) =>
    card.entities.some((e) => e.type === "code" && card.text.slice(e.offset, e.offset + e.length) === addr);
  // default template ({address} bare — the VALUE brings its own code markup)
  assert.ok(codeOn(fmt.trendingPost(coin), "So1CopyMe111"), "default: CA copyable");
  // admin re-typed the template as PLAIN text (formatting lost) — still copyable
  await tpl.setTemplate("post_trending", "🔥 New\n\n📄 Contract:\n{address}");
  assert.ok(codeOn(fmt.trendingPost(coin), "So1CopyMe111"), "plain custom: CA copyable");
  // legacy custom that writes its own `{address}` backticks — no stray backticks
  await tpl.setTemplate("post_trending", "🔥 New\n\n📄 Contract:\n`{address}`");
  const legacy = fmt.trendingPost(coin);
  assert.ok(codeOn(legacy, "So1CopyMe111"), "legacy backticked custom: CA copyable");
  assert.ok(!legacy.text.includes("`"), "no stray backtick chars leak");
  await tpl.resetTemplate("post_trending");
});

test("chain_emojis saved with premium emoji → chain line carries the custom emoji", async () => {
  const fmt = require("../src/channels/format");
  const text = "solana = 🟣\nbsc = 🟡";
  await tpl.setTemplate("chain_emojis", {
    text,
    entities: [{ type: "custom_emoji", offset: text.indexOf("🟣"), length: 2, custom_emoji_id: "555" }],
  });
  const card = fmt.trendingPost({ name: "T", symbol: "T", chain: "solana", address: "So1", links: {} });
  const ce = card.entities.find((e) => e.custom_emoji_id === "555");
  assert.ok(ce, "custom chain emoji entity present in the rendered post");
  assert.strictEqual(card.text.slice(ce.offset, ce.offset + ce.length), "🟣", "fallback char under the entity");
  await tpl.resetTemplate("chain_emojis");
});

test("new default layout still spaces correctly with empty optional vars", () => {
  const r = tpl.render("post_listing_xpress", {
    logoEmoji: "",
    name: "T",
    symbol: "$T",
    chain: "Solana",
    address: "So1",
    price: "$1",
    mcap: "$2",
    liq: "$3",
    coinUrl: "https://dexvra.io/t",
    coinUrlLabel: "dexvra.io/t",
    twitter: "https://x.com/t",
    website: "https://t.io",
    telegram: "https://t.me/t",
    site: "https://dexvra.io",
    listing: "https://t.me/l",
    trending: "https://t.me/tr",
    announce: "https://t.me/a",
  });
  assert.ok(!/\n{3,}/.test(r.text), JSON.stringify(r.text));
  assert.ok(r.text.includes("T ($T)") && r.text.includes("Network:"));
});

test("entity-saved WYSIWYG template: socials strip remaps entity offsets", async () => {
  const fmt = require("../src/channels/format");
  const text =
    "HEAD\n\n🔗 {symbol} social links\n❌ [X]({twitter})\n🌐 [Website]({website})\n✈️ [Telegram]({telegram})\n\n📎 END {name}";
  const clipIdx = text.indexOf("📎");
  await tpl.setTemplate("post_trending", {
    text,
    entities: [
      { type: "bold", offset: 0, length: 4 },
      { type: "custom_emoji", offset: clipIdx, length: 2, custom_emoji_id: "123" },
    ],
  });
  // no socials at all → the whole social paragraph (incl. header line) drops
  const card = fmt.trendingPost({ name: "T", symbol: "T", chain: "solana", address: "So1", links: {} });
  assert.ok(!card.text.includes("social links"), card.text);
  assert.ok(card.text.includes("HEAD"));
  assert.ok(card.text.includes("📎 END T"));
  const clip = card.entities.find((e) => e.type === "custom_emoji");
  assert.ok(clip && card.text.slice(clip.offset, clip.offset + clip.length) === "📎", "custom emoji stays glued after strip");
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
  // one social present → only that line survives, header stays
  const partial = fmt.trendingPost({ name: "T", symbol: "T", chain: "solana", address: "So1", links: { website: "https://t.io" } });
  assert.ok(partial.text.includes("social links"));
  assert.ok(partial.text.includes("Website"));
  assert.ok(!/❌ X/.test(partial.text), partial.text);
  await tpl.resetTemplate("post_trending");
});

test("paste-proof relink: NAME → token page and Buy/Sell CTA → trade bot survive a plain-text paste", async () => {
  const fmt = require("../src/channels/format");
  // An admin PASTED the listing template as plain text → every [label](url)
  // markup is gone (the exact state behind the $IF screenshot).
  const pasted =
    "⚡ Xpress Listing — {name} live on Dexvra {logoEmoji}\n\n" +
    "💲 {name} ({symbol})\n\n" +
    "{chainEmoji} Network: {chain}\n📄 Contract address:\n{address}\n\n" +
    "📊 Price: {price}\n🏦 Market cap: {mcap} · 💧 Liquidity: {liq}\n\n" +
    "⚡ Buy / Sell on Dexvra Trade Bot\n\n" +
    "🔗 {symbol} social links\n❌ X · 🌐 Website · ✈️ Telegram\n\n" +
    "📎 Dexvra\n💎 Dexvra.io · 🚨 Listings · 🔥 Trending · 📢 Announcements";
  await tpl.setTemplate("post_listing_xpress", pasted);
  const coin = {
    name: "What If", symbol: "IF", chain: "robinhood", tier: "XPRESS",
    address: "0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1",
    price: 0.00514, mcap: 5.1e6, liq: 232200,
    links: { twitter: "https://x.com/w", website: "https://w.io", telegram: "https://t.me/w" },
  };
  const card = fmt.listingPost(coin);
  const linkFor = (needle) =>
    card.entities.find((e) => e.type === "text_link" && card.text.substr(e.offset, e.length).includes(needle));
  const nameLink = linkFor("What If");
  assert.ok(nameLink, "the name became a link after paste");
  assert.strictEqual(nameLink.url, `https://dexvra.io/token/robinhood/${coin.address}`, "name → token page");
  // ONLY the name is linked, not the "($IF)" ticker.
  assert.strictEqual(card.text.substr(nameLink.offset, nameLink.length), "What If", "link covers just the name");
  const cta = linkFor("Buy / Sell on Dexvra Trade Bot");
  assert.ok(cta, "the Buy/Sell CTA became a link after paste");
  // The deep link carries the chain (ca_<chain>_<address>) so the trade bot
  // opens the exact venue without guessing.
  assert.strictEqual(cta.url, `https://t.me/dexvratradebot?start=ca_robinhood_${coin.address}`, "CTA → trade bot with chain + CA");
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
  await tpl.resetTemplate("post_listing_xpress");
});
