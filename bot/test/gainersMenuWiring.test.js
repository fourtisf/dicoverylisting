// Handler ORDER inside @dexvraadminbot, driven through real Telegraf updates.
//
// This exists because of a specific, silent failure mode. adminBot's generic
// `bot.on("text")` / `bot.on(["photo", …])` handlers do NOT call next(), so
// anything registered after them never sees a message — a Top-Gainers input
// registered too late would simply do nothing. The mirror image is just as bad:
// gainersMenu's handlers must pass through everything they are not waiting for,
// or editing a template (the admin bot's whole original purpose) stops working.
//
// Nothing here touches the network: telegram.callApi is stubbed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-wiring-"));
process.env.BOT_DATA_DIR = DIR;
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_WIRING";

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4242, type: "private" };

// The stub goes on Telegram.prototype, NOT on bot.telegram: this Telegraf version
// hands each update its own Telegram clone, so ctx.telegram !== bot.telegram and
// an instance stub is silently bypassed — every call then goes to the real API.
const REAL_CALL_API = Telegram.prototype.callApi;

/** A built admin bot whose every API call is recorded instead of sent. */
function harness() {
  const bot = adminBot.build();
  // Telegraf resolves getMe at launch(); driving handleUpdate() by hand means we
  // have to supply it, or command matching throws before any handler runs.
  bot.botInfo = {
    id: 777,
    is_bot: true,
    first_name: "Dexvra Admin",
    username: "dexvraadminbot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  // adminBot installs a bot.catch that logs and swallows. That is right in
  // production and useless in a test — a handler error would show up here as
  // "nothing was sent". Re-throw instead.
  bot.catch((e) => {
    throw e;
  });
  const calls = [];
  let mid = 100;
  Telegram.prototype.callApi = async function stubbedCallApi(method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage" || method === "sendPhoto") {
      return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    }
    return true;
  };
  let uid = 0;
  // Telegram attaches a bot_command entity to every command, and Telegraf's
  // command filter looks for it — a synthetic "/home" with no entities is not a
  // command as far as the framework is concerned.
  const text = (t) => {
    const message = { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: t };
    if (t.startsWith("/")) message.entities = [{ type: "bot_command", offset: 0, length: t.split(/\s/)[0].length }];
    return bot.handleUpdate({ update_id: ++uid, message });
  };
  const tap = (data) =>
    bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid),
        from: ADMIN,
        chat_instance: "1",
        data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
  const sent = () =>
    calls
      .filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
      .map((c) => String(c.payload.text || ""));
  return { bot, calls, text, tap, sent };
}

test("the gainers panel opens from the main menu button", async () => {
  const h = harness();
  await h.tap("gn");
  const out = h.sent().join("\n");
  assert.match(out, /Banner Top Gainers/);
  assert.match(out, /Channel:/);
});

test("the main menu carries the button that opens it", () => {
  const kb = adminBot._menu.mainKb();
  const flat = JSON.stringify(kb);
  assert.match(flat, /"gn"/, "no menu entry means the feature is unreachable");
  assert.match(flat, /Banner Top Gainers/);
});

test("an awaited gainers input is consumed by the gainers handler", async () => {
  const h = harness();
  await h.tap("gn_time"); // arms awaitingGn = {mode:"time"}
  assert.match(h.sent().join("\n"), /HH:MM/);
  await h.text("10:30");
  const out = h.sent().join("\n");
  assert.match(out, /Daily post time/, "the gainers text handler never ran — check registration order");
  assert.match(out, /10:30/);
  assert.strictEqual(require("../src/services/gainersConfig").get().dailyTime, "10:30");
});

test("a template edit still works — the gainers handler passes text through", async () => {
  const h = harness();
  await h.tap("e:welcome"); // adminBot arms awaitingTemplate
  assert.match(h.sent().join("\n"), /Send the new text/);
  await h.text("A brand new welcome message");
  const out = h.sent().join("\n");
  assert.match(out, /Saved/, "gainersMenu swallowed a template edit instead of calling next()");
  const tpl = require("../src/templates");
  assert.match(tpl.getRaw("welcome"), /A brand new welcome message/);
  await tpl.resetTemplate("welcome");
});

