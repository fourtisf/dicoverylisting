// How the trending board actually reaches the channel: premium via the GramJS
// account, and what happens on each way that can fail. These paths are the
// difference between an animated board and a plain-unicode one, and every
// failure mode looks identical from inside the channel — so pin them here.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tp-"));

const test = require("node:test");
const assert = require("node:assert");

const md = require("../src/marketdata");
md.fetchMarket = async () => ({ priceUsd: 1, mcap: 1_000_000, change24h: 12.5 });
const api = require("../src/api/dexvra");
api.getListings = async () => [
  { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "bonk", sym: "BONK", tier: "DIAMOND" },
];

const gramjs = require("../src/gramjs");
const poster = require("../src/services/trendingPoster");
const tb = require("../src/services/trendingBoard");

// A fake Bot API + a fake premium account, both recording what they were asked
// to do, so a test can assert on the *entities that went out*.
function harness() {
  const calls = [];
  const tg = {
    sendMessage: async (chat, text, extra) => {
      calls.push({ via: "bot", op: "send", entities: extra.entities });
      return { message_id: 100 + calls.length };
    },
    editMessageText: async (chat, id, _x, text, extra) => {
      calls.push({ via: "bot", op: "edit", id, entities: extra.entities });
      return true;
    },
    pinChatMessage: async (chat, id) => {
      calls.push({ via: "bot", op: "pin", id });
      return true;
    },
    deleteMessage: async (chat, id) => {
      calls.push({ via: "bot", op: "delete", id });
      return true;
    },
  };
  return { calls, tg };
}
const withGramjs = (impl) => Object.assign(gramjs, impl);
const nCustom = (entities) => (entities || []).filter((e) => e.type === "custom_emoji").length;

test.beforeEach(async () => {
  poster._resetState();
  await tb.reset();
});

test("premium account connected → the board posts WITH custom-emoji entities", async () => {
  const { calls, tg } = harness();
  const sent = [];
  withGramjs({
    available: () => true,
    sendToChannel: async (chan, payload) => {
      sent.push(payload);
      return { message_id: 7 };
    },
    editChannelMessage: async (chan, id, payload) => {
      sent.push({ ...payload, edit: id });
      return { message_id: id };
    },
  });
  await poster.runOnce(tg);
  assert.strictEqual(sent.length, 1, "posted once, via the premium account");
  assert.ok(nCustom(sent[0].entities) >= 2, `rank badge + chain logo went out premium: ${nCustom(sent[0].entities)}`);
  assert.ok(!sent[0].text.includes("emoji/"), "no raw markup in the visible text");
  assert.strictEqual(calls.length, 0, "the Bot API was not touched");
});

test("nothing changed → no pointless edit; text change → one edit, same message", async () => {
  const { tg } = harness();
  const sent = [];
  withGramjs({
    available: () => true,
    sendToChannel: async (c, p) => (sent.push({ op: "send", ...p }), { message_id: 7 }),
    editChannelMessage: async (c, id, p) => (sent.push({ op: "edit", id, ...p }), { message_id: id }),
  });
  await poster.runOnce(tg);
  await poster.runOnce(tg);
  assert.strictEqual(sent.length, 1, "identical board → skipped");
  // A new token joins the board — the text changes, so it must publish again.
  const base = await api.getListings();
  api.getListings = async () => [
    ...base,
    { status: "approved", trendingRank: 2, trendExp: 0, chain: "bsc", address: "0xf", sym: "FLOKI", tier: "GOLD" },
  ];
  try {
    await poster.runOnce(tg);
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual([sent[1].op, sent[1].id], ["edit", 7], "edits the SAME message, never a second board");
    assert.ok(sent[1].text.includes("$FLOKI"), "the new token is on the board");
  } finally {
    api.getListings = async () => base;
  }
});

test("Telegram refuses the emoji → same message degrades to unicode, no duplicate board", async () => {
  const { calls, tg } = harness();
  const sent = [];
  withGramjs({
    available: () => true,
    sendToChannel: async (c, p) => {
      if (nCustom(p.entities)) throw new Error("RPCError 400: PREMIUM_ACCOUNT_REQUIRED");
      sent.push({ op: "send", ...p });
      return { message_id: 7 };
    },
    editChannelMessage: async (c, id, p) => {
      if (nCustom(p.entities)) throw new Error("RPCError 400: PREMIUM_ACCOUNT_REQUIRED");
      sent.push({ op: "edit", id, ...p });
      return { message_id: id };
    },
  });
  await poster.runOnce(tg);
  assert.strictEqual(sent.length, 1, "exactly one message survives");
  assert.strictEqual(nCustom(sent[0].entities), 0, "retried with the emoji stripped");
  assert.ok(
    sent[0].entities.some((e) => e.type === "bold") && sent[0].entities.some((e) => e.type === "text_link"),
    "bold + links are kept — only the custom emoji are dropped",
  );
  assert.strictEqual(calls.length, 0, "stayed on the SAME transport — no bot-api duplicate");
});

test("premium account offline → Bot API posts the unicode fallback", async () => {
  const { calls, tg } = harness();
  withGramjs({ available: () => false });
  await poster.runOnce(tg);
  const send = calls.find((c) => c.op === "send");
  assert.ok(send, "posted through the Bot API");
  assert.strictEqual(nCustom(send.entities), 0, "Telegram strips these from a bot anyway — never send them");
  assert.ok(send.entities.some((e) => e.type === "bold"), "the rest of the formatting still goes out");
});

