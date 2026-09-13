#!/usr/bin/env node
/**
 * DOES THE PAGE ARRIVE WITH THE BOARD IN IT — measured against the running
 * server, not reasoned about from the source.
 *
 * This exists because the one-line check that preceded it was wrong in the
 * expensive direction: `curl … | grep -c 'class="row'` run in the seconds after
 * `pm2 restart` prints 0, because a process that has just booted has an empty
 * cache and `SiteLayout` is BOUNDED — it drops the board from the HTML rather
 * than hang. Read as a broken deploy, it is the system working. A check that
 * fails on its own happy path teaches the reader to ignore it, which is the
 * state `chart:preview` sat in for weeks.
 *
 * Node 18 (production's version) and no imports from `src/**\/*.ts` — the
 * `logos:check` rule: a check that cannot run on the box is not a check. The
 * predicates are exported and unit-tested, because the first two cuts of this
 * file each carried a defect of exactly the kind it exists to catch (see
 * firstPaint.test.ts).
 */
import { pathToFileURL } from "node:url";

const TRIES = 6;
const GAP_MS = 2500;

/** Board rows in the HTML, not counting the header row. */
export const boardRows = (html) =>
  (html.match(/class="row[ "]/g) || []).length - (html.match(/class="row head"/g) || []).length;

/**
 * ⚠️ THE <noscript> COPY IS SUPPOSED TO HAVE NO media="print". Nothing can
 * promote it without JS, so it is a plain link on purpose — and the first cut
 * of this check matched it and reported correct code as broken. A check that is
 * red on a healthy page is worse than no check.
 */
export function fontVerdict(html) {
  const scriptable = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
  const links = (scriptable.match(/<link[^>]*>/gi) || []).filter(
    (t) => /rel="stylesheet"/i.test(t) && /fonts\.googleapis\.com/i.test(t),
  );
  return {
    links: links.length,
    blocking: links.filter((t) => !/media="print"/i.test(t)).length,
    promoted: /l\.sheet\?go\(\)/.test(scriptable) || /media='all'/.test(scriptable),
    noscript: /<noscript>[\s\S]*?fonts\.googleapis\.com/i.test(html),
    preconnected: /rel="preconnect" href="https:\/\/fonts\.gstatic\.com"/i.test(html),
  };
}

/**
 * ⚠️ A MINIFIER REWRITES `@import url('x')` AS `@import"x"`, and the first cut
 * only matched the source spelling — so it printed ✓ over the very build it
 * exists to catch. Both spellings, and `url(` optional.
 */
