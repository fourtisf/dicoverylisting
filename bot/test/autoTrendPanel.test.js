// The Auto Trending panel showed six steppers crammed onto two rows, which
// Telegram truncated to "🕐 Mi…" and "Max 1…" — settings nobody could read, let
// alone change with confidence. And it printed the CONFIG without ever printing
// the BOARD, so the question the operator actually had ("why is Robinhood still
// empty?") had no answer anywhere on screen.
//
// These render the real panel, because the layout IS the thing that was wrong.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-atpanel-"));

const test = require("node:test");
const assert = require("node:assert");

const autoTrend = require("../src/services/autoTrend");
const admin = require("../src/admin/adminBot");

const plain = (s) => String(s).replace(/<\/?(b|i|code)>/g, "");
const rows = (kb) => kb.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text));
/** A board where every interesting state is present at once. */
const COUNTS = {
  solana: { featured: 5, eligible: 12 }, // at target
  bsc: { featured: 1, eligible: 4 }, // short, fixable
  ethereum: { featured: 1, eligible: 0 }, // short, nothing left
  base: { featured: 1, eligible: 8 },
  robinhood: { featured: 0, eligible: 0 }, // empty and unfixable
  // Tron JOINED the auto-trended set on 2026-08-23 ("chain sol bsc eth
  // robinhood base dan tron"), so the "has listings but is not auto-trended"
  // case moved to Polygon. The case itself still matters: such a chain stays
  // one tap from a Run now, and deliberately without a fraction.
  tron: { featured: 3, eligible: 5 },
  polygon: { featured: 0, eligible: 2 }, // not auto-trended, but has listings
  sui: { featured: 0, eligible: 0 }, // nothing at all
};
async function panel(counts = COUNTS, cfg = {}) {
  // fillFromMarket is stated EXPLICITLY, not inherited: it is persisted, so one
  // test turning it off used to leak into every test after it — and the symptom
  // (a panel reading "cannot be filled") looks exactly like a real regression.
  await autoTrend.set({ enabled: true, perChainMin: 5, perChainMax: 8, fillFromMarket: true, ...cfg });
  admin._test.setAtCounts(counts);
  return { text: plain(admin._test.atText()), kb: rows(admin._test.atKb()) };
}

test("no button label is long enough for Telegram to truncate", () => {
  // THE bug, measured. Telegram cuts a label to fit its share of the row, so a
  // six-button row loses the words and keeps the emoji: "🕐 Mi…".
  return panel().then(({ kb }) => {
    for (const row of kb) {
      assert.ok(row.length <= 3, `${row.length} buttons in one row: ${row.join(" | ")}`);
      for (const label of row) {
        // Three per row leaves roughly 16 chars each before Telegram elides.
        const budget = row.length === 1 ? 40 : row.length === 2 ? 22 : 16;
        assert.ok(label.length <= budget, `"${label}" is ${label.length} chars in a row of ${row.length}`);
      }
    }
  });
});

test("every stepper says what it changes, on its own row", async () => {
  const { kb } = await panel();
  const flat = kb.map((r) => r.join(" "));
  for (const setting of ["🎯 min 5/chain", "🎯 max 8/chain", "⏱ Min 3h", "⏱ Max 18h", "🔁 Every 20m", "🔁 to 120m"]) {
    const row = kb.find((r) => r.includes(setting));
    assert.ok(row, `no row for "${setting}" — labels: ${flat.join(" / ")}`);
    assert.deepStrictEqual(row, ["➖", setting, "➕"], `"${setting}" must sit between its own two steppers`);
  }
});

test("the panel shows the BOARD, not just the settings", async () => {
  // The operator's question is "is it working", and the config cannot answer it.
  const { text } = await panel();
  // The target is a RANGE rolled per chain, so every count is printed against
  // the range: "7/5–8" must not read as over target.
  assert.match(text, /📊 Board right now — target 5–8 per chain, rolled at random/);
  assert.match(text, /✅ .*Solana — 5\/5–8/, text);
  assert.match(text, /⏳ .*BSC — 1\/5–8 · 4 ready to promote/, text);
  assert.match(text, /🔴 .*Robinhood — 0\/5–8 · no listings left on this chain/, text);
});

