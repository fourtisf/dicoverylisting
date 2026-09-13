// trendingBoard config + trendingPoster board rendering (tier-priority + format).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tb-"));

const test = require("node:test");
const assert = require("node:assert");

// Mock live market data BEFORE trendingPoster destructures fetchMarket.
const md = require("../src/marketdata");
const MOCK = {
  wif: { mcap: 1_793_783, change24h: 47.2 },
  bonk: { mcap: 1_291_521_621_468, change24h: 12.4 },
  alive: { mcap: 28_607, change24h: 39.9 },
  floki: { mcap: 3_925_360, change24h: 133 },
};
md.fetchMarket = async (_chain, addr) =>
  MOCK[addr] ? { priceUsd: 1, ...MOCK[addr] } : { priceUsd: 1, mcap: 1_000_000, change24h: 1.5 };
const api = require("../src/api/dexvra");

const tb = require("../src/services/trendingBoard");
const pe = require("../src/config/premiumEmoji");
const poster = require("../src/services/trendingPoster");

test("board: premium defaults out of the box (numbers + chain logos)", async () => {
  assert.strictEqual(tb.RANK_SLOTS, 10, "10 editable rank slots");
  // Ranks 1–9 ship a verified premium id; rank 10 has none → plain unicode.
  for (let pos = 1; pos <= 9; pos++) {
    assert.ok(pe.isPremium(tb.rankBadge(pos)), `rank ${pos} is premium by default`);
    assert.strictEqual(tb.displayEmoji(tb.rankBadge(pos)), `${pos}️⃣`, `rank ${pos} falls back to its number`);
  }
  assert.strictEqual(tb.rankBadge(10), "🔟", "rank 10 has no verified id → plain");
  assert.strictEqual(tb.rankBadge(11), "11.", "ranks past 10 fall back to N.");
  // Chains with a verified id are premium; the rest keep their unicode default.
  for (const id of ["solana", "bsc", "ethereum", "base", "tron", "plasma", "sui"]) {
    assert.ok(pe.isPremium(tb.chainLogo(id)), `${id} logo is premium by default`);
  }
  assert.strictEqual(tb.chainLogo("robinhood"), "🟢", "no verified id → plain unicode default");
  const cov = tb.premiumCoverage();
  assert.strictEqual(cov.ranksPremium, 9);
  assert.strictEqual(cov.chainsPremium, 7);
});

test("board: override, reset, rank fallback", async () => {
  await tb.setRankEmoji(1, "🔥");
  assert.strictEqual(tb.rankBadge(1), "🔥", "an emoji with no known id stays plain");
  assert.strictEqual(tb.isRankCustom(1), true);
  assert.strictEqual(tb.isRankPremium(1), false);
  await tb.setChainLogo("bsc", "🐤");
  assert.strictEqual(tb.chainLogo("bsc"), "🐤");
  await tb.reset();
  assert.ok(pe.isPremium(tb.rankBadge(1)), "reset restores the premium default");
  assert.ok(pe.isPremium(tb.chainLogo("bsc")));
});

test("board: a plain emoji is promoted to its premium twin", async () => {
  // The operator typed a plain 1️⃣ before premium defaults existed — same
  // artwork, so render it premium instead of leaving it flat.
  await tb.setRankEmoji(4, "2️⃣");
  assert.strictEqual(tb.rankBadge(4), pe.markup("2️⃣", pe.RANK_IDS[2]), "plain number → premium number");
  // Chain brand aliases resolve per chain (a 🟣 for Solana, not for a rank).
  await tb.setChainLogo("solana", "◎");
  assert.strictEqual(tb.chainLogo("solana"), pe.markup("◎", pe.CHAIN_EMOJI.solana.id), "alias → the Solana logo");
  await tb.setRankEmoji(5, "🟣");
  assert.strictEqual(tb.rankBadge(5), "🟣", "a chain alias must NOT leak into a rank badge");
  await tb.reset();
});

