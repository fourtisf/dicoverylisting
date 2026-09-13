// The X metrics resolver. Most of these pin the difference between "we could
// not read" and "nothing happened" — collapsing those paints a live raid at 0.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-xm-"));

const test = require("node:test");
const assert = require("node:assert");
const x = require("../src/raid/xMetrics");
const xEmbed = require("../src/raid/xEmbed");
const xGuest = require("../src/raid/xGuest");

const ID = "2084979178378498146";
const REAL_TOKEN = `AAAAAAAAAAAAAAAAAAAAA${"x9Kq".repeat(20)}%3DdexvraRaid`;

let realFetch;
test.beforeEach(() => {
  realFetch = global.fetch;
  x._reset();
  xEmbed._reset();
  xGuest._reset();
  delete process.env.X_BEARER_TOKEN;
  delete process.env.X_GUEST_QUERY_ID;
  // The two keyless sources are ON by default (src/raid/sourceFlag.js). Almost
  // every test below is about ONE path, so it pins the others off EXPLICITLY
  // rather than leaning on an ambient default — which is exactly what made this
  // file fragile the day that default changed: "no token" silently stopped
  // meaning "no source". The handful of tests that are ABOUT the default delete
  // these two lines themselves.
  process.env.RAID_FREE_METRICS = "0";
  process.env.RAID_GUEST_METRICS = "0";
});
test.afterEach(() => {
  global.fetch = realFetch;
});

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const apiBody = (over = {}) => ({
  data: { text: "gm", public_metrics: { like_count: 200, reply_count: 10, retweet_count: 5, quote_count: 1, ...over } },
});

// ── URL parsing ──────────────────────────────────────────────────────────────

test("every shape an admin might paste resolves to the same post id", () => {
  for (const u of [
    `https://x.com/dexvraio/status/${ID}`,
    `https://twitter.com/dexvraio/status/${ID}?s=20&t=abc`,
    `https://x.com/i/web/status/${ID}`,
    `http://www.twitter.com/someone/statuses/${ID}`,
    ID,
  ]) {
    assert.strictEqual(x.parseTweetId(u), ID, u);
  }
});

test("a profile link or junk is not a post", () => {
  for (const u of ["https://x.com/dexvraio", "https://dexvra.io", "", null, "hello"]) {
    assert.strictEqual(x.parseTweetId(u), null);
  }
});

test("the stored link is canonical, so a later handle change can't break it", () => {
  assert.strictEqual(x.tweetUrl(ID), `https://x.com/i/status/${ID}`);
});

// ── Placeholder token ────────────────────────────────────────────────────────

test("the .env.example placeholder is recognised WITHOUT asking X", async () => {
  // Provoking a 401 arms a process-wide cooldown, so one config typo would
  // blind every group's raid for two minutes at a time, in a loop, forever.
  process.env.X_BEARER_TOKEN = "AAAAAAAAAAAAAAA";
  assert.strictEqual(x.apiToken(), "");
  let called = 0;
  global.fetch = async () => { called++; return jsonRes(apiBody()); };
  const res = await x.fetchTweetMetrics(ID);
  assert.strictEqual(called, 0);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(x.isOnCooldown(), false);
});

test("a REAL token starts with a run of A's and must not be rejected", () => {
  // This is why the check is anchored at both ends: /^A+/ without $ would
  // throw away every genuine app-only bearer token.
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  assert.strictEqual(x.apiToken(), REAL_TOKEN);
});

test("with no source at all, the advice points at the keyless way through", async () => {
  const res = await x.fetchTweetMetrics(ID);
  assert.strictEqual(res.ok, false);
  assert.match(res.advice, /Crew goal/);
  assert.match(res.advice, /X_BEARER_TOKEN/);
});

// ── The paid path ────────────────────────────────────────────────────────────

test("a successful read maps X's field names to ours", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  global.fetch = async () => jsonRes(apiBody());
  const res = await x.fetchTweetMetrics(ID);
  assert.deepStrictEqual(
    { ok: res.ok, likes: res.likes, replies: res.replies, retweets: res.retweets, source: res.source },
    { ok: true, likes: 200, replies: 10, retweets: 5, source: "api" },
  );
});

