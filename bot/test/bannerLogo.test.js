// "lalu lgo juga bermasalah" — the $WROTE listing banner went out to 12,523
// subscribers drawing the DEXVRA DIAMOND where the token's artwork belongs,
// for a token whose picture is on its own pad page and whose contract
// publishes it.
//
// Nothing upstream was broken. The Pons reader had already been fixed to
// publish the `ipfs://<cid>` the contract carries, and the bot rewrites that to
// ONE hardcoded gateway (`PONS_IPFS_GATEWAY`, ipfs.io). Then `fetchLogoUrl`
// fetched that url RAW: a gateway that has not pinned the CID answers 404, the
// buffer came back null, the fallback artwork shipped — and the `catch` said
// nothing at all.
//
// That is "never one hardcoded host" and "a guard is only honest while it
// measures the stack the caller actually uses" in the same three lines. The
// SITE has had gateway failover since the $BREAKING round; the banners went
// around `/api/logo` entirely, so fixing the website's gateway list bought the
// channel nothing.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bannerlogo-"));

const test = require("node:test");
const assert = require("node:assert");
const { _fetchLogoUrl: fetchLogoUrl, _photoSource: photoSource } = require("../src/fulfillment");
const { SITE_URL, DEXVRA_API_BASE } = require("../src/config/constants");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
// What ponsChain.httpsLogo stores for a Pons launch: a gateway url, which is
// exactly the spelling that had no second chance.
const IPFS_LOGO = "https://ipfs.io/ipfs/bafkreiwalletroute";

/** Record every url fetched, and answer per-url. `undefined` = unreachable. */
function stubFetch(router) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const body = router(u);
    if (body === undefined) throw new Error("ECONNREFUSED");
    if (body === null) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer ?? body };
  };
  return { asked, restore: () => (global.fetch = orig) };
}

const isProxy = (u) => u.includes("/api/logo?u=");

test("a token logo is fetched THROUGH the site's image proxy, never raw", async () => {
  // ⚠️ THE POSITIVE TEST. A version that still fetched the raw url would fail
  // no assertion about refusals — it would simply draw the wrong thing, which
  // is what shipped.
  const { asked, restore } = stubFetch((u) => (isProxy(u) ? PNG : null));
  try {
    const buf = await fetchLogoUrl(IPFS_LOGO);
    assert.ok(buf && buf.length, "the proxy had the artwork — the banner must get bytes");
    assert.strictEqual(asked.length, 1, `one request: ${asked.join(", ")}`);
    assert.ok(isProxy(asked[0]), `must go through /api/logo: ${asked[0]}`);
    // The CID has to survive the hop, or the proxy cannot fail over to another
    // gateway — which is the entire reason for going through it.
    assert.ok(
      decodeURIComponent(asked[0]).includes(IPFS_LOGO),
      `the original url must travel intact: ${asked[0]}`,
    );
  } finally {
    restore();
  }
});

test("…over DEXVRA_API_BASE, because WE are the one fetching", async () => {
  // Same box. A public round trip to dexvra.io for our own proxy is latency on
  // the path a buyer is waiting on.
  const { asked, restore } = stubFetch((u) => (isProxy(u) ? PNG : null));
  try {
    await fetchLogoUrl(IPFS_LOGO);
    assert.ok(asked[0].startsWith(DEXVRA_API_BASE), `expected localhost: ${asked[0]}`);
  } finally {
    restore();
  }
});