test("plain chatter with nothing armed reaches nobody and crashes nothing", async () => {
  const h = harness();
  await h.text("just talking");
  assert.deepStrictEqual(h.sent(), []);
});

test("a command sent while an input is armed is not eaten as that input", async () => {
  const h = harness();
  await h.tap("gn_tz");
  await h.text("/home");
  const out = h.sent().join("\n");
  assert.match(out, /Dexvra Admin/, "/home must still open the menu");
  assert.ok(!/Timezone →/.test(out), "the command was stored as a timezone");
});

test("/cancel disarms an armed gainers input", async () => {
  const h = harness();
  await h.tap("gn_min"); // arms "send me a minimum gain %"
  await h.text("/cancel");
  assert.match(h.sent().join("\n"), /Cancelled/);
  const before = require("../src/services/gainersConfig").get().minGainPct;
  await h.text("42"); // must be treated as ordinary chatter now, not as the value
  assert.strictEqual(require("../src/services/gainersConfig").get().minGainPct, before, "/cancel left the input armed");
});

test("the settings panel and the layout picker render every template", async () => {
  const h = harness();
  await h.tap("gn_set");
  const s = h.sent().join("\n");
  assert.match(s, /Daily auto-post/);
  assert.match(s, /Minimum gain/);
  const kb = JSON.stringify(adminBot._menu.mainKb()); // sanity: menu still builds
  assert.ok(kb.length > 10);
  const gm = require("../src/admin/gainersMenu");
  const pick = JSON.stringify(gm._panels.tplPickKb());
  for (const id of require("../src/gainersBanner").TEMPLATE_IDS) {
    assert.match(pick, new RegExp(`gn_dt:${id}`), `${id} is not offered in the picker`);
    assert.match(pick, new RegExp(`gn_pool:${id}`), `${id} can't be put in the random rotation`);
  }
});

test("the daily toggle flips the stored setting", async () => {
  const cfg = require("../src/services/gainersConfig");
  await cfg.set({ daily: false });
  const h = harness();
  await h.tap("gn_daily");
  assert.strictEqual(cfg.get().daily, true);
  await h.tap("gn_daily");
  assert.strictEqual(cfg.get().daily, false);
});

test("a bad channel is refused with a reason and nothing is stored", async () => {
  const cfg = require("../src/services/gainersConfig");
  await cfg.set({ channel: "" });
  const h = harness();
  await h.tap("gn_ch");
  await h.text("not a channel");
  assert.match(h.sent().join("\n"), /doesn't look like a channel/);
  assert.strictEqual(cfg.get().channel, "");
  await h.tap("gn_ch");
  await h.text("@dexvratrending");
  assert.strictEqual(cfg.get().channel, "@dexvratrending");
  await cfg.set({ channel: "" });
});

// ── end to end: preview in the admin bot → published by the main bot ────────
const BOARD = {
  live: true,
  tokens: ["HOODRAT", "KOMA", "GTAVI", "ESPRESSO", "IFHOOD"].map((symbol, i) => ({
    chain: "solana",
    address: "So" + symbol,
    symbol: "$" + symbol,
    name: symbol + " Token",
    logoUrl: null,
    links: { twitter: `https://x.com/${symbol.toLowerCase()}` },
    priceUsd: 0.0042,
    mcap: 12_400_000 - i * 1e6,
    liq: 300_000,
    vol: { "24h": 1e5 },
    chg: { "24h": 204 - i * 40 },
    source: "live",
    tier: "DIAMOND",
  })),
};

function stubBoardFetch() {
  const real = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/api/tokens")) {
      return { ok: true, status: 200, json: async () => BOARD, headers: { get: () => "application/json" } };
    }
    // Every logo URL 404s — the banner must fall back to $SYMBOL monograms.
    return { ok: false, status: 404, json: async () => ({}), headers: { get: () => "text/plain" } };
  };
  return () => {
    global.fetch = real;
  };
}

