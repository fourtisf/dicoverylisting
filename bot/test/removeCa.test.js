// 🗑 Remove CA — and the rule that removing a token is not the same as
// resetting a group.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-rmca-"));

const test = require("node:test");
const assert = require("node:assert");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");
const tpl = require("../src/templates");

const CHAT = -100777;
const buttons = (kb) => kb.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

function tapCtx(what, chatId = CHAT) {
  const sent = [];
  const edits = [];
  const toasts = [];
  return {
    chat: { id: chatId, type: "supergroup" },
    from: { id: 1 },
    match: [null, what],
    callbackQuery: { message: { message_id: 5 } },
    telegram: { getChatMember: async () => ({ status: "administrator" }) },
    answerCbQuery: async (t) => { toasts.push(t || ""); },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 9 }; },
    editMessageText: async (text, extra) => { edits.push({ text, extra }); },
    sent, edits, toasts,
  };
}

const configured = () =>
  cfg.upsert(CHAT, {
    address: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
    pairAddress: "PooL",
    chain: "solana",
    sym: "Jimothy",
    name: "Jimothy The Raccoon",
    minBuyUsd: 250,
    whaleWalletUsd: 75000,
    pin: false,
    on: true,
  });

test("the settings panel offers Remove CA, on a row of its own", () => {
  const kb = setup.settingsKeyboard({ on: true, pin: true });
  assert.ok(buttons(kb).includes("bs_rmca"), "the button exists");
  // Not beside the power toggle: two buttons that both stop the alerts, side by
  // side on a phone, is a mis-tap waiting to happen — and only one of them is
  // undone by tapping again.
  const rows = kb.reply_markup.inline_keyboard;
  const rmRow = rows.find((r) => r.some((b) => b.callback_data === "bs_rmca"));
  assert.strictEqual(rmRow.length, 1, "alone on its row");
  assert.ok(!rmRow.some((b) => b.callback_data === "bs_power"), "and not next to the power toggle");
});

test("removing takes two taps, and the first one changes nothing", async () => {
  await configured();
  const ctx = tapCtx("rmca");
  await setup.settingsTap(ctx);
  assert.strictEqual(ctx.edits.length, 1, "the panel became the confirm, in place");
  assert.match(ctx.edits[0].text, /Remove \$Jimothy\?/);
  assert.deepStrictEqual(
    buttons({ reply_markup: ctx.edits[0].extra.reply_markup }),
    ["bs_rmyes", "bs_rmno"],
    "confirm or back out — nothing else",
  );
  assert.ok(cfg.get(CHAT).address, "and the CA is still there");
});

test("backing out puts the panel back exactly as it was", async () => {
  await configured();
  const ctx = tapCtx("rmno");
  await setup.settingsTap(ctx);
  assert.ok(cfg.get(CHAT).address, "nothing removed");
  assert.match(ctx.edits.at(-1).text, /Ge87Etsj/, "the status panel is back");
});

test("confirming clears the TOKEN and keeps the group's tuning", async () => {
  // The ordinary reason to do this is swapping one contract for another. Wiping
  // the floor and the whale bar with it would silently reset numbers the admin
  // chose, and they would find out from the first alert under the wrong floor.
  await configured();
  const ctx = tapCtx("rmyes");
  await setup.settingsTap(ctx);
  const g = cfg.get(CHAT);
  assert.strictEqual(g.address, null, "CA gone");
  assert.strictEqual(g.pairAddress, null, "and the pool it resolved to");
  assert.strictEqual(g.sym, null);
  assert.strictEqual(g.minBuyUsd, 250, "floor kept");
  assert.strictEqual(g.whaleWalletUsd, 75000, "whale bar kept");
  assert.strictEqual(g.pin, false, "pin setting kept");
});

test("a group with no CA is not active, whatever its on flag says", async () => {
  // `on` is deliberately left alone by the removal, so this is what actually
  // stops the alerts. If it ever stopped being true, removing a CA would leave
  // a group being polled for a token it no longer has.
  await configured();
  await setup.settingsTap(tapCtx("rmyes"));
  assert.strictEqual(cfg.get(CHAT).on, true, "the flag is untouched");
  assert.ok(!cfg.active().some((g) => String(g.chatId) === String(CHAT)), "but the group is not polled");
});

test("after removing, the panel says how to start again — by pasting", async () => {
  await configured();
  const ctx = tapCtx("rmyes");
  await setup.settingsTap(ctx);
  const back = ctx.edits.at(-1);
  assert.match(back.text, /Paste your contract address/i, "the shortest path leads");
  assert.deepStrictEqual(buttons({ reply_markup: back.extra.reply_markup }), ["bs_token"], "and one button to do it");
  assert.match(tpl.t("buybot_removed_toast"), /[Pp]aste a new contract/, "the toast says it too");
});

