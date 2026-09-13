// The listing form's contract step, driven with the indexers misbehaving.
//
// The live report (2026-08-28): "bot tidak merespon untuk paket listing setelah
// di minta drop ca" — the CA prompt standing over a bot that never answered.
// The step awaited fetchMarket + fetchTokenDescription, both of which queue on
// the shared GeckoTerminal budget (group/gtPairs, PRIO_BACKGROUND) with no
// deadline: 12s per slot on the keyless 5/min split, queue cap 200 — behind a
// normal day of timer pipelines a user-prompted paste could wait MINUTES.
// Autofill is an enrichment; these tests pin that it can never hold the form.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-listform-"));
process.env.LISTING_AUTOFILL_MS = "80"; // read at require time — set before the module loads

const test = require("node:test");
const assert = require("node:assert");

const listing = require("../src/handlers/listing");
const text = require("../src/handlers/text");
const listedGuard = require("../src/helpers/listedGuard");

const MINT = "AVBN6kXdaw27ySuvMevKYzNTL8d39b7sGQFDCmsvpump";
const NEVER = () => new Promise(() => {});

function ctxWith(session, msgText) {
  const replies = [];
  return {
    replies,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    session,
    message: { text: msgText },
    reply: async (t, extra) => {
      replies.push({ text: String(t), extra });
      return { message_id: replies.length };
    },
    replyWithPhoto: async (photo, extra) => {
      replies.push({ photo, text: String((extra && extra.caption) || "") });
      return { message_id: replies.length };
    },
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
  };
}

const form = (over = {}) => ({ ...listing._test.emptyForm(), chain: "solana", ...over });
const realLookups = { ...listing._lookups };
const realBlock = listedGuard.blockIfListed;
test.beforeEach(() => {
  Object.assign(listing._lookups, realLookups);
  listedGuard.blockIfListed = async () => false; // no network in this suite
});
test.after(() => {
  Object.assign(listing._lookups, realLookups);
  listedGuard.blockIfListed = realBlock;
});

/** The handler under a hard 2s ceiling — a hang must FAIL, not stall the run. */
async function drive(ctx) {
  let timer;
  try {
    await Promise.race([
      listing.handleText(ctx),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("handleText hung — the autofill bound is gone")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("⚠️ indexers that never answer cannot hold the form — the paste is acknowledged and the flow moves on", async () => {
  listing._lookups.fetchTokenInfo = NEVER;
  listing._lookups.fetchMarket = NEVER;
  listing._lookups.fetchTokenDescription = NEVER;
  const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, MINT);
  await drive(ctx);
  // The paste is answered BEFORE the lookups: a prompted input followed by
  // seconds of nothing reads as a dead bot, and was reported as one.
  assert.match(ctx.replies[0].text, /Reading your token/i, "the immediate acknowledgement card");
  // Nothing autofilled → the form asks for the name, exactly as if the
  // indexers had answered empty.
  assert.match(ctx.replies[1].text, /Token Name/i, `flow did not continue: ${JSON.stringify(ctx.replies)}`);
  assert.strictEqual(ctx.session.awaitingField, "name");
  assert.strictEqual(ctx.session.form.address, MINT);
});

test("fast answers still autofill — the bound must cost a healthy lookup nothing", async () => {
  listing._lookups.fetchTokenInfo = async () => ({
    name: "Pump Tok", symbol: "PUMP", logoUrl: null,
    website: "https://pump.example", twitter: null, telegram: null, onCurve: true, progressPct: 40, launchpad: "pump.fun",
  });
  listing._lookups.fetchMarket = async () => null;
  listing._lookups.fetchTokenDescription = async () => "A test token.";
  const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, MINT);
  await drive(ctx);
  const f = ctx.session.form;
  assert.strictEqual(f.sym, "PUMP");
  assert.strictEqual(f.name, "Pump Tok");
  assert.strictEqual(f.website, "https://pump.example");
  assert.ok(f.bonding && f.bonding.launchpad === "pump.fun", "the bonding notice survives the bound");
  assert.strictEqual(ctx.session.awaitingField, null);
  const last = ctx.replies[ctx.replies.length - 1];
  assert.match(last.text, /PUMP/, "the review card renders the autofilled ticker");
});

test("a lookup that rejects — or throws synchronously — is a miss, never a dead form", async () => {
  listing._lookups.fetchTokenInfo = () => { throw new Error("sync boom"); };
  listing._lookups.fetchMarket = async () => { throw new Error("async boom"); };
  listing._lookups.fetchTokenDescription = async () => null;
  const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, MINT);
  await drive(ctx);
  assert.match(ctx.replies[1].text, /Token Name/i, "the flow continued past the failures");
});

test("⚠️ a flow handler that throws is ANSWERED, not swallowed into a warn", async () => {
  // textRouter's catch used to log and say nothing — the prompt card standing
  // over silence, indistinguishable from a dead bot. The refusal-off-screen
  // lesson, on text input.
  const real = listing.handleText;
  listing.handleText = async () => { throw new Error("boom"); };
  try {
    const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, "anything");
    await text.textRouter(ctx);
    assert.ok(
      ctx.replies.some((r) => /didn't go through/i.test(r.text)),
      `no visible reply on a handler error: ${JSON.stringify(ctx.replies)}`,
    );
  } finally {
    listing.handleText = real;
  }
});
