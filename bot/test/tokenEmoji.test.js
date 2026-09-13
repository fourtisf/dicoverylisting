// tokenEmoji — logo → animated custom-emoji pipeline. Isolated data dir; no
// Telegram calls (rendering + naming only — the Bot API side needs real
// tokens and is exercised on the live admin free-test).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-emoji-"));

const test = require("node:test");
const assert = require("node:assert");
const te = require("../src/tokenEmoji");

function makeLogo(w, h) {
  const cv = require("@napi-rs/canvas");
  const c = cv.createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#22c55e";
  g.beginPath();
  g.arc(w / 2, h / 2, Math.min(w, h) / 2 - 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 40px sans-serif";
  g.fillText("D", w / 2 - 14, h / 2 + 14);
  return c.toBuffer("image/png");
}

test("pack slug + title follow Telegram's rules", () => {
  const slug = te.packSlug("$BULLCAT", "solana", "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump", "dexvraadminbot");
  assert.match(slug, /^[a-z][a-z0-9_]*_by_dexvraadminbot$/);
  assert.ok(!slug.includes("__"), "no consecutive underscores");
  // numeric-leading tickers get a letter prefix
  assert.match(te.packSlug("100x", "bsc", "0xabc", "bot"), /^t100x_/);
  assert.ok(te.packTitle("$BULLCAT").startsWith("BULLCAT by "));
  // deterministic: same token → same slug (idempotent recreate)
  assert.strictEqual(
    te.packSlug("$A", "bsc", "0xABC", "b"),
    te.packSlug("$A", "bsc", "0xabc", "b"),
  );
});

test("fallback char is a real emoji per ticker initial", () => {
  assert.strictEqual(te.pickFallbackChar("$BULLCAT"), "🅱️");
  assert.strictEqual(te.pickFallbackChar("100x"), "🔢");
  assert.strictEqual(te.pickFallbackChar(""), "💎");
});

test("static webp render: 100×100, under the 64KB cap", async () => {
  const buf = await te.logoToStaticWebp(makeLogo(512, 512));
  assert.ok(buf.length > 0 && buf.length <= 64 * 1024, `size ${buf.length}`);
  // RIFF....WEBP magic
  assert.strictEqual(buf.slice(0, 4).toString(), "RIFF");
  assert.strictEqual(buf.slice(8, 12).toString(), "WEBP");
});

test("animated webm render: VP9 loop under the 64KB custom-emoji cap", async (t) => {
  let buf;
  try {
    buf = await te.logoToAnimatedWebm(makeLogo(512, 512));
  } catch (e) {
    // ffmpeg dep genuinely missing in some sandboxes — skip rather than lie
    if (/ffmpeg|canvas/i.test(e.message)) return t.skip(`toolchain unavailable: ${e.message}`);
    throw e;
  }
  assert.ok(buf.length > 0 && buf.length <= 64 * 1024, `size ${buf.length}`);
  // EBML magic (webm/matroska container)
  assert.strictEqual(buf.readUInt32BE(0), 0x1a45dfa3);
});

test("emojiTag: falls back to the plain char without a stored id", () => {
  // It used to return "" — which left a visible gap in the post header, right
  // after the tier badge, and made the listing look half-rendered. The plain
  // char is what a non-premium viewer sees for a token that DOES have a pack,
  // so the header reads the same either way.
  const tag = te.emojiTag("solana", "NoSuchAddr", "$X");
  assert.ok(tag.trim().length, "the slot is filled");
  assert.ok(!tag.includes("emoji/"), "…but it is not premium markup — there is no pack");
});

// Every path that publishes a listing card has to create the pack FIRST —
// emojiTag() reads the store synchronously, so a card rendered before the pack
// exists shows the plain fallback char where the token's logo belongs. The paid
// listing path always did this; force-post and auto-listing did not, which is
// why their posts came out with a generic emoji.
test("force post and auto-listing create the token emoji before rendering", () => {
  const fp = fss.readFileSync(require.resolve("../src/admin/forcePost.js"), "utf8");
  assert.match(fp, /ensureEmoji\(coin, row\)/, "force post must ensure the pack");
  // …and it has to happen BEFORE the card is built, not after.
  for (const kind of ["listing", "trending"]) {
    const i = fp.indexOf("await ensureEmoji");
    const j = fp.indexOf(`mediaFor("${kind}"`);
    assert.ok(i > -1 && j > -1 && i < j, `${kind}: ensure must come first`);
  }
  const alSrc = fss.readFileSync(require.resolve("../src/services/autoLister.js"), "utf8");
  assert.match(alSrc, /ensureFromUrl/, "auto-listing must ensure the pack too");
});

test("ensureFromUrl: no logo, no pack, no throw", async () => {
  await assert.doesNotReject(async () => {
    assert.strictEqual(await te.ensureFromUrl({ chain: "solana", address: "X", symbol: "$X" }, null), null);
    assert.strictEqual(await te.ensureFromUrl({ chain: null, address: null }, "https://x/y.png"), null);
  });
});
