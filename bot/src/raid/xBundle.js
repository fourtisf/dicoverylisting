// Reading X's own JavaScript for the GraphQL operation ids it is currently using.
//
// X rotates those hashes on its own schedule and a stale one 404s every request.
// The bundle that broke us also carries the fix, so the honest answer to "the
// hash churns" is to read it rather than to page an operator who may be asleep.
//
// ONE OWNER, because a bundle is MEGABYTES. Both keyless GraphQL callers — the
// post-metrics read and the timeline read — need ids from the same files, and
// two independent sweeps would download the same megabytes twice and get the
// host blocked twice as fast. The sweep is shared, the throttle is shared, and
// each caller asks for the operations it needs.
//
// Strictly bounded: a caller runs this only AFTER a 404 has proved its current
// id stale, at most once per window, over a handful of ranked files. Every
// failure resolves to "nothing found" and leaves the caller's previous tier in
// force — this can never be the reason a raid stops.
const log = require("../helpers/logger");

const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10000;
const MAX_BUNDLES = 4;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const found = new Map(); // operationName → { at, id }
let triedAt = 0; // shared: one sweep per window however many callers ask

/** A discovered id for this operation, or "" when we have none that is fresh. */
function cached(operationName, now = Date.now()) {
  const hit = found.get(operationName);
  return hit && now - hit.at < TTL_MS ? hit.id : "";
}

/** A response body as text, or "" for anything unreadable. Tolerates a stub with
 *  no `.text()` rather than throwing inside a best-effort path. */
async function readText(res) {
  if (!res || !res.ok || typeof res.text !== "function") return "";
  try {
    return String((await res.text()) || "");
  } catch {
    return "";
  }
}

// The operation map lives in the api/endpoint chunks; `main` is the fallback.
// Ordering matters only because the budget is deliberately small.
function score(url) {
  if (/\/api\./.test(url) || /endpoint/i.test(url)) return 3;
  if (/main\./.test(url)) return 2;
  return 1;
}

/**
 * Pull one operation's id out of a bundle. BOTH field orders occur across
 * builds, so both are matched rather than assuming the one that shipped today.
 *
 * The second pattern refuses to cross a `}`: reaching into the next object would
 * hand back a real-looking id belonging to a DIFFERENT operation — a silent
 * wrong answer, where a missed match merely falls back to the seed and retries.
 */
function findQueryId(js, operationName) {
  const a = js.match(new RegExp(`queryId:"([\\w-]{10,40})",operationName:"${operationName}"`));
  if (a) return a[1];
  const b = js.match(new RegExp(`operationName:"${operationName}",[^}]{0,80}?queryId:"([\\w-]{10,40})"`));
  return b ? b[1] : "";
}

/**
 * Discover ids for the named operations. Never throws.
 *
 * @param {string[]} operations
 * @returns {Promise<Object>} { [operationName]: id } — only what was found.
 */
async function discoverQueryIds(operations) {
  const names = (Array.isArray(operations) ? operations : [operations]).filter(Boolean);
  if (!names.length) return {};
  const now = Date.now();

  // Everything already fresh → answer without touching the network.
  const have = {};
  for (const n of names) {
    const id = cached(n, now);
    if (id) have[n] = id;
  }
  if (Object.keys(have).length === names.length) return have;

  // Throttled on the ATTEMPT, not on success: a box that cannot reach the bundle
  // host must not re-run a multi-megabyte sweep on every 404 of every group.
  if (triedAt && now - triedAt < TTL_MS) return have;
  triedAt = now;

  try {
    const shell = await fetch("https://x.com/", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const html = await readText(shell);
    if (!html) return have;
    const urls = [
      ...new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s)]+\.js/g) || []),
    ];
    const ranked = urls.sort((a, b) => score(b) - score(a)).slice(0, MAX_BUNDLES);

    for (const url of ranked) {
      // eslint-disable-next-line no-await-in-loop
      const js = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then(readText)
        .catch(() => "");
      if (!js) continue;
      for (const n of names) {
        if (have[n]) continue;
        const id = findQueryId(js, n);
        if (id) {
          have[n] = id;
          found.set(n, { at: Date.now(), id });
          log.info(`[raid] X rotated its hash — discovered queryId for ${n}: ${id}`);
        }
      }
      if (Object.keys(have).length === names.length) break;
    }
    if (!Object.keys(have).length) log.warn(`[raid] could not find ${names.join("/")} in x.com's bundle`);
    return have;
  } catch (e) {
    log.warn(`[raid] queryId discovery failed: ${(e && e.message) || e}`);
    return have;
  }
}

/** Test seam. */
function _reset() {
  found.clear();
  triedAt = 0;
}

module.exports = { discoverQueryIds, findQueryId, cached, _reset, TTL_MS, MAX_BUNDLES };