test("⚠️ a REFUSAL by the proxy is an ANSWER and is not retried raw", async () => {
  // The proxy carries the hotlink allowlist and the redirect re-check. Falling
  // back to a direct read on a refusal would defeat both, and would put a
  // picture in the channel that the token's own page cannot draw.
  const { asked, restore } = stubFetch((u) => (isProxy(u) ? null : PNG));
  try {
    const buf = await fetchLogoUrl(IPFS_LOGO);
    assert.strictEqual(buf, null, "refused means refused");
    assert.strictEqual(asked.length, 1, `the raw url must NOT be tried: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test("…but a proxy that cannot be REACHED still falls through to a direct read", async () => {
  // A web app mid-deploy must not cost every listing its artwork. "Could not
  // ask" and "answered no" are different facts — this file's oldest rule.
  const { asked, restore } = stubFetch((u) => (isProxy(u) ? undefined : PNG));
  try {
    const buf = await fetchLogoUrl(IPFS_LOGO);
    assert.ok(buf && buf.length, "the direct read is exactly what this did before");
    assert.strictEqual(asked.length, 2);
    assert.strictEqual(asked[1], IPFS_LOGO);
  } finally {
    restore();
  }
});

test("an UPLOAD is read straight off our own disk — nothing to fail over to", async () => {
  const { asked, restore } = stubFetch(() => PNG);
  try {
    const buf = await fetchLogoUrl("/api/media/abc.png");
    assert.ok(buf && buf.length);
    assert.strictEqual(asked[0], `${SITE_URL}/api/media/abc.png`);
    assert.ok(!isProxy(asked[0]), "our own file needs no allowlist and no gateway");
  } finally {
    restore();
  }
});

test("⚠️ photoSource proxies too — and over the PUBLIC origin, because Telegram fetches it", async () => {
  // The last-resort media is the token logo url itself. Handing Telegram a bare
  // ipfs.io url is the same defect on the one path whose fallback is no picture
  // at all — and localhost:3005 is not a place Telegram can reach.
  const src = photoSource(null, IPFS_LOGO);
  assert.ok(isProxy(src), `expected the proxy: ${src}`);
  assert.ok(src.startsWith(SITE_URL), `Telegram needs the public origin: ${src}`);
  assert.ok(decodeURIComponent(src).includes(IPFS_LOGO));

  // An uploaded file and a Telegram file_id are unchanged.
  assert.strictEqual(photoSource("file_123", IPFS_LOGO), "file_123");
  assert.strictEqual(photoSource(null, "/api/media/abc.png"), `${SITE_URL}/api/media/abc.png`);
  assert.strictEqual(photoSource(null, null), null);
});

test("concurrent logo fetches do not read each other's 'was the proxy up'", async () => {
  // ⚠️ The reachability verdict travels back WITH the bytes rather than living
  // in a module-level flag: a listing and its trending slot are fetched
  // concurrently here, and a shared variable would be read by whichever call
  // happened to look after somebody else's write. Here the proxy REFUSES one
  // url and is UNREACHABLE for the other; each must take its own branch.
  const REFUSED = "https://cdn.example.com/refused.png";
  const { asked, restore } = stubFetch((u) => {
    if (isProxy(u)) return decodeURIComponent(u).includes("refused") ? null : undefined;
    return PNG;
  });
  try {
    const [refused, unreachable] = await Promise.all([fetchLogoUrl(REFUSED), fetchLogoUrl(IPFS_LOGO)]);
    assert.strictEqual(refused, null, "a refusal is not retried raw, whatever the other call saw");
    assert.ok(unreachable && unreachable.length, "an unreachable proxy still falls through");
    assert.ok(!asked.includes(REFUSED), `the refused url must never be fetched raw: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

// ── TWO SPELLINGS OF ONE UPLOAD ──────────────────────────────────────────────
//
// api.uploadImage returned `${DEXVRA_API_BASE}${url}` — an ABSOLUTE
// `http://127.0.0.1:3005/api/media/<hex>.png` — while its call site said
// "relative", and the row was stored that way for a month. When this bot's
// banner fetch moved behind /api/logo, that url was proxied, refused (non-https
// localhost is not on the allowlist), NOT retried raw (a refusal is an answer),
// and the warn blamed "no gateway served it as an image" — about a file on
// this machine. Found by driving it, not by post:check: the five newest rows
// all carried external logos.
const HEX = "0123456789abcdef01234567";
const REL = `/api/media/${HEX}.png`;
const OLD_SHAPE = `http://127.0.0.1:3005${REL}`;

test("⚠️ an upload stored in the OLD absolute spelling is fetched as OUR file, never proxied", async () => {
  const { asked, restore } = stubFetch((u) => (isProxy(u) ? null : PNG)); // the proxy would 400 it
  try {
    const buf = await fetchLogoUrl(OLD_SHAPE);
    assert.ok(buf && buf.length, "artwork on our own disk must reach the banner");
    assert.strictEqual(asked.length, 1);
    assert.ok(!isProxy(asked[0]), `must not go through /api/logo: ${asked[0]}`);
    assert.ok(asked[0].startsWith(DEXVRA_API_BASE) && asked[0].endsWith(REL), `read over localhost: ${asked[0]}`);
  } finally {
    restore();
  }
});

test("…and the relative spelling is read over DEXVRA_API_BASE too — no public round trip for a local file", async () => {
  const { asked, restore } = stubFetch(() => PNG);
  try {
    await fetchLogoUrl(REL);
    assert.strictEqual(asked[0], `${DEXVRA_API_BASE}${REL}`);
  } finally {
    restore();
  }
});

test("⚠️ a FOREIGN host that copies our path is still proxied — and still refused", async () => {
  // Recognising the path alone would let a stranger's url skip the allowlist.
  const { asked, restore } = stubFetch((u) => (isProxy(u) ? null : PNG));
  try {
    const buf = await fetchLogoUrl(`https://evil.example${REL}`);
    assert.strictEqual(buf, null);
    assert.ok(isProxy(asked[0]), `must go through the proxy: ${asked[0]}`);
    assert.strictEqual(asked.length, 1, "and a refusal is not retried raw");
  } finally {
    restore();
  }
});

test("photoSource hands Telegram the PUBLIC relative url for an old-shape upload", () => {
  assert.strictEqual(photoSource(null, OLD_SHAPE), `${SITE_URL}${REL}`);
  assert.strictEqual(photoSource(null, REL), `${SITE_URL}${REL}`);
});

test("⚠️ the proxy's x-logo-why reaches the warn — never one sentence for every refusal", async () => {
  // /api/logo names the per-gateway outcome on a header precisely so this side
  // can say WHICH refusal it was. readImage threw it away, so an allowlist 400,
  // a directory listing and a dead gateway all printed "no gateway served it".
  const log = require("../src/helpers/logger");
  const warns = [];
  const origWarn = log.warn;
  log.warn = (m) => warns.push(String(m));
  const orig = global.fetch;
  global.fetch = async (url) => {
    if (isProxy(String(url))) {
      return {
        ok: false,
        status: 404,
        headers: { get: (k) => (k === "x-logo-why" ? "ipfs.io: HTTP 404; pump.mypinata.cloud: served text/html" : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return { ok: true, status: 200, arrayBuffer: async () => PNG };
  };
  try {
    await fetchLogoUrl(IPFS_LOGO);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /pump\.mypinata\.cloud: served text\/html/, `the reason must travel: ${warns[0]}`);
    assert.ok(!/no gateway served it as an image/.test(warns[0]), "the generic sentence must not replace a specific one");
  } finally {
    global.fetch = orig;
    log.warn = origWarn;
  }
});

test("…and a refusal with NO header still names the status rather than a gateway", async () => {
  const log = require("../src/helpers/logger");
  const warns = [];
  const origWarn = log.warn;
  log.warn = (m) => warns.push(String(m));
  const { restore } = stubFetch((u) => (isProxy(u) ? null : PNG)); // 404, no headers at all
  try {
    await fetchLogoUrl(IPFS_LOGO);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /proxy answered HTTP 404/, warns[0]);
  } finally {
    restore();
    log.warn = origWarn;
  }
});
