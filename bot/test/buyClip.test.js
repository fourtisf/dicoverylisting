// The admin-uploaded GIF/video for buy alerts (@dexvraadminbot → 🎨 Gambar
// Banner Channel → 🟢 Buy Bot). One clip, every group.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-clip-"));
process.env.BOT_DATA_DIR = dir;

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const bannerTpl = require("../src/bannerTemplate");
const adminBot = require("../src/admin/adminBot");

const kindPath = (kind, ext) => path.join(dir, `banner-media-${kind}.${ext}`);
const clipPath = (ext) => kindPath("buy", ext);
const writeKind = (kind, ext) => fss.writeFileSync(kindPath(kind, ext), "GIF89a-not-really");
const writeClip = (ext) => writeKind("buy", ext);
const clearClips = () => {
  for (const kind of ["buy", "whale", "default"]) {
    for (const ext of ["gif", "mp4", "webm", "mov", "jpg", "png"]) {
      try {
        fss.unlinkSync(kindPath(kind, ext));
      } catch {
        /* not there */
      }
    }
  }
};

test.beforeEach(clearClips);
test.after(clearClips);

test("with no clip uploaded, the alert is a plain text message", async () => {
  const calls = [];
  const tg = {
    sendMessage: async (c, t, e) => calls.push(["text", c, t, e]),
    sendAnimation: async () => calls.push(["anim"]),
    sendVideo: async () => calls.push(["video"]),
  };
  await mon.sendAlert(tg, "-100", "buy!", { entities: [] });
  assert.strictEqual(calls[0][0], "text");
});

test("a GIF is sent as an ANIMATION with the alert as its caption", async () => {
  writeClip("gif");
  const calls = [];
  const tg = {
    sendMessage: async () => calls.push(["text"]),
    sendAnimation: async (c, media, extra) => calls.push(["anim", c, media, extra]),
    sendVideo: async () => calls.push(["video"]),
  };
  const entities = [{ type: "bold", offset: 0, length: 3 }];
  await mon.sendAlert(tg, "-100", "buy!", { entities, disable_web_page_preview: true });
  const [kind, chat, media, extra] = calls[0];
  assert.strictEqual(kind, "anim");
  assert.strictEqual(chat, "-100");
  assert.strictEqual(media.source, clipPath("gif"));
  assert.strictEqual(extra.caption, "buy!");
  // caption_entities, NOT entities — a caption carries its formatting under a
  // different key, and sending the wrong one drops every link silently.
  assert.deepStrictEqual(extra.caption_entities, entities);
  assert.strictEqual(extra.entities, undefined);
});

test("a self-handled clip fallback stays OUT of the ops channel", async () => {
  // The alert still goes out (as text), the preview screen reports refused
  // clips where the operator edits the card, and pm2 logs keep the line — the
  // ops channel is for things somebody must act on, and this is not one.
  const log = require("../src/helpers/logger");
  const channel = [];
  log._resetDedupe();
  log.attach({ telegram: { sendMessage: async (_c, text) => channel.push(text) } }, "@logs");
  try {
    writeClip("gif");
    const tg = {
      sendMessage: async () => ({ message_id: 1 }),
      sendAnimation: async () => {
        throw new Error("400: wrong file identifier");
      },
      sendVideo: async () => {},
    };
    await mon.sendAlert(tg, "-100", "buy!", {});
    assert.deepStrictEqual(channel, [], "nothing forwarded for a handled fallback");
  } finally {
    log.attach(null, "", "");
  }
});

test("a 429 on the clip BUBBLES — one flood event, one warning, the clip kept for the retry", async () => {
  // The chat is flooded, not the clip rejected: the text fallback would hit
  // the same wall, warning the ops channel twice for one event and delivering
  // a clipless alert where holding off keeps the buy for a retry WITH its
  // artwork. deliver()'s flood handler owns this error.
  writeClip("gif");
  const calls = [];
  const tg = {
    sendMessage: async () => calls.push(["text"]),
    sendAnimation: async () => {
      const e = new Error("429: Too Many Requests: retry after 99");
      e.parameters = { retry_after: 99 };
      throw e;
    },
    sendVideo: async () => calls.push(["video"]),
  };
  await assert.rejects(() => mon.sendAlert(tg, "-100", "buy!", {}), /retry after 99/);
  assert.deepStrictEqual(calls, [], "no text fallback during a flood wait");
});

