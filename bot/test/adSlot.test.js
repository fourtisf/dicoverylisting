// The ad slot is where the advertiser's creative lands inside the template
// frame. Two things went wrong at once on a custom "Banner Live" template: the
// creative sat right of the frame's centre with dead black space down the left,
// and the one control that fixes that was not reachable from the admin bot.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-slot-"));
process.env.BOT_DATA_DIR = dir;

const test = require("node:test");
const assert = require("node:assert");
const bannerTpl = require("../src/bannerTemplate");

const admin = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");

test("with the BUNDLED artwork the slot keeps its measured coordinates", () => {
  // Those numbers were measured against the bundled frame (left:410 top:140 at
  // 1280×640, ×2). Centring them would break the artwork that ships with the bot.
  const s = bannerTpl.getSettings("banner");
  assert.strictEqual(s.slotShape, "rect");
  assert.strictEqual(s.logoX, 836);
  assert.strictEqual(s.logoY, 296);
});

test("once the operator uploads their own template the slot starts centred", () => {
  // We no longer know where THEIR frame is, so the bundled coordinates stop
  // being a default and become a wrong guess. Centre is the only defensible
  // starting point for an unknown design.
  fss.writeFileSync(path.join(dir, "banner-media-banner.mp4"), "clip");
  delete require.cache[require.resolve("../src/bannerTemplate")];
  const fresh = require("../src/bannerTemplate");
  const s = fresh.getSettings("banner");
  assert.strictEqual(s.logoX, "center");
  assert.strictEqual(s.logoY, "center");
  assert.strictEqual(s.slotW, 1548, "only the position is a guess — the size is not touched");
});

test("an explicit admin tweak still beats the centred default", async () => {
  delete require.cache[require.resolve("../src/bannerTemplate")];
  const fresh = require("../src/bannerTemplate");
  await fresh.updateSettings("banner", { logoX: 700 });
  assert.strictEqual(fresh.getSettings("banner").logoX, 700, "the operator's own positioning wins");
});

test("the slot editor exposes centring — the control that fixes dead space", () => {
  // bxc/bxsn already handled elem "slot"; the buttons were simply never
  // rendered in the slot branch, so a 300px move meant ~15 taps of ➡ and
  // centring was impossible.
  const kb = admin.slice(admin.indexOf("function bxElemKb"));
  const slotKb = kb.slice(0, kb.indexOf("const c = BX[elem];"));
  assert.match(slotKb, /bxc:\$\{kind\}:slot/, "⬌ Centre must be reachable");
  assert.match(slotKb, /bxcy:\$\{kind\}:slot/, "⬍ Centre too — a frame is centred on both axes");
  assert.match(slotKb, /bxsn:\$\{kind\}:slot/, "and exact W×H entry, so a big resize is one message");
});

test("vertical centring is wired, not just drawn", () => {
  assert.match(admin, /\^bxcy:\$\{KL\}:\$\{EX\}\$/, "the handler exists");
  const h = admin.slice(admin.indexOf("bxcy:${KL}"), admin.indexOf("bxcy:${KL}") + 600);
  assert.match(h, /yKey: "logoY"/, "…and centres the slot on Y");
  assert.match(h, /\[c\.yKey\]: "center"/);
});

test("both axes accept `center` when typed by hand", () => {
  // The parser always allowed it; the prompt and the error only mentioned X,
  // which is how an operator concludes it cannot be done.
  assert.match(admin, /\^\(center\|-\?\\d\+\)\\s\*,\\s\*\(center\|-\?\\d\+\)\$/);
  assert.match(admin, /Atau tulis <code>center<\/code> sebagai ganti angka/, "the prompt says so");
  assert.match(admin, /Atau: <code>center,center<\/code>/, "and so does the error");
});

test("the editor screen is in Indonesian, and explains every button on it", () => {
  // The operator reads Indonesian. "1548x760 at (836, 296)" told them nothing;
  // neither did "Wider". This screen is the one they were stuck on.
  const t = admin.slice(admin.indexOf("kotak untuk gambar client") - 200);
  assert.match(t, /Ruang kosong:/, "says how much empty room is on each side");
  assert.match(t, /ruang kosong lebih banyak di/, "and which side has more");
  assert.match(t, /Kotak sudah di tengah/);
  assert.match(t, /Muat semua|Isi penuh/, "says how a differently-shaped client picture is fitted");
  assert.match(t, /Fungsi tombol/, "every button is explained on the same screen");
  assert.match(t, /perbesar atau perkecil/, "in the words the operator actually asked for");
  for (const banned of ["cover-fit", "canvas", "Narrower", "Shorter", "Wider", "Taller", "Empty space"]) {
    assert.ok(!t.slice(0, 1800).includes(banned), `"${banned}" is exactly the wording that was not understood`);
  }
});

