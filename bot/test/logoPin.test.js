// PIN THE ARTWORK — what ends "mengapa selalu seperti ini".
//
// $GG's picture was a link to a public IPFS gateway; whether that gateway had
// the CID cached changed hour by hour, and the same code loaded it on two
// deploys and failed on two. A logo that has loaded ONCE is bytes in hand: the
// bot uploads them to /api/media and points the row at our own copy, so no
// later banner, Telegram photo, tweet or board ever asks a gateway again.
//
// Driven over the same global.fetch seam bannerLogo.test.js uses, routed by
// url. ⚠️ ANY GATEWAY HOST BEING ASKED FAILS THE TEST — that is the promise.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-logopin-"));
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "test-token";

const test = require("node:test");
const assert = require("node:assert");
const fulfil = require("../src/fulfillment");
const { DEXVRA_API_BASE } = require("../src/config/constants");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const CID_URL = "https://ipfs.io/ipfs/bafybeibk74wtpsgccfehq4zatxgorv5pwfmtpy7qo7hj6kbvko5nmvokba";
const UPLOAD = "/api/media/0123456789abcdef01234567.png";
const ROW = { chain: "solana", address: "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump" };

/** Routes by url; records every upload body and every pin body. */
function stub(over = {}) {
  const orig = global.fetch;
  const calls = { asked: [], uploads: [], pins: [] };
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.asked.push(u);
    if (u.includes("/api/logo?u=")) {
      return over.logo ? over.logo() : { ok: true, status: 200, headers: { get: (k) => (k === "x-logo-via" ? "pump.mypinata.cloud 380ms" : null) }, arrayBuffer: async () => PNG };
    }
    if (u.endsWith("/api/internal/upload")) {
      calls.uploads.push(init.body);
      return over.upload ? over.upload() : { ok: true, status: 200, json: async () => ({ url: UPLOAD }) };
    }
    if (u.endsWith("/api/internal/listings/pin-logo")) {
      calls.pins.push(JSON.parse(init.body));
      // ⚠️ api.call() reads res.text(), not res.json() — a stub without text()
      // makes api.pinLogo THROW, the best-effort catch returns the original url,
      // and the positive test fails while claiming the pin never fired. A test
      // measuring its own fake, one more time.
      return over.pin ? over.pin() : { ok: true, status: 200, text: async () => JSON.stringify({ pinned: true }) };
    }
    if (u.startsWith(`${DEXVRA_API_BASE}/api/media/`)) {
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG };
    }
    throw new Error(`a GATEWAY was asked directly: ${u}`); // ipfs.io, dweb.link, pinata…
  };
  return { calls, restore: () => (global.fetch = orig) };
}

test("⚠️ POSITIVE: a loaded external logo is uploaded and the row is pointed at our copy", async () => {
  // The curveBuyPath rule: a wiring that does nothing refuses beautifully, so
  // this asserts the pin HAPPENED and what it carried.
  const { calls, restore } = stub();
  try {
    const out = await fulfil._pinLogo(ROW, CID_URL, PNG);
    assert.strictEqual(out, UPLOAD, "this post renders from our own copy");
    assert.strictEqual(calls.uploads.length, 1, "exactly one upload");
    assert.strictEqual(calls.pins.length, 1, "exactly one CAS");
    assert.deepStrictEqual(calls.pins[0], { chain: ROW.chain, address: ROW.address, fromUrl: CID_URL, toUrl: UPLOAD });
  } finally {
    restore();
  }
});

test("⚠️ THE PROMISE: a pinned url is read off THIS BOX, and no gateway is ever asked again", async () => {
  const { calls, restore } = stub();
  try {
    const x = await fulfil._fetchLogoUrlX(UPLOAD);
    assert.ok(x.bytes && x.bytes.length);
    assert.strictEqual(x.source, "upload");
    assert.strictEqual(calls.asked.length, 1);
    assert.strictEqual(calls.asked[0], `${DEXVRA_API_BASE}${UPLOAD}`, "localhost, the media route, nothing else");
    assert.ok(!calls.asked.some((u) => u.includes("/api/logo")), "not even our own proxy");
  } finally {
    restore();
  }
});

test("best-effort: a refused CAS returns the ORIGINAL url and throws nothing", async () => {
  // An admin changed the logo in the window — their decision wins, the post
  // renders from what it fetched, and nothing about the order is affected.
  const { restore } = stub({ pin: () => ({ ok: true, status: 200, text: async () => JSON.stringify({ pinned: false }) }) });
  try {
    assert.strictEqual(await fulfil._pinLogo(ROW, CID_URL, PNG), CID_URL);
  } finally {
    restore();
  }
});

