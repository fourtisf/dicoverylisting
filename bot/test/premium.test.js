const test = require("node:test");
const assert = require("node:assert");
const premium = require("../src/premium");
const tpl = require("../src/templates");

test("parse: premium emoji tag → custom_emoji entity with clean text", () => {
  const { text, entities } = premium.parse("Hi [🚀](emoji/5341323326188956773) world");
  assert.strictEqual(text, "Hi 🚀 world");
  assert.strictEqual(entities.length, 1);
  const e = entities[0];
  assert.strictEqual(e.type, "custom_emoji");
  assert.strictEqual(e.custom_emoji_id, "5341323326188956773");
  assert.strictEqual(e.offset, 3);
  assert.strictEqual(e.length, "🚀".length); // 2 UTF-16 code units — Telegram's unit
});

test("parse: bold / link / code with correct UTF-16 offsets", () => {
  const { text, entities } = premium.parse("**Bold** then [site](https://x.io) and `code`");
  assert.strictEqual(text, "Bold then site and code");
  assert.deepStrictEqual(
    entities.map((e) => [e.type, e.offset, e.length]),
    [
      ["bold", 0, 4],
      ["text_link", 10, 4],
      ["code", 19, 4],
    ],
  );
  assert.strictEqual(entities[1].url, "https://x.io");
});

test("parse: offsets stay correct AFTER a multi-code-unit emoji", () => {
  const { text, entities } = premium.parse("[🚀](emoji/1)**B**");
  assert.strictEqual(text, "🚀B");
  const bold = entities.find((e) => e.type === "bold");
  assert.strictEqual(bold.offset, 2); // 🚀 occupies UTF-16 offsets 0..1
  assert.strictEqual(bold.length, 1);
});

test("parse: no markup → plain text, no entities; emoji tags ≠ normal links", () => {
  const p1 = premium.parse("just text 🚀");
  assert.strictEqual(p1.text, "just text 🚀");
  assert.strictEqual(p1.entities.length, 0);
  const p2 = premium.parse("[go](emoji/12) vs [go](https://a.b)");
  assert.strictEqual(p2.entities[0].type, "custom_emoji");
  assert.strictEqual(p2.entities[1].type, "text_link");
});

test("parse: premium emoji NESTED in a link label — link intact, emoji entity inside it", () => {
  // The buy card's CTA row is "[⚡ Trade on Dexvra](url) · [📈 Chart](url)…" —
  // three link labels. A premium swap there writes the fragment INSIDE the
  // label, and the old single-pass scan could not read that: the link died or
  // literal brackets leaked. This is the exact shape the footer swap produces.
  const { text, entities } = premium.parse("[[⚡](emoji/111) Trade on Dexvra](https://t.me/x) · [[🆙](emoji/222) Chart](https://c)");
  assert.strictEqual(text, "⚡ Trade on Dexvra · 🆙 Chart");
  const links = entities.filter((e) => e.type === "text_link");
  assert.deepStrictEqual(links.map((e) => text.substr(e.offset, e.length)), ["⚡ Trade on Dexvra", "🆙 Chart"]);
  const prem = entities.filter((e) => e.type === "custom_emoji");
  assert.deepStrictEqual(prem.map((e) => [text.substr(e.offset, e.length), e.custom_emoji_id]), [["⚡", "111"], ["🆙", "222"]]);
  // Nested: each emoji entity sits inside its link's span, containing entity first.
  assert.ok(prem[0].offset >= links[0].offset && prem[0].offset + prem[0].length <= links[0].offset + links[0].length);
  assert.ok(entities.indexOf(links[0]) < entities.indexOf(prem[0]), "link (container) sorted before its emoji");
});

test("parse: premium emoji inside **bold** keeps both", () => {
  const { text, entities } = premium.parse("**[🔥](emoji/9) hot**");
  assert.strictEqual(text, "🔥 hot");
  assert.deepStrictEqual(
    entities.map((e) => [e.type, e.offset, e.length]),
    [["bold", 0, 6], ["custom_emoji", 0, 2]],
  );
});