test("403 reads as OUT OF CREDITS, not as a plan tier — credits exhaust silently", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  global.fetch = async () => jsonRes({}, 403);
  const res = await x.fetchTweetMetrics(ID);
  assert.match(res.error, /credit/i);
  assert.match(res.advice, /pay-per-use/i);
  assert.strictEqual(x.isOnCooldown(), true);
});

test("401 names the variable and the restart that actually applies it", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  global.fetch = async () => jsonRes({}, 401);
  const res = await x.fetchTweetMetrics(ID);
  assert.match(res.advice, /X_BEARER_TOKEN/);
  assert.strictEqual(x.isOnCooldown(), true);
});

test("a 429 backs off for EVERY post — X rate-limits the app, not the post", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  let calls = 0;
  global.fetch = async () => { calls++; return jsonRes({}, 429); };
  await x.fetchTweetMetrics(ID);
  const res = await x.fetchTweetMetrics("999999999");
  assert.strictEqual(calls, 1, "the second post never reached X");
  assert.strictEqual(res.cooldown, true);
});

test("a 404 does NOT arm the cooldown — one dead post must not blind every raid", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  global.fetch = async () => jsonRes({}, 404);
  const res = await x.fetchTweetMetrics(ID);
  assert.strictEqual(res.gone, true);
  assert.strictEqual(x.isOnCooldown(), false);
});

test("a `gone` post short-circuits — every source would say the same thing", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  process.env.RAID_FREE_METRICS = "1";
  const hosts = [];
  global.fetch = async (url) => {
    hosts.push(new URL(String(url)).host);
    return jsonRes({}, 404);
  };
  await x.fetchTweetMetrics(ID);
  assert.deepStrictEqual(hosts, ["api.x.com"], "the free source is never asked");
});

// ── Caching ──────────────────────────────────────────────────────────────────

test("N groups raiding the SAME post cost one read; a different post does not", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  let calls = 0;
  global.fetch = async () => { calls++; return jsonRes(apiBody()); };
  await x.fetchTweetMetrics(ID);
  await x.fetchTweetMetrics(ID);
  assert.strictEqual(calls, 1);
  await x.fetchTweetMetrics("111111111");
  assert.strictEqual(calls, 2, "one post's cache never answers for another");
});

test("a baseline read bypasses the cache — it defines what '+15' means", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  let calls = 0;
  global.fetch = async () => { calls++; return jsonRes(apiBody()); };
  await x.fetchTweetMetrics(ID);
  await x.fetchTweetMetrics(ID, { force: true });
  assert.strictEqual(calls, 2);
});

test("failures are never cached, so a recovery is seen on the next poll", async () => {
  process.env.X_BEARER_TOKEN = REAL_TOKEN;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1 ? jsonRes({}, 500) : jsonRes(apiBody());
  };
  assert.strictEqual((await x.fetchTweetMetrics(ID)).ok, false);
  assert.strictEqual((await x.fetchTweetMetrics(ID)).ok, true);
});

// ── The keyless sources ──────────────────────────────────────────────────────

test("the embed source reports retweets as null, never 0", async () => {
  // 0 would read as "nobody has reposted yet" and leave a goal at 0/5 for the
  // whole raid; null lets the launcher drop a goal it can never measure.
  process.env.RAID_FREE_METRICS = "1";
  global.fetch = async () => jsonRes({ favorite_count: 12, conversation_count: 4, text: "hi" });
  const res = await x.fetchTweetMetrics(ID);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.retweets, null);
  assert.deepStrictEqual(res.unsupported, ["retweets"]);
});

test("an HTTP 200 with an empty body is a FAILURE, not a reading of zero", async () => {
  process.env.RAID_FREE_METRICS = "1";
  // The last two are JSON OBJECTS with no counts — X's tombstone shape, and a
  // bare {}. A typeof check alone lets those through as "0 likes", which would
  // launch a raid from a baseline of zero and then complete it on the next poll
  // the moment the endpoint answered properly, with no engagement generated.
  for (const body of ["", "<!DOCTYPE html><html>bot check</html>", null, { __typename: "TweetTombstone" }, {}]) {
    xEmbed._reset();
    x._reset();
    global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
    const res = await x.fetchTweetMetrics(ID);
    assert.strictEqual(res.ok, false, JSON.stringify(body));
    assert.strictEqual(res.likes, undefined, "a partial object would paint a live raid at zero");
  }
});

