// "@dexvraceo tambahkan username ini untuk admin agar pembayaran semuanya 0".
//
// Admins pay nothing but every flow still runs end to end, and the switch is
// `isAdminUser` — one predicate, read by the payment path, the admin bot's own
// guard, the Mass DM test send and the raid panel. A name added here is the
// only kind of fix a `git pull` carries: ADMIN_USERNAMES is otherwise env-only
// and `.env` lives on the server, which is why the ids are baked in too.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-adminfree-"));

const test = require("node:test");
const assert = require("node:assert");

const { isAdminUser, ADMIN_USERNAMES, ADMIN_IDS, normAdminUsernames } = require("../src/config/constants");
const { startPayment } = require("../src/handlers/pay");
const { TIER_MAP } = require("../src/config/packages");

// Telegram never puts an `@` on `from.username`, and it does not normalise
// case — so these are the two shapes a real update can carry.
const ctxFor = (username, id = "555001") => ({
  from: { id, username },
  chat: { id },
  session: {},
  answerCbQuery: async () => true,
  reply: async () => ({ message_id: 1 }),
});

test("@dexvraceo is an admin — the ask", () => {
  assert.ok(isAdminUser(ctxFor("dexvraceo")));
});

// ⚠️ Telegram does not lowercase a username, and a person who set theirs as
// DexvraCEO sends exactly that. Matching only the lowercase spelling would be a
// name that reads as added and charges full price.
test("⚠️ …in whatever case Telegram sends it", () => {
  for (const spelling of ["dexvraceo", "DexvraCEO", "DEXVRACEO", "DexvraCeo"]) {
    assert.ok(isAdminUser(ctxFor(spelling)), spelling);
  }
});

// ⚠️ THE BUILT-IN LIST GOES THROUGH THE SAME NORMALISER AS THE ENV ONE. An
// operator pastes "@dexvraceo" — that is how this name was given — so a source
// whose entries keep their @ would match nobody, silently, and read exactly
// like a name that was never added.
//
// ⚠️ It is DRIVEN rather than asserted about, because every entry shipped today
// is already spelled correctly: a mutant that normalises one source and not the
// other changes no stored value and survives an assertion on ADMIN_USERNAMES.
// The hostile spellings are what make the rule observable.
test("⚠️ the normaliser covers EVERY source, whatever the spelling", () => {
  assert.deepStrictEqual(normAdminUsernames(["@DexvraCEO"], ["dexvraceo"]), ["dexvraceo"], "built-in first");
  assert.deepStrictEqual(normAdminUsernames(["dexvraceo"], ["@DexvraCEO"]), ["dexvraceo"], "env second");
  assert.deepStrictEqual(normAdminUsernames(["  @Dexvraceo  "]), ["dexvraceo"], "a pasted line keeps its spaces");
  assert.deepStrictEqual(normAdminUsernames([""], ["", null, undefined]), [], "nothing blank survives");
});

test("⚠️ …and the list it produced is what isAdminUser can actually match", () => {
  assert.ok(ADMIN_USERNAMES.includes("dexvraceo"), `stored as: ${JSON.stringify(ADMIN_USERNAMES)}`);
  for (const u of ADMIN_USERNAMES) {
    assert.strictEqual(u, u.toLowerCase(), `not lowercased: ${u}`);
    assert.ok(!u.startsWith("@"), `@ not stripped: ${u}`);
    assert.ok(u, "a blank entry would make isAdminUser's uname guard the only thing between a nameless user and free");
  }
});

test("nobody else is", () => {
  assert.ok(!isAdminUser(ctxFor("dexvrace")), "a prefix is a different account");
  assert.ok(!isAdminUser(ctxFor("dexvraceo2")));
  assert.ok(!isAdminUser(ctxFor("buyer")));
  assert.ok(!isAdminUser(ctxFor(undefined)), "a user with no public username");
  assert.ok(!isAdminUser({}), "an update with no from at all");
});

// The ids are the primary route and must not have moved.
test("the built-in owner ids still resolve", () => {
  for (const id of ["1322401802", "7176469093"]) {
    assert.ok(ADMIN_IDS.includes(id));
    assert.ok(isAdminUser({ from: { id, username: "whatever" } }));
  }
});

// ⚠️ A POSITIVE, DRIVEN test, because `isAdminUser` being right and the payment
// path READING it are two different facts — the curveBuyPath scar. What the ask
// is about is the amount on the card, so that is what is measured: the order
// really arms at zero, through the real handler.
test("⚠️ …and the order this username arms really costs 0", async () => {
  const order = {
    kind: "xpress_listing",
    chain: "solana",
    native: "SOL",
    humanAmount: TIER_MAP.XPRESS.price.SOL,
    prices: TIER_MAP.XPRESS.price,
    label: "Xpress Listing — $TEST",
    payload: { listingInput: { chain: "solana", address: "So1111", sym: "TEST", name: "Test" } },
  };
  const ctx = ctxFor("dexvraceo");
  await startPayment(ctx, order);

  const pp = ctx.session.pendingPayment;
  assert.ok(pp, "an order was armed");
  assert.strictEqual(pp.adminFree, true);
  assert.strictEqual(pp.order.amountSmallest, "0", "the card takes nothing");
  // ⚠️ The PRICE is untouched — this is a waived charge, not a free package.
  // Zeroing humanAmount would make every receipt and every ops report claim the
  // package is worth nothing.
  assert.strictEqual(pp.order.humanAmount, TIER_MAP.XPRESS.price.SOL);
});

test("…and the same order from anyone else does not", async () => {
  const order = {
    kind: "xpress_listing",
    chain: "solana",
    native: "SOL",
    humanAmount: TIER_MAP.XPRESS.price.SOL,
    prices: TIER_MAP.XPRESS.price,
    label: "Xpress Listing — $TEST",
    payload: { listingInput: { chain: "solana", address: "So1112", sym: "TEST", name: "Test" } },
  };
  const ctx = ctxFor("buyer", "555002");
  await startPayment(ctx, order);

  const pp = ctx.session.pendingPayment;
  assert.strictEqual(pp.adminFree, false);
  assert.notStrictEqual(pp.order.amountSmallest, "0", "a real buyer is charged");
});
