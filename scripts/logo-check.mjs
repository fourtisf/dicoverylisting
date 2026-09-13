// logos:check — WHY IS THIS TOKEN DRAWING A MONOGRAM?
//
// Reported as "project ini punya logo pas listing mengapa skrg sudah ilang
// lognya": a paid listing that went out with its artwork and now shows the
// site's two-letter monogram. Three different things produce that picture and
// they need three different answers, and from the board they are identical:
//
//   1. THE ROW LOST ITS LOGO. A re-POST of a token the site already carried
//      used to overwrite the stored row whole, and an absent optional field is
//      `undefined` — so a re-list that carried no logo deleted the one the
//      project uploaded. (Fixed: lib/relist.ts. This finds rows it already hit.)
//   2. THE UPLOAD IS GONE. `data/listings.json` is mirrored to Mongo and
//      restored from it; `data/uploads/` is not, so a box that lost its disk
//      came back with every row asserting `/api/media/<hex>.png` and none of
//      those files behind them. (Fixed: lib/mediaFile.ts clears and re-resolves
//      them. This shows any still in flight.)
//   3. THE URL IS REAL AND WE REFUSE IT. `/api/logo`'s allowlist is part of
//      "every token has a logo", not only of security: a host missing from it
//      is a working image rendered as a monogram, refused by us, silently.
//
// ⚠️ IT DRIVES THE RUNNING SERVER, and it fetches every logo THROUGH THE PROXY
// the browser uses. That is the whole point: whether a CDN answers is a
// property of this box's egress today — the rule `raid:check`,
// `launchpads:check`, `fonts:check` and `chart:check` all state — and a check
// that reasoned about the URL instead of loading it would print green over
// exactly the rows that draw boxes. It also cannot import `src/**/*.ts`:
// PRODUCTION RUNS NODE 18, where that throws.
//
//   npm run logos:check                       # every listed token
//   npm run logos:check -- solana VJdpSDD…    # one token you are looking at
//   npm run logos:check -- --bad              # only the rows that fail
//   BASE_URL=http://127.0.0.1:3005 npm run logos:check
//
// With INTERNAL_API_TOKEN set (the bot's own, in bot/.env) it also reads the
// STORED row, which is what separates cause 1 from the rest: a row whose stored
// logoUrl is blank lost it, and a row whose stored logoUrl is the one failing
// to load did not.
//
// Exits non-zero when any row would draw a monogram — green means "the board's
// artwork is safe", not "the server answered".
import { execSync } from "node:child_process";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m";
const BASE = (process.env.BASE_URL ?? "http://localhost:3005").replace(/\/+$/, "");
const TOKEN = process.env.INTERNAL_API_TOKEN ?? "";

const argv = process.argv.slice(2);
const onlyBad = argv.includes("--bad");
const [wantChain, wantAddr] = argv.filter((a) => !a.startsWith("--"));

/** The build stamp of this CHECKOUT — printed against the server's own, because
 *  every round of this has begun with somebody reading a check as a statement
 *  about the fix they just deployed. The server only ever pulls `main`, so a
 *  fix on a branch is not deployed however many times `git pull` runs. */
function stamp() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

const UPLOAD_RE = /^\/api\/media\/[a-f0-9]{24}\.(?:png|jpe?g|gif|webp)$/i;
/** The DexScreener CDN path we CONSTRUCT — a guess, never an answer. Naming it
 *  is the difference between "nobody has given this token a logo" and "somebody
 *  did and it broke". */
const CONVENTION_RE = /dd\.dexscreener\.com\/ds-data\/tokens\//i;

/**
 * Which rung of the ladder this row is drawing from.
 *
 * ⚠️ IT NEEDS THE STORED ROW TO BE SURE, and says so when it does not have it.
 * The CDN path is both a thing we CONSTRUCT when nobody has given a token
 * artwork and a perfectly good url somebody may have SET — the seed listings
 * store exactly that string. Classifying by shape alone reported "nobody has
 * given this token artwork" over rows that carry a stored logo, which is the
 * wrong half of the diagnosis and would send an operator to fix the wrong
 * thing. With INTERNAL_API_TOKEN the row settles it; without it the answer is
 * honestly ambiguous and is printed as such.
 */