test("the guest source is tried BEFORE the embed one — it answers about reposts", async () => {
  process.env.RAID_GUEST_METRICS = "1";
  process.env.RAID_FREE_METRICS = "1";
  const hosts = [];
  global.fetch = async (url) => {
    const u = new URL(String(url));
    hosts.push(u.pathname);
    if (u.pathname.includes("guest/activate")) return jsonRes({ guest_token: "G1" });
    return jsonRes({ data: { tweetResult: { result: { legacy: { favorite_count: 9, reply_count: 2, retweet_count: 3 } } } } });
  };
  const res = await x.fetchTweetMetrics(ID);
  assert.strictEqual(res.source, "guest");
  assert.strictEqual(res.retweets, 3);
  assert.ok(!hosts.some((p) => p.includes("tweet-result")), "the embed source was never needed");
});

test("a genuinely unliked post still reads as a real zero", () => {
  // The guard is the PRESENCE of the field, not its truthiness.
  process.env.RAID_FREE_METRICS = "1";
  global.fetch = async () => jsonRes({ favorite_count: 0, conversation_count: 0, text: "new post" });
  return x.fetchTweetMetrics(ID).then((res) => {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.likes, 0);
  });
});

test("a guest 404 does not blind every other group", async () => {
  // One deleted post must not arm a process-wide backoff — and it is worse
  // here than on the paid path, because this source never reports `gone`, so
  // the raid on the dead post keeps polling for its full hour.
  process.env.RAID_GUEST_METRICS = "1";
  global.fetch = async (url) =>
    String(url).includes("guest/activate") ? jsonRes({ guest_token: "G1" }) : jsonRes({}, 404);
  await xGuest.fetchGuestMetrics(ID);
  assert.strictEqual(xGuest.isOnCooldown(), false);
});

test("a guest 404 is AMBIGUOUS, so it never claims the post is gone", async () => {
  // It could equally mean X rotated its GraphQL hash. Claiming `gone` would
  // cancel every live raid on healthy posts the first time that happens.
  process.env.RAID_GUEST_METRICS = "1";
  global.fetch = async (url) =>
    String(url).includes("guest/activate") ? jsonRes({ guest_token: "G1" }) : jsonRes({}, 404);
  const res = await xGuest.fetchGuestMetrics(ID);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.gone, undefined);
});

test("the guest token is minted once and reused across posts", async () => {
  process.env.RAID_GUEST_METRICS = "1";
  let mints = 0;
  global.fetch = async (url) => {
    if (String(url).includes("guest/activate")) {
      mints++;
      return jsonRes({ guest_token: "G1" });
    }
    return jsonRes({ data: { tweetResult: { result: { legacy: { favorite_count: 1, reply_count: 0, retweet_count: 0 } } } } });
  };
  await xGuest.fetchGuestMetrics("1");
  await xGuest.fetchGuestMetrics("2");
  await xGuest.fetchGuestMetrics("3");
  // Activation is itself rate limited — minting per poll gets the host blocked
  // faster than the reads would.
  assert.strictEqual(mints, 1);
});

test("a stale guest session is refreshed exactly once, then it gives up", async () => {
  process.env.RAID_GUEST_METRICS = "1";
  let mints = 0;
  let reads = 0;
  global.fetch = async (url) => {
    if (String(url).includes("guest/activate")) {
      mints++;
      return jsonRes({ guest_token: `G${mints}` });
    }
    reads++;
    return jsonRes({}, 403);
  };
  const res = await xGuest.fetchGuestMetrics(ID);
  assert.strictEqual(mints, 2);
  assert.strictEqual(reads, 2);
  assert.strictEqual(res.ok, false);
});

