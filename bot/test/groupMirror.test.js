// Every listing should also show up in the community group. It is a FORWARD
// from the listing channel rather than a second post, and that choice is the
// whole design:
//   • a forward keeps the premium custom emoji — a Bot-API re-post strips them
//   • it is one call, with no media re-upload
//   • the "Forwarded from Dexvra Listing Alerts" header sends readers to the
//     channel instead of competing with it
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-groupmirror-"));

const test = require("node:test");
const assert = require("node:assert");

const post = require("../src/channels/post");
const { CHANNELS, GROUP_CHAT } = require("../src/config/constants");

const read = (p) => fss.readFileSync(require.resolve(`../src/${p}`), "utf8");
/** Source minus comments — the comments here quote the design on purpose, so
 *  "does this file really call the mirror" has to ignore them. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A bot that records forwards, and can be told to fail. */
function recorder({ fail = null } = {}) {
  const forwards = [];
  post.attach({
    forwardMessage: async (to, from, id) => {
      if (fail) throw new Error(fail);
      forwards.push({ to, from, id });
      return { message_id: 999 };
    },
  });
  return forwards;
}

test("the group is configured, and points at the community group", () => {
  assert.strictEqual(GROUP_CHAT, "@dexvragroup");
  assert.match(code("config/constants.js"), /env\.GROUP_CHAT === undefined \? "@dexvragroup" : env\.GROUP_CHAT/,
    "an operator must be able to repoint it — or switch it off with an empty value");
});

test("a listing is forwarded, not re-posted", () => {
  // sendMessage/sendPhoto would strip the premium emoji and re-upload the media.
  const src = code("channels/post.js");
  const fn = src.slice(src.indexOf("async function mirrorToGroup("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /tg\.forwardMessage\(GROUP_CHAT, fromChannel, msg\.message_id\)/);
  assert.ok(!/sendPhoto|sendMedia|sendMessage|copyMessage/.test(body), "a copy is not a forward");
});

test("it forwards from the listing channel to the group", async () => {
  const forwards = recorder();
  await post.mirrorToGroup(CHANNELS.listing, { message_id: 4242 });
  assert.deepStrictEqual(forwards, [{ to: "@dexvragroup", from: CHANNELS.listing, id: 4242 }]);
});

test("a mirror that fails never breaks the listing that paid for it", async () => {
  // The buyer's money is already spent and the channel post is already live. A
  // group the bot was removed from must cost nothing.
  recorder({ fail: "Forbidden: bot is not a member of the supergroup chat" });
  const r = await post.mirrorToGroup(CHANNELS.listing, { message_id: 1 });
  assert.strictEqual(r, null, "it reports failure by returning null, not by throwing");
});

test("nothing to forward is not an error", async () => {
  const forwards = recorder();
  assert.strictEqual(await post.mirrorToGroup(CHANNELS.listing, null), null, "a failed channel post has no message to mirror");
  assert.strictEqual(await post.mirrorToGroup(CHANNELS.listing, {}), null, "…nor does a message with no id");
  assert.strictEqual(forwards.length, 0);
});

test("every path that publishes a listing mirrors it", () => {
  // Three of them, and a new one is easy to add without noticing this exists.
  assert.match(code("fulfillment.js"), /await post\.mirrorToGroup\(CHANNELS\.listing, listingMsg\);/, "the paid listing");
  assert.match(code("services/autoLister.js"), /await post\.mirrorToGroup\(CHANNELS\.listing, msg, \{ label: "auto-listing" \}\)/, "the auto-lister");
  // Force-post mirrors at deliver(), the single choke-point every kind goes
  // through — so Xpress and Listing+Trending are both covered without either
  // remembering to call it.
  const fp = code("admin/forcePost.js");
  assert.match(fp, /if \(channel === CHANNELS\.listing\) await post\.mirrorToGroup\(channel/);
  const deliver = fp.slice(fp.indexOf("async function deliver("));
  assert.ok(deliver.indexOf("mirrorToGroup") < deliver.indexOf("\n}\n"), "…and it is inside deliver(), not beside one caller");
});

test("only the listing post is mirrored — the group is not a third channel", () => {
  // The same card also goes to @dexvraio and a trending card to @dexvratrending.
  // Forwarding those too would put three near-identical posts in the group for
  // one listing, which is the spam this is meant to avoid.
  const fulfil = code("fulfillment.js");
  for (const line of fulfil.split("\n")) {
    if (!line.includes("mirrorToGroup")) continue;
    assert.match(line, /CHANNELS\.listing/, `mirroring a non-listing channel: ${line.trim()}`);
  }
  assert.ok(!/mirrorToGroup\(CHANNELS\.(announce|trending)/.test(fulfil));
  assert.ok(!/mirrorToGroup/.test(code("services/pumpChecker.js")), "a pump alert is a reply in a thread, not a listing");
});

test("an empty GROUP_CHAT turns the mirror off cleanly", async () => {
  // Not everyone runs a group. Unset must mean silence, not a warning per post.
  const forwards = recorder();
  const src = code("channels/post.js");
  assert.match(src, /if \(!tg \|\| !GROUP_CHAT \|\| !msg \|\| !msg\.message_id\) return null;/);
  assert.strictEqual(forwards.length, 0);
});

test("a failure says what to check", () => {
  // "mirror failed: Forbidden" sends an operator reading pm2 logs nowhere.
  const src = read("channels/post.js");
  assert.match(src, /is the bot a member of the group, and can it post there\?/);
});