test("a chain that cannot be filled is distinguished from one that just has not been yet", async () => {
  // Identical on screen before this: both simply absent from the board. One
  // needs patience, the other needs listings, and the operator cannot act
  // correctly without knowing which.
  //
  // With 🧲 Fill from market ON (the default) "needs listings" is no longer a
  // dead end — the next cycle lists that chain's biggest tokens — so the panel
  // must say THAT instead of asking the operator for something the bot now
  // does. With it OFF the old sentence is still the true one.
  const { text } = await panel();
  assert.match(text, /have no spare listings/);
  assert.match(text, /biggest tokens/, "the panel does not say the shortfall gets filled");

  const off = await panel(COUNTS, { fillFromMarket: false });
  assert.match(off.text, /cannot be filled — they have no spare listings/);
  assert.match(off.text, /Fill from market.*is off|list tokens there yourself/s);

  // Every configured chain short but with spare listings — nothing is blocked,
  // so the panel must promise a cycle rather than ask for more listings.
  const fixable = await panel(
    Object.fromEntries(autoTrend.get().chains.map((id) => [id, { featured: 1, eligible: 9 }])),
  );
  assert.match(fixable.text, /below target; the next cycle tops them up/);
  assert.ok(!fixable.text.includes("cannot be filled"), "nothing here is blocked");
});

test("when everything is at target it says so, instead of leaving the reader to check five lines", async () => {
  const at = Object.fromEntries(autoTrend.get().chains.map((id) => [id, { featured: 5, eligible: 3 }]));
  const { text } = await panel(at);
  assert.match(text, /Every chain is at target\. Nothing to do until a slot expires\./);
});

test("the Run now buttons lead with the chains the panel is about", async () => {
  const { kb } = await panel();
  const runs = kb.flat().filter((t) => t.startsWith("⚡"));
  const cfg = autoTrend.get();
  for (let i = 0; i < cfg.chains.length; i++) {
    assert.ok(runs[i], `missing a Run now button for ${cfg.chains[i]}`);
    assert.match(runs[i], /\d\/5–8$/, `an auto-filled chain must show its progress against the RANGE: ${runs[i]}`);
  }
});

test("chains nobody has listed on are dropped, not printed as '0/5'", async () => {
  // The list was 20 rows of "0/5" for networks with no listings at all. A Run
  // now there can only fail, and the fraction invents a target the chain has no
  // part in.
  const { kb } = await panel();
  const runs = kb.flat().filter((t) => t.startsWith("⚡"));
  assert.ok(!runs.some((t) => t.includes("Sui")), `Sui has nothing listed: ${runs.join(" | ")}`);
  // Polygon is not auto-trended but DOES have listings — still one tap away,
  // and deliberately without a fraction.
  const spare = runs.find((t) => t.includes("Polygon"));
  assert.ok(spare, `Polygon has listings and must stay reachable: ${runs.join(" | ")}`);
  assert.ok(!/\/\d/.test(spare), `a chain with no target must not show one: ${spare}`);
});

