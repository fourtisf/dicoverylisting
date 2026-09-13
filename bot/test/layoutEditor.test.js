// The banner layout editor: size steps, and the token name's own position.
//
// The name used to be `nomove` — it is DRAWN under the ticker at nameOffsetY, so
// there was no coordinate to move. It has nameX/nameY now, both null until the
// operator moves it, which is what keeps every layout tuned before those keys
// existed rendering exactly as it did.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bx-"));
process.env.BANNER_BUNDLED_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bx-art-"));

const test = require("node:test");
const assert = require("node:assert");
const bt = require("../src/bannerTemplate");

const admin = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");

// ── Where the name actually lands ────────────────────────────────────────────
// Measured off the real overlay rather than asserted against the config: the
// question is where the pixels go, and the config is only one input to that.
// nameColor is set to a colour nothing else on the canvas uses, so a hit can
// only be the name — the default #B8CCC8 is close enough to the ticker's
// shadowed mint edge to make a looser scan lie.
const PROBE = "#FF00FF";
const DATA = { symbol: "SAMPLE", name: "Sample Token", chain: "SOLANA", price: "$0.0042", mcap: "$1.2M" };

function squarePng() {
  const cv = require("@napi-rs/canvas");
  const c = cv.createCanvas(64, 64);
  c.getContext("2d").fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
}

