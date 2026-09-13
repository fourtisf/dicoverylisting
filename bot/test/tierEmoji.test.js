// Tier badges (Diamond → Bronze) are admin-settable, and can be PREMIUM.
//
// They used to be a hardcoded map in format.js, which is how PLATINUM ended up
// rendering as nothing at all, and then as a trophy the operator never chose.
// They now come from the `tier_emojis` template — the same shape as the
// per-chain logos, so the same editor and the same premium-emoji handling.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tier-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const fmt = require("../src/channels/format");

const coin = (tier) => ({ name: "Cupsey", symbol: "$CUPSEY", chain: "solana", address: "6Nwar", tier, links: {}, siteUrl: "u" });
const header = (tier) => fmt.listingPost(coin(tier)).text.split("\n")[0];

test("every tier Diamond → Bronze ships a badge", () => {
  for (const [tier, emoji] of [
    ["DIAMOND", "💎"],
    ["GOLD", "🥇"],
    ["PLATINUM", "🏆"],
    ["SILVER", "🥈"],
    ["BRONZE", "🥉"],
  ]) {
    const h = header(tier);
    assert.ok(h.includes(emoji), `${tier} should carry ${emoji}: ${h}`);
    assert.ok(h.includes("tier"), h);
  }
});

test("the operator can change a tier's emoji from the admin bot", async () => {
  await tpl.setTemplate("tier_emojis", "diamond = 🔱\ngold = 🥇\nplatinum = 🏆\nsilver = 🥈\nbronze = 🥉");
  try {
    assert.ok(header("DIAMOND").includes("🔱"), header("DIAMOND"));
    assert.ok(!header("DIAMOND").includes("💎"), "the old badge is gone");
  } finally {
    await tpl.resetTemplate("tier_emojis");
  }
  assert.ok(header("DIAMOND").includes("💎"), "reset restores the built-in badge");
});

test("a PREMIUM tier emoji reaches the post as a custom_emoji entity", async () => {
  // What an admin pasting a premium emoji into the editor actually stores.
  const text = "diamond = 💎\ngold = 🥇\nplatinum = 🔱\nsilver = 🥈\nbronze = 🥉";
  await tpl.setTemplate("tier_emojis", {
    text,
    entities: [
      { type: "custom_emoji", offset: text.indexOf("💎"), length: 2, custom_emoji_id: "111" },
      { type: "custom_emoji", offset: text.indexOf("🔱"), length: 2, custom_emoji_id: "222" },
    ],
  });
  try {
    // Scoped to the TIER's ids. The post's footer legitimately carries premium
    // emoji of its own (💎 Dexvra.io · 🚨 Listings · 📢 Announcements), so
    // "the post has no custom_emoji at all" stopped being the same question as
    // "this tier stayed plain" the moment em() started emitting its ids.
    const tierCe = (p) => p.entities.filter((e) => e.type === "custom_emoji" && ["111", "222"].includes(e.custom_emoji_id));
    const dia = fmt.listingPost(coin("DIAMOND"));
    const d = tierCe(dia);
    assert.strictEqual(d.length, 1, "the premium diamond survived into the post");
    assert.strictEqual(dia.text.substr(d[0].offset, d[0].length), "💎", "…sitting on its own fallback char");
    // A different tier picks up ITS id, not the first one in the file.
    const plat = fmt.listingPost(coin("PLATINUM"));
    assert.ok(tierCe(plat).some((e) => e.custom_emoji_id === "222"), plat.text);
    // A tier the admin left plain stays plain — no id borrowed from a neighbour.
    const gold = fmt.listingPost(coin("GOLD"));
    assert.strictEqual(tierCe(gold).length, 0, gold.text);
    const at = gold.text.indexOf("🥇");
    assert.ok(at > -1, gold.text);
    assert.ok(!gold.entities.some((e) => e.type === "custom_emoji" && e.offset === at),
      "the plain gold char got covered by a custom_emoji entity");
  } finally {
    await tpl.resetTemplate("tier_emojis");
  }
});

test("a tier missing from the template falls back to packages.js, never to blank", async () => {
  await tpl.setTemplate("tier_emojis", "diamond = 💎"); // the operator deleted the rest
  try {
    const h = header("BRONZE");
    assert.ok(/🥉/.test(h), `bronze must still have a badge: ${h}`);
    assert.ok(!/·\s{2,}/.test(h), "and no double space where the badge would be");
  } finally {
    await tpl.resetTemplate("tier_emojis");
  }
});

test("the tier map is edited exactly like the chain map", () => {
  // Same template group and the same parser — so the Swap-emoji picker and the
  // premium paste both work on it without special cases.
  assert.ok(tpl.keys().includes("tier_emojis"));
  assert.strictEqual(tpl.meta("tier_emojis").group, tpl.meta("chain_emojis").group);
  assert.ok(tpl.listEmojis("tier_emojis").length >= 5, "the per-emoji picker sees every badge");
});

// One setting, every surface. The badge used to be hardcoded three times — in
// format.js for the Telegram post, in twitter.js for the tweet, and via
// packages.js for the buy-flow keyboard — so changing it in the admin bot moved
// the channel post and quietly left the other two behind.
test("the tweet and the tier chooser follow the same setting", async () => {
  const twitter = fss.readFileSync(require.resolve("../src/twitter.js"), "utf8");
  assert.ok(!/X_TIER_EMOJI\s*=/.test(twitter), "twitter.js must not keep its own tier map");
  assert.match(twitter, /tierBadgeChar/, "…it reads the shared one");
  const listing = fss.readFileSync(require.resolve("../src/handlers/listing.js"), "utf8");
  assert.match(listing, /tierBadgeChar/, "the tier chooser shows the badge the buyer will get");

  await tpl.setTemplate("tier_emojis", "diamond = 🔱\ngold = 🥇\nplatinum = 🏆\nsilver = 🥈\nbronze = 🥉");
  try {
    assert.strictEqual(fmt.tierBadgeChar("DIAMOND"), "🔱", "the change reaches plain-text surfaces");
  } finally {
    await tpl.resetTemplate("tier_emojis");
  }
});

test("a premium badge is flattened for surfaces that cannot render it", async () => {
  // X is plain text and a regular bot's keyboard has custom emoji stripped, so
  // both need the FALLBACK char — not the markup, and not a blank.
  const text = "diamond = 💎\ngold = 🥇";
  await tpl.setTemplate("tier_emojis", {
    text,
    entities: [{ type: "custom_emoji", offset: text.indexOf("💎"), length: 2, custom_emoji_id: "777" }],
  });
  try {
    assert.match(fmt.tierBadge("DIAMOND"), /\(emoji\/777\)/, "the channel post keeps the premium markup");
    assert.strictEqual(fmt.tierBadgeChar("DIAMOND"), "💎", "…the tweet gets the plain char");
  } finally {
    await tpl.resetTemplate("tier_emojis");
  }
});
