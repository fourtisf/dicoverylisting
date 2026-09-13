// The built-in premium (custom) emoji registry: id hygiene, markup round-trip
// through premium.parse(), and the plain → premium promotion rules.
const test = require("node:test");
const assert = require("node:assert");

const pe = require("../src/config/premiumEmoji");
const premium = require("../src/premium");

test("registry: every id is a plausible Telegram document id", () => {
  const ids = [
    ...Object.values(pe.RANK_IDS).filter(Boolean),
    ...Object.values(pe.CHAIN_EMOJI).map((c) => c.id),
  ];
  assert.ok(ids.length >= 16, "the registry actually ships ids");
  for (const id of ids) {
    assert.match(id, /^\d{15,20}$/, `${id} looks like a custom-emoji document id`);
    assert.doesNotThrow(() => BigInt(id), `${id} survives the BigInt() the GramJS entity needs`);
  }
});

test("registry: ranks 1–9 have ids, 10 degrades to plain unicode", () => {
  for (let i = 1; i <= 9; i++) assert.ok(pe.isPremium(pe.rankDefault(i)), `rank ${i} premium`);
  assert.strictEqual(pe.rankDefault(10), "🔟", "no guessed id — a bad id kills the whole message");
  assert.strictEqual(pe.rankDefault(0), "");
  assert.strictEqual(pe.rankDefault(11), "");
});

test("registry: a chain without a verified id returns null (caller keeps its default)", () => {
  assert.ok(pe.isPremium(pe.chainDefault("bsc")));
  assert.strictEqual(pe.chainDefault("robinhood"), null);
  assert.strictEqual(pe.chainDefault("nope"), null);
});

test("markup helpers: isPremium / idOf / charOf", () => {
  const frag = pe.markup("🔷", "5384367256501238350");
  assert.strictEqual(frag, "[🔷](emoji/5384367256501238350)");
  assert.strictEqual(pe.isPremium(frag), true);
  assert.strictEqual(pe.idOf(frag), "5384367256501238350");
  assert.strictEqual(pe.charOf(frag), "🔷");
  // A plain char is its own fallback and carries no id.
  assert.strictEqual(pe.isPremium("🔷"), false);
  assert.strictEqual(pe.idOf("🔷"), null);
  assert.strictEqual(pe.charOf("🔷"), "🔷");
  assert.strictEqual(pe.markup("🔟", null), "🔟", "no id → the bare char");
});

test("promote: plain → premium twin, markup untouched, unknown left alone", () => {
  assert.strictEqual(pe.promote("3️⃣"), pe.markup("3️⃣", pe.RANK_IDS[3]));
  assert.strictEqual(pe.promote("🔶"), pe.markup("🔶", pe.CHAIN_EMOJI.bsc.id));
  const explicit = "[🥇](emoji/5440539497383087970)";
  assert.strictEqual(pe.promote(explicit), explicit, "an operator's own id always wins");
  assert.strictEqual(pe.promote("🦄"), "🦄", "no known id → unchanged");
  assert.strictEqual(pe.promote(""), "");
  assert.strictEqual(pe.promote(null), "");
});

test("promoteChain: brand aliases resolve per chain only", () => {
  assert.strictEqual(pe.promoteChain("solana", "🟣"), pe.markup("🟣", pe.CHAIN_EMOJI.solana.id));
  assert.strictEqual(pe.promoteChain("bsc", "🟡"), pe.markup("🟡", pe.CHAIN_EMOJI.bsc.id));
  // The same char in another chain's context must NOT borrow that logo.
  assert.strictEqual(pe.promoteChain("base", "🟣"), "🟣");
  // A canonical char still promotes anywhere (identical artwork).
  assert.strictEqual(pe.promoteChain("robinhood", "🔷"), pe.markup("🔷", pe.CHAIN_EMOJI.ethereum.id));
});

test("every default parses into exactly one custom_emoji entity over its char", () => {
  const frags = [
    ...Array.from({ length: 9 }, (_, i) => pe.rankDefault(i + 1)),
    ...Object.keys(pe.CHAIN_EMOJI).map((c) => pe.chainDefault(c)),
  ];
  for (const frag of frags) {
    const { text, entities } = premium.parse(frag);
    const ce = entities.filter((e) => e.type === "custom_emoji");
    assert.strictEqual(ce.length, 1, `${frag} → one custom_emoji entity`);
    assert.strictEqual(ce[0].offset, 0);
    // Telegram counts UTF-16 code units and the entity must cover the whole
    // fallback emoji (1️⃣ is 3 units, 🧂 is 2) — a short length is rejected.
    assert.strictEqual(ce[0].length, text.length, `${frag} entity covers the fallback char`);
    assert.ok(!text.includes("emoji/"), "no raw markup survives into the sent text");
  }
});