test("board: legacy saves of old built-in defaults don't shadow the premium ones", async () => {
  // The old setRankEmoji() wrote the whole RESOLVED array, so setting rank 1
  // also froze the defaults of the day into ranks 2–10. Those must be treated
  // as "still default" — otherwise the board can never go premium again.
  const { saveJSON } = require("../src/helpers/persist");
  await saveJSON("trendingBoard.json", {
    rankEmojis: ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"],
    chainLogos: { solana: "🟣", bsc: "🟡", base: "🔵" },
  });
  for (let pos = 1; pos <= 9; pos++) {
    assert.ok(pe.isPremium(tb.rankBadge(pos)), `legacy rank ${pos} default → premium`);
    assert.strictEqual(tb.isRankCustom(pos), false, `legacy rank ${pos} isn't an override`);
  }
  for (const id of ["solana", "bsc", "base"]) {
    assert.ok(pe.isPremium(tb.chainLogo(id)), `legacy ${id} default → premium`);
    assert.strictEqual(tb.isChainCustom(id), false);
  }
  await tb.reset();
});

test("board: setRankEmoji stores only real overrides", async () => {
  await tb.setRankEmoji(2, "⭐");
  const saved = require("../src/helpers/persist").loadJSONSync("trendingBoard.json", {});
  assert.strictEqual(saved.rankEmojis[1], "⭐");
  assert.deepStrictEqual(
    saved.rankEmojis.filter(Boolean),
    ["⭐"],
    "untouched slots stay null so future defaults still reach them",
  );
  await tb.reset();
});

test("board: rank must be 1–10", async () => {
  await assert.rejects(() => tb.setRankEmoji(11, "x"));
  await assert.rejects(() => tb.setRankEmoji(0, "x"));
  await tb.setRankEmoji(10, "🚀"); // rank 10 is now valid
  assert.strictEqual(tb.rankBadge(10), "🚀");
  await tb.reset();
});

test("board: custom markers track admin overrides (✅ vs default)", async () => {
  assert.strictEqual(tb.isRankCustom(3), false, "rank 3 starts on default");
  assert.strictEqual(tb.isChainCustom("bsc"), false, "bsc starts on default");
  await tb.setRankEmoji(3, "⭐");
  await tb.setChainLogo("bsc", "🐤");
  assert.strictEqual(tb.isRankCustom(3), true, "rank 3 now marked custom");
  assert.strictEqual(tb.isChainCustom("bsc"), true, "bsc now marked custom");
  const bsc = tb.chainList().find((c) => c.id === "bsc");
  assert.ok(bsc.custom, "chainList exposes the custom flag");
  assert.strictEqual(bsc.premium, false, "…and whether it renders premium");
  await tb.reset();
  assert.strictEqual(tb.isRankCustom(3), false, "reset clears the marker");
  assert.strictEqual(tb.isChainCustom("bsc"), false);
  assert.ok(tb.chainList().find((c) => c.id === "bsc").premium, "back to the premium default");
});

test("poster: tier priority beats performance, fourtis format", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "bonk", sym: "BONK", tier: "BRONZE" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "wif", sym: "WIF", tier: "DIAMOND" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "alive", sym: "ALIVE", tier: "XPRESS" },
  ];
  const text = await poster.buildText(); // premium markup
  assert.ok(
    text.includes(`${tb.chainLogo("solana")} **SOLANA - Trending**`),
    "chain header with the (premium) logo + bold markup",
  );
  // Diamond (WIF) must rank above Bronze (BONK) and Xpress (ALIVE) despite lower mcap.
  const iWif = text.indexOf("$WIF");
  const iBonk = text.indexOf("$BONK");
  const iAlive = text.indexOf("$ALIVE");
  assert.ok(iWif < iBonk && iBonk < iAlive, `tier order wrong: WIF@${iWif} BONK@${iBonk} ALIVE@${iAlive}`);
  assert.ok(text.includes(`${tb.rankBadge(1)} +47.20% |`), "rank badge + signed % present");
  assert.ok(text.includes("1,793,783$"), "comma market cap present");
  // The markup parses into entities cleanly (what actually gets sent).
  const parsed = require("../src/premium").parse(text);
  assert.ok(parsed.entities.some((e) => e.type === "bold"), "bold entities");
  assert.ok(parsed.entities.some((e) => e.type === "text_link"), "link entities");
  assert.ok(
    parsed.entities.some((e) => e.type === "custom_emoji"),
    "the default board already carries premium emoji — no admin setup needed",
  );
  assert.ok(!/\*\*|\]\(/.test(parsed.text), "no raw markup leaks into the sent text");
});