test("parse: a NEAR-MISS fragment stays literal — never a text_link with an emoji/ url", () => {
  // Emoji-shaped but malformed (a junk id, a bracket or newline in the char)
  // is not consumed by the fragment pre-pass. Without the emoji/ guard on the
  // link scan it became a text_link whose url is the relative "emoji/…" — and
  // the Bot API refuses that ENTIRE message. Literal text is ugly; a buy alert
  // that silently stops sending is a production incident.
  for (const s of ["[🔥](emoji/12x) now", "[x](emoji/abc)", "[a\nb](emoji/5) x", "[🔥*](emoji/5) y"]) {
    const { entities } = premium.parse(s);
    assert.ok(
      !entities.some((e) => e.type === "text_link" && String(e.url).startsWith("emoji/")),
      `no emoji/ text_link for ${JSON.stringify(s)}`,
    );
  }
});

test("parse: entities NEVER extend past the text, whatever junk comes in", () => {
  // A fragment char carrying markup delimiters used to let the pattern scan
  // cut a span through the middle of the char, emitting a custom_emoji entity
  // beyond the end of the message — which Telegram rejects wholesale.
  for (const s of [
    "[x**](emoji/1)b**", "**a[x**](emoji/1)", "[`x`](emoji/5) hi", "x[a**b](emoji/1)c**d",
    "`[😀](emoji/5)`", "[[⚡](emoji/1) T](u) `c` **b**", "[😀](emoji/", "](emoji/1)[",
  ]) {
    const { text, entities } = premium.parse(s);
    for (const e of entities) {
      assert.ok(e.offset >= 0 && e.offset + e.length <= text.length, `${JSON.stringify(s)} → in-bounds ${JSON.stringify(e)} in ${JSON.stringify(text)}`);
    }
  }
});

test("parse: a fragment inside `code` shows its char but nests NO entity in the code span", () => {
  // Telegram allows nothing nested inside code — an illegal shape can fail the
  // whole send. The char still lands (monospace emoji beats leaked markup).
  const { text, entities } = premium.parse("`a [🔥](emoji/9) b`");
  assert.strictEqual(text, "a 🔥 b");
  assert.deepStrictEqual(entities.map((e) => e.type), ["code"]);
});

test("parse: overlapping patterns keep the first, never corrupt offsets", () => {
  // link text containing ** — bold pattern overlaps the link match
  const { text, entities } = premium.parse("[**x**](https://a.b) tail");
  assert.ok(text.endsWith(" tail"));
  for (const e of entities) {
    assert.ok(e.offset >= 0 && e.offset + e.length <= text.length, "entity inside text bounds");
  }
});

test("toGramJs maps entity types (fake Api)", () => {
  class FakeEnt {
    constructor(o) {
      Object.assign(this, o);
    }
  }
  const Api = {
    MessageEntityCustomEmoji: class extends FakeEnt {},
    MessageEntityBold: class extends FakeEnt {},
    MessageEntityItalic: class extends FakeEnt {},
    MessageEntityTextUrl: class extends FakeEnt {},
    MessageEntityUrl: class extends FakeEnt {},
    MessageEntityCode: class extends FakeEnt {},
    MessageEntityPre: class extends FakeEnt {},
    MessageEntityUnderline: class extends FakeEnt {},
    MessageEntityStrike: class extends FakeEnt {},
    MessageEntitySpoiler: class extends FakeEnt {},
  };
  const out = premium.toGramJs(
    [
      { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "123" },
      { type: "bold", offset: 3, length: 4 },
      { type: "text_link", offset: 8, length: 4, url: "https://x.io" },
      { type: "mention", offset: 0, length: 1 }, // unknown → dropped
    ],
    Api,
  );
  assert.strictEqual(out.length, 3);
  assert.ok(out[0] instanceof Api.MessageEntityCustomEmoji);
  assert.strictEqual(out[0].documentId, 123n);
  assert.strictEqual(out[2].url, "https://x.io");
});

test("substituteEntities: entities after a placeholder shift by the delta", () => {
  // "{name} is **live**"  — bold sits after the placeholder
  const r = premium.substituteEntities("{name} is live", [{ type: "bold", offset: 10, length: 4 }], {
    name: "Jimothy",
  });
  assert.strictEqual(r.text, "Jimothy is live");
  assert.deepStrictEqual(r.entities, [{ type: "bold", offset: 11, length: 4 }]);
});