function kindOf(url, stored, haveStore) {
  if (!url) return "none";
  if (UPLOAD_RE.test(url)) return "upload";
  if (haveStore && stored?.logoUrl && String(stored.logoUrl).trim() === String(url).trim()) return "stored";
  if (haveStore) return CONVENTION_RE.test(url) ? "convention" : "live/resolved";
  if (url.startsWith("/")) return "same-origin";
  return CONVENTION_RE.test(url) ? "cdn-path?" : "external";
}

/** The URL the BROWSER actually requests — a 1:1 port of `lib/logo.ts`'s
 *  `logoSrc`. Anything else measures a stack the page does not use, which is
 *  `fonts:check` printing nine green ticks over a banner drawing boxes. */
function browserSrc(url) {
  const u = String(url ?? "").trim();
  if (!u) return null;
  if (u.startsWith("//")) return `/api/logo?u=${encodeURIComponent(`https:${u}`)}`;
  if (u.startsWith("/") || u.startsWith("data:")) return u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return `/api/logo?u=${encodeURIComponent(u)}`;
  return u;
}

async function loads(url) {
  const src = browserSrc(url);
  if (!src) return { ok: false, why: "no logo at all" };
  try {
    const res = await fetch(`${BASE}${src}`, { headers: { accept: "image/*,*/*" }, signal: AbortSignal.timeout(15_000) });
    const ct = res.headers.get("content-type") ?? "";
    const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0;
    if (!res.ok) {
      // ⚠️ `HTTP 404` FROM OUR OWN PROXY IS NOT A DIAGNOSIS. It is what the
      // route answers once every IPFS gateway has refused, and the operator
      // needs to know WHICH refusal: a CID nothing has pinned is artwork that
      // is gone, while every gateway serving `text/html` is a dag-pb CID that
      // resolves to a DIRECTORY — deterministic, unrelated to pinning, and
      // fixable. The route carries that on `x-logo-why` precisely so this line
      // can print it.
      const detail = res.headers.get("x-logo-why");
      return { ok: false, why: detail ? `HTTP ${res.status} — ${detail}` : `HTTP ${res.status}`, status: res.status };
    }
    if (!/^image\//i.test(ct)) return { ok: false, why: `served ${ct || "no content-type"}, not an image` };
    return { ok: true, why: `${ct} · ${Math.round(bytes / 1024)}KB` };
  } catch (e) {
    // ⚠️ AN UNREACHABLE SERVER IS NOT A BROKEN LOGO. Kept as its own verdict so
    // one dead port cannot report every project's artwork as missing.
    return { ok: false, unreachable: true, why: e?.message ?? String(e) };
  }
}

/** Did the internal API answer? Without it a same-origin url cannot be told
 *  apart from a row that lost its logo, so it is not called a fault. */
const haveStoreKnown = (stored) => Boolean(stored);

async function storedRows() {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/api/internal/listings`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const map = new Map();
    for (const r of j.listings ?? []) map.set(`${r.chain}:${String(r.address).toLowerCase()}`, r);
    return map;
  } catch {
    return null;
  }
}

/** Which of the causes this row is, in words an operator can act on. */
function diagnose(rendered, stored, res, k, haveStore) {
  if (res.status === 400)
    return `${R}OUR PROXY REFUSED IT${X} — the host is not on /api/logo's allowlist. That is a working image url we are throwing away, and it is a code fix`;
  if (k === "upload")
    return `the uploaded file is gone from data/uploads — data/ is not in the Mongo mirror, so a box that lost its disk lost every upload. The site clears it and the resolver looks for a replacement on the next rebuild`;
  if (haveStore && !stored?.logoUrl && rendered)
    return `the STORED row has NO logo, so this is a guess the site fell back to — the row lost its artwork (a re-list used to erase it; lib/relist.ts stops that now). Set one in the admin panel, or let the resolver fill it`;
  if (k === "stored") return `the row's OWN logo will not load — check the host, or replace it in the admin panel`;
  if (k === "convention")
    return `nothing but the constructed DexScreener CDN path, and it missed — nobody has given this token artwork`;
  if (k === "cdn-path?")
    return `the DexScreener CDN path, and it missed. Whether the row STORES it or the site fell back to it needs INTERNAL_API_TOKEN to tell apart`;
  if (k === "none") return `no source has any artwork for this token`;
  if (/\/ipfs\//i.test(String(rendered ?? "")) && !res.ok)
    return `this IPFS gateway does not have the CID (${res.why}). Content-addressed storage means another gateway may serve exactly the same bytes — /api/logo tries a LIST of them, so a row still failing here has been refused by all of them`;
  if (!res.ok) return `the image host answered ${res.why}`;
  return "";
}

/** Retry a connection while the server is still coming up. Bounded, and it
 *  SAYS it is waiting — a silent 15-second pause reads as a hang. */
async function withRetry(fn, tries = 6, gapMs = 2500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === tries - 1) break;
      if (i === 0) process.stdout.write(`  ${D}waiting for ${BASE} to come up`);
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  process.stdout.write(`${X}\n`);
  throw last;
}

async function main() {
  console.log(`\nWhich listed tokens would draw a monogram?   ${D}checkout ${stamp()} · server ${BASE}${X}\n`);

  let payload;
  try {
    // ⚠️ WAIT FOR A SERVER THAT IS STILL BOOTING. The natural way to run this
    // is `pm2 restart dexvra && npm run logos:check`, and Next takes a few
    // seconds to bind — so the first cut reported "the server did not answer"
    // for the one order an operator actually types, right after a deploy. A
    // check that fails on its own happy path teaches the reader to ignore it.
    payload = await withRetry(async () => {
      const res = await fetch(`${BASE}/api/tokens`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
      return res.json();
    });
  } catch (e) {
    console.log(
      `${R}✗ The server at ${BASE} did not answer after several tries (${e?.message ?? e}).${X}\n` +
        `  Start it (\`npm run build && npm start\`) or point BASE_URL at the right port —\n` +
        `  dexvra.io runs on 3005 under pm2. Nothing here is a statement about the logos.\n`,
    );
    process.exit(1);
  }

  const serverBuild = payload.build ?? "unknown";
  const cut = String(serverBuild).replace(/\+dirty$/, "");
  if (cut !== "unknown" && !stamp().startsWith(cut))
    console.log(
      `  ${Y}⚠ The server is running build ${serverBuild}, this checkout is ${stamp()}.${X}\n` +
        `    ${D}Everything below is a statement about the OLD code.${X}\n`,
    );

  let rows = payload.tokens ?? [];
  if (wantChain && wantAddr)
    rows = rows.filter((t) => t.chain === wantChain && String(t.address).toLowerCase() === wantAddr.toLowerCase());
  if (!rows.length) {
    // ⚠️ A RUN THAT MEASURED NOTHING IS AN ERROR, NEVER A QUIET GREEN.
    console.log(
      `${R}Nothing was probed${X} — ` +
        (wantChain ? `${wantChain}/${wantAddr} is not listed on this server.` : `the board came back with no tokens at all.`) +
        `\n`,
    );
    process.exit(1);
  }

  const stored = await storedRows();
  if (!stored)
    console.log(
      `  ${D}INTERNAL_API_TOKEN not set (or the internal API refused) — reporting what the board${X}\n` +
        `  ${D}RENDERS. Set it to also see the STORED row, which is what tells a logo that was${X}\n` +
        `  ${D}erased apart from one that will not load.${X}\n`,
    );

  // ⚠️ TWO KINDS OF FAILURE, AND ONLY ONE OF THEM IS A FAULT.
  //
  // A board always has some rows nobody has ever made artwork for — the
  // resolver sweeps eight a minute and will fill what it can find, and a token
  // whose project never drew a logo is not a defect. If those failed the run,
  // this check would be RED for ever, and a check that is always red is worse
  // than no check: it trains the reader to ignore the red. (`chart:preview`
  // spent weeks in exactly that state, asserting a feature that had been
  // deliberately deleted.)
  //
  // So: `broken` is a row where something we HAVE is not working — a stored
  // logo that will not load, an upload whose file is gone, a url our own proxy
  // refuses. That is what turns the exit code. `backlog` is a row with nothing
  // to break yet, and it is reported and counted and does not fail anything.
  const broken = [];
  const backlog = [];
  const refused = [];
  let ok = 0;
  let unreachable = 0;

  for (const t of rows) {
    // Sequential: this pulls real bytes through our own proxy, and a hundred
    // concurrent CDN fetches is a check manufacturing the failure it reports.
    const res = await loads(t.logoUrl);
    const row = stored?.get(`${t.chain}:${String(t.address).toLowerCase()}`);
    const k = kindOf(t.logoUrl, row, Boolean(stored));
    const fault =
      !res.ok &&
      !res.unreachable &&
      (k === "upload" || k === "stored" || res.status === 400 || (!haveStoreKnown(stored) && k === "same-origin"));
    if (res.unreachable) unreachable++;
    else if (res.ok) ok++;
    else (fault ? broken : backlog).push({ t, k, res, row });
    if (res.status === 400) refused.push(t);
    if (res.ok && onlyBad) continue;
    const mark = res.ok ? `${G}✓${X}` : fault ? `${R}✗${X}` : `${Y}·${X}`;
    // ⚠️ TRUNCATED ONLY WHERE IT LOADS. The column is elided to keep the table
    // readable, and the first cut elided it on the FAILING rows too — the one
    // line whose whole job is showing you the url that broke. It cut
    // `ipfs.io/ipfs/bafkrei…` at exactly 46 characters, which reads as a
    // malformed CID rather than a clipped one, and an operator cannot copy it,
    // paste it in a browser, or tell the two apart. The full url is printed
    // under any row that did not load.
    const shown = t.logoUrl ? String(t.logoUrl).replace(/^https?:\/\//, "").slice(0, 46) : "—";
    console.log(
      `  ${mark} ${String(t.symbol).padEnd(12)} ${D}${String(t.chain).padEnd(9)}${X} ` +
        `${C}${k.padEnd(13)}${X} ${D}${shown.padEnd(48)}${X} ${res.ok ? D : fault ? R : Y}${res.why}${X}`,
    );
    if (!res.ok) {
      // The whole url, never elided — this is the value the reader has to act on.
      if (t.logoUrl && String(t.logoUrl).replace(/^https?:\/\//, "").length > 46)
        console.log(`     ${D}↳ url: ${t.logoUrl}${X}`);
      const d = diagnose(t.logoUrl, row, res, k, Boolean(stored));
      if (d) console.log(`     ${Y}↳${X} ${d}`);
      if (row && row.logoUrl !== t.logoUrl)
        console.log(`     ${D}↳ stored: ${row.logoUrl ?? "(blank)"}${X}`);
    }
  }

  console.log(
    `\n  ${D}${rows.length} listed · ${ok} with artwork that loads · ${broken.length} broken · ` +
      `${backlog.length} with nothing to draw yet` +
      (unreachable ? ` · ${unreachable} unreachable` : "") +
      `${X}`,
  );

  if (refused.length)
    console.log(
      `\n  ${Y}⚠ ${refused.length} logo(s) were refused by OUR OWN PROXY (HTTP 400).${X}\n` +
        `    ${D}That is a real, working image url rendered as a monogram — the host is missing${X}\n` +
        `    ${D}from ALLOW in src/app/api/logo/route.ts. It is a code fix, not a data one.${X}\n` +
        refused.map((t) => `      ${t.symbol}  ${t.logoUrl}`).join("\n"),
    );

  if (!broken.length) {
    if (backlog.length)
      console.log(
        `\n${G}Nothing is broken.${X} ${D}${backlog.length} row(s) have no artwork anywhere yet — that is the${X}\n` +
          `  ${D}resolver's ordinary backlog, not a fault; it sweeps 8 a minute and fills what it finds.${X}\n`,
      );
    else console.log(`\n${G}Every listed token draws real artwork from this box.${X}\n`);
    return;
  }
  console.log(
    `\n${R}${broken.length} listed token(s) have artwork that is BROKEN, not missing.${X}\n` +
      `  ${D}Each one is something the site HAS and cannot serve — act on these.${X}\n` +
      broken.map((b) => `      ${b.t.symbol.padEnd(12)} ${b.k.padEnd(12)} ${b.res.why}`).join("\n") +
      `\n`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(`${R}logos:check failed: ${e?.stack ?? e}${X}`);
  process.exit(1);
});
