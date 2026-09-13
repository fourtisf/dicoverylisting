// The network's own glyph leads the token row on a buy alert.
//
// The card used to open that row with a fixed 📃 on every chain, so a Solana
// buy and a Base buy were typographically identical — the one fact a reader
// needs before anything else on the card (which network is this?) was the one
// fact the row did not carry. Every rival buy bot leads with the network mark.
//
// It comes from `chain_emojis`, the SAME map the channel posts read, and that
// sharing is the point: one edit rebrands a network in both places, and a
// premium custom emoji pasted there reaches every buy card on that network.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cemoji-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const tpl = require("../src/templates");

const g = (over = {}) => ({
  chatId: "-100", chain: "solana", address: "So1Token", pairAddress: "PooLAddr",
  sym: "ALON", name: "alon", ...over,
});
const pool = { priceUsd: 0.00004823, mcap: 15511897, liquidity: 183475, change24h: 18.42 };
const buy = { txHash: "5xTx", buyer: "AFqu1Maaaaaaaaaaaaaaaaaaaaaaajail", usd: 804.72, tokenAmount: 51874.15 };

test("the token row opens with the token's OWN chain emoji, no group setup", () => {
  assert.match(mon.alertVars(g(), buy, pool, null).nameRow, /^🟣 /);
  assert.match(mon.alertVars(g({ chain: "base" }), buy, pool, null).nameRow, /^🔵 /);
  assert.match(mon.alertVars(g({ chain: "bsc" }), buy, pool, null).nameRow, /^🟡 /);
});

test("a chain with no entry in the map still gets a glyph, never a bare row", () => {
  // 💠 is the shared fallback. A row that opened with a space would read as a
  // rendering fault on exactly the chains we support least well.
  assert.match(mon.alertVars(g({ chain: "nosuchchain" }), buy, pool, null).nameRow, /^💠 /);
});

test("the rendered card carries it — not just the var bag", () => {
  const { text } = mon.renderRealAlert(g(), buy, pool, null);
  assert.match(text, /🟣 alon \$ALON/);
  assert.doesNotMatch(text, /📃/); // the fixed icon it replaced
});

test("editing chain_emojis moves the buy card, not only the channel posts", async () => {
  // The whole reason format.js exports chainEmoji instead of buyMonitor keeping
  // its own copy: one edit, both surfaces.
  await tpl.setTemplate("chain_emojis", "solana = 🦊");
  try {
    assert.match(mon.alertVars(g(), buy, pool, null).nameRow, /^🦊 /);
  } finally {
    await tpl.resetTemplate("chain_emojis");
  }
  assert.match(mon.alertVars(g(), buy, pool, null).nameRow, /^🟣 /);
});

test("a PREMIUM chain emoji survives onto the buy card as an entity", async () => {
  // Pasted in @dexvraadminbot, `chain_emojis` is stored as {text, entities} and
  // the text alone only carries the fallback char. The card has to come out
  // with a custom_emoji entity over it, or the operator's paid emoji silently
  // degrades to a coloured circle everywhere except the channel.
  await tpl.setTemplate("chain_emojis", {
    text: "solana = 🟣",
    entities: [{ type: "custom_emoji", offset: 9, length: 2, custom_emoji_id: "5445284980978621387" }],
  });
  try {
    const payload = mon.renderRealAlert(g(), buy, pool, null);
    const prem = (payload.entities || []).filter((e) => e.type === "custom_emoji");
    assert.strictEqual(prem.length, 1);
    assert.strictEqual(prem[0].custom_emoji_id, "5445284980978621387");
    assert.strictEqual(payload.text.substr(prem[0].offset, prem[0].length), "🟣");
  } finally {
    await tpl.resetTemplate("chain_emojis");
  }
});

test("the whale card leads with it too — the two cards are one grammar", () => {
  const text = tpl.render("group_whale_alert", mon.alertVars(g(), buy, pool, null)).text;
  assert.match(text, /🟣 alon \$ALON/);
});

test("{chainEmoji} is offered on both cards, so an operator can move it", () => {
  for (const key of ["group_buy_alert", "group_whale_alert", "group_name_row"]) {
    assert.ok(tpl.meta(key).ph.includes("chainEmoji"), `${key} must advertise {chainEmoji}`);
  }
});

test("the byline rides the OPENING line, not the foot of the card", () => {
  // It sat under the CTA row for a while — last thing read, first thing a
  // screenshot crops. Asserted on the default so a reshuffle has to be
  // deliberate.
  const head = (k) => String(tpl.getRawValue(k)).split("\n")[0];
  assert.ok(head("group_buy_alert").includes("{poweredBy}"), `byline left the header line: ${head("group_buy_alert")}`);
  assert.ok(head("group_whale_alert").includes("{poweredBy}"));
});