test("best-effort: an upload the route declines (500, or an SVG) returns the original", async () => {
  const { calls, restore } = stub({ upload: () => ({ ok: false, status: 500, json: async () => ({ error: "unsupported" }) }) });
  try {
    assert.strictEqual(await fulfil._pinLogo(ROW, CID_URL, PNG), CID_URL);
    assert.strictEqual(calls.pins.length, 0, "no CAS without an upload to point at");
  } finally {
    restore();
  }
});

test("⚠️ best-effort: a pin that HANGS returns the original inside PIN_LOGO_MS — a pin may never cost a paid post", async () => {
  // ⚠️ The stub's delay is REFFED and only a few seconds past the bound. The
  // first cut slept 60s unref'd — and with `bounded` removed the test simply
  // hung the file, which node:test reported as NOTHING failing. A guard that
  // hangs instead of failing is the silence it was written to end.
  const { restore } = stub({
    pin: () => new Promise((r) => setTimeout(() => r({ ok: true, status: 200, text: async () => JSON.stringify({ pinned: true }) }), fulfil._PIN_LOGO_MS + 3000)),
  });
  try {
    const t0 = Date.now();
    const out = await fulfil._pinLogo(ROW, CID_URL, PNG);
    const took = Date.now() - t0;
    assert.strictEqual(out, CID_URL);
    assert.ok(took < fulfil._PIN_LOGO_MS + 1500, `returned in ${took}ms, bound is ${fulfil._PIN_LOGO_MS}ms`);
  } finally {
    restore();
  }
});

test("an url that is already OURS, in either spelling, makes ZERO upload calls", async () => {
  // Re-uploading on every trending purchase would be one file per post.
  const { calls, restore } = stub();
  try {
    assert.strictEqual(await fulfil._pinLogo(ROW, UPLOAD, PNG), UPLOAD);
    assert.strictEqual(await fulfil._pinLogo(ROW, `http://127.0.0.1:3005${UPLOAD}`, PNG), `http://127.0.0.1:3005${UPLOAD}`);
    assert.strictEqual(calls.uploads.length, 0);
    assert.strictEqual(calls.pins.length, 0);
  } finally {
    restore();
  }
});

test("no bytes, no pin — and a non-http url is never pinned", async () => {
  const { calls, restore } = stub();
  try {
    assert.strictEqual(await fulfil._pinLogo(ROW, CID_URL, null), CID_URL);
    assert.strictEqual(await fulfil._pinLogo(ROW, "ipfs://bafk", PNG), "ipfs://bafk");
    assert.strictEqual(calls.uploads.length, 0);
  } finally {
    restore();
  }
});

test("⚠️ the X form carries the proxy's facts: via on a 200, status + why on a refusal", async () => {
  const good = stub();
  try {
    const x = await fulfil._fetchLogoUrlX(CID_URL);
    assert.strictEqual(x.source, "proxy");
    assert.strictEqual(x.via, "pump.mypinata.cloud 380ms", "which gateway answered, and how fast");
  } finally {
    good.restore();
  }
  const badP = stub({
    logo: () => ({ ok: false, status: 404, headers: { get: (k) => (k === "x-logo-why" ? "ipfs.io: no answer after 5000ms; gateway.pinata.cloud: HTTP 429 after 310ms" : null) }, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  try {
    const x = await fulfil._fetchLogoUrlX(CID_URL);
    assert.strictEqual(x.bytes, null);
    assert.strictEqual(x.reached, true);
    assert.strictEqual(x.status, 404);
    assert.match(x.why, /HTTP 429 after 310ms/, "the per-gateway reason travels verbatim");
  } finally {
    badP.restore();
  }
});

test("BOTH fulfilment siblings pin, before the url is read by the watch and the media", () => {
  // A rule applied to one of two siblings is a rule half-made — this file's
  // scar, three times over. Comment-stripped, so the docs cannot satisfy it.
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const pins = src.match(/= await pinLogo\(/g) || [];
  assert.strictEqual(pins.length, 2, "a listing and a trending slot");
  // `= await` — the wrapper `fetchLogoUrl` reads `(await fetchLogoUrlX(…)).bytes`
  // and is not a call site; the two that assign `logoFetch` are.
  const xs = src.match(/= await fetchLogoUrlX\(/g) || [];
  assert.strictEqual(xs.length, 2, "both read through the X form so the watch gets the facts");
  // Ordering: the listing's pin sits above its reportFigures call.
  const pinAt = src.indexOf("input.logoUrl = await pinLogo(");
  const watchAt = src.indexOf('kind: "listing", chain: input.chain');
  assert.ok(pinAt > 0 && watchAt > pinAt, "the listing pins BEFORE the watch reads the url");
  const tPin = src.indexOf("row.logoUrl = await pinLogo(");
  const tWatch = src.indexOf('kind: "trending", chain: p.chain');
  assert.ok(tPin > 0 && tWatch > tPin, "…and so does the trending slot");
});