test("substituteEntities: entity spanning the placeholder stretches", () => {
  // bold covers "hi {n}!" entirely
  const r = premium.substituteEntities("hi {n}!", [{ type: "bold", offset: 0, length: 7 }], { n: "world" });
  assert.strictEqual(r.text, "hi world!");
  assert.deepStrictEqual(r.entities, [{ type: "bold", offset: 0, length: 9 }]);
});

test("substituteEntities: entity strictly inside the placeholder is dropped", () => {
  const r = premium.substituteEntities("a {ph} b", [{ type: "bold", offset: 3, length: 2 }], { ph: "XY" });
  assert.strictEqual(r.text, "a XY b");
  assert.deepStrictEqual(r.entities, []);
});

test("substituteEntities: emoji-length values keep UTF-16 math right", () => {
  // premium emoji entity AFTER the placeholder; value contains an emoji (2 units)
  const r = premium.substituteEntities(
    "{v} [x]",
    [{ type: "custom_emoji", offset: 4, length: 3, custom_emoji_id: "9" }],
    { v: "🚀" },
  );
  assert.strictEqual(r.text, "🚀 [x]");
  assert.strictEqual(r.entities[0].offset, 3); // "🚀 " = 3 UTF-16 units
});

test("substituteEntities: multiple placeholders, missing → empty", () => {
  const r = premium.substituteEntities("{a}-{b}-{c}", [], { a: "1", c: "333" });
  assert.strictEqual(r.text, "1--333");
});

test("substituteEntities: value containing {braces} is not re-expanded", () => {
  const r = premium.substituteEntities("{a}", [], { a: "{b}", b: "NO" });
  assert.strictEqual(r.text, "{b}");
});

test("sanitizeVar neutralizes markup injection in user values", () => {
  assert.strictEqual(premium.sanitizeVar("[click](https://scam)"), "(click)(https://scam)");
  assert.strictEqual(premium.sanitizeVar("`rm -rf`"), "'rm -rf'");
  assert.strictEqual(premium.sanitizeVar(null), "");
});

test("sanitizeUrl: a ')' in a URL cannot close a markup link early", () => {
  const url = premium.sanitizeUrl("https://x.io/a)(malicious[b]`c");
  assert.ok(!url.includes(")") && !url.includes("(") && !url.includes("[") && !url.includes("`"));
  const { text, entities } = premium.parse(`[Website](${url}) tail`);
  assert.strictEqual(text, "Website tail"); // ONE link, nothing injected
  assert.strictEqual(entities.length, 1);
  assert.strictEqual(entities[0].type, "text_link");
});

test("hasAuthoredFormatting: auto-detected url/command entities do NOT count", () => {
  assert.ok(!premium.hasAuthoredFormatting([{ type: "url", offset: 0, length: 10 }]));
  assert.ok(!premium.hasAuthoredFormatting([{ type: "bot_command", offset: 0, length: 5 }]));
  assert.ok(premium.hasAuthoredFormatting([{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "1" }]));
  assert.ok(premium.hasAuthoredFormatting([{ type: "bold", offset: 0, length: 3 }]));
});

test("substituteEntities: rich {text, entities} var merges fragment entities at insertion point", () => {
  const frag = premium.parse("🚨 Listing: [open ↗](https://t.me/x/1)");
  const r = premium.substituteEntities(
    "Done! {links} 🎉",
    [{ type: "bold", offset: 0, length: 5 }],
    { links: frag },
  );
  assert.strictEqual(r.text, "Done! 🚨 Listing: open ↗ 🎉");
  const link = r.entities.find((e) => e.type === "text_link");
  assert.ok(link, "fragment link entity survived");
  // link points at "open ↗" in the FINAL string
  assert.strictEqual(r.text.slice(link.offset, link.offset + link.length), "open ↗");
  // template's own bold untouched
  assert.deepStrictEqual(r.entities.find((e) => e.type === "bold"), { type: "bold", offset: 0, length: 5 });
});

test("looksLikeHtml: real tags yes, bare & / < no", () => {
  assert.ok(premium.looksLikeHtml("<b>x</b>"));
  assert.ok(premium.looksLikeHtml('<a href="u">x</a>'));
  assert.ok(!premium.looksLikeHtml("Listing & Trending"));
  assert.ok(!premium.looksLikeHtml("a < b"));
  assert.ok(!premium.looksLikeHtml("**bold** [x](u)"));
});