test("preview renders a real banner from live data and offers to post it", async () => {
  const restore = stubBoardFetch();
  const h = harness();
  try {
    await h.tap("gn_t:list5");
  } finally {
    restore();
  }
  const photos = h.calls.filter((c) => c.method === "sendPhoto");
  assert.strictEqual(photos.length, 1, "the preview must show the actual artwork");
  assert.match(String(photos[0].payload.caption), /HOODRAT/, "the caption is the one the channel will get");
  const out = h.sent().join("\n");
  assert.match(out, /Preview/);
  assert.match(out, /\$HOODRAT/);
  assert.match(out, /Data: <b>board<\/b>/, "the admin is told which source the numbers came from");
});

test("a day with no qualifying gainers posts nothing and says why", async () => {
  const cfg = require("../src/services/gainersConfig");
  await cfg.set({ minGainPct: 500 }); // nothing in BOARD clears this
  const restore = stubBoardFetch();
  const h = harness();
  try {
    await h.tap("gn_t:list5");
  } finally {
    restore();
    await cfg.set({ minGainPct: 1 });
  }
  assert.strictEqual(h.calls.filter((c) => c.method === "sendPhoto").length, 0, "no artwork for an empty board");
  assert.match(h.sent().join("\n"), /Nothing to post/);
});

test("end to end: 📤 Post queues it, the main bot publishes, the admin gets the link", async () => {
  const post = require("../src/channels/post");
  const poster = require("../src/services/gainersPoster");
  const restore = stubBoardFetch();
  const h = harness();
  try {
    await h.tap("gn_t:podium"); // builds the session the Post button acts on
    const realSend = post.sendPhoto;
    const seen = [];
    post.sendPhoto = async (channel, photo, caption, opts) => {
      seen.push({ channel, photo, caption, opts });
      return { message_id: 8899 };
    };
    // The admin bot waits for the main bot; run the main bot's drain alongside it.
    const drain = (async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 150));
        await poster._drainQueue();
        if (seen.length) return;
      }
    })();
    try {
      await Promise.all([h.tap("gn_post"), drain]);
    } finally {
      post.sendPhoto = realSend;
    }
    assert.strictEqual(seen.length, 1, "the main bot never published the queued banner");
    assert.ok(seen[0].photo.source, "published from the queued PNG");
    assert.match(String(seen[0].caption.text), /HOODRAT/);
    assert.match(h.sent().join("\n"), /Posted/, "the admin was not told the outcome");
    assert.match(h.sent().join("\n"), /t\.me\/.+\/8899/);
  } finally {
    restore();
  }
});

test.afterEach(() => {
  Telegram.prototype.callApi = REAL_CALL_API; // never leave the prototype patched
});
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("📈 the percentage toggle flips showPct from the panel, and the settings screen says so", async () => {
  // "bisakah anda buat fitur kaya presentase kenaikan bisa di on ofin" — the
  // switch is a tap, not an .env line, and the tap has to reach the store the
  // MAIN bot's poster reads. Driven through a real callback update: a source
  // scan would pass on a `gn_pct` button wired to nothing.
  const cfg = require("../src/services/gainersConfig");
  await cfg.set({ showPct: true });
  const h = harness();
  await h.tap("gn_pct");
  assert.strictEqual(cfg.get().showPct, false, "the tap did not reach the store");
  assert.match(h.sent().join("\n"), /Percentage gain[^\n]*\bno\b/, "the settings screen still claims the figure is shown");
  await h.tap("gn_pct");
  assert.strictEqual(cfg.get().showPct, true);
  assert.match(h.sent().join("\n"), /Percentage gain[^\n]*\byes\b/);
});