async function nameBox() {
  const cv = require("@napi-rs/canvas");
  const buf = await bt.compose("listing", squarePng(), DATA, { transparent: true });
  if (!buf) return null;
  const img = await cv.loadImage(buf);
  const c = cv.createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (d[i + 3] > 230 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

test("the name ships with NO position of its own, and follows the ticker", async () => {
  // A default coordinate here would have teleported every already-tuned name to
  // one spot the moment this shipped. null means "wherever the ticker is".
  const s = bt.getSettings("listing");
  assert.strictEqual(s.nameX, null);
  assert.strictEqual(s.nameY, null);

  await bt.updateSettings("listing", { nameColor: PROBE, tickerX: 210, tickerY: 618, nameOffsetY: 96 });
  const at618 = await nameBox();
  assert.ok(at618, "the name is drawn");
  assert.ok(Math.abs(at618.cy - (618 + 96)) < 25, `sits ~96px under the ticker, got cy=${at618.cy}`);

  await bt.updateSettings("listing", { tickerY: 900 });
  const at900 = await nameBox();
  assert.ok(Math.abs(at900.cy - at618.cy - 282) < 3, "moving the TICKER moved the name with it");
  assert.strictEqual(at900.x, at618.x, "and left it on the ticker's X");
});

test("moving the name pins it, and the ticker stops dragging it around", async () => {
  await bt.updateSettings("listing", { nameColor: PROBE, tickerX: 210, tickerY: 900, nameX: 1400, nameY: 300 });
  const pinned = await nameBox();
  assert.ok(Math.abs(pinned.x - 1400) < 8, `starts at its own X, got ${pinned.x}`);
  assert.ok(Math.abs(pinned.cy - 300) < 25, `sits at its own Y, got cy=${pinned.cy}`);

  await bt.updateSettings("listing", { tickerY: 200 });
  const after = await nameBox();
  assert.deepStrictEqual([after.x, after.cy], [pinned.x, pinned.cy], "the ticker no longer drags it");
});

test("0 is a real coordinate, not 'unset'", async () => {
  // The one position an operator cannot express if `!v` is used as the test for
  // "nothing stored" — and the top/left edge is exactly where someone tuning a
  // header wants it.
  await bt.updateSettings("listing", { nameColor: PROBE, nameX: 0, nameY: 0 });
  const box = await nameBox();
  assert.ok(box, "still drawn");
  // The first INKED pixel, not the text origin — a glyph carries a few px of
  // left side bearing. What matters is that it is at the edge and not at the
  // ticker's x=210, which is where "0 means unset" would have put it.
  assert.ok(box.x < 10, `hard against the left edge, got x=${box.x}`);
  assert.ok(box.y < 5, `and against the top, got y=${box.y}`);
});

test("the name centres on its own, independently of the ticker", async () => {
  await bt.updateSettings("listing", { nameColor: PROBE, tickerX: 210, nameX: "center", nameY: 640 });
  const box = await nameBox();
  assert.ok(Math.abs(box.cx - 1280) < 4, `centred on the 2560px canvas, got cx=${box.cx}`);
});

test("clearing both keys hands the name back to the ticker", async () => {
  // The way out of a pin that is not "reset the whole kind and lose every other
  // tweak" — which was the only undo before 🔗 Ikut Ticker lagi.
  await bt.updateSettings("listing", { nameColor: PROBE, tickerX: 210, tickerY: 900, nameX: 1400, nameY: 300 });
  const pinned = await nameBox();
  await bt.updateSettings("listing", { nameX: null, nameY: null });
  const freed = await nameBox();
  assert.notStrictEqual(freed.x, pinned.x);
  assert.ok(Math.abs(freed.cy - (900 + 96)) < 25, "back under the ticker");
});

test("a long name is measured as it is DRAWN, so centring is not off by the cut", async () => {
  // compose() slices the name to 32 chars but used to measure the whole string,
  // which pushed a long centred name left by exactly the width of what was cut.
  await bt.updateSettings("listing", { nameColor: PROBE, nameX: "center", nameY: 640 });
  const short = await nameBox();
  const cv = require("@napi-rs/canvas");
  const long = { ...DATA, name: "Sample Token" + "x".repeat(120) };
  const buf = await bt.compose("listing", squarePng(), long, { transparent: true });
  const img = await cv.loadImage(buf);
  const c = cv.createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  let minX = Infinity;
  let maxX = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (d[i + 3] > 230 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  assert.ok(Math.abs((minX + maxX) / 2 - 1280) < 6, `a 132-char name still centres, got cx=${(minX + maxX) / 2}`);
  assert.ok(short, "and the short one did too");
});

// ── The editor's buttons ─────────────────────────────────────────────────────

test("every element offers the same three size steps", () => {
  assert.match(admin, /const BX_SIZE_STEPS = \[5, 10, 20\]/, "5 / 10 / 20 px");
  const kb = admin.slice(admin.indexOf("function bxElemKb"));
  const generic = kb.slice(kb.indexOf("const c = BX[elem];"));
  assert.match(generic, /BX_SIZE_STEPS\.map\(\(n\) => cb\(`➖ \$\{n\}px`/, "a shrink row");
  assert.match(generic, /BX_SIZE_STEPS\.map\(\(n\) => cb\(`➕ \$\{n\}px`/, "and a grow row");
  // The handler clamps per element, so one step table is safe for a 60–1600px
  // logo and a 12–140px font alike.
  assert.match(admin, /bxsd:\$\{KL\}:\(logo\|ticker\|name\|meta\|badge\|pct\|price\|slotw\|sloth\):\(-\?\\\\d\+\)/, "and any delta reaches the handler");
});

test("the arrows offer the same three steps, in all four directions", () => {
  assert.match(admin, /const BX_MOVE_STEPS = \[5, 10, 20\]/, "5 / 10 / 20 px");
  const fn = admin.slice(admin.indexOf("function bxArrowRows"), admin.indexOf("function bxElemText"));
  for (const [arrow, delta] of [
    ["⬅", "\\$\\{-n\\}:0"],
    ["⬆", "0:\\$\\{-n\\}"],
    ["⬇", "0:\\$\\{n\\}"],
    ["➡", "\\$\\{n\\}:0"],
  ]) {
    assert.match(fn, new RegExp(`cb\\(\`${arrow} \\$\\{n\\}px\`, \`bxmd:\\$\\{kind\\}:\\$\\{elem\\}:${delta}\``), `${arrow} carries the step`);
  }
  // Both screens use it — the ad slot was the one place still on a lone row.
  assert.match(admin, /\.\.\.bxArrowRows\(kind, "slot"\)/, "the ad slot too");
  assert.match(admin, /rows\.push\(\.\.\.bxArrowRows\(kind, elem\)\)/, "and every other element");
});

test("no dead step constants are left lying around", () => {
  // BX_MOVE_COARSE/BX_MOVE_FINE were declared and never read — they looked like
  // the live tuning knobs while the arrows actually used a third constant. Same
  // trap as the BX `sf` field, which sat unread through 34 call sites.
  for (const name of ["BX_STEP", "BX_MOVE_COARSE", "BX_MOVE_FINE"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(admin), `${name} is gone, not just unused`);
  }
});

test("the name element can be moved, centred and typed — not just resized", () => {
  const bx = admin.slice(admin.indexOf("const BX = {"), admin.indexOf("function bxPos"));
  const line = bx.split("\n").find((l) => l.trim().startsWith("name:"));
  assert.ok(line, "the name element still exists");
  assert.match(line, /xKey: "nameX"/, "it has an X now");
  assert.match(line, /yKey: "nameY"/, "and a Y");
  assert.match(line, /follows: "ticker"/, "and knows where 'here' is before the first nudge");
  assert.ok(!/nomove/.test(line), "and is no longer pinned in place");
});

test("an arrow tap starts from where the element IS, not from a default constant", () => {
  // Reading the raw null instead and btNum(null, 1070) hands back a constant —
  // which is how one nudge teleports the name across the banner.
  const h = admin.slice(admin.indexOf("bxmd:${KL}"), admin.indexOf("bxmd:${KL}") + 900);
  assert.match(h, /const p = bxPos\(s, elem\)/);
  assert.match(h, /btNum\(p\.x, 1070\)/);
  assert.match(h, /btNum\(p\.y, 430\)/);
  assert.ok(!/btNum\(s\[c\.xKey\]/.test(h), "never straight off the stored key");
});

test("there is a way back from a pin that does not reset the whole kind", () => {
  assert.match(admin, /bxfollow:\$\{kind\}:\$\{elem\}/, "the button is rendered");
  assert.match(admin, /\^bxfollow:\$\{KL\}:\$\{EX\}\$/, "and wired");
  const h = admin.slice(admin.indexOf("^bxfollow:"), admin.indexOf("^bxfollow:") + 700);
  assert.match(h, /\[c\.xKey\]: null, \[c\.yKey\]: null/, "clearing BOTH axes, so it fully follows again");
});

test("resizing the logo by an ODD step is an exact round trip", () => {
  // Math.round on the sum sent ➕5 and ➖5 to different places, so pressing one
  // then the other left the logo a pixel off.
  assert.match(admin, /const dx = Math\.trunc\(\(Number\(s\.logoSize\) - size\) \/ 2\)/);
  // The arithmetic itself, in both directions, from a range of starting sizes.
  // Odd sizes included: they are what an odd step produces, and they are where
  // rounding a half-delta went wrong.
  const clamp = (v) => Math.max(60, Math.min(1600, v));
  const grow = (size, x, step) => {
    const next = clamp(size + step);
    return [next, x + Math.trunc((size - next) / 2)];
  };
  for (const start of [420, 421, 430, 63, 1575]) {
    for (const step of [5, 10, 20]) {
      const [grown, x1] = grow(start, 1890, step);
      const [shrunk, x2] = grow(grown, x1, -step);
      assert.strictEqual(shrunk, start, `size returns: ${start} +${step} -${step}`);
      assert.strictEqual(x2, 1890, `and so does the position: ${start} +${step} -${step}`);
    }
  }
  // At the ceiling the SIZE cannot round-trip — growing 1599 by 5 lands on 1600,
  // so shrinking by 5 lands on 1595. That is the clamp doing its job, and the
  // position still tracks whatever the size actually did.
  const [atMax, xMax] = grow(1599, 1890, 5);
  assert.strictEqual(atMax, 1600, "grow stops at smax");
  assert.strictEqual(xMax, 1890, "a +1px grow moves the corner by 0px, not by a rounded 1px");
});