// ── templates.render() modes ─────────────────────────────────────────────────

test("render: markup default → clean text + entities (emoji as unicode by default)", () => {
  const r = tpl.render("welcome");
  assert.ok(r.text.includes("Welcome to Dexvra"));
  assert.ok(!r.text.includes("**"), "markup stripped from text");
  assert.ok(!r.text.includes("(emoji/"), "emoji tags stripped from text");
  // the emoji fallback char is present in the text in BOTH modes (premium on/off)
  assert.ok(r.text.includes("💎"), "diamond emoji present");
  const bold = r.entities.filter((e) => e.type === "bold");
  assert.ok(bold.length >= 3, "welcome keeps bold entities");
});

test("render: channel post default substitutes vars into entities payload", () => {
  const r = tpl.render("post_trending", {
    symbol: "$JIM",
    name: "Jimothy",
    chain: "SOLANA",
    address: "`So1abc`", // format.js pre-wraps the CA as code markup (tap-to-copy)
    price: "$0.01",
    mcap: "$1M",
    coinUrl: "https://dexvra.io/x",
    socials: "",
    footer: "",
  });
  assert.ok(r.text.includes("New Trending on Dexvra"));
  assert.ok(r.text.includes("$JIM"));
  assert.ok(r.text.includes("So1abc"));
  assert.ok(r.text.includes("Market cap: $1M"), "market-cap value present");
  assert.ok(r.entities.some((e) => e.type === "code")); // `address`
  // every entity within bounds
  for (const e of r.entities) assert.ok(e.offset + e.length <= r.text.length);
});

test("render: legacy HTML template gets markup-stripped, HTML-escaped vars", async () => {
  // simulate an admin-saved HTML template (pre-markup era)
  const os = require("node:os");
  const fss = require("node:fs");
  const path = require("node:path");
  // isolate template storage
  const tmp = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tpl-"));
  fss.writeFileSync(
    path.join(tmp, "templates.json"),
    JSON.stringify({ payment_snag: "<b>Snag!</b> Order {order} — sorry." }),
  );
  // fresh module instance against the isolated dir
  const prevEnv = process.env.BOT_DATA_DIR;
  process.env.BOT_DATA_DIR = tmp;
  delete require.cache[require.resolve("../src/templates")];
  delete require.cache[require.resolve("../src/helpers/persist")];
  delete require.cache[require.resolve("../src/config/constants")]; // DATA_DIR lives here
  const tpl2 = require("../src/templates");
  const r = tpl2.render("payment_snag", { order: "x<y&[link](https://evil)" });
  assert.ok(r.html != null, "legacy HTML mode");
  assert.ok(r.html.includes("<b>Snag!</b>"), "template's own tags intact");
  assert.ok(!r.html.includes("x<y"), "user '<' escaped");
  assert.ok(r.html.includes("&lt;"), "escaped entity present");
  assert.ok(!r.html.includes("[link]("), "markup stripped from value");
  // restore
  if (prevEnv === undefined) delete process.env.BOT_DATA_DIR;
  else process.env.BOT_DATA_DIR = prevEnv;
  delete require.cache[require.resolve("../src/templates")];
  delete require.cache[require.resolve("../src/helpers/persist")];
  delete require.cache[require.resolve("../src/config/constants")];
});

test("render: entity-based saved template substitutes with offset shifting", () => {
  // simulate an admin-pasted template (entities, no markup)
  const saved = {
    text: "Hello {name} 🚀",
    entities: [
      { type: "bold", offset: 6, length: 6 }, // covers {name}
      { type: "custom_emoji", offset: 13, length: 2, custom_emoji_id: "42" },
    ],
  };
  const r = require("../src/premium").substituteEntities(saved.text, saved.entities, { name: "Jimothy!" });
  assert.strictEqual(r.text, "Hello Jimothy! 🚀");
  const emoji = r.entities.find((e) => e.type === "custom_emoji");
  assert.strictEqual(emoji.offset, 15); // shifted by +2 ("Jimothy!" vs "{name}")
});