test("📈 the preview card carries the switch, and a tap re-renders the SAME sample without the figure", async () => {
  // "masih blm ada setingnanya" — the toggle shipped under ⚙️ Settings, and the
  // operator was looking at the PREVIEW, where the figures are and where the
  // decision is made. Driven through real updates with topGainers stubbed:
  // the tap must flip the store, redraw from the session's sample (one sample
  // per sitting — a re-sample would make "with %" and "without %" two
  // different rankings), and the redrawn caption must carry no percentage.
  const gainers = require("../src/gainers");
  const cfg = require("../src/services/gainersConfig");
  await cfg.set({ showPct: true });
  const sample = Array.from({ length: 10 }, (_, i) => ({
    chain: "solana", address: `So${i + 1}`, symbol: `TOK${i + 1}`, name: `Token ${i + 1}`,
    pct: 200 - i * 7, price: 0.0042, mcap: 1_200_000, liq: 90_000,
    url: `https://dexvra.io/token/solana/So${i + 1}`,
  }));
  const realTop = gainers.topGainers;
  const realLogos = gainers.loadLogos;
  let samples = 0;
  gainers.topGainers = async () => { samples++; return { coins: sample.map((c) => ({ ...c })), source: "board", pool: 386, notes: [], handles: null }; };
  gainers.loadLogos = async () => {};
  try {
    const h = harness();
    const photos = () => h.calls.filter((c) => c.method === "sendPhoto").map((c) => String(c.payload.caption || ""));
    const cards = () => h.calls.filter((c) => c.method === "sendMessage" && c.payload.reply_markup).map((c) => JSON.stringify(c.payload.reply_markup));

    await h.tap("gn_t:list5");
    assert.strictEqual(samples, 1, "the first preview takes the sample");
    assert.strictEqual(photos().length, 1, "no preview was rendered — the harness is not measuring anything");
    assert.match(photos()[0], /\+200%/, "the positive control: the ON preview carries the figure");
    assert.match(cards().at(-1), /% gain: ON → hide/, "the card does not carry the switch");

    await h.tap("gn_pvpct");
    assert.strictEqual(cfg.get().showPct, false, "the tap did not reach the store");
    assert.strictEqual(samples, 1, "the toggle RE-SAMPLED — with % and without % are now two rankings");
    assert.strictEqual(photos().length, 2, "the toggle did not re-render the preview");
    assert.doesNotMatch(photos()[1], /%/, "the redrawn caption still prints the percentage");
    assert.match(photos()[1], /#TOK1/, "the ranking itself must stay");
    assert.match(h.sent().join("\n"), /Percentage gain: hidden/, "the card does not say the figure is hidden");
    assert.match(cards().at(-1), /% gain: OFF → show/, "the button did not flip its label");

    await h.tap("gn_pvpct");
    assert.strictEqual(cfg.get().showPct, true);
    assert.strictEqual(samples, 1);
    assert.match(photos()[2], /\+200%/, "switching back on did not restore the figure");
  } finally {
    gainers.topGainers = realTop;
    gainers.loadLogos = realLogos;
    await cfg.set({ showPct: true });
  }
});

test("📈 a tap on a card whose sample is gone still flips the switch and takes a fresh sample", async () => {
  // A cancelled or expired sitting leaves no session. The tap asked for two
  // things — flip, and show me — and `fresh: false` over an empty session
  // would answer the second with "Nothing to post", which reads as the switch
  // having broken the feature.
  const gainers = require("../src/gainers");
  const cfg = require("../src/services/gainersConfig");
  await cfg.set({ showPct: true });
  const realTop = gainers.topGainers;
  const realLogos = gainers.loadLogos;
  let samples = 0;
  gainers.topGainers = async () => {
    samples++;
    return { coins: [{ chain: "solana", address: "So1", symbol: "ONLY", name: "Only", pct: 42, price: 1, mcap: 2_000_000, liq: 50_000, url: "https://dexvra.io/token/solana/So1" }], source: "board", pool: 1, notes: [], handles: null };
  };
  gainers.loadLogos = async () => {};
  try {
    const h = harness();                       // a NEW bot: no session, no sample
    await h.tap("gn_pvpct");
    assert.strictEqual(cfg.get().showPct, false, "the tap did not reach the store");
    assert.strictEqual(samples, 1, "nothing was sampled — the tap rendered from a sample that does not exist");
    const photos = h.calls.filter((c) => c.method === "sendPhoto");
    assert.strictEqual(photos.length, 1, "no preview was rendered");
    assert.doesNotMatch(String(photos[0].payload.caption || ""), /%/);
  } finally {
    gainers.topGainers = realTop;
    gainers.loadLogos = realLogos;
    await cfg.set({ showPct: true });
  }
});