export const importsOverNetwork = (css) => /@import\s*(?:url\()?\s*['"]?https?:/i.test(css);

/**
 * Ports this app is plausibly listening on locally.
 *
 * ⚠️ THE DEFAULT IS A GUESS, and a wrong guess reads exactly like a dead
 * server — `pm2 ls` says `online` and the check says "did not answer", which
 * sends the reader to debug a process that is working perfectly.
 */
const LOCAL_PORTS = [process.env.PORT, 3005, 3000, 3001, 3055, 8080].filter(Boolean);

/**
 * ⚠️ A COMMAND AN OPERATOR CAN PASTE MUST CONTAIN ONLY REAL VALUES, or it must
 * not be a command. This file's first draft answered a wrong port by printing
 * `npm run firstpaint:check -- http://127.0.0.1:<port>` — angle brackets, which
 * bash reads as REDIRECTS, so the line dies with `syntax error near unexpected
 * token` before the script runs. That is CLAUDE.md's opening rule, broken in
 * the act of diagnosing something else, for the fourth time in this repo.
 *
 * So it does not ask for the port. It ASKS THE BOX — the same move `abi:check`
 * makes when it is given no address.
 */
async function findLocal(defaultOrigin) {
  try {
    await fetch(defaultOrigin + "/api/tokens");
    return { origin: defaultOrigin, found: false };
  } catch { /* keep looking */ }
  for (const port of LOCAL_PORTS) {
    const candidate = `http://127.0.0.1:${port}`;
    if (candidate === defaultOrigin) continue;
    try {
      const res = await fetch(candidate + "/api/tokens");
      // Our app, not merely something listening: the payload carries a build.
      if (res.ok && JSON.parse(await res.text()).build !== undefined)
        return { origin: candidate, found: true };
    } catch { /* next */ }
  }
  return { origin: defaultOrigin, found: false };
}

async function main(origin, { discover = false } = {}) {
  if (discover) {
    const hit = await findLocal(origin);
    if (hit.found) {
      console.log(`\nNothing on ${origin}; the app answers on ${hit.origin} — measuring that.`);
      console.log(`(pass it explicitly next time: npm run firstpaint:check -- ${hit.origin})`);
      origin = hit.origin;
    }
  }
  const get = async (path) => {
    const t0 = Date.now();
    const res = await fetch(origin + path, { redirect: "follow" });
    return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text(), ms: Date.now() - t0 };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let bad = 0;
  const fail = (s) => { bad++; console.log(`  ✗ ${s}`); };
  const ok = (s) => console.log(`  ✓ ${s}`);
  const note = (s) => console.log(`  · ${s}`);

  console.log(`\nFirst paint — ${origin}\n`);

  // 1 · which build answered ───────────────────────────────────────────────
  // Every round of this has begun with somebody reading a check as a statement
  // about the fix they just deployed. One line settles it.
  let build = "unknown";
  try {
    const r = await get("/api/tokens");
    build = JSON.parse(r.body).build ?? "unknown";
    console.log(`1 · build ${build}`);
    note(`/api/tokens answered in ${r.ms}ms`);
  } catch (err) {
    console.log("1 · build unknown");
    fail(`the server did not answer — is it running? (${err?.message ?? err})`);
    note("`pm2 ls` may well say `online` — that only means nothing is listening HERE.");
    note("The port is not a fact this script can know, so it goes looking; if that");
    note("finds nothing, pass the origin as an argument (the public one works too).");
    console.log("\nNothing else can be measured.\n");
    return 1;
  }

  // 2 · the board in the HTML ──────────────────────────────────────────────
  // Retried, because a COLD process legitimately drops it: the layout waits a
  // bounded moment for the market read and ships the shell rather than hang.
  // Absent on try 1 and present on try 3 is the system working.
  console.log("\n2 · does the html carry the board?");
  let rows = 0, tries = 0, ttfb = 0;
  for (; tries < TRIES; tries++) {
    const r = await get("/");
    rows = boardRows(r.body);
    ttfb = r.ms;
    if (rows > 0) break;
    if (tries === 0) note("not yet — the process looks cold, waiting for the market read…");
    await sleep(GAP_MS);
  }
  if (rows > 0) {
    ok(`${rows} board row(s) server-rendered${tries ? ` (after ${tries + 1} tries, ~${(tries * GAP_MS) / 1000}s of warm-up)` : ""}`);
    note(`html in ${ttfb}ms — a reader sees the board without waiting for the bundle`);
  } else {
    fail(`no board rows in the html after ${TRIES} tries (~${(TRIES * GAP_MS) / 1000}s)`);
    note("the page still works — the browser fetches /api/tokens — but the reader");
    note("waits for bundle + hydrate + a round trip first, which is the slow path.");
    note("If /api/tokens above was slow, that is the cause: the layout will not");
    note("hang on it. If it was fast, check that this build is the one deployed.");
  }

  // 3 · the fonts are off the critical path ────────────────────────────────
  // A CSS @import is three serial round trips to a third party, all
  // render-blocking — and a pending stylesheet blocks SCRIPT EXECUTION, so
  // hydration and the board's own fetch wait on Google. It cost 12.5s on a box
  // that could not reach fonts.googleapis.com.
  console.log("\n3 · are the webfonts blocking the page?");
  const home = (await get("/")).body;
  const f = fontVerdict(home);
  if (f.links === 0) fail("no webfont stylesheet in the html at all");
  else if (f.blocking) fail(`the font stylesheet is render-blocking (no media="print") — ${f.blocking} of ${f.links}`);
  else ok(`the font stylesheet is non-blocking (${f.links} link, promoted after load)`);
  if (f.links && !f.promoted) fail("nothing promotes the print-media stylesheet — the fonts would never apply");
  else if (f.links) ok("…and something promotes it once it has loaded");
  if (!f.noscript) fail("no <noscript> fallback — a reader with JS off gets no webfonts at all");
  else ok("a <noscript> fallback carries a plain link");
  if (!f.preconnected) fail("fonts.gstatic.com is not preconnected — the font FILES pay a cold connection");
  else ok("both font origins preconnected");

  // ⚠️ A STYLESHEET WE COULD NOT READ IS NOT A CLEAN ONE. The first cut fetched
  // these and never looked at the status: against a server whose build had been
  // replaced under it, every request came back a 400 HTML page with no @import
  // in it, and the check printed ✓ over the exact defect it was written for.
  let read = 0, imported = 0, unread = 0;
  for (const href of (home.match(/href="(\/_next\/static\/css\/[^"]+)"/g) || []).map((m) => m.slice(6, -1))) {
    const r = await get(href);
    if (r.status !== 200 || !/text\/css/i.test(r.type)) { unread++; note(`${href} → HTTP ${r.status} ${r.type || "(no type)"}`); continue; }
    read++;
    if (importsOverNetwork(r.body)) { imported++; note(`${href} @imports a third-party stylesheet`); }
  }
  if (unread) fail(`${unread} stylesheet(s) could not be read — this says nothing either way`);
  if (imported) fail(`${imported} stylesheet(s) @import over the network — three serial round trips`);
  else if (read) ok(`no stylesheet @imports over the network (${read} read)`);

  console.log(
    bad === 0
      ? `\nThe page arrives ready: the board is in the html and nothing third-party blocks it. (build ${build})\n`
      : `\n${bad} problem(s) above. (build ${build})\n`,
  );
  if (origin.includes("127.0.0.1") || origin.includes("localhost"))
    console.log("Measured against the LOCAL server. If this is green and the public\n" +
      "site is not, something in front of it is serving cached html:\n" +
      "  node scripts/firstpaint-check.mjs https://dexvra.io\n");
  return bad === 0 ? 0 : 1;
}

// Importable for the tests without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const given = process.argv[2];
  // Only hunt for the port when nobody named an origin — an argument is a
  // decision, and quietly measuring somewhere else would answer a question
  // that was not asked.
  process.exit(await main(given || `http://127.0.0.1:${process.env.PORT || 3005}`, { discover: !given }));
}