test("a bad X_GUEST_FEATURES override falls back instead of taking the source down", () => {
  process.env.X_GUEST_FEATURES = "{not json";
  assert.deepStrictEqual(xGuest.features(), xGuest.DEFAULT_FEATURES);
  delete process.env.X_GUEST_FEATURES;
});

// ── The source defaults ──────────────────────────────────────────────────────

test("both keyless sources ship ON — a stock bot must be able to read a post", () => {
  // The reversal this pins: with all three sources off, `anySource()` is false,
  // every raid launches crew-only, and likes/replies/reposts can NEVER appear.
  // From inside Telegram that is indistinguishable from a broken feature — the
  // goals sit on the card and the numbers never move.
  delete process.env.RAID_FREE_METRICS;
  delete process.env.RAID_GUEST_METRICS;
  assert.strictEqual(xEmbed.isEnabled(), true);
  assert.strictEqual(xGuest.isEnabled(), true);
  assert.strictEqual(x.anySource(), true, "a bot with no X token at all can still read a post");
});

test("a BLANK value still means on — that line is what .env.example used to ship", () => {
  // `RAID_GUEST_METRICS=` is "the operator never decided", not "the operator
  // said no". Reading it as a refusal would keep the source dark on exactly the
  // boxes that copied the template without editing it. Note this deliberately
  // differs from config/constants.js's bool(), where "" is false.
  process.env.RAID_FREE_METRICS = "";
  process.env.RAID_GUEST_METRICS = "   ";
  assert.strictEqual(xEmbed.isEnabled(), true);
  assert.strictEqual(xGuest.isEnabled(), true);
});

test("an explicit 0 always wins — turning a source off must stay expressible", () => {
  // Both modules carry real warnings about datacenter IP blocks and about the
  // embed source's reply count being the whole conversation. An operator who
  // reads them has to be able to act on them.
  for (const off of ["0", "false", "no", "off", "OFF"]) {
    process.env.RAID_FREE_METRICS = off;
    process.env.RAID_GUEST_METRICS = off;
    assert.strictEqual(xEmbed.isEnabled(), false, off);
    assert.strictEqual(xGuest.isEnabled(), false, off);
  }
});

// ── The self-healing operation id ────────────────────────────────────────────

test("an operator-pinned X_GUEST_QUERY_ID always wins and is never rediscovered", async () => {
  // It is the documented escape hatch. A hatch that quietly ignores the value
  // you put in it is worse than no hatch at all.
  process.env.RAID_GUEST_METRICS = "1";
  process.env.X_GUEST_QUERY_ID = "PINNED_BY_OPERATOR";
  assert.deepStrictEqual(xGuest.queryId(), { id: "PINNED_BY_OPERATOR", from: "env" });
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return String(url).includes("guest/activate") ? jsonRes({ guest_token: "G1" }) : jsonRes({}, 404);
  };
  await xGuest.fetchGuestMetrics(ID);
  assert.ok(urls.some((u) => u.includes("PINNED_BY_OPERATOR")), "their id was the one actually used");
  assert.ok(!urls.some((u) => u.includes("abs.twimg.com")), "and no rediscovery ran behind their back");
});

test("a 404 rediscovers the rotated hash from x.com's bundle and retries ONCE", async () => {
  // A rotation 404s every post. The bundle that broke us also carries the fix,
  // so the honest response is to read it rather than page an operator who may
  // be asleep while every group's repost goal sits at zero.
  process.env.RAID_GUEST_METRICS = "1";
  const BUNDLE = "https://abs.twimg.com/responsive-web/client-web/api.abc123.js";
  const graphqlIds = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("guest/activate")) return jsonRes({ guest_token: "G1" });
    if (u === "https://x.com/") return { ok: true, status: 200, text: async () => `<script src="${BUNDLE}"></script>` };
    if (u === BUNDLE) {
      return { ok: true, status: 200, text: async () => `x={queryId:"FRESHqueryId01",operationName:"TweetResultByRestId"}` };
    }
    const id = u.split("/graphql/")[1].split("/")[0];
    graphqlIds.push(id);
    // The seed is stale; the rediscovered id works.
    if (id !== "FRESHqueryId01") return jsonRes({}, 404);
    return jsonRes({ data: { tweetResult: { result: { legacy: { favorite_count: 7, reply_count: 2, retweet_count: 4 } } } } });
  };
  const res = await xGuest.fetchGuestMetrics(ID);
  assert.deepStrictEqual(graphqlIds, [xGuest.SEED_QUERY_ID, "FRESHqueryId01"], "stale id, then the rediscovered one");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.retweets, 4, "and reposts — the whole reason this source exists — come back");
  assert.deepStrictEqual(xGuest.queryId(), { id: "FRESHqueryId01", from: "discovered" });
});