test("premium comes online later → the board re-renders even though the text is identical", async () => {
  const { calls, tg } = harness();
  withGramjs({ available: () => false });
  await poster.runOnce(tg); // unicode via Bot API, message 101
  assert.strictEqual(calls.filter((c) => c.op === "send").length, 1);

  const sent = [];
  withGramjs({
    available: () => true,
    sendToChannel: async (c, p) => (sent.push(p), { message_id: 7 }),
    editChannelMessage: async (c, id, p) => (sent.push({ ...p, edit: id }), { message_id: id }),
    deleteChannelMessage: async () => true,
  });
  await poster.runOnce(tg);
  assert.strictEqual(sent.length, 1, "same text, but the MODE changed → re-render (not skipped)");
  assert.ok(nCustom(sent[0].entities) >= 2, "now with premium emoji");
  // The old Bot-API board is superseded — GramJS can't edit it, so it must go.
  assert.ok(
    calls.some((c) => c.op === "delete" && c.id === 101),
    `the stale bot-api board is deleted: ${JSON.stringify(calls)}`,
  );
});

test("the board it edits is the one pinned — a stale duplicate can't keep the pin", async () => {
  // A leftover board from an older run stayed pinned while the poster quietly
  // edited a DIFFERENT message: readers saw a board that never changed, and
  // posting logs looked perfectly healthy. Pin what we actually maintain.
  const { tg } = harness();
  const pins = [];
  withGramjs({
    available: () => true,
    sendToChannel: async () => ({ message_id: 7 }),
    editChannelMessage: async (c, id) => ({ message_id: id }),
    pinChannelMessage: async (c, id) => pins.push(id),
  });
  await poster.runOnce(tg);
  assert.deepStrictEqual(pins, [7], "pins the message it maintains");
  // …but only once per process — no pin spam on every refresh.
  const base = await api.getListings();
  api.getListings = async () => [
    ...base,
    { status: "approved", trendingRank: 2, trendExp: 0, chain: "bsc", address: "0xf", sym: "FLOKI", tier: "GOLD" },
  ];
  try {
    await poster.runOnce(tg);
    assert.deepStrictEqual(pins, [7], "no re-pin on later refreshes");
  } finally {
    api.getListings = async () => base;
  }
});

test("a non-emoji GramJS failure still falls back to the Bot API", async () => {
  const { calls, tg } = harness();
  withGramjs({
    available: () => true,
    sendToChannel: async () => {
      throw new Error("FLOOD_WAIT_42");
    },
    editChannelMessage: async () => {
      throw new Error("FLOOD_WAIT_42");
    },
  });
  await poster.runOnce(tg);
  assert.ok(calls.some((c) => c.via === "bot" && c.op === "send"), "the board still gets published");
});

// ── What runOnce REPORTS ────────────────────────────────────────────────────
//
// The board looks identical in the channel whether its custom emoji rendered or
// silently fell back to the plain chars — nobody without Telegram Premium can
// tell, and the operator asking "did my emoji take?" is usually one of them. So
// the publish reports what it did, and @dexvraadminbot's 🔄 Refresh board now
// prints that answer in the chat instead of leaving it in pm2's log.

test("a premium publish reports the mode and the emoji COUNT", async () => {
  const { tg } = harness();
  withGramjs({
    available: () => true,
    sendToChannel: async () => ({ message_id: 501 }),
    editChannelMessage: async () => true,
    pinChannelMessage: async () => true,
    isPremiumEmojiError: () => false,
  });
  const r = await poster.runOnce(tg);
  assert.strictEqual(r.mode, "premium");
  assert.strictEqual(r.transport, "gramjs");
  assert.ok(r.premium > 0, `the board ships premium badges, so the count must be > 0: ${JSON.stringify(r)}`);
  assert.ok(["posted", "edited"].includes(r.how), `unexpected how: ${r.how}`);

  // A second run with nothing changed must say so rather than claim a publish.
  const again = await poster.runOnce(tg);
  assert.strictEqual(again.how, "unchanged");
});

test("a PLAIN publish names why — the three causes have three different fixes", async () => {
  const { tg } = harness();
  withGramjs({ available: () => false, isPremiumEmojiError: () => false });
  const r = await poster.runOnce(tg);
  assert.strictEqual(r.mode, "plain");
  assert.match(r.why || "", /not connected/, "an operator reading this must learn what to fix");
  assert.strictEqual(r.premium, 0, "nothing animated went out, so the count must not claim otherwise");
});

test("Telegram refusing the emoji is reported as plain, with the refusal carried", async () => {
  const { tg } = harness();
  withGramjs({
    available: () => true,
    sendToChannel: async () => ({ message_id: 601 }),
    editChannelMessage: async () => true,
    pinChannelMessage: async () => true,
    isPremiumEmojiError: () => true,
    recordEmojiRefusal: () => {},
  });
  // First send throws the premium refusal, the degrade path re-sends plain.
  let first = true;
  withGramjs({
    sendToChannel: async () => {
      if (first) { first = false; throw new Error("EMOJI_INVALID"); }
      return { message_id: 602 };
    },
  });
  const r = await poster.runOnce(tg);
  assert.strictEqual(r.mode, "plain");
  assert.match(r.why || "", /EMOJI_INVALID/, "the refusal Telegram gave is the diagnosis — it must not be swallowed");
});
