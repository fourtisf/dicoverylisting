// t.me/<bot>?start=<payload> — a link from a group landing on an exact screen.
//
// Telegram opens the private chat with a START button; tapping it sends
// "/start <payload>". Before this the payload was read for exactly one thing
// (telling an injected group /start from a typed one) and thrown away
// everywhere else, so every link into the bot arrived at the main menu with a
// row still to find.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-deep-"));

const test = require("node:test");
const assert = require("node:assert");
const start = require("../src/handlers/start");

function pmCtx(payload) {
  const sent = [];
  return {
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "Naufal" },
    startPayload: payload,
    session: { type: "half_built_form", form: { name: "leftover" } },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 1 }; },
    replyWithPhoto: async (_p, extra) => { sent.push({ text: (extra && extra.caption) || "", extra }); return { message_id: 1 }; },
    telegram: { deleteMessage: async () => {} },
    sent,
  };
}

test("every deep link resolves to a handler that exists", () => {
  // A payload naming a handler that was renamed would open the bot on nothing,
  // and the only symptom is a link that "does not work".
  for (const [payload, fn] of Object.entries(start.DEEP_LINKS)) {
    assert.strictEqual(typeof fn, "function", `${payload} is not callable`);
  }
  assert.ok(start.DEEP_LINKS[start.DEEP_LINK_LISTING], "the one the group button uses");
});

test("Listing / Trending opens the package picker, not the main menu", async () => {
  const ctx = pmCtx(start.DEEP_LINK_LISTING);
  await start.startHandler(ctx);
  assert.ok(ctx.sent.length, "something was sent");
  assert.strictEqual(ctx.session.type, "tiered_listing", "landed in the Listing & Trending flow");
});

test("a deep link starts a clean session", async () => {
  // Followed mid-form, it must not inherit half of an abandoned one — the next
  // message the user types would be read into the wrong field.
  const ctx = pmCtx(start.DEEP_LINK_LISTING);
  await start.startHandler(ctx);
  assert.ok(!ctx.session.form || !ctx.session.form.name, "the leftover form is gone");
});

test("an unknown payload opens the bot instead of failing", async () => {
  // Stale links live in old group posts forever. Landing on home is a worse
  // answer than the right screen and a far better one than nothing.
  const ctx = pmCtx("some-old-campaign-tag");
  await start.startHandler(ctx);
  assert.ok(ctx.sent.length, "the home card still went out");
});

test("a payload that throws still opens the bot", async () => {
  const real = start.DEEP_LINKS.banner;
  try {
    start.DEEP_LINKS.banner = () => { throw new Error("boom"); };
    const ctx = pmCtx("banner");
    await start.startHandler(ctx);
    assert.ok(ctx.sent.length, "fell through to home rather than sending nothing");
  } finally {
    start.DEEP_LINKS.banner = real;
  }
});

test("the group button points at the bot, and the channel at the listing feed", () => {
  const { BOT_USERNAME, CHANNELS } = require("../src/config/constants");
  const urls = start.groupStartKeyboard().inline_keyboard.flat().filter((b) => b.url).map((b) => b.url);
  assert.ok(
    urls.some((u) => u === `https://t.me/${BOT_USERNAME}?start=${start.DEEP_LINK_LISTING}`),
    `Listing / Trending should deep-link the bot, got ${urls.join(" ")}`,
  );
  // The LISTING channel, not the announcement one: this button sits directly
  // under Listing / Trending, and pointing them at different feeds is how
  // somebody ends up in the wrong channel looking for their own listing.
  assert.ok(
    urls.some((u) => u === `https://t.me/${String(CHANNELS.listing).replace(/^@/, "")}`),
    `Channel should be the listing feed, got ${urls.join(" ")}`,
  );
  assert.ok(!urls.some((u) => /dexvra\.io/.test(u)), "and nothing still points at the website");
});
