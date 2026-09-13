// What happens when the advertiser's banner is a different shape from the box.
//
// It was cover-fitted: scaled up until the box was full, everything outside
// cropped away. For a token LOGO that is right — a square in a circle loses
// nothing anyone cares about. For an AD it is destructive: the Wide Banner
// package is sold at 1200×240 (5:1) and the frame is 1548×760 (2:1), so cover
// threw away 59% of its WIDTH. The buyer paid for a banner and roughly its
// middle third got published.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-fit-"));

const test = require("node:test");
const assert = require("node:assert");
const bannerTpl = require("../src/bannerTemplate");

let cv;
try {
  cv = require("@napi-rs/canvas");
} catch {
  cv = null;
}

// A 5:1 creative with a solid GREEN stripe on its far left and a RED stripe on
// its far right. If either colour is missing from the composite, that edge was
// cropped off — which is exactly the failure being tested.
function wideCreative() {
  const c = cv.createCanvas(1200, 240);
  const g = c.getContext("2d");
  g.fillStyle = "#101010";
  g.fillRect(0, 0, 1200, 240);
  g.fillStyle = "#00FF00";
  g.fillRect(0, 0, 60, 240);
  g.fillStyle = "#FF0000";
  g.fillRect(1140, 0, 60, 240);
  return c.toBuffer("image/png");
}

/** Does the composite contain a pixel close to this colour? */
async function hasColour(buf, [r, g, b]) {
  const img = await cv.loadImage(buf);
  const c = cv.createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - r) < 40 && Math.abs(data[i + 1] - g) < 40 && Math.abs(data[i + 2] - b) < 40) return true;
  }
  return false;
}

test("a wide client banner keeps BOTH its edges — nothing is cropped", async (t) => {
  if (!cv) return t.skip("@napi-rs/canvas not installed");
  const out = await bannerTpl.compose("banner", wideCreative(), {});
  if (!out) return t.skip("no bundled banner artwork in this checkout");
  assert.ok(await hasColour(out, [0, 255, 0]), "the LEFT edge of the client's banner was cropped away");
  assert.ok(await hasColour(out, [255, 0, 0]), "the RIGHT edge of the client's banner was cropped away");
});

test("cover is still available, and it does crop — that is what it means", async (t) => {
  if (!cv) return t.skip("@napi-rs/canvas not installed");
  await bannerTpl.updateSettings("banner", { slotFit: "cover" });
  const out = await bannerTpl.compose("banner", wideCreative(), {});
  if (!out) return t.skip("no bundled banner artwork in this checkout");
  const left = await hasColour(out, [0, 255, 0]);
  const right = await hasColour(out, [255, 0, 0]);
  assert.ok(!left && !right, "cover must fill the box by cropping — both 5:1 edges go");
  await bannerTpl.updateSettings("banner", { slotFit: "contain" });
});

test("contain is the default for an ad slot, and only for an ad slot", () => {
  const src = fss.readFileSync(require.resolve("../src/bannerTemplate.js"), "utf8");
  assert.match(src, /slotShape: "rect", slotFit: "contain"/, "the ad slot ships as contain");
  // A token logo stays cover-fitted: it is a square dropped into a circle, and
  // letterboxing it would leave bars inside the ring.
  assert.match(src, /const fit = isRect \? \(cfg\.slotFit === "cover" \? "cover" : "contain"\) : "cover";/);
});

test("the gap is filled with the picture itself, not a black bar", () => {
  // A 5:1 banner in a 2:1 box leaves 60% of the height empty. Flat black reads
  // as a broken render; a blurred blow-up of the same artwork reads as design.
  const src = fss.readFileSync(require.resolve("../src/bannerTemplate.js"), "utf8");
  const i = src.indexOf('if (fit === "contain")');
  assert.ok(i > -1);
  const block = src.slice(i, i + 500);
  assert.match(block, /ctx\.filter = "blur\(/);
  assert.match(block, /globalAlpha/);
  assert.match(block, /Math\.min\(sw \/ img\.width, sh \/ img\.height\)/, "the creative itself is contain-scaled");
});

test("the operator can switch it, and the screen says which is on", () => {
  const admin = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  assert.match(admin, /\^bxfit:\$\{KL\}\$/, "there is a toggle handler");
  assert.match(admin, /slotFit: cover \? "contain" : "cover"/, "…that flips the setting");
  assert.match(admin, /🖼 Muat semua \(utuh\)/, "the button names the state it will give you");
  assert.match(admin, /🖼 Isi penuh \(terpotong\)/);
  assert.match(admin, /Ukuran banner client boleh beda-beda — otomatis menyesuaikan/, "the screen answers the question that prompted this");
});

test("each product's box takes the shape it was SOLD at", async (t) => {
  // Standard is 600×240 (2.5:1) and Wide is 1200×240 (5:1) — two different
  // products, two different shapes, and one fixed 2:1 box could serve neither.
  // An advertiser who sent exactly what we asked for still got letterboxed.
  if (!cv) return t.skip("@napi-rs/canvas not installed");
  const exact = (w, h) => {
    const c = cv.createCanvas(w, h);
    const g = c.getContext("2d");
    g.fillStyle = "#101010";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#00FF00";
    g.fillRect(0, 0, Math.round(w * 0.04), h);
    g.fillStyle = "#FF0000";
    g.fillRect(w - Math.round(w * 0.04), 0, Math.round(w * 0.04), h);
    return c.toBuffer("image/png");
  };
  for (const [size, w, h] of [["600 × 240", 600, 240], ["1200 × 240", 1200, 240]]) {
    const out = await bannerTpl.compose("banner", exact(w, h), { slotSize: size });
    if (!out) return t.skip("no bundled banner artwork in this checkout");
    // A correct upload must reach both edges — with no blurred band, which is
    // what appears the moment the drawn box is a different shape.
    assert.ok(await hasColour(out, [0, 255, 0]), `${size}: left edge missing`);
    assert.ok(await hasColour(out, [255, 0, 0]), `${size}: right edge missing`);
  }
});

test("the shape comes from the sold size string, the site's own source of truth", () => {
  const src = fss.readFileSync(require.resolve("../src/bannerTemplate.js"), "utf8");
  assert.match(src, /function aspectOfSize/, "parsed from \"600 × 240\"");
  assert.match(src, /const soldAspect = isRect \? aspectOfSize\(slotSize\) : 0;/);
  // The operator's box stays the BOUNDING area; the sold shape is fitted inside
  // it and centred, so their positioning still means something.
  assert.match(src, /const lx = bx \+ \(bw - sw\) \/ 2;/);
  const ful = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  assert.match(ful, /const shape = \{ slotSize: rec\.size \};/, "fulfilment passes the booked size");
});

test("an unknown size falls back to the operator's box, never to a guess", () => {
  const src = fss.readFileSync(require.resolve("../src/bannerTemplate.js"), "utf8");
  const i = src.indexOf("function aspectOfSize");
  assert.match(src.slice(i, i + 400), /if \(!m\) return 0;/);
  assert.match(src.slice(i, i + 400), /w > 0 && h > 0 \? w \/ h : 0/);
});
