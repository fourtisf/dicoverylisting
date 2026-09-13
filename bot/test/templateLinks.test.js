// Every link in every default template must be a URL Telegram will accept.
//
// This exists because one did not. group_start put {bot} in a link target while
// its caller was overriding {bot} with the @handle, so the entity URL came out
// as "@dexvrabot" and Telegram refused the WHOLE message: "400: Bad Request:
// entity URL '@dexvrabot' is invalid: Wrong HTTP URL". In a group that reads as
// /start doing nothing at all.
//
// A link is the one thing in a template that can fail the send outright — bad
// prose still delivers. So every one of them is rendered and checked here.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-lnk-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

// A full bag, so nothing renders blank and hides a broken link behind an empty
// placeholder. Every value is the SHAPE the real caller passes.
const VARS = {
  name: "The Bull Cat", symbol: "$BULLCAT", tag: "BULLCAT", chain: "Solana", native: "SOL",
  address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump", price: "$0.001266", mcap: "$1.3M",
  liq: "$183.5K", change: "+18.4%", impact: "0.42%", usd: "$804.72", tokenAmt: "51,874.15",
  holds: "1,980,000", holdsUsd: "$95,523", position: "+3.82%", whaleBar: "$50,000",
  tier: "NEW BUY", emoji: "🟢🟢🟢", bar: "▰▰▱", count: "3", buysWord: "buys",
  coinUrl: "https://dexvra.io/token/solana/G9j8", chartUrl: "https://dexscreener.com/solana/pool",
  tradeUrl: "https://t.me/dexvratradebot?start=ca_solana_G9j8",
  url: "https://dexvra.io/token/solana/G9j8", siteUrl: "https://dexvra.io/token/solana/G9j8",
  listingUrl: "https://t.me/dexvralisting/6", trendingUrl: "https://t.me/dexvratrending/3",
  announceUrl: "https://t.me/dexvraio/9", xUrl: "https://x.com/i/status/1",
  linkUrl: "https://bullcat.io", website: "https://bullcat.io", twitter: "https://x.com/bullcat",
  telegram: "https://t.me/bullcat", coinUrlLabel: "dexvra.io/token/solana/G9j8",
  verify: "👤 0x1f4b…9ac2", wallet: "Position: 1,980,000 $BULLCAT",
  title: "The Bull Cat", slot: "Wide Banner", description: "A community memecoin.",
  overview: "A community memecoin.", logo: "✅ set", field: "name", order: "k3n8",
  amount: "1", label: "Diamond Listing", size: "728×90", size2x: "1456×180",
  duration: "3 Days", hours: "48", usd2: "670", discount: "20", queueNote: "",
  postLinks: "🚨 Listing: https://t.me/dexvralisting/6", announceX: "",
  ref: "MDX-4821", reached: "8,214", sol: "1 SOL", bnb: "0.15 BNB", eth: "0.05 ETH",
  seq: "#7", percent: "62", left: "38m", crew: "14", roster: "@ana, @bo",
  progress: "❤️ Likes ▰▰▱ 209/215", post: "gm", updated: "12:33:57", note: "",
  goals: "🤝 Crew — +10", lock: "off", record: "", maxMinutes: "30", sources: "",
  date: "Aug 10", list: "1. $BULLCAT +42%", multiple: "2×", firstMc: "$310K",
  lastMc: "$1.3M", rank: "2", gain: "+42%", mention: " @bullcat", handle: "@dexvralisting",
  tierEmoji: "💎", chainEmoji: "🟣", logoEmoji: "🐶", pool: "resolved ✓", minBuy: "$50",
  whale: "$50,000", pin: "on", state: "🟢 ON", chains: "solana, bsc", unsupported: "",
  started: "3", completed: "1",
};

/** Telegram accepts http(s) and tg:// in a text_link. Nothing else. */
const OK_URL = /^(https?:\/\/[^\s]+|tg:\/\/[^\s]+)$/;

test("every link in every default template is a URL Telegram accepts", () => {
  const bad = [];
  for (const key of tpl.keys()) {
    let payload;
    try {
      payload = tpl.render(key, VARS);
    } catch (e) {
      bad.push(`${key}: render threw — ${e.message}`);
      continue;
    }
    for (const e of payload.entities || []) {
      if (e.type !== "text_link") continue;
      if (!OK_URL.test(String(e.url || ""))) {
        bad.push(`${key}: "${payload.text.substr(e.offset, e.length)}" → ${JSON.stringify(e.url)}`);
      }
    }
  }
  assert.deepStrictEqual(bad, [], `Telegram refuses the WHOLE message on any of these:\n${bad.join("\n")}`);
});

test("{bot} is a URL and {botName} is the handle — they are not interchangeable", () => {
  // Tested on the VARIABLES, not on one template's wording: which template
  // happens to carry a bot link is an admin's copy decision, and pinning this
  // to group_start meant the test broke the moment the operator asked for that
  // line to go.
  const link = tpl.renderValue("[x]({bot})", {});
  const url = (link.entities || []).find((e) => e.type === "text_link")?.url;
  assert.match(String(url), /^https:\/\/t\.me\/\S+$/, "{bot} resolves to a t.me URL");
  assert.match(tpl.renderValue("{botName}", {}).text, /^@\S+$/, "{botName} is the @handle");
});

test("no caller overrides {bot} with a bare @handle", () => {
  // baseVars already supplies it as a t.me URL. An override with "@name" is
  // invisible until a template happens to use it as a link target.
  for (const rel of ["handlers/start.js", "handlers/registry.js", "group/setup.js", "raid/panel.js"]) {
    const s = fss.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");
    assert.ok(!/\bbot:\s*[`"']@/.test(s), `${rel} overrides {bot} with an @handle`);
  }
});