test("Remove CA on a group that has none is a toast, not a broken confirm", async () => {
  await cfg.upsert(CHAT, { address: null, pairAddress: null, sym: null });
  const ctx = tapCtx("rmca");
  await setup.settingsTap(ctx);
  assert.strictEqual(ctx.edits.length, 0, "no confirm panel for a token that isn't there");
  assert.match(ctx.toasts.join(" "), /No token set/i);
});

test("the empty state leads with pasting, not with syntax", () => {
  // /settoken still works. It is the slowest of the three ways in and the only
  // one that needs syntax, so it is not what the card should teach.
  const t = tpl.t("buybot_need_token");
  assert.match(t, /[Pp]aste your contract address/);
  assert.ok(!t.includes("/settoken"), "no command to copy out");
});

// ── The /settoken receipt ────────────────────────────────────────────────────

test("the receipt echoes the CA the bot actually heard", async () => {
  // The address was pasted from somewhere else moments ago. A group about to
  // run alerts on it should be able to check the bot heard the right one BEFORE
  // the first buy lands, not from the first alert that names a token nobody
  // recognises.
  const t = tpl.t("settoken_ok", {
    chain: "Solana",
    nameRow: "📃 alon $ALON",
    address: "8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS",
    links: "",
    minBuy: "$10",
    whale: "$50,000",
  });
  assert.match(t, /8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS/, "the whole address, not a prefix");
  assert.match(t, /alon \$ALON/);
  assert.match(t, /Solana/);
});

test("a token with no socials loses the row, not the receipt", async () => {
  // Most fresh launches have none. A bare label with nothing after it is not a
  // row, it is a rendering bug.
  const t = tpl.t("settoken_ok", {
    chain: "Solana", nameRow: "📃 $ALON", address: "8XtRW", links: "", minBuy: "$10", whale: "$50,000",
  });
  assert.ok(!/\n\n\n/.test(t), "no hole where the links row was");
  assert.match(t, /Buy alerts are live/, "and the receipt still says what is running");
});

test("socials that cannot be fetched cost a row, never the setup", async () => {
  // By the time this runs the token is configured and the alerts are live. An
  // indexer having a bad minute must not turn a successful setup into an error.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  try {
    ds.fetchTokenInfo = async () => { throw new Error("ENOTFOUND"); };
    assert.deepStrictEqual(await setup.tokenLinks("solana", "8XtRW"), {
      links: "", website: "", twitter: "", telegram: "",
    });
  } finally {
    ds.fetchTokenInfo = real;
  }
});

test("a hostile URL never reaches the group's setup reply", async () => {
  // These come from a third-party feed and land inside an href. A javascript:
  // URL has no business there, and a malformed one makes Telegram reject the
  // WHOLE message — taking the receipt down over a link.
  const ds = require("../src/dexscreener");
  const real = ds.fetchTokenInfo;
  try {
    ds.fetchTokenInfo = async () => ({
      website: "javascript:alert(1)",
      twitter: "https://x.com/real",
      telegram: "not a url at all",
    });
    const out = await setup.tokenLinks("solana", "8XtRW");
    assert.strictEqual(out.website, "", "javascript: dropped");
    assert.strictEqual(out.telegram, "", "junk dropped");
    assert.match(out.twitter, /https:\/\/x\.com\/real/, "the real one survives");
    assert.strictEqual(out.links, out.twitter, "and the row carries only what survived");
  } finally {
    ds.fetchTokenInfo = real;
  }
});

test("the Position row links the buyer's wallet, and drops the link cleanly", () => {
  // The "(Wallet)" every other buy bot carries: the one link on this row that
  // lets a reader go and see what else that address holds.
  const mon = require("../src/group/buyMonitor");
  const g = { chatId: "-1", chain: "solana", address: "So1", sym: "ALON", minBuyUsd: 0 };
  const buy = { txHash: "t", buyer: "GDAtwgaaaaaaaaaaaaaaaaaaaaaaaaZ7tX" };
  const pos = { held: 187161.15, holdsUsd: 941.79, position: "+18.70%" };
  const row = mon.positionRow(g, pos, buy);
  assert.match(row, /\[Wallet\]\(https:\/\//, "linked, not dead text");
  assert.match(row, /GDAtwg/, "and it points at the buyer");
  // A WHOLE SEGMENT: a chain with no explorer loses the link, not the row.
  const noExplorer = mon.positionRow({ ...g, chain: "nosuchchain" }, pos, buy);
  assert.ok(noExplorer.length, "the row survives");
  assert.ok(!/Wallet/.test(noExplorer), "without a dangling label");
  // And no buyer at all is the same case.
  assert.ok(!/Wallet/.test(mon.positionRow(g, pos, { txHash: "t", buyer: "" })));
});
