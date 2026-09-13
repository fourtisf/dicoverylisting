// /ca — "what's the contract?", the most-asked question in any token group.
//
// The bot had no answer for it. A member typed /ca or just "ca" and nothing
// happened, so every group answered it by hand a hundred times or pinned a
// message that scrolled out of reach.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ca-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const cfg = require("../src/group/config");
const setup = require("../src/group/setup");

const ADDR = "8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS";

/** A group chat context that records what the bot replied. */
function ctxFor(chatId, text = "/ca", from = { id: 7 }) {
  const sent = [];
  return {
    sent,
    chat: { id: chatId, type: "supergroup" },
    from,
    message: { text, message_id: 1 },
    reply: (t, e) => (sent.push({ text: t, extra: e || {} }), Promise.resolve({ message_id: 2 })),
    telegram: { getChatMember: async () => ({ status: "member" }) },
  };
}
const configure = (chatId, over = {}) =>
  cfg.upsert(chatId, { chain: "solana", address: ADDR, sym: "ALON", name: "alon", pairAddress: "PooL1", on: true, ...over });

test("it answers with the contract address, tap-to-copy", async () => {
  // A `code` span, because a hand-typed contract address is a lost transaction.
  const ctx = ctxFor("-1001");
  await configure("-1001");
  await setup.ca(ctx);
  const { text, extra } = ctx.sent[0];
  assert.ok(text.includes(ADDR));
  const code = (extra.entities || []).find((e) => e.type === "code");
  assert.ok(code, "the address must be a code span");
  assert.strictEqual(text.substr(code.offset, code.length), ADDR, "the span covers the address exactly");
});

