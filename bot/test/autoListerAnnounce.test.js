// Auto-Listing → @dexvraio.
//
// Operator's rule (2026-08-04): a FREE auto listing reaches the announcement
// channel on the "Listing & Trending" package and on nothing else. `free` and
// `xpress` auto listings stay out of @dexvraio entirely, and a paid listing
// still gets there only on tier #1–#3 (packages.js `announce: true`).
//
// @dexvraio is public and the post is PINNED, so every case here is about
// something that cannot be taken back once it goes out.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alann-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const post = require("../src/channels/post");
const postids = require("../src/channels/postids");
const tokenEmoji = require("../src/tokenEmoji");
const twitter = require("../src/twitter");
const fulfillment = require("../src/fulfillment");
const { CHANNELS } = require("../src/config/constants");

const now = 1_800_000_000_000;
const info = { name: "Nine Hood", symbol: "NINEHOOD", mcap: 1.2e6, liq: 120_000, vol24: 300_000, priceUsd: 0.0012 };

/** Record every channel post instead of sending it. Returns the log. */
function stub(t) {
  const sent = [];
  const orig = {
    sendMedia: post.sendMedia,
    mirrorToGroup: post.mirrorToGroup,
    ensureFromUrl: tokenEmoji.ensureFromUrl,
    enabled: twitter.enabled,
    postMedia: fulfillment.postMedia,
  };
  let id = 500;
  post.sendMedia = async (channel, media, payload, opts = {}) => {
    sent.push({ channel, pin: Boolean(opts.pin), id: ++id });
    return { message_id: id };
  };
  post.mirrorToGroup = async () => null;
  tokenEmoji.ensureFromUrl = async () => null;
  twitter.enabled = () => false; // no network, and tweetListing returns early
  sent.badges = [];
  fulfillment.postMedia = async (kind, coin, buf, fileId, url, badge) => {
    sent.badges.push({ kind, badge });
    return { type: "photo", source: Buffer.from("x") };
  };
  t.after(() => {
    post.sendMedia = orig.sendMedia;
    post.mirrorToGroup = orig.mirrorToGroup;
    tokenEmoji.ensureFromUrl = orig.ensureFromUrl;
    twitter.enabled = orig.enabled;
    fulfillment.postMedia = orig.postMedia;
  });
  return sent;
}

/** Run announce() for one token under the CURRENT config. */
function announceWith(address) {
  const c = { chain: "solana", address };
  const cfg = al.get();
  return al.announce({}, c, info, al.listingInput(c.chain, c.address, info, cfg, now), cfg).then(() => c);
}

const channels = (sent) => sent.map((s) => s.channel);

test("Listing & Trending: the free auto listing is announced in @dexvraio", async (t) => {
  const sent = stub(t);
  await al.set({ pkg: "trending", trendHours: 12, postChannel: true, announceChannel: true });
  const c = await announceWith("So1AnnTrend1");

  assert.ok(channels(sent).includes(CHANNELS.listing), "the listing channel post is the baseline — the stubs are wrong if this is missing");
  assert.ok(channels(sent).includes(CHANNELS.announce), `Listing & Trending did NOT reach ${CHANNELS.announce}`);
  assert.ok(channels(sent).includes(CHANNELS.trending), "the board card still goes to the trending channel");

  // Pinned, exactly like a tier #1–#3 paid listing (fulfillment.js).
  const ann = sent.find((s) => s.channel === CHANNELS.announce);
  assert.strictEqual(ann.pin, true, "@dexvraio posts are pinned — the newest announcement is what a visitor should see");

  // Recorded, or a later pump alert replies in the listing channel only and
  // never under the announcement it belongs to (pumpChecker reads annMsgId).
  const ids = postids.get(c.chain, c.address);
  assert.strictEqual(ids.annMsgId, ann.id, "annMsgId must be the message we just announced, not some earlier one");
  assert.strictEqual(
    ids.listingMsgId,
    sent.find((s) => s.channel === CHANNELS.listing).id,
    "listingMsgId must survive the same write",
  );
});