test("the slot buttons are Indonesian nouns, not English comparatives", () => {
  const kb = admin.slice(admin.indexOf("function bxElemKb"));
  const slotKb = kb.slice(0, kb.indexOf("const c = BX[elem];"));
  const labels = [...slotKb.matchAll(/cb\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 8, `expected the slot keyboard's labels, got ${labels.length}`);
  for (const want of ["Lebar ➕", "Lebar ➖", "Tinggi ➕", "Tinggi ➖", "⬌ Ke tengah", "⬍ Ke tengah", "⌨ Atur ukuran", "⌨ Atur posisi"]) {
    assert.ok(labels.includes(want), `missing button: ${want}`);
  }
  // Only the LABELS — the comment above them quotes the old words on purpose,
  // to explain to the next reader why they were replaced.
  for (const banned of ["Wider", "Narrower", "Taller", "Shorter", "Width ➕", "Height ➖", "Type W×H", "Type X,Y", "Set size", "Set place"]) {
    assert.ok(!labels.includes(banned), `button label "${banned}" has to be translated before it can be acted on`);
  }
  // Telegram truncates a two-column row; these have to stay short.
  for (const l of labels) assert.ok(l.length <= 16, `"${l}" is ${l.length} chars — it will be cut off`);
});

test("the resize toast names the thing, not an internal variable", () => {
  // It printed `${key} ${v}px` where key holds "slotW"/"slotH" — the operator
  // was shown "slotW 1548px", a field name from the config file.
  assert.match(admin, /\$\{elem === "slotw" \? "Lebar" : "Tinggi"\} \$\{v\}px/);
  assert.ok(!admin.includes("answerCbQuery(`${key} ${v}px`)"), "the raw key must not reach a human");
});

test("one control keeps one name across both screens", () => {
  // The auto-text toggle was "Auto-text" on one screen and "Text" on another —
  // the same switch under two names reads as two different settings.
  assert.ok(!/🔤 Text: \$\{showText/.test(admin), "the old second name is gone");
  assert.match(admin, /🔤 Tulisan: \$\{showText \? "AKTIF" : "MATI"\}/);
  assert.match(admin, /🔤 Tulisan otomatis: AKTIF/, "…and the long form agrees with it");
});

test("the artwork-saved message points at a button that exists", () => {
  // It said "Open 🖱 Logo editor" — grep found exactly one occurrence of that
  // name in the whole file, because no such button was ever built.
  assert.ok(!admin.includes("🖱 Logo editor"), "a control that does not exist cannot be opened");
  assert.match(admin, /Buka 🎛 Atur tata letak/, "the real button is named instead");
});

test("the box can be resized as a whole, keeping its shape", () => {
  // "Lebar ➖" and "Tinggi ➖" could shrink a box, but only by tapping two
  // buttons a different number of times each — and the shape drifted while you
  // did it. "Make it smaller" needed to be one button.
  assert.match(admin, /\^bxscale:\$\{KL\}:\(up\|down\)\$/, "there is a whole-box scale handler");
  const h = admin.slice(admin.indexOf("bxscale:${KL}"), admin.indexOf("bxscale:${KL}") + 800);
  assert.match(h, /slotW: w, slotH: h/, "both sides move together");
  assert.match(h, /1 \/ 1\.08/, "…by the same factor, which is what keeps the shape");
  const kb = admin.slice(admin.indexOf("function bxElemKb"));
  const slotKb = kb.slice(0, kb.indexOf("const c = BX[elem];"));
  const labels = [...slotKb.matchAll(/cb\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.includes("➕ Perbesar") && labels.includes("➖ Perkecil"), "and it is the first thing on the screen");
  assert.strictEqual(labels[0], "➕ Perbesar", "top row — it is the control people look for");
});

test("scaling stays inside the canvas, in both directions", () => {
  const h = admin.slice(admin.indexOf("bxscale:${KL}"), admin.indexOf("bxscale:${KL}") + 800);
  assert.match(h, /Math\.max\(200, Math\.min\(2560,/, "width is clamped to the canvas");
  assert.match(h, /Math\.max\(120, Math\.min\(1280,/, "height too");
});