test("poster: ticker links to Telegram, market cap links to the Dexvra CA page", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "robinhood", address: "0xRH", sym: "RHT", tier: "GOLD", telegram: "@rht_official" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "base", address: "0xNoTg", sym: "NOTG", tier: "SILVER" },
  ];
  const text = await poster.buildText();
  // Robinhood chain renders (it's in CHAIN_ORDER).
  assert.ok(text.includes("ROBINHOOD - Trending"), "robinhood chain present");
  // $ticker → the token's Telegram.
  assert.ok(text.includes("[$RHT](https://t.me/rht_official)"), "ticker links to Telegram");
  // market cap → the Dexvra token page (its CA).
  assert.ok(text.includes("](https://dexvra.io/token/robinhood/0xRH)"), "mcap links to Dexvra CA page");
  // No Telegram → ticker falls back to the Dexvra page (never a dead link).
  assert.ok(text.includes("[$NOTG](https://dexvra.io/token/base/0xNoTg)"), "ticker falls back to Dexvra");
});

test("board: premium-emoji badge stored as markup, displayed as fallback", async () => {
  await tb.setRankEmoji(1, "[🥇](emoji/5440539497383087970)"); // admin sent a premium 🥇
  assert.strictEqual(tb.rankBadge(1), "[🥇](emoji/5440539497383087970)", "board gets the premium markup");
  assert.strictEqual(tb.displayEmoji(tb.rankBadge(1)), "🥇", "editor shows the plain fallback");
  assert.strictEqual(tb.isRankCustom(1), true, "marked custom");
  // The board markup with a premium badge parses to a custom_emoji entity.
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "wif", sym: "WIF", tier: "DIAMOND" },
  ];
  const parsed = require("../src/premium").parse(await poster.buildText());
  assert.ok(parsed.entities.some((e) => e.type === "custom_emoji" && e.custom_emoji_id === "5440539497383087970"), "premium badge → custom_emoji entity");
  assert.ok(!parsed.text.includes("emoji/"), "no raw emoji markup in the sent text");
  await tb.reset();
});

test("poster: no featured tokens → null (nothing to post)", async () => {
  api.getListings = async () => [{ status: "approved", trendingRank: null, chain: "solana", address: "x", sym: "X" }];
  assert.strictEqual(await poster.buildText(), null);
});

// ── Board title emoji ───────────────────────────────────────────────────────
// The 🔥 opening the title line used to be hard-coded, so making it a premium
// (animated) fire meant a redeploy. It is a settable slot now — and the default
// stays PLAIN unicode on purpose: there is no verified premium id for a fire,
// and a guessed id makes Telegram reject the entire message (EMOJI_INVALID),
// which would take the whole board down rather than one emoji.
test("board title: plain 🔥 by default, and it opens the title line", async () => {
  await tb.reset();
  assert.strictEqual(tb.titleEmoji(), "🔥");
  assert.strictEqual(tb.isTitleCustom(), false);
  assert.strictEqual(tb.isTitlePremium(), false);
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "wif", sym: "WIF", tier: "DIAMOND" },
  ];
  const text = await poster.buildText();
  assert.ok(text.startsWith("🔥 **Dexvra Trending**"), text.slice(0, 60));
});

test("board title: an admin's premium fire renders on the board", async () => {
  await tb.setTitleEmoji("[🔥](emoji/5445284980978621387)");
  assert.strictEqual(tb.isTitlePremium(), true, "stored as premium markup");
  assert.strictEqual(tb.isTitleCustom(), true);
  assert.strictEqual(tb.displayEmoji(tb.titleEmoji()), "🔥", "the editor shows the plain fallback");
  assert.ok(tb.premiumCoverage().titlePremium, "counted in the editor's coverage line");
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "wif", sym: "WIF", tier: "DIAMOND" },
  ];
  const parsed = require("../src/premium").parse(await poster.buildText());
  assert.ok(
    parsed.entities.some((e) => e.type === "custom_emoji" && e.custom_emoji_id === "5445284980978621387"),
    "title fire → custom_emoji entity",
  );
  assert.ok(parsed.text.startsWith("🔥 Dexvra Trending"), parsed.text.slice(0, 40));
  await tb.reset();
  assert.strictEqual(tb.titleEmoji(), "🔥", "reset restores the built-in fire");
});

test("board: the footer link is gone — the board ends on the last token", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "wif", sym: "WIF", tier: "DIAMOND" },
  ];
  const text = await poster.buildText();
  assert.ok(!/View all on Dexvra/.test(text), text);
  assert.ok(!/dexvra\.io\/trending/.test(text), "…and its link with it");
});
