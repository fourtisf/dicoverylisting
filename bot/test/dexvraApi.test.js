// THE SITE-API CLIENT, which had no test at all — and it is the whole write path.
//
// `createListing` is the last step of every free listing, and `canCreate` is
// what 🔎 Test scan and `listing:check` both ask before they promise anything.
// A drift here is invisible in the direction that matters: a POST that really
// created the row but whose envelope we stopped reading makes the bot report
// "the site accepted the request but returned no listing", skip `everListed`,
// never announce, and fire the all-refused blocker — paging the operator about
// a site that is working, while the row quietly exists.
const test = require("node:test");
const assert = require("node:assert");

process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "x".repeat(32);
const api = require("../src/api/dexvra");

function stubFetch(t, handler) {
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  };
  t.after(() => (global.fetch = real));
  return seen;
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a 2xx envelope yields the listing — the field the whole create path reads", async (t) => {
  stubFetch(t, () => json({ listing: { id: "l_1", chain: "solana", sym: "$NINEHOOD" } }));
  const out = await api.createListing({ chain: "solana" });
  assert.strictEqual(out.id, "l_1");
});

test("the request is authenticated and carries JSON", async (t) => {
  const seen = stubFetch(t, () => json({ listing: { id: "l_1" } }));
  await api.createListing({ chain: "solana" });
  assert.match(seen[0].url, /\/api\/internal\/listings$/);
  assert.strictEqual(seen[0].init.method, "POST");
  assert.match(seen[0].init.headers.authorization, /^Bearer /);
  assert.strictEqual(seen[0].init.headers["content-type"], "application/json");
});

test("a non-2xx throws with the STATUS in the message — the scan parses it to tell a payload problem from a credentials one", async (t) => {
  for (const [status, body] of [
    [400, { error: "Invalid ticker" }],
    [401, { error: "Unauthorized" }],
    [500, { error: "boom" }],
  ]) {
    stubFetch(t, () => json(body, status));
    await assert.rejects(
      () => api.createListing({}),
      (e) => {
        assert.match(e.message, new RegExp(`→ ${status}:`), `status missing from: ${e.message}`);
        assert.match(e.message, new RegExp(body.error), "the site's own sentence is the diagnosis");
        return true;
      },
    );
  }
});

test("getListings unwraps the envelope, and answers [] rather than undefined", async (t) => {
  stubFetch(t, () => json({ listings: [{ id: "a" }] }));
  assert.strictEqual((await api.getListings()).length, 1);
  stubFetch(t, () => json({}));
  assert.deepStrictEqual(await api.getListings(), []);
});

// ── canCreate: the probe both diagnostics rely on ───────────────────────────

test("⚠️ canCreate: a 400 is the PASS — authorised, reachable, validator working", async (t) => {
  const seen = stubFetch(t, () => json({ error: "Unknown chain" }, 400));
  const r = await api.canCreate();
  assert.deepStrictEqual(r, { ok: true, status: 400, why: null });
  // …and it can never create: the body is one the site's own validator refuses
  // before `addListing` is ever reached.
  assert.strictEqual(seen[0].init.body, "{}");
});

test("canCreate: 401/403 name the credentials, not the payload", async (t) => {
  for (const status of [401, 403]) {
    stubFetch(t, () => json({ error: "Unauthorized" }, status));
    const r = await api.canCreate();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, status);
    assert.match(r.why, /credentials/);
    assert.match(r.why, /INTERNAL_API_TOKEN/);
  }
});

test("⚠️ canCreate: a site that ACCEPTS an empty payload is a validator hole, not a green tick", async (t) => {
  stubFetch(t, () => json({ listing: { id: "l_1" } }));
  const r = await api.canCreate();
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /accepted an empty listing payload/);
});

test("⚠️ canCreate mirrors the site's 24-char minimum — a 401 over a token both halves agree on sends the operator hunting a mismatch that does not exist", async (t) => {
  const real = process.env.INTERNAL_API_TOKEN;
  const path = require.resolve("../src/api/dexvra");
  const cpath = require.resolve("../src/config/constants");
  try {
    process.env.INTERNAL_API_TOKEN = "short";
    delete require.cache[path];
    delete require.cache[cpath];
    const fresh = require("../src/api/dexvra");
    stubFetch(t, () => {
      throw new Error("must not reach the network");
    });
    const r = await fresh.canCreate();
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /only 5 characters/);
    assert.match(r.why, new RegExp(String(fresh.MIN_TOKEN_LEN)));
  } finally {
    process.env.INTERNAL_API_TOKEN = real;
    delete require.cache[path];
    delete require.cache[cpath];
    require("../src/api/dexvra");
  }
});

test("⚠️ uploadImage returns the RELATIVE url the route answers — never prefixed with DEXVRA_API_BASE", async (t) => {
  // It used to return `${DEXVRA_API_BASE}${json.url}` — an absolute localhost
  // url — while its call site's comment said "relative". The site's validator
  // accepted it, so `http://127.0.0.1:3005/api/media/<hex>.png` was stored on
  // public listings: the site proxied it and drew a monogram, and the bot's own
  // banner fetch later refused it as a foreign host.
  process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "test-token";
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ url: "/api/media/0123456789abcdef01234567.png" }) });
  t.after(() => (global.fetch = real));
  const url = await api.uploadImage(Buffer.from("89504e47", "hex"), "logo.png", "image/png");
  assert.strictEqual(url, "/api/media/0123456789abcdef01234567.png");
  assert.ok(!/^https?:\/\//.test(url), "an absolute url here is the defect");
});
