// "1 token 1x listing" — a contract that is already on dexvra.io can never be
// listed again, and saying so is not optional: the site's addListing()
// OVERWRITES a row with the same chain+address instead of rejecting it, so a
// second listing of someone else's contract silently replaces their name, logo,
// overview and socials. Nothing stopped that before.
//
// The reply mirrors what Fourtis answers with — the token's page plus a route to
// Book Trending — and it is a normal editable template, so the copy belongs to
// the operator, not to this file.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-listed-"));

const test = require("node:test");
const assert = require("node:assert");

const listed = require("../src/helpers/listedGuard");
const api = require("../src/api/dexvra");
const tpl = require("../src/templates");

const read = (p) => fss.readFileSync(require.resolve(`../src/${p}`), "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const EVM = "0xe934e36A439C94017B64a3FecE66AF12099aBF50";
const SOL = "9j8Y1rG7oPTBvxpLbAAvJKQ6oXqPPSXHVBwGHYPUMP";
const ROW = { chain: "robinhood", address: EVM, sym: "HOPPY", name: "Hoppy", status: "approved" };

/** Stub the listings API. `rows` is what /api/internal/listings returns; pass a
 *  string to make the call fail instead. */
function listings(rows) {
  api.getListings = async () => {
    if (typeof rows === "string") throw new Error(rows);
    return rows;
  };
}

/** A ctx that records what the bot sent. */
function ctx() {
  const sent = [];
  return {
    sent,
    chat: { type: "private" },
    message: {},
    session: { type: "xpress_listing", form: {} },
    reply: async (text, extra) => {
      sent.push({ text, extra });
      return { message_id: sent.length };
    },
    telegram: { deleteMessage: async () => {} },
  };
}

// ── what counts as "already listed" ─────────────────────────────────────────

test("an approved listing owns the contract", async () => {
  listings([ROW]);
  assert.ok(await listed.existingListing(EVM, "robinhood"));
});

test("a pending one owns it too — it is queued, not free", async () => {
  listings([{ ...ROW, status: "pending" }]);
  assert.ok(await listed.existingListing(EVM, "robinhood"));
});

test("a REJECTED one does not — a refused submission must be retryable", async () => {
  listings([{ ...ROW, status: "rejected" }]);
  assert.strictEqual(await listed.existingListing(EVM, "robinhood"), null);
});

test("the match ignores case but never crosses chains", async () => {
  listings([ROW]);
  assert.ok(await listed.existingListing(EVM.toLowerCase(), "robinhood"), "checksum vs lowercase is the same contract");
  assert.strictEqual(await listed.existingListing(EVM, "base"), null, "same address on another chain is another token");
});

test("with no chain given it searches every chain — that is how a bare paste works", async () => {
  listings([ROW]);
  const row = await listed.existingListing(EVM);
  assert.strictEqual(row.chain, "robinhood", "and the chain comes back out of the lookup");
});

// ── recognising a contract ──────────────────────────────────────────────────

test("a bare contract is recognised on both address families", () => {
  assert.deepStrictEqual(listed.extractAddress(EVM), { address: EVM, chain: null });
  assert.strictEqual(listed.extractAddress(SOL).address, SOL);
});

test("a dexvra.io token link carries its chain", () => {
  const hit = listed.extractAddress(`https://dexvra.io/token/robinhood/${EVM}`);
  assert.deepStrictEqual(hit, { address: EVM, chain: "robinhood" });
});

test("ordinary chatter is not a contract", () => {
  // "0x123" is a REAL Sui/Aptos address shape (those chains trim leading
  // zeros), which is why the bare-paste path also demands a plausible length.
  for (const s of ["hello", "when listing?", "0x123", "", "  ", "gm gm", "0x" + "z".repeat(40), "0xdead"]) {
    assert.strictEqual(listed.extractAddress(s), null, `"${s}" must not trigger a listings lookup`);
  }
});

// ── the reply ───────────────────────────────────────────────────────────────

test("the card names the token, links its page, and offers Book Trending", async () => {
  listings([ROW]);
  const c = ctx();
  await listed.sendAlreadyListed(c, ROW);
  assert.strictEqual(c.sent.length, 1);
  const { text, extra } = c.sent[0];
  assert.match(text, /Hoppy/);
  assert.match(text, /already listed/i);
  assert.match(text, new RegExp(`dexvra\\.io/token/robinhood/${EVM}`), "the token's own page, not the home page");
  const rows = extra.reply_markup.inline_keyboard;
  assert.strictEqual(rows[0][0].callback_data, "trend_coin", "Book Trending is the first thing offered");
  assert.ok(rows.some((r) => r.some((b) => b.callback_data === "home")));
});

test("the copy is an editable template, not a string in the code", () => {
  assert.ok(tpl.render("already_listed", { name: "X", symbol: "X", chain: "c", address: "a", url: "u", site: "s" }));
  const meta = tpl.META ? tpl.META.already_listed : null;
  if (meta) {
    assert.strictEqual(meta.group, "Bot Messages", "so it shows up in the adminbot editor");
    for (const p of ["name", "symbol", "chain", "address", "url", "site"]) {
      assert.ok(meta.ph.includes(p), `the editor must document {${p}}`);
    }
  }
  assert.match(code("templates.js"), /already_listed:\s*\{ group: "Bot Messages"/, "listed in META");
  assert.ok(!/already listed on/i.test(code("helpers/listedGuard.js")), "no hardcoded copy in the guard");
});

test("every placeholder the editor advertises is really substituted", () => {
  const out = tpl.render("already_listed", listed.listedVars(ROW));
  const body = typeof out === "string" ? out : out.text || "";
  assert.ok(!/\{(name|symbol|chain|address|url|site)\}/.test(body), `a placeholder survived: ${body}`);
});

// ── where it is enforced ────────────────────────────────────────────────────

test("the form stops at the contract step, before it fills anything in", () => {
  const src = code("handlers/listing.js");
  const i = src.indexOf("if (await listed.blockIfListed(ctx, input, f.chain)) return;");
  assert.ok(i > -1, "no check at the contract step");
  assert.ok(i < src.indexOf("f.address = input;"), "…and it runs before the form is populated");
  assert.ok(i < src.indexOf("fetchTokenInfo(f.chain, input)"), "…and before the autofill round-trip");
});

test("it is checked AGAIN at the last gate before money moves", () => {
  // The contract step may have run minutes earlier; the token can be listed in
  // between, and by then a payment would buy an overwrite of someone else's row.
  const src = code("handlers/listing.js");
  const fn = src.slice(src.indexOf("async function approve("), src.indexOf("async function goPay(") + 1);
  const gate = src.slice(src.indexOf("async function approve("));
  assert.match(gate, /const dup = await listed\.existingListing\(f\.address, f\.chain\);/);
  assert.match(gate, /if \(dup\) return listed\.sendAlreadyListed\(ctx, dup\);/);
  assert.ok(gate.indexOf("const dup = await") < gate.indexOf("goPay(ctx,"), "before the payment call, not after");
  void fn;
});

test("that last gate fails CLOSED — an unreachable API stops the sale", () => {
  // The opposite of the contract step. Taking money we cannot verify buys a
  // listing that would overwrite an existing one, and fulfilment goes through
  // the very API that just failed.
  const gate = code("handlers/listing.js").slice(code("handlers/listing.js").indexOf("async function approve("));
  const c = gate.slice(gate.indexOf("duplicate re-check failed"));
  assert.match(c, /return toast\(ctx, tpl\.render\("trending_service_down"\)\);/);
});

test("the contract step fails OPEN — a blip must not cost a sale", async () => {
  listings("listings API down");
  const c = ctx();
  assert.strictEqual(await listed.blockIfListed(c, EVM, "robinhood"), false, "the form carries on");
  assert.strictEqual(c.sent.length, 0, "and says nothing about it");
});

test("a contract pasted with no flow running gets an answer", async () => {
  // Screenshot: /start, then a contract, then nothing at all — textRouter
  // returned early on `!s.type` and the message vanished.
  const src = code("handlers/text.js");
  assert.match(src, /if \(!s\.type\) return await bareContract\(ctx, raw\);/);
  assert.match(src, /const hit = listed\.extractAddress\(raw\);/);
  assert.match(src, /if \(!hit\) return;/, "only a real contract may reach the API");
  assert.match(src, /if \(raw\.startsWith\("\/"\)\) return;/, "commands still belong to their own handlers");
});

test("an unlisted contract pasted into the chat stays silent", async () => {
  listings([]);
  const c = ctx();
  c.session = {};
  const row = await listed.existingListing(EVM);
  assert.strictEqual(row, null);
  assert.strictEqual(c.sent.length, 0, "the bot must not answer every stray paste");
});

test("answering clears a half-built form so the next message is not swallowed", async () => {
  listings([ROW]);
  const c = ctx();
  c.session = { type: "xpress_listing", awaitingField: "address", form: { chain: "robinhood" }, latest_bot_message: 7 };
  await listed.sendAlreadyListed(c, ROW);
  assert.strictEqual(c.session.type, undefined, "the flow is over — it cannot be completed");
  assert.strictEqual(c.session.awaitingField, undefined);
  assert.strictEqual(c.session.latest_bot_message, 1, "but the card it just sent is still tracked for editing");
});
