// Every listing pins itself in the channel it lands in. The failure this guards
// against is not "the pin call is missing" — it is a pin that FAILS SILENTLY:
// the premium GramJS account is often an admin for POSTING only, so its own
// pinMessage is refused with CHAT_ADMIN_REQUIRED while the post itself lands
// fine. That looked exactly like "the bot doesn't pin".
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pin-"));

const test = require("node:test");
const assert = require("node:assert");
const gramjs = require("../src/gramjs");
const post = require("../src/channels/post");

const PAYLOAD = { text: "hello", entities: [{ type: "bold", offset: 0, length: 5 }] };

function harness({ pinThrows = false } = {}) {
  const pins = [];
  post.attach({
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 }),
    sendAnimation: async () => ({ message_id: 3 }),
    sendVideo: async () => ({ message_id: 4 }),
    pinChatMessage: async (chat, id, extra) => {
      if (pinThrows) throw new Error("Bad Request: not enough rights to pin a message");
      pins.push({ chat, id, extra });
      return true;
    },
  });
  return pins;
}

test("bot-api post: pin is awaited, silent, and actually issued", async () => {
  const pins = harness();
  const realAvail = gramjs.available;
  gramjs.available = () => false; // force the Bot API path
  try {
    await post.sendMedia("@dexvralisting", { type: "photo", source: Buffer.from("x") }, PAYLOAD, { pin: true });
    assert.strictEqual(pins.length, 1, "the pin call happened before sendMedia resolved");
    assert.strictEqual(pins[0].chat, "@dexvralisting");
    assert.strictEqual(pins[0].extra.disable_notification, true, "pinning must not notify 12k subscribers");
  } finally {
    gramjs.available = realAvail;
  }
});

test("gramjs post whose OWN pin was refused: the bot pins it instead", async () => {
  const pins = harness();
  const realAvail = gramjs.available;
  const realSend = gramjs.sendToChannel;
  gramjs.available = () => true;
  // Posted fine, but the premium account has no pin rights → pinned: false.
  gramjs.sendToChannel = async () => ({ message_id: 77, chat: { id: -100 }, pinned: false });
  try {
    await post.sendMedia("@dexvralisting", { type: "animation", source: "/tmp/x.mp4" }, PAYLOAD, { pin: true });
    assert.strictEqual(pins.length, 1, "the bot picked up the pin — pinning is not author-restricted");
    assert.strictEqual(pins[0].id, 77, "…of the message gramjs actually posted");
  } finally {
    gramjs.available = realAvail;
    gramjs.sendToChannel = realSend;
  }
});

test("gramjs already pinned it: the bot doesn't pin twice", async () => {
  const pins = harness();
  const realAvail = gramjs.available;
  const realSend = gramjs.sendToChannel;
  gramjs.available = () => true;
  gramjs.sendToChannel = async () => ({ message_id: 78, chat: { id: -100 }, pinned: true });
  try {
    await post.sendMedia("@dexvralisting", { type: "animation", source: "/tmp/x.mp4" }, PAYLOAD, { pin: true });
    assert.strictEqual(pins.length, 0);
  } finally {
    gramjs.available = realAvail;
    gramjs.sendToChannel = realSend;
  }
});

test("no pin requested → nothing is pinned", async () => {
  const pins = harness();
  const realAvail = gramjs.available;
  gramjs.available = () => false;
  try {
    await post.sendMedia("@dexvratrending", { type: "photo", source: Buffer.from("x") }, PAYLOAD);
    assert.strictEqual(pins.length, 0, "the trending channel's pin belongs to the board");
  } finally {
    gramjs.available = realAvail;
  }
});

test("both transports refuse: the post still succeeds, and it is LOUD", async () => {
  harness({ pinThrows: true });
  const realAvail = gramjs.available;
  gramjs.available = () => false;
  try {
    const msg = await post.sendMedia("@dexvralisting", { type: "photo", source: Buffer.from("x") }, PAYLOAD, { pin: true });
    assert.ok(msg && msg.message_id, "a refused pin must never lose the post");
    assert.strictEqual(await post.ensurePinned("@dexvralisting", { message_id: 9 }, false), false, "reports the failure");
  } finally {
    gramjs.available = realAvail;
  }
});

test("the listing card pins in both channels — and the trending card never does", () => {
  // Read line by line: a regex across the whole file trips over the nested
  // parens in fmt.listingPost(coin) and quietly matches nothing.
  const lines = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8").split("\n");
  const sends = lines.filter((l) => l.includes("post.sendMedia(CHANNELS."));
  const listingCard = sends.filter((l) => l.includes("fmt.listingPost("));
  assert.ok(listingCard.length >= 2, `the listing card goes to both channels, found ${listingCard.length}`);
  for (const l of listingCard) assert.ok(/pin: true/.test(l), `listing card must pin: ${l.trim()}`);
  // The Trending board owns the pin in @dexvratrending — a second writer there
  // means one of them silently loses.
  for (const l of sends.filter((l) => l.includes("CHANNELS.trending"))) {
    assert.ok(!/pin: true/.test(l), `must not pin in the trending channel: ${l.trim()}`);
  }
});
