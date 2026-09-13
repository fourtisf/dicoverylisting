// The @dexvraadminbot trending-board editor: how an admin's premium emoji is
// captured, what the ✅/💎/▫️ markers mean, and that the premium-status report
// names the ACTUAL blocking cause instead of a generic "not connected".
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123:TEST";
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ab-"));

const test = require("node:test");
const assert = require("node:assert");

const { _board } = require("../src/admin/adminBot");
const tb = require("../src/services/trendingBoard");
const pe = require("../src/config/premiumEmoji");
const gramjs = require("../src/gramjs");

const flat = (kb) => kb.reply_markup.inline_keyboard.flat();

test("emojiFragment: a premium emoji is stored as markup, a plain one as the char", () => {
  // What Telegram actually delivers for a premium emoji: the fallback char in
  // .text plus a custom_emoji entity carrying the document id.
  const premiumMsg = { text: "🔥", entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "5382023248034677414" }] };
  assert.strictEqual(_board.emojiFragment(premiumMsg), "[🔥](emoji/5382023248034677414)");
  assert.strictEqual(_board.emojiFragment({ text: "🔥" }), "🔥", "plain emoji → the bare char");
  assert.strictEqual(_board.emojiFragment({ text: "🔥 extra words" }), "🔥", "only the first token");
  assert.strictEqual(_board.emojiFragment({ text: "" }), "");
  // Entity present but no id → don't fabricate markup.
  assert.strictEqual(_board.emojiFragment({ text: "🔥", entities: [{ type: "bold", offset: 0, length: 2 }] }), "🔥");
  // These values are spliced into the channel post's markup — never let typed
  // markup characters through, or a badge becomes a link in the public board.
  assert.strictEqual(_board.emojiFragment({ text: "[tap](https://evil.example)" }), "taphttps://evil.example");
  assert.strictEqual(_board.emojiFragment({ text: "**x**" }), "x");
});

test("a typed link can never become a rank badge or chain logo", async () => {
  await tb.setRankEmoji(3, "[tap](https://evil.example)");
  assert.ok(!/\]\(http/.test(tb.rankBadge(3)), `no link markup survives: ${tb.rankBadge(3)}`);
  await tb.setChainLogo("base", "[tap](https://evil.example)");
  assert.ok(!/\]\(http/.test(tb.chainLogo("base")), `no link markup survives: ${tb.chainLogo("base")}`);
  await tb.reset();
});

test("editor markers say whether a slot is YOURS, not only whether it is premium", async () => {
  // This used to render 💎 for BOTH the built-in premium badge and the
  // operator's own, so a panel on which nothing had ever been saved looked
  // exactly like one where every slot was set. "Sudah di set sesuai yang saya
  // mau tapi bot tidak memakai emoji premium" was reported from a screenshot of
  // ranks 1–9 all showing 💎 — which proved nothing either way.
  await tb.reset();
  assert.strictEqual(_board.tbMark(true, true), "💎", "your own premium emoji");
  assert.strictEqual(_board.tbMark(true, false), "🔹", "premium, but the built-in one — NOT what you saved");
  assert.notStrictEqual(_board.tbMark(true, true), _board.tbMark(true, false), "the two premium states are indistinguishable again");
  assert.strictEqual(_board.tbMark(false, true), "✅");
  assert.strictEqual(_board.tbMark(false, false), "▫️");
  // Ranks 1–9 ship premium, so a fresh panel is all built-ins.
  const labels = flat(_board.tbKb()).map((b) => b.text);
  assert.ok(labels.filter((t) => t.startsWith("🔹")).length >= 9, `expected ≥9 built-in premium ranks, got: ${labels.join(" | ")}`);
  assert.ok(!labels.some((t) => t.startsWith("💎 1")), "nothing is saved yet, so no slot may claim to be yours");
  assert.ok(labels.some((t) => t.includes("Premium status")), "the diagnostic is one tap away");
  // Saving your OWN premium emoji is what turns the marker to 💎 — the one
  // thing the operator needs to be able to see.
  await tb.setRankEmoji(1, "[🦄](emoji/5445284980978621387)");
  assert.ok(flat(_board.tbKb()).some((b) => b.text.startsWith("💎 1")), "a saved premium emoji does not read as yours");
  // A plain override flips that slot to ✅.
  await tb.setRankEmoji(2, "🦄");
  assert.ok(flat(_board.tbKb()).some((b) => b.text.startsWith("✅ 2")), "plain override → ✅");
  await tb.reset();
});

test("the legend explains all FOUR markers, or the panel is a puzzle", () => {
  const txt = _board.tbText();
  for (const m of ["💎", "🔹", "✅", "▫️"]) assert.ok(txt.includes(m), `${m} is used but never explained`);
  assert.ok(/YOUR premium/i.test(txt), "the legend does not distinguish yours from the built-in one");
  assert.ok(_board.tbChainsKb, "chain screen still reachable");
});

test("editor: chain keyboard marks the premium logos", async () => {
  await tb.reset();
  const btns = flat(_board.tbChainsKb());
  const bsc = btns.find((b) => b.text.includes("BSC"));
  assert.ok(bsc.text.startsWith("🔹"), `BSC ships a BUILT-IN premium logo (🔹, not 💎 — nothing was saved): ${bsc.text}`);
  assert.ok(bsc.text.includes(pe.CHAIN_EMOJI.bsc.char), "the button shows the plain fallback, not raw markup");
  assert.ok(!bsc.text.includes("emoji/"), "never leak markup into a button label");
  const rh = btns.find((b) => b.text.includes("Robinhood"));
  assert.ok(rh.text.startsWith("▫️"), `Robinhood has no verified id yet: ${rh.text}`);
});