test("the announced card wears the tier the listing was actually given", async (t) => {
  const sent = stub(t);
  await al.set({ pkg: "trending", postChannel: true, announceChannel: true });
  const cfg = al.get();
  const input = al.listingInput("solana", "So1AnnBadge1", info, cfg, now);
  await al.announce({}, { chain: "solana", address: "So1AnnBadge1" }, info, input, cfg);

  // A card with no badge on a listing the site shows as Gold is the two halves
  // of one product disagreeing in public.
  assert.ok(al.TREND_TIERS.includes(input.tier), `expected a drawn tier, got ${input.tier}`);
  const expected = al.badgeFor(input.tier);
  assert.ok(
    sent.badges.some((b) => b.kind === "listing" && b.badge === expected),
    `listing card badge should be "${expected}", got ${JSON.stringify(sent.badges)}`,
  );
});

test("a plain free listing wears no badge — there is no such package to sell", async (t) => {
  const sent = stub(t);
  await al.set({ pkg: "free", postChannel: true });
  const cfg = al.get();
  const input = al.listingInput("solana", "So1AnnNoBadge1", info, cfg, now);
  await al.announce({}, { chain: "solana", address: "So1AnnNoBadge1" }, info, input, cfg);

  assert.strictEqual(input.tier, "FREE");
  assert.ok(
    sent.badges.every((b) => b.badge === null),
    `a FREE listing put a badge on its card: ${JSON.stringify(sent.badges)}`,
  );
});

test("the plain Free package never reaches @dexvraio", async (t) => {
  const sent = stub(t);
  await al.set({ pkg: "free", postChannel: true, announceChannel: true });
  await announceWith("So1AnnFree1");

  assert.ok(channels(sent).includes(CHANNELS.listing), "a free listing still posts to the listing channel");
  assert.ok(
    !channels(sent).includes(CHANNELS.announce),
    `a plain free listing reached ${CHANNELS.announce} — only Listing & Trending may`,
  );
  assert.ok(!channels(sent).includes(CHANNELS.trending), "no board slot, so no trending card");
});

test("Xpress never reaches @dexvraio either — it is a listing, not an announcement", async (t) => {
  const sent = stub(t);
  await al.set({ pkg: "xpress", postChannel: true, announceChannel: true });
  await announceWith("So1AnnXpress1");

  assert.ok(channels(sent).includes(CHANNELS.listing));
  assert.ok(!channels(sent).includes(CHANNELS.announce), `Xpress reached ${CHANNELS.announce}`);
});

test("the operator can mute @dexvraio without giving up the package", async (t) => {
  const sent = stub(t);
  await al.set({ pkg: "trending", postChannel: true, announceChannel: false });
  await announceWith("So1AnnMuted1");

  assert.ok(!channels(sent).includes(CHANNELS.announce), "announceChannel:false did not mute anything");
  // The rest of the package is untouched — muting the megaphone must not cost
  // the token its listing post or its board card.
  assert.ok(channels(sent).includes(CHANNELS.listing));
  assert.ok(channels(sent).includes(CHANNELS.trending));
});

test("announceChannel defaults ON, survives reset, and is a real boolean", async () => {
  await al.reset();
  assert.strictEqual(al.get().announceChannel, true, "the package announces by default");
  // It cannot fire on its own: postChannel gates every channel post, and it is
  // still OFF after a reset. That is why this one may default to true.
  assert.strictEqual(al.get().postChannel, false);

  await al.set({ announceChannel: false });
  assert.strictEqual(al.get().announceChannel, false, "false must persist — not be read back as the default");
  await al.reset();
  assert.strictEqual(al.get().announceChannel, true);
});

test("a garbage stored value falls back to announcing, never to a silent half-package", async () => {
  await al.set({ announceChannel: "yes please" });
  assert.strictEqual(al.get().announceChannel, true, "only a real boolean overrides the default");
  await al.reset();
});

test("the admin panel can actually toggle it — button and handler agree", () => {
  const src = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  // A button whose callback nothing listens for is a dead tap, and the panel is
  // the only way to reach this switch.
  assert.match(src, /cb\(`🔔 \$\{CHANNELS\.announce\}: \$\{c\.announceChannel \? "ON" : "OFF"\}`, "alann"\)/, "no toggle button");
  assert.match(src, /bot\.action\("alann"/, "no handler for the alann button");
  assert.match(src, /autoLister\.set\(\{ announceChannel: !autoLister\.get\(\)\.announceChannel \}\)/, "the handler does not flip the flag");
});
