// The wiring between the three logo pieces, and the proxy that serves what they
// find. These are source guards — weaker than driving the code, and used here
// because the pipeline module imports "@/"-aliased Next modules the test runner
// cannot resolve. Each one pins a defect that has actually happened.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS } from "../config/chains.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PIPELINE = read("src/lib/providers/index.ts");
const PROXY = read("src/app/api/logo/route.ts");
const COIN = read("src/components/Coin.tsx");
const STORE = read("src/lib/store.ts");
/** The proxy's own ALLOW list, parsed from it — so a guard about "every
 *  gateway is allowed" cannot drift from the list it is checking against. */
const ALLOW_HOSTS = [...(PROXY.slice(PROXY.indexOf("const ALLOW = ["), PROXY.indexOf("];", PROXY.indexOf("const ALLOW = ["))).matchAll(/"([a-z0-9.-]+)"/g))].map((m) => m[1]);
/** Comments quote the defect they guard against, so a scan for a banned line
 *  has to read the CODE. Without this the proxy's own warning about
 *  `redirect: "follow"` fails the test that forbids it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ the board no longer merges logos with `t.logoUrl ?? m.logoUrl`", () => {
  // That line could never reach its second operand: rowToBoardToken fills
  // logoUrl with the CDN convention, which is non-null on every DexScreener
  // chain — so a constructed path outranked the real image_url both indexes
  // were handing us, and the row drew a monogram.
  assert.ok(!/logoUrl: t\.logoUrl \?\? m\.logoUrl/.test(PIPELINE), "the inverted ladder is gone");
  assert.match(PIPELINE, /pickLogo\(\{/, "one owner decides which logo a row renders");
  assert.equal(PIPELINE.match(/pickLogo\(/g)?.length, 1, "called in exactly one place — no second ladder");
});

test("the ladder reads the STORED row, not the board token's filled-in guess", () => {
  // …by way of `storedLogo`, which is that row's value minus the one case where
  // it is not a logo at all (see the next test).
  assert.match(PIPELINE, /const storedLogo = row\?\.logoUrl && !isLostUpload\(lost, row\.logoUrl\)/);
  assert.match(PIPELINE, /stored: storedLogo/);
  assert.match(PIPELINE, /live: m\?\.logoUrl/);
  assert.match(PIPELINE, /resolved: knownLogo\(/);
});

test("⚠️ an upload whose file is gone loses to every answer below it", () => {
  // data/listings.json is mirrored to Mongo and restored from it; data/uploads
  // is not. So a box that loses its disk comes back asserting `/api/media/…`
  // for every paid listing with none of those files behind them — and the row
  // is monogrammed FOR EVER, because `pickLogo` calls it "stored" (so the
  // resolver never queues it) and `setResolvedLogo` refuses to write over any
  // logoUrl at all. Two correct guards holding a dead URL between them.
  assert.match(PIPELINE, /lostUploads\(rows\.map\(\(r\) => r\.logoUrl\)/);
  assert.match(PIPELINE, /list: listUploads/);
  // ⚠️ ONE normaliser for the lookup key. The first cut keyed the set by
  // trimmed URL and asked with the raw store value, so it answered "not lost"
  // for exactly the rows it exists to find.
  assert.ok(!/lost\.has\(/.test(code(PIPELINE)), "the caller asks through isLostUpload, never by raw string");
  // …and it is cleared in the store, or the sweep's answer has nowhere to land.
  assert.match(PIPELINE, /forgetLostUploads\(/);
  assert.match(STORE, /applyLostUpload\(/, "the rule lives in logoWrite, where a test can drive it");
  assert.ok(!/await forgetLostUploads/.test(PIPELINE), "a board render must not wait on a store write");
});

test("⚠️ a re-list may fill a listing's fields, never blank them", () => {
  // `addListing` keeps the id on a duplicate and used to write the incoming row
  // over the stored one WHOLE — and `buildRow` renders an absent optional field
  // as `undefined`. So every re-POST of a token the site already carried erased
  // the logo the project uploaded, their socials, the overview, and a trending
  // window that was still running. Nothing failed and nothing said so.
  assert.match(STORE, /mergeRelist\(rows\[dupIdx\], rec\)/);
  assert.ok(
    !/created = \{\s*\.\.\.rec,\s*id: dupIdx >= 0/.test(STORE),
    "the wholesale overwrite is gone",
  );
});

test("⚠️ TWO LOCKS on the takeover, because each one leaves the other's half open", () => {
  // `/api/submit` is unauthenticated and `addListing` keeps the id of a
  // chain+address it already holds — so a submission for a live paid listing
  // took that row over. MEASURED with the route guard removed and only the
  // store lock in place: the row stayed approved and kept its logo, and its
  // ticker came back `$STOLEN`. With only the route guard, a future caller
  // reintroduces the demotion. Both, or it is half fixed.
  const SUBMIT = code(read("src/app/api/submit/route.ts"));
  assert.match(SUBMIT, /const existing = \(await allListings\(\)/, "the route refuses a duplicate outright");
  assert.match(SUBMIT, /status: 409/);
  assert.ok(SUBMIT.indexOf("existing") < SUBMIT.indexOf("addListing(built.row"), "…before it writes anything");
  assert.match(STORE, /keepStatus\(rows\[dupIdx\]\.status/, "and a create may promote a row, never demote one");
});

test("the listing form does not report a refusal as a success", () => {
  // It fired the request and forgot it, wrote the local "My listings" record,
  // and went straight to "Submission received!" — so a 400, a 429, a dead
  // network and now the 409 above all showed a paying project a green tick over
  // a queue entry that does not exist.
  const MODAL = code(read("src/components/ListingModal.tsx"));
  assert.ok(!/void fetch\("\/api\/submit"/.test(MODAL), "the fire-and-forget submit is gone");
  assert.match(MODAL, /if \(!res\.ok\) \{/);
  assert.ok(
    MODAL.indexOf("await fetch(\"/api/submit\"") < MODAL.indexOf("setStep(4)"),
    "the server answers before the success screen",
  );
  assert.ok(
    MODAL.indexOf("if (!res.ok)") < MODAL.indexOf("addListing({"),
    "…and before the local record, or a refused listing sits in My listings for ever",
  );
});

test("one owner for the uploads directory", () => {
  // Three files declared `path.join(process.cwd(), "data", "uploads")`. It
  // matters more now that the board asks whether an upload is still on disk: a
  // reader pointed at the wrong directory reports every paid listing's logo as
  // lost, and the site clears them.
  // ⚠️ THE PROPERTY, NOT THE SPELLING. This required every file to mention
  // `UPLOADS_DIR` by name — so the day the two upload routes stopped touching
  // the directory at all (they hand their bytes to `mediaStore.saveMedia`,
  // which is the one owner of the WRITE) it went red over code that keeps the
  // rule perfectly. What must never come back is a second declaration of the
  // path, and that is what is asserted.
  const owners = [
    "src/app/api/admin/upload/route.ts",
    "src/app/api/internal/upload/route.ts",
    "src/app/api/media/[name]/route.ts",
    "src/lib/mediaStore.ts",
  ];
  for (const f of owners) {
    assert.ok(!/"data", "uploads"/.test(code(read(f))), `${f} must not declare its own copy`);
  }
  assert.match(read("src/lib/uploadsDir.ts"), /export const UPLOADS_DIR/);
});

test("⚠️ the board pipeline PINS what the resolver found, not just persists it", () => {
  // Persisting a gateway url makes the ANSWER permanent and leaves the DELIVERY
  // a dice roll — `$GG`'s CID flipped ✓/✗ across four deploys with no code
  // change. A wiring that does nothing refuses beautifully, so this asserts the
  // wire and logoPin.test.ts asserts the rule.
  const src = code(read("src/lib/providers/index.ts"));
  assert.match(src, /persist: setResolvedLogo/);
  assert.match(src, /pin: \(chain, address, url\)/, "the sweep was given no way to pin");
  assert.match(src, /pinResolvedLogo\(chain, address, url, \{ commit: pinLogo \}\)/,
    "the pin must commit through the store's compare-and-set, never a bare write");
});

test("one owner for WRITING an upload — the sniff, the bound and the name", () => {
  // Byte-identical `sniff()`, `MAX` and `writeFile` in both upload routes, each
  // with a comment saying it matched the other. A third copy was what the logo
  // pin needed; three copies of "what this server will store and serve back as
  // an image" is how one of them ends up accepting an SVG.
  for (const f of ["src/app/api/admin/upload/route.ts", "src/app/api/internal/upload/route.ts"]) {
    const src = code(read(f));
    assert.match(src, /saveMedia\(/, `${f} does not write through the one owner`);
    assert.ok(!/function sniff\(/.test(src), `${f} has grown its own magic-byte sniff again`);
    assert.ok(!/writeFile\(/.test(src), `${f} writes the file itself again`);
  }
  const store = code(read("src/lib/mediaStore.ts"));
  assert.match(store, /export function sniffImage/);
  assert.match(store, /export async function saveMedia/);
  // The url must stay RELATIVE: `mediaFile.mediaPath` recognises our own
  // uploads by their path, and an absolute localhost one was stored on public
  // listings for a month.
  assert.match(store, /url: `\/api\/media\/\$\{name\}`/);
});

test("⚠️ logos:check asks for the url the BROWSER asks for", () => {
  // The script cannot import `lib/logo.ts` — production runs Node 18 and a
  // check that will not run on the box is worth nothing — so it carries a port
  // of `logoSrc`, and a port is a second owner. A guard is only honest while it
  // measures the stack the page actually uses: a check that fetched the raw url
  // would report green over every logo `/api/logo` refuses, which is one of the
  // three causes it exists to name.
  const CHECK = code(read("scripts/logo-check.mjs"));
  const SRC = code(read("src/lib/logo.ts"));
  for (const branch of [
    'u.startsWith("//")',                       // protocol-relative → the proxy
    'u.startsWith("/") || u.startsWith("data:")', // same-origin / inline → as-is
    "/^[a-z][a-z0-9+.-]*:\\/\\//i.test(u)",       // every other scheme → the proxy
    "/api/logo?u=${encodeURIComponent(",
  ]) {
    assert.ok(SRC.includes(branch), `logoSrc still has: ${branch}`);
    assert.ok(CHECK.includes(branch), `logos:check mirrors it: ${branch}`);
  }
});

test("a row with nothing but the convention is queued for the resolver", () => {
  assert.match(PIPELINE, /logo\.kind === "convention" \|\| logo\.kind === "none"/);
  assert.match(PIPELINE, /shouldLookUp\(/, "and only when it is worth spending a lookup on");
});

test("the handful the sweep looks up is the handful worth looking up", () => {
  // It does 8 rows a pass and a board can be 80 short, so the ORDER is a
  // decision: a featured row and a row nobody scrolls to are not worth the
  // same lookup. Without this the list was whatever order the store held.
  assert.match(PIPELINE, /needLogo\.sort\(/);
  assert.match(PIPELINE, /Number\(b\.featured\) - Number\(a\.featured\) \|\| b\.vol - a\.vol/);
});

test("what the sweep finds is persisted, or it dies with the process", () => {
  assert.match(PIPELINE, /backfillLogos\(/);
  assert.match(PIPELINE, /persist: setResolvedLogo/);
});

test("the sweep is never awaited by a board render", () => {
  // Resolving means three rate-limited APIs and a verification fetch. The
  // render must not be behind that — backfillLogos returns immediately.
  assert.ok(!/await backfillLogos/.test(PIPELINE), "a board render must not wait on a logo lookup");
});

test("every chain declares a CoinGecko platform, or explicitly declares it has none", () => {
  // Same rule as the DexScreener id: nothing outside the registry may hardcode
  // a chain id, and a new chain must decide rather than inherit undefined.
  for (const c of Object.values(CHAINS)) {
    assert.ok("coingecko" in c, `${c.id} must declare a coingecko platform (null if unsupported)`);
    assert.ok(c.coingecko === null || typeof c.coingecko === "string");
  }
  assert.equal(CHAINS.robinhood.coingecko, null, "CoinGecko has no platform for Robinhood Chain");
  assert.equal(CHAINS.bsc.coingecko, "binance-smart-chain", "its id differs from ours and from DexScreener's");
});

// ── the proxy ───────────────────────────────────────────────────────────────

test("the proxy carries the hosts token artwork actually lives on", () => {
  // A host missing from the allowlist is a real, working logo url rendered as a
  // monogram — refused by us, silently, with nothing in the UI to say so.
  for (const host of ["mypinata.cloud", "nftstorage.link", "dweb.link", "arweave.net", "trustwallet.com", "jup.ag"])
    assert.match(PROXY, new RegExp(`"${host.replace(".", "\\.")}"`), `${host} must be allowed`);
});

test("an ipfs:// URI is turned into a gateway URL rather than refused", () => {
  assert.match(PROXY, /ipfs:\\\/\\\//);
  assert.match(PROXY, /IPFS_GATEWAY/);
});

test("⚠️ redirects are followed BY HAND and re-checked against the allowlist", () => {
  // `redirect: "follow"` hands the guard's whole job to the upstream: an
  // allowed host answering `302 http://169.254.169.254/…` would have this
  // server fetch its own cloud metadata and serve the bytes back.
  assert.match(PROXY, /redirect: "manual"/);
  assert.ok(!/redirect: "follow"/.test(code(PROXY)), "no follow left anywhere in the proxy");
  const loop = PROXY.slice(PROXY.indexOf("for (let hop"));
  assert.match(loop, /if \(!next \|\| !allowed\(next\)\)/, "every hop is validated");
  // ⚠️ Not a character window: a slice measured in characters fails the moment
  // a comment lands between the two lines, which is a test about formatting.
  assert.ok(loop.indexOf("allowed(next)") < loop.indexOf("url = next"), "…before it is followed");
});

test("⚠️ NEVER ONE HARDCODED IPFS GATEWAY", () => {
  // `$BREAKING` stored `https://ipfs.io/ipfs/<cid>`, ipfs.io answered 404, the
  // proxy gave up, and a paid listing drew its monogram. Nothing was wrong with
  // the url, the CID, or the allowlist — one gateway could not find the
  // content. "Never one hardcoded host" is this repo's own rule (JUP_BASES).
  assert.ok(!/const IPFS_GATEWAY\s*=\s*"/.test(code(PROXY)), "the single gateway constant is gone");
  // ⚠️ THE LADDER IS ONE MODULE, and the route READS it. This used to pin the
  // list's spelling inside the route and went red the day the site's logo
  // resolver needed the same ladder and it moved to lib/ipfsGateways — over
  // code that keeps the rule perfectly. A second copy inside the route is
  // exactly what the move exists to prevent (the $GG round: the pump.fun pin
  // allowlisted in one place and missing from the other).
  const LADDER = read("src/lib/ipfsGateways.ts");
  assert.match(LADDER, /export const IPFS_GATEWAYS: string\[\]/);
  assert.match(LADDER, /process\.env\.IPFS_GATEWAYS/, "…and it is env-overridable, so a dead gateway costs a line not a deploy");
  assert.match(code(PROXY), /import \{[^}]*\bIPFS_GATEWAYS\b[^}]*\} from "@\/lib\/ipfsGateways"/, "the proxy imports the one ladder");
  assert.ok(!/const IPFS_GATEWAYS\b/.test(code(PROXY)), "…and carries no list of its own");
  // Every gateway in the shipped list must itself pass the allowlist, or the
  // failover would build urls the guard then refuses — a fallback that cannot
  // fire, which reads exactly like one that never helps.
  const list = code(LADDER).slice(code(LADDER).indexOf("const IPFS_GATEWAYS"), code(LADDER).indexOf("export function", code(LADDER).indexOf("const IPFS_GATEWAYS")));
  const hosts = [...list.matchAll(/"https:\/\/([^/]+)\//g)].map((m) => m[1]);
  assert.ok(hosts.length >= 3, `a LIST, not a host — found ${hosts.length}`);
  for (const h of hosts)
    assert.ok(
      ALLOW_HOSTS.some((d) => h === d || h.endsWith(`.${d}`)),
      `${h} must be on the proxy allowlist, or the failover builds urls the guard then refuses`,
    );
});

test("an IPFS 404 falls over to the next gateway; a CDN 404 does not", () => {
  // The transport-only failover rule exists because "the same request gets the
  // same status everywhere else". That is NOT true of a content-addressed
  // fetch: a CID is the hash of the bytes, so another gateway serving it serves
  // byte-identical content. `candidates()` is where that distinction lives.
  assert.match(PROXY, /function candidates\(url: URL\): URL\[\]/);
  assert.match(PROXY, /if \(!cid\) return \[url\];/, "a non-IPFS url gets exactly one attempt");
  assert.match(PROXY, /const out = \[url\];/, "…and the gateway the caller named is tried FIRST");
  assert.match(PROXY, /IPFS_MAX_TRIES/, "bounded");
  assert.match(PROXY, /Date\.now\(\) > deadline/, "…and time-bounded, or one request holds a socket for every gateway's timeout");
});

test("⚠️ a redirect somewhere we do not allow ends the request, it does not retry", () => {
  // That failure is about US being pointed at something, not about the content
  // being unavailable — falling through to the next gateway would bury it.
  const loop = PROXY.slice(PROXY.indexOf("for (let hop"));
  assert.ok(
    loop.indexOf("status: 400") < loop.indexOf("res = null; // transport failure"),
    "the disallowed-redirect return sits inside the hop loop, before the catch",
  );
});

test("the proxy carries no host broad enough to make us anyone's image CDN", () => {
  // A bare cloudfront.net would proxy every AWS customer's bucket through our
  // domain — somebody else's bandwidth and somebody else's content, served as
  // ours. Narrow beats convenient here.
  for (const host of ["cloudfront.net", "amazonaws.com", "googleusercontent.com"])
    assert.ok(!new RegExp(`"${host.replace(".", "\\.")}"`).test(PROXY), `${host} is too broad to allow`);
});

test("a body we are not going to read is released", () => {
  // On a long-lived server doing this per token, an unread body keeps its
  // socket busy until the GC gets round to it.
  assert.ok((PROXY.match(/body\?\.cancel\(\)/g) ?? []).length >= 3, "redirects, wrong types and oversized bodies");
});

test("only https, only images, and an SVG is served inert", () => {
  assert.match(PROXY, /u\.protocol !== "https:"/);
  assert.match(PROXY, /\^image\\\//);
  // An SVG is a DOCUMENT when opened directly, and one served from our own
  // origin can carry script. Refusing SVGs would drop real logos.
  assert.match(PROXY, /x-content-type-options/);
  assert.match(PROXY, /content-security-policy/);
});

test("a logo that cannot be served still renders as the monogram, never a broken tile", () => {
  assert.match(PROXY, /status: 404/, "a miss is a 404, which is what <Coin> listens for");
  assert.match(COIN, /onError=\{\(\) => setBroken\(true\)\}/);
  assert.match(COIN, /coin-mono/);
});