test("an MP4 is sent as a VIDEO", async () => {
  writeClip("mp4");
  const calls = [];
  const tg = {
    sendMessage: async () => calls.push(["text"]),
    sendAnimation: async () => calls.push(["anim"]),
    sendVideo: async (c, media) => calls.push(["video", c, media]),
  };
  await mon.sendAlert(tg, "-100", "buy!", {});
  assert.strictEqual(calls[0][0], "video");
});

test("a still photo is sent as a PHOTO", async () => {
  // The media slot took clips only, so an operator with house artwork had to
  // animate it before the buy bot would carry it at all.
  writeClip("jpg");
  const calls = [];
  const tg = {
    sendMessage: async () => calls.push(["text"]),
    sendAnimation: async () => calls.push(["anim"]),
    sendVideo: async () => calls.push(["video"]),
    sendPhoto: async (c, media, extra) => calls.push(["photo", c, media, extra]),
  };
  await mon.sendAlert(tg, "-100", "buy!", { entities: [{ type: "bold", offset: 0, length: 3 }] });
  assert.strictEqual(calls[0][0], "photo");
  // Same caption rule as a clip: a photo's formatting rides on caption_entities.
  assert.ok(calls[0][3].caption_entities, "the alert's formatting survives");
  assert.strictEqual(calls[0][3].entities, undefined);
});