test("the board can be re-read without reopening the menu", async () => {
  // It is a snapshot taken when the panel opened; after a Run now, or after
  // waiting out a cycle, re-reading it is the whole point.
  const { kb } = await panel();
  assert.ok(kb.flat().includes("🔄 Refresh"), kb.flat().join(" | "));
  const src = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  assert.match(src, /bot\.action\("atref", async \(ctx\) => \{/);
  assert.match(src, /_atCounts = await autoTrend\.featuredByChain\(\)/);
});

test("changing the per-chain target moves every number on the panel together", async () => {
  const { text, kb } = await panel(COUNTS, { perChainMin: 6, perChainMax: 6 });
  assert.match(text, /target 6 per chain/, "a pinned range prints as one number, not '6–6'");
  assert.match(text, /Solana — 5\/6/, "at 5 it is no longer at target");
  assert.ok(kb.flat().includes("🎯 min 6/chain"));
  assert.ok(kb.flat().some((t) => t.includes("Solana 5/6")), kb.flat().join(" | "));
  await autoTrend.set({ perChainMin: 5, perChainMax: 8 });
});

test("the panel says how tokens are chosen, because that is the product claim", async () => {
  // A trending board asserts "these are moving". Filling it at random made the
  // assertion false, and the panel described it as random in so many words.
  const { text } = await panel();
  assert.match(text, /top gainers/, text);
  assert.match(text, /biggest 24h/, text);
  assert.match(text, /any package/, text, "no tier is held back — Xpress included");
  assert.match(text, /best 24h mover/, "Run now places the best one, not an arbitrary one");
  assert.ok(!/\brandom\b listed/.test(text), "the old claim must be gone");
});



test("a chain with genuinely nothing listed still reads as nothing listed", async () => {
  const { text } = await panel({
    solana: { featured: 5, eligible: 3, blocked: 0 },
    bsc: { featured: 5, eligible: 1, blocked: 0 },
    ethereum: { featured: 5, eligible: 1, blocked: 0 },
    base: { featured: 5, eligible: 1, blocked: 0 },
    robinhood: { featured: 0, eligible: 0, blocked: 0 },
  });
  assert.match(text, /🔴 .*Robinhood — 0\/5–8 · no listings left on this chain/, text);
  assert.match(text, /biggest tokens|needs more tokens listed there/, text);
  assert.ok(!text.includes("Xpress"), "nothing here is blocked by a tier rule");
});

test("the panel says whether the settings can actually deliver the policy", async () => {
  // "every trending token gets its post" is the policy, and two numbers can
  // quietly make it impossible — a daily cap below the churn, or a gap so wide
  // the day runs out. Both look exactly like a broken announcer from outside.
  const ok = await panel(COUNTS, { announce: true, perChainMin: 5, announcePerDay: 100, announceGapMin: 15 });
  assert.match(ok.text, /every one gets through/, ok.text);

  const capped = await panel(COUNTS, { announce: true, perChainMin: 5, announcePerDay: 10, announceGapMin: 15 });
  assert.match(capped.text, /⚠️.*only 10 can post/s, capped.text);
  assert.match(capped.text, /the 10\/day cap is the limit/, "it must name WHICH number is the bottleneck");
  assert.match(capped.text, /their slots expire first/, "…and what that costs");

  const slow = await panel(COUNTS, { announce: true, perChainMin: 5, announcePerDay: 200, announceGapMin: 120 });
  assert.match(slow.text, /the 120 min gap is the limit/, slow.text);
  await autoTrend.set({ announcePerDay: 100, announceGapMin: 15 });
});

test("the announce rails are reachable in a sane number of taps", async () => {
  // ±1 against a cap of 100 is 97 taps. The gap had no control at all, and it
  // is the number that actually paces the channel now.
  const { kb } = await panel(COUNTS, { announce: true });
  const flat = kb.flat();
  assert.ok(flat.some((t) => /max \d+\/day/.test(t)), flat.join(" | "));
  assert.ok(flat.some((t) => /1 per \d+m/.test(t)), "the gap needs its own row");
  const src = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  assert.match(src, /"atapd:-10"/, "the daily cap steps by 10");
  assert.match(src, /bot\.action\(\/\^atagap:\(-\?\\d\+\)\$\/, atStep\("announceGapMin"/, "and the gap stepper is wired");
});

test("the fill number reads as a SPEED, not as a cap on the board", async () => {
  // First question it was asked: "jadi maksud anda max 3 project per chain?".
  // No — the board holds `perChain`; the fill number is only how fast a gap is
  // closed. A label that has to be explained is the same defect as a status
  // line that has to be explained.
  const { text, kb } = await panel(COUNTS, { perChainMin: 5, perChainMax: 5, fillMaxPerCycle: 3 });
  assert.match(text, /per chain per cycle/, "the unit is missing, so the number reads as a total");
  assert.match(text, /a speed, not a limit on the board/);
  assert.match(text, /board still holds <?b?>?5/, "it must restate what the board actually holds");
  assert.match(text, /2 cycle\(s\)/, "it does the arithmetic instead of leaving it to the reader");
  // …and the same number on the blocked-chains line, which is where an operator
  // reads it first.
  assert.ok(!/up to 3 per chain\.|to 3 per chain<\/i>/.test(text), `the shorter form is back: ${text}`);
  const label = kb.flat().find((t) => t.includes("/chain/"));
  assert.ok(label, `the button must carry the unit too: ${kb.flat().join(" | ")}`);
  assert.ok(!/max/.test(label), `"max N/chain" is the reading that caused the question: ${label}`);
});

// ── the quality floors ───────────────────────────────────────────────────────

test("the floors are on the panel, editable, and 0 reads as OFF", async () => {
  const on = await panel(COUNTS, { minMcapUsd: 100_000, minVol24hUsd: 10_000 });
  assert.ok(on.text.includes("Quality floors"), "the floors must be explained, not only stepped");
  assert.ok(/\$100\.0K/.test(on.text) && /\$10\.0K/.test(on.text), "…with their actual numbers");
  const labels = on.kb.flat().join(" | ");
  assert.ok(/🏦 cap \$100\.0K\+/.test(labels), `no cap row: ${labels}`);
  assert.ok(/📊 vol \$10\.0K\+/.test(labels), `no volume row: ${labels}`);

  // ⚠️ 0 IS OFF AND MUST READ AS OFF. "$0" on a row labelled "min cap" says the
  // filter is set to nothing, which is the opposite of what it means.
  const off = await panel(COUNTS, { minMcapUsd: 0, minVol24hUsd: 0 });
  const offLabels = off.kb.flat().join(" | ");
  assert.ok(/🏦 cap OFF/.test(offLabels), `the off state prints a number: ${offLabels}`);
  assert.ok(!/cap \$0/.test(offLabels) && !/vol \$0/.test(offLabels), "…and never $0");
  assert.ok(off.text.includes("Quality floors: OFF"), "the body must say so too");
});

test("⚠️ the floors paragraph never promises a filler that is switched OFF", async () => {
  // One message said the gap would be filled and then, four paragraphs down,
  // that a chain with no spare listings "stays short until somebody lists
  // tokens on it". A panel contradicting itself in two places is the buy card's
  // two ideas of "whale", on the screen an operator tunes from.
  const on = await panel(COUNTS, { minMcapUsd: 100_000, minVol24hUsd: 10_000, fillFromMarket: true });
  assert.ok(/goes to 🧲 Fill from market/.test(on.text));

  const off = await panel(COUNTS, { minMcapUsd: 100_000, minVol24hUsd: 10_000, fillFromMarket: false });
  assert.ok(!/goes to 🧲 Fill from market/.test(off.text), "it promised a filler that is off");
  assert.ok(/publishes a SHORT board/.test(off.text), "…and it must say what happens instead");
});

test("the label row OPENS a typed input — a $10K floor cannot be stepped to", async () => {
  // The trigger ceiling stepped in ±$100,000 and drew "angkanya bisa di ketik
  // biar cpt". A cap floor moves in millions and a volume floor in thousands,
  // so one step size fits neither: at ±$1M a $10K volume floor is unreachable.
  const kb = admin._test.atKb();
  const data = JSON.stringify(kb);
  assert.ok(data.includes("atset:minMcapUsd"), "the cap label is still a no-op button");
  assert.ok(data.includes("atset:minVol24hUsd"), "the volume label is still a no-op button");
});