test("editor text: coverage line reflects the real premium state", async () => {
  await tb.reset();
  const txt = _board.tbText();
  assert.ok(txt.includes("ranks 9/10"), `ranks coverage in: ${txt}`);
  assert.ok(txt.includes("chains 7/"), "chain coverage present");
  assert.ok(!txt.includes("emoji/"), "no raw markup in the editor copy");
});

test("premium report: says the session is missing, not just 'not connected'", async () => {
  const txt = await _board.premiumReportText();
  assert.ok(txt.includes("No premium-account session") || txt.includes("API_ID"), `actionable cause named: ${txt}`);
  assert.ok(txt.includes("gramjs-login.js") || txt.includes("my.telegram.org"), "tells the operator what to run");
  assert.ok(txt.includes("Board slots premium:"), "reports board coverage too");
});

// The report reads what the MAIN bot recorded — the admin process must never
// open its own MTProto client on the same session (AUTH_KEY_DUPLICATED risk).
const withStatus = (last, extra = {}) => ({
  enabled: true, apiCreds: true, sessionPresent: true, libInstalled: true,
  sessionFile: "/tmp/session.txt", cooldownSec: 0, last, ...extra,
});
async function reportWith(diag) {
  const real = gramjs.diagnose;
  gramjs.diagnose = () => diag;
  try {
    return await _board.premiumReportText();
  } finally {
    gramjs.diagnose = real;
  }
}

test("premium report: a non-Premium account is called out as THE blocker", async () => {
  const txt = await reportWith(withStatus({ at: Date.now(), ok: true, account: "@dexvraposter", premium: false }));
  assert.ok(txt.includes("does NOT have Telegram Premium"), `names the real cause: ${txt}`);
  assert.ok(txt.includes("@dexvraposter"), "identifies which account");
});

test("premium report: a live emoji refusal outranks a stale 'premium: true'", async () => {
  const txt = await reportWith(
    withStatus({ at: Date.now(), ok: true, account: "@dexvraposter", premium: true, emojiRefused: true, emojiError: "PREMIUM_ACCOUNT_REQUIRED" }),
  );
  assert.ok(txt.includes("REFUSED the custom emoji"), `reports what actually happened: ${txt}`);
  assert.ok(txt.includes("PREMIUM_ACCOUNT_REQUIRED"), "shows Telegram's own error");
});

test("premium report: a failed connection shows the error and the fix", async () => {
  const txt = await reportWith(withStatus({ at: Date.now() - 120000, ok: false, error: "AUTH_KEY_UNREGISTERED" }));
  assert.ok(txt.includes("Last connection FAILED"), "flags the failure");
  assert.ok(txt.includes("AUTH_KEY_UNREGISTERED") && txt.includes("gramjs-login.js"), "error + remedy");
  assert.ok(/2min ago/.test(txt), `says when: ${txt}`);
});

test("premium report: healthy account reads as ready", async () => {
  const txt = await reportWith(withStatus({ at: Date.now(), ok: true, account: "@dexvraposter", premium: true }));
  assert.ok(txt.includes("Telegram Premium: <b>yes</b>"), `ready: ${txt}`);
  assert.ok(!txt.includes("❌"), "no false alarms when everything is fine");
});

test("premium report: session present but the main bot hasn't posted yet", async () => {
  const txt = await reportWith(withStatus(null));
  assert.ok(txt.includes("not used yet"), `explains the gap instead of crying failure: ${txt}`);
});

// ── "sudah di set tapi bot tidak memakai emoji premium terbaru" ──────────────
//
// The board republishes on a 5-minute interval, so after saving a badge the
// operator saw nothing change and had no way to tell a slow interval from a
// setting that never took — or from a premium account Telegram was refusing.
// 🔄 Refresh board now asks the MAIN bot to publish immediately and reports
// which of those three happened, in the chat, at the moment they ask.

test("the refresh card says whether the emoji actually went out ANIMATED", () => {
  const card = (board) => _board.tbRefreshText({ results: [{ board }] });

  const premium = card({ how: "edited", mode: "premium", premium: 14, messageId: 7 });
  assert.match(premium, /✅/);
  assert.match(premium, /14 custom emoji/, "the operator is told how many went out");

  // The answer this button exists for: published, but the emoji did NOT render.
  // It must not read as a success, and it must name the CAUSE — "the board is
  // not premium" has three unrelated causes and three different fixes.
  const plain = card({ how: "edited", mode: "plain", premium: 0, messageId: 7, why: "the premium account is not connected" });
  assert.match(plain, /⚠️/);
  assert.ok(!/✅/.test(plain), "a plain publish must never render as a success");
  assert.match(plain, /not connected/, "the reason is missing");
  assert.match(plain, /Premium status/, "no route to the fix");
  assert.match(plain, /Your saved emoji are fine/, "it must not send the operator back to re-set the emoji");

  // Nothing trending → there is no board. Not an error, and not a success.
  assert.match(card({ how: "empty" }), /No token is trending/);
  assert.match(card({ how: "failed", why: "boom" }), /FAILED/);
  // A job the main bot never answered is its own state, not a silent ✅.
  assert.match(_board.tbRefreshText({ error: "timeout" }), /No answer from the main bot/);
});

test("the refresh button is ON the board screen, beside the diagnostic", () => {
  const labels = flat(_board.tbKb()).map((b) => b.text);
  assert.ok(labels.some((t) => /Refresh board now/.test(t)), `no way to publish on demand: ${labels.join(" | ")}`);
  assert.match(_board.tbText(), /Refresh board now/, "the screen does not mention what the button does");
});