test("both queryId field orders are matched — builds disagree about which comes first", () => {
  const a = `,{queryId:"AAAAAAAAAA11",operationName:"TweetResultByRestId"},`;
  const b = `,{operationName:"TweetResultByRestId",operationType:"query",queryId:"BBBBBBBBBB22"},`;
  assert.strictEqual(xGuest.findQueryId(a, "TweetResultByRestId"), "AAAAAAAAAA11");
  assert.strictEqual(xGuest.findQueryId(b, "TweetResultByRestId"), "BBBBBBBBBB22");
  assert.strictEqual(xGuest.findQueryId("nothing here", "TweetResultByRestId"), "");
});

test("a queryId is never paired with an operation from a DIFFERENT object", () => {
  // This is what the `[^}]` in the second pattern buys, and it is why that
  // pattern is not loosened to tolerate a nested `metadata:{…}` between the two
  // fields. Reaching across a closing brace would hand back a real-looking id
  // belonging to some other operation — a silent wrong answer, where a missed
  // match merely falls back to the seed and retries in the next window.
  const spanning = `{operationName:"TweetResultByRestId"},{queryId:"CCCCCCCCCC33",operationName:"Other"}`;
  assert.strictEqual(xGuest.findQueryId(spanning, "TweetResultByRestId"), "");
});

test("rediscovery that finds nothing does NOT retry — a second identical 404 is not progress", async () => {
  // Retrying the id X just refused costs one more request against a host that
  // has already said no, and makes a dead end look like a repair.
  process.env.RAID_GUEST_METRICS = "1";
  let graphqlReads = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("guest/activate")) return jsonRes({ guest_token: "G1" });
    if (u === "https://x.com/") return { ok: true, status: 200, text: async () => "<html>no bundles here</html>" };
    graphqlReads++;
    return jsonRes({}, 404);
  };
  const res = await xGuest.fetchGuestMetrics(ID);
  assert.strictEqual(graphqlReads, 1, "exactly one read — the retry was not worth making");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.gone, undefined, "and a 404 here still never claims the post is gone");
  assert.strictEqual(xGuest.isOnCooldown(), false, "nor does it blind every other group");
});

test("discovery is throttled, so an unreachable bundle host is not swept per 404", async () => {
  // A bundle is megabytes. A box that cannot reach abs.twimg.com at all must
  // not re-run the sweep on every poll of every group.
  process.env.RAID_GUEST_METRICS = "1";
  let shellReads = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("guest/activate")) return jsonRes({ guest_token: "G1" });
    if (u === "https://x.com/") {
      shellReads++;
      throw new Error("ENETUNREACH");
    }
    return jsonRes({}, 404);
  };
  await xGuest.fetchGuestMetrics("1");
  await xGuest.fetchGuestMetrics("2");
  await xGuest.fetchGuestMetrics("3");
  assert.strictEqual(shellReads, 1, "one attempt per window, however many posts 404");
});

test("a stub with no .text() cannot crash the discovery path", async () => {
  // Defensive on purpose: discovery runs inside the read path of a live raid,
  // and an unreadable response must cost the repair, never the poll.
  process.env.RAID_GUEST_METRICS = "1";
  global.fetch = async (url) =>
    String(url).includes("guest/activate") ? jsonRes({ guest_token: "G1" }) : jsonRes({}, 404);
  const res = await xGuest.fetchGuestMetrics(ID);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "X's anonymous read endpoint returned nothing for this post");
});