test("name, network and address sit on three consecutive lines", async () => {
  // TIGHT. Somebody asking for the CA is going to copy it and leave; every
  // blank line between them and the address is a line they scroll past.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => null;
  setup._linksCache.clear();
  try {
    const ctx = ctxFor("-1002");
    await configure("-1002");
    await setup.ca(ctx);
    // The network row leads with the NETWORK'S mark, not a fixed 🔗 — read from
    // the shared chain_emojis map so it moves with the buy cards.
    const { chainEmoji } = require("../src/channels/format");
    assert.strictEqual(ctx.sent[0].text, `💵 alon $ALON\n${chainEmoji("solana")} Solana\n${ADDR}`);
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("it does NOT repeat our own Chart / Trade / Dexvra links", async () => {
  // Those three are on every buy alert this group already receives. Repeating
  // them under a question the project asked about THEIR contract turns an
  // answer into an advert.
  const ctx = ctxFor("-1009");
  await configure("-1009");
  await setup.ca(ctx);
  const { text, extra } = ctx.sent[0];
  const labels = (extra.entities || []).filter((e) => e.type === "text_link").map((e) => text.substr(e.offset, e.length));
  for (const gone of ["📈 Chart", "⚡ Trade", "💎 Dexvra"]) assert.ok(!labels.includes(gone), `${gone} must be gone`);
});

test("a token with no resolved name prints the ticker once, not twice", async () => {
  const ctx = ctxFor("-1003");
  await configure("-1003", { name: "" });
  await setup.ca(ctx);
  assert.match(ctx.sent[0].text, /^💵 \$ALON$/m);
});

test("no token set → the same card /buybot shows, with the same Add CA button", async () => {
  // One place that explains how to set a token, not two that will eventually
  // disagree about it.
  const ctx = ctxFor("-1004");
  await setup.ca(ctx);
  const { text, extra } = ctx.sent[0];
  assert.match(text, /No token set here yet/);
  const btns = (extra.reply_markup.inline_keyboard || []).flat();
  assert.ok(btns.some((b) => b.callback_data === "bs_token"), "the way out is on the card");
});

test("it is NOT admin-gated — the people asking are holders, not the admin", async () => {
  // getChatMember reports a plain member above, and the answer still comes.
  const ctx = ctxFor("-1005");
  await configure("-1005");
  await setup.ca(ctx);
  assert.ok(ctx.sent[0].text.includes(ADDR));
});

test("in a private chat it says so instead of answering nothing", async () => {
  const ctx = ctxFor("55");
  ctx.chat.type = "private";
  await setup.ca(ctx);
  assert.strictEqual(ctx.sent.length, 1);
  assert.ok(!ctx.sent[0].text.includes(ADDR));
});

test("a bare 'ca' is the same question without the slash", async () => {
  await configure("-1006");
  for (const word of ["ca", "CA", "Ca?", "contract", "/ca"]) {
    const ctx = ctxFor("-1006", word);
    let fell = false;
    await setup.groupTokenReply(ctx, () => (fell = true));
    assert.ok(!fell, `"${word}" should be answered, not passed through`);
    assert.ok(ctx.sent[0] && ctx.sent[0].text.includes(ADDR), `"${word}" must return the CA`);
  }
});

test("a bare 'ca' in a group with NO token stays silent", async () => {
  // /ca is explicit and always deserves a reply. A bot that answers a random
  // "ca" in a group it was never pointed at is posting unprompted into
  // somebody's chat, which is how it gets removed.
  const ctx = ctxFor("-1007", "ca");
  let fell = false;
  await setup.groupTokenReply(ctx, () => (fell = true));
  assert.ok(fell, "it must fall through");
  assert.strictEqual(ctx.sent.length, 0);
});

test("ordinary chat containing the word is left alone", async () => {
  await configure("-1008");
  for (const line of ["ca please", "what is the ca", "contract address?", "cat"]) {
    const ctx = ctxFor("-1008", line);
    let fell = false;
    await setup.groupTokenReply(ctx, () => (fell = true));
    assert.ok(fell, `"${line}" is conversation, not a command`);
  }
});

test("the project's own socials ride along, from DexScreener", async () => {
  // Asked for in the same breath as the CA. Read from the pair info, so a
  // project that set them on DexScreener gets them here with no extra setup.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => ({
    website: "https://alon.fun",
    twitter: "https://x.com/alon",
    telegram: "https://t.me/alon",
  });
  setup._linksCache.clear();
  try {
    const ctx = ctxFor("-1010");
    await configure("-1010");
    await setup.ca(ctx);
    const { text, extra } = ctx.sent[0];
    const links = {};
    for (const e of extra.entities || []) if (e.type === "text_link") links[text.substr(e.offset, e.length)] = e.url;
    assert.strictEqual(links.Website, "https://alon.fun");
    assert.strictEqual(links.X, "https://x.com/alon");
    assert.strictEqual(links.Telegram, "https://t.me/alon");
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("no socials → the row VANISHES, it does not leave a gap", async () => {
  // Most fresh launches have none. A blank line where a row was reads as a
  // rendering fault on exactly the tokens that look least trustworthy already.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => null;
  setup._linksCache.clear();
  try {
    const ctx = ctxFor("-1011");
    await configure("-1011");
    await setup.ca(ctx);
    assert.doesNotMatch(ctx.sent[0].text, /\n\n\n/, "no blank line where the socials were");
    assert.ok(ctx.sent[0].text.includes(ADDR), "the CA still arrives — socials are a bonus, not the answer");
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("an indexer that is down never costs a member the address", async () => {
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => {
    throw new Error("ECONNRESET");
  };
  setup._linksCache.clear();
  try {
    const ctx = ctxFor("-1012");
    await configure("-1012");
    await setup.ca(ctx);
    assert.ok(ctx.sent[0].text.includes(ADDR));
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("the socials lookup is cached — /ca is asked by members, over and over", async () => {
  // A busy group asks this dozens of times a day. One fresh DexScreener request
  // per ask is a self-inflicted rate limit, and this project has already had a
  // third-party feed refuse this server at the IP level.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  let calls = 0;
  ds.fetchTokenInfo = async () => (calls++, { website: "https://alon.fun" });
  setup._linksCache.clear();
  try {
    await configure("-1013");
    for (let i = 0; i < 5; i++) await setup.ca(ctxFor("-1013"));
    assert.strictEqual(calls, 1, "five asks, one lookup");
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("a failed lookup is cached too, but only briefly", async () => {
  // An indexer having a bad minute must not be re-asked on every single /ca for
  // that minute — and it must not be written off for ten either.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => null;
  setup._linksCache.clear();
  try {
    await configure("-1014");
    await setup.ca(ctxFor("-1014"));
    const entry = setup._linksCache.get(`solana:${ADDR}`);
    assert.ok(entry.ttl < 5 * 60 * 1000, "a miss expires in minutes, not tens of minutes");
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("EVERY emoji on the card is reachable from the emoji editor", async () => {
  // The gap this closes: 🌐 𝕏 💬 were written into group/setup.js, so they were
  // the only glyphs on this card the "😀 Swap emoji" screen could not touch —
  // the same gap 📃 and 👤 had on the buy card.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => ({ website: "https://a.io", twitter: "https://x.com/a", telegram: "https://t.me/a" });
  setup._linksCache.clear();
  try {
    const ctx = ctxFor("-1015");
    await configure("-1015");
    await setup.ca(ctx);
    // chain_emojis is in the list because the network mark on the row is the
    // NETWORK'S own, from the map the buy cards and channel posts share — a
    // different template, but reachable from the same admin bot, which is what
    // this test is actually about.
    const swappable = new Set(
      ["group_ca", "social_emojis", "chain_emojis"].flatMap((k) => tpl.listEmojis(k).map((e) => e.char)),
    );
    const onCard = [...new Set([...ctx.sent[0].text.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]))];
    assert.deepStrictEqual(onCard.filter((c) => !swappable.has(c)), []);
  } finally {
    ds.fetchTokenInfo = real;
    setup._linksCache.clear();
  }
});

test("swapping a socials icon changes the card, without touching its wording", async () => {
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => ({ website: "https://a.io" });
  setup._linksCache.clear();
  await tpl.setTemplate("social_emojis", "website = 🏠\nx = 𝕏\ntelegram = 💬");
  try {
    const ctx = ctxFor("-1016");
    await configure("-1016");
    await setup.ca(ctx);
    assert.match(ctx.sent[0].text, /🏠 Website/);
  } finally {
    ds.fetchTokenInfo = real;
    await tpl.resetTemplate("social_emojis");
    setup._linksCache.clear();
  }
});

test("the socials wording is editable too, field by field", async () => {
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => ({ website: "https://a.io", telegram: "https://t.me/a" });
  setup._linksCache.clear();
  // Only the first field overridden — the rest must fall back rather than blank.
  await tpl.setTemplate("social_labels", "Situs");
  try {
    const ctx = ctxFor("-1017");
    await configure("-1017");
    await setup.ca(ctx);
    assert.match(ctx.sent[0].text, /🌐 Situs/);
    assert.match(ctx.sent[0].text, /💬 Telegram/, "an untyped field keeps its default");
  } finally {
    ds.fetchTokenInfo = real;
    await tpl.resetTemplate("social_labels");
    setup._linksCache.clear();
  }
});

test("an emptied icon drops the glyph, not into a leading space", async () => {
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  ds.fetchTokenInfo = async () => ({ website: "https://a.io" });
  setup._linksCache.clear();
  await tpl.setTemplate("social_emojis", "website =\nx = 𝕏\ntelegram = 💬");
  try {
    const ctx = ctxFor("-1018");
    await configure("-1018");
    await setup.ca(ctx);
    assert.match(ctx.sent[0].text, /\n\nWebsite$/, "no orphaned space where the icon was");
  } finally {
    ds.fetchTokenInfo = real;
    await tpl.resetTemplate("social_emojis");
    setup._linksCache.clear();
  }
});

test("the card is admin-editable like every other group message", () => {
  const m = tpl.meta("group_ca");
  assert.strictEqual(m.group, "Group Setup");
  for (const ph of ["nameRow", "chain", "address", "links", "website", "twitter", "telegram", "chartUrl", "tradeUrl", "coinUrl"]) {
    assert.ok(m.ph.includes(ph), `{${ph}} must be offered in the editor`);
  }
});

test("the trade link has ONE definition, shared with the buy card", () => {
  // It used to live in buyMonitor.js alone. Two copies of the ?start= payload
  // shape is one to forget when the shape changes.
  const { tradeDeepLink } = require("../src/config/chains");
  const mon = require("../src/group/buyMonitor");
  const vars = mon.alertVars(
    { chatId: "-1", chain: "solana", address: ADDR, sym: "ALON", name: "alon" },
    { txHash: "t", buyer: "b", usd: 40, tokenAmount: 100 },
    { priceUsd: 1, mcap: 1 },
    null,
  );
  assert.strictEqual(vars.tradeUrl, tradeDeepLink("solana", ADDR));
});

test("the /ca card leads its chain row with THAT chain's own mark", () => {
  // {chainEmoji} was already passed to this template and simply never used: the
  // row led with a fixed 🔗, which told a reader "chain" beside a word that
  // already said Solana. It reads the same admin-editable chain_emojis map as
  // the buy cards and the channel posts, so one premium emoji covers all three.
  const tpl = require("../src/templates");
  const { chainEmoji } = require("../src/channels/format");
  const row = (chain) =>
    tpl
      .render("group_ca", { label: "**T** $T", chain, chainEmoji: chainEmoji(chain), address: "CA", links: "" })
      .text.split("\n")[1];
  for (const chain of ["solana", "robinhood", "bsc"]) {
    assert.ok(row(chain).startsWith(chainEmoji(chain)), `${chain}: got ${row(chain)}`);
  }
  assert.notStrictEqual(chainEmoji("solana"), chainEmoji("robinhood"), "or the row says nothing");
});