test("only the group-alert slots may take a still photo", () => {
  // Everywhere else the still image is the ⬆ Upload artwork slot, which gets
  // DRAWN ON. A photo accepted into the media slot there would silently replace
  // a composited banner with a flat one.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  const set = src.match(/const BT_PHOTO_KINDS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(set, "the photo-capable kinds are still declared as a set");
  const kinds = set[1].match(/"([a-z]+)"/g).map((s) => s.replace(/"/g, ""));
  assert.deepStrictEqual(kinds.sort(), ["buy", "default", "whale"]);
});

test("an uploaded photo is mirrored, so a container replace does not eat it", () => {
  // Every media extension has to be on the blob regex. One that is missing is
  // an upload the operator silently loses on the next deploy.
  const mirror = fss.readFileSync(path.join(__dirname, "..", "src", "db", "mediaMirror.js"), "utf8");
  const re = mirror.match(/const BLOB_RE = (\/.+\/i);/);
  assert.ok(re, "the blob regex still exists");
  // eslint-disable-next-line no-eval -- the file's own literal, read from disk
  const rx = eval(re[1]);
  const bannerTemplate = fss.readFileSync(path.join(__dirname, "..", "src", "bannerTemplate.js"), "utf8");
  const exts = bannerTemplate.match(/const MEDIA_EXT = \{([^}]+)\}/)[1].match(/(\w+):/g).map((s) => s.slice(0, -1));
  for (const ext of exts) assert.ok(rx.test(`banner-media-buy.${ext}`), `.${ext} uploads are mirrored`);
});

test("a clip Telegram REFUSES costs the artwork, never the alert", async () => {
  writeClip("gif");
  const calls = [];
  const tg = {
    sendMessage: async (c, t) => {
      calls.push(["text", t]);
      return { message_id: 1 };
    },
    sendAnimation: async () => {
      throw new Error("400: Bad Request: wrong file identifier");
    },
    sendVideo: async () => {},
  };
  const sent = await mon.sendAlert(tg, "-100", "buy!", {});
  assert.strictEqual(calls[0][0], "text", "it falls back to the text card");
  assert.deepStrictEqual(sent, { message_id: 1 });
});

test("swapping the clip takes effect on the very next alert", () => {
  // It is resolved per send rather than cached: editing it at runtime is the
  // entire point of the admin menu.
  assert.strictEqual(mon.buyClip(), null);
  writeClip("gif");
  assert.strictEqual(mon.buyClip().type, "animation");
  clearClips();
  assert.strictEqual(mon.buyClip(), null);
});

test("the buy clip uses the same per-kind storage as every other banner clip", async () => {
  // Which is what gets it into the Mongo media mirror (BLOB_RE covers
  // banner-media-*) and out of a container replace alive.
  await bannerTpl.saveMedia("buy", Buffer.from("x"), "gif");
  assert.ok(bannerTpl.mediaOverride("buy"));
  await bannerTpl.removeMedia("buy");
  assert.strictEqual(bannerTpl.mediaOverride("buy"), null);
});

test("the admin menu exposes Buy Bot as a media-capable kind", () => {
  // The upload/remove/preview handlers are all gated on one regex; a kind
  // missing from it renders a button that silently does nothing.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  const km = src.match(/const KM = "\(([^)]+)\)"/);
  assert.ok(km, "the media-kind regex still exists");
  for (const kind of ["buy", "whale", "default"]) {
    assert.ok(km[1].split("|").includes(kind), `${kind} is media-capable`);
    assert.match(src, new RegExp(`btk:${kind}`), `and ${kind} is reachable from the artwork menu`);
  }
  assert.ok(typeof adminBot === "object");
});

// ── The ⭐ default slot ───────────────────────────────────────────────────────

test("an empty slot falls back to the shared default clip", () => {
  // One upload, artwork on every group alert — the point of the slot.
  writeKind("default", "gif");
  assert.strictEqual(mon.buyClip("buy").source, kindPath("default", "gif"));
  assert.strictEqual(mon.buyClip("whale").source, kindPath("default", "gif"));
});

test("a kind's OWN clip always beats the default", () => {
  writeKind("default", "gif");
  writeKind("whale", "gif");
  assert.strictEqual(mon.buyClip("whale").source, kindPath("whale", "gif"), "whale keeps its own look");
  assert.strictEqual(mon.buyClip("buy").source, kindPath("default", "gif"), "buy, undressed, takes the house clip");
});

test("buy and whale still never borrow from EACH OTHER", () => {
  // The two slots exist so a whale LOOKS different scrolling past. Only the
  // explicit ⭐ default is shared; cross-borrowing would give both alerts
  // identical artwork with only the wording changed.
  writeKind("buy", "gif");
  assert.strictEqual(mon.buyClip("whale"), null, "no whale clip and no default → text, not the buy clip");
  writeKind("whale", "mp4");
  assert.strictEqual(mon.buyClip("buy").source, kindPath("buy", "gif"), "and buy does not borrow the whale clip either");
});

test("with nothing uploaded anywhere, nothing changes — the alert is still text", () => {
  assert.strictEqual(mon.buyClip("buy"), null);
  assert.strictEqual(mon.buyClip("whale"), null);
  assert.strictEqual(mon.buyClip(mon.DEFAULT_CLIP_KIND), null);
});

test("asking for the default kind directly does not look itself up twice", () => {
  // Cheap to get wrong, and the wrong version is an infinite-ish double stat()
  // on the hot path for every alert sent with no clip at all.
  const bt = require("../src/bannerTemplate");
  const real = bt.mediaOverride;
  const asked = [];
  try {
    bt.mediaOverride = (k) => {
      asked.push(k);
      return null;
    };
    assert.strictEqual(mon.buyClip("default"), null);
    assert.deepStrictEqual(asked, ["default"]);
  } finally {
    bt.mediaOverride = real;
  }
});

test("an uploaded .mp4 is sent as an ANIMATION, not as a video player", async () => {
  // MEDIA_EXT maps mp4/webm/mov → "video", and sendVideo renders a PLAYER: a
  // play button the viewer has to tap, no autoplay, no loop. A buy alert's
  // artwork is a decorative loop nobody wants to press play on — which is
  // exactly what the group reported. The channel posts already normalise their
  // clips; this path did not.
  const mon = require("../src/group/buyMonitor");
  const bt = require("../src/bannerTemplate");
  const realClip = bt.mediaOverride;
  const realInline = bt.toInlineClip;
  const calls = [];
  try {
    bt.mediaOverride = () => ({ type: "video", source: "/tmp/whatever.mp4" });
    // Stand in for the ffmpeg step: the point under test is that sendAlert ASKS
    // for the normalised clip and dispatches on what it gets back.
    bt.toInlineClip = async () => ({ type: "animation", source: "/tmp/whatever.mp4" });
    const tg = {
      sendAnimation: async (...a) => { calls.push(["animation", ...a]); return { message_id: 1 }; },
      sendVideo: async (...a) => { calls.push(["video", ...a]); return { message_id: 1 }; },
      sendPhoto: async () => ({ message_id: 1 }),
      sendMessage: async () => ({ message_id: 1 }),
    };
    await mon.sendAlert(tg, -1, "hi", {}, "buy");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], "animation", "sendVideo means a play button and no loop");
  } finally {
    bt.mediaOverride = realClip;
    bt.toInlineClip = realInline;
  }
});

test("a clip that cannot be normalised still posts the alert", () => {
  // Artwork is never worth an alert. ffmpeg missing, or a file it cannot read,
  // must cost the loop and nothing else.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  const fn = src.slice(src.indexOf("async function sendAlert"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /toInlineClip/, "the clip is normalised");
  assert.match(body, /catch \(e\)/, "and a failure is swallowed, not propagated");
  assert.match(body, /\|\| clip/, "falling back to the clip as uploaded");
});
