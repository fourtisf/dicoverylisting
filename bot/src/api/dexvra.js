// Client for the dexvra web app's token-guarded internal API (/api/internal/*).
// The web process is the sole writer of data/listings.json — the bot only ever
// mutates the store through these calls. Uses global fetch/FormData/Blob (Node 18+).
const { DEXVRA_API_BASE, INTERNAL_API_TOKEN } = require("../config/constants");
const log = require("../helpers/logger");

const TIMEOUT_MS = 15000;

function authHeaders(extra) {
  return { authorization: `Bearer ${INTERNAL_API_TOKEN}`, ...extra };
}

async function call(method, path, body) {
  // Every call through here is authenticated, reads included, so the message
  // must not claim a write: `trending:check` only READS and reported "bot
  // cannot write listings", which sends the reader looking for the wrong thing.
  if (!INTERNAL_API_TOKEN) {
    throw new Error(`INTERNAL_API_TOKEN is not set — cannot ${method === "GET" ? "read from" : "write to"} the site's internal API`);
  }
  const url = `${DEXVRA_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(body != null ? { "content-type": "application/json" } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (json && json.error) || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

// ── Listings ─────────────────────────────────────────────────────────────────
/** Create an APPROVED listing (a paid order that cleared payment). Returns the
 *  StoredListing (with .id). `input` is a ListingInput (see adminValidate.ts). */
async function createListing(input) {
  const out = await call("POST", "/api/internal/listings", input);
  return out?.listing || null;
}

async function updateListing(id, patch) {
  const out = await call("PATCH", `/api/internal/listings/${encodeURIComponent(id)}`, patch);
  return out?.listing || null;
}

/**
 * Remove a listing the BOT created. Returns `{ deleted, chain, address, sym }`.
 *
 * The site REFUSES anything somebody paid for — a real tier, a live trending
 * slot, or a row this bot did not create — and answers 409 with which rule
 * stopped it. That guard lives there rather than here on purpose: a caller can
 * be wrong about what it is holding, and the store cannot.
 */
async function deleteListing(id) {
  return call("DELETE", `/api/internal/listings/${encodeURIComponent(id)}`);
}

/** Every stored listing (bot reads for pump/trending). */
async function getListings() {
  const out = await call("GET", "/api/internal/listings");
  return (out && out.listings) || [];
}

/**
 * THE SITE'S OWN TRENDING ORDER, per chain — `{ frame, live, updatedAt, chains }`.
 *
 * The channel board mirrors dexvra.io rather than ranking for itself: the two
 * were showing different tokens because they answered "what is trending" from
 * different places, and a project checks one against the other. The site owns
 * that answer (`byChange` in src/lib/home.ts); this reads it.
 *
 * Throws what the call threw — the poster treats an unreachable site as "no
 * top-up available" and still publishes the booked slots, because a board that
 * vanished is worse than one that is short.
 */
async function boardRank(frame = "24h") {
  const out = await call("GET", `/api/internal/board-rank?frame=${encodeURIComponent(frame)}`);
  return out && out.chains ? out : { frame, live: false, chains: {} };
}

/** Find the stored listing for a chain+address (case-insensitive), or null. */
async function findListing(chain, address) {
  const addr = String(address || "").toLowerCase();
  const all = await getListings();
  return all.find((r) => r.chain === chain && String(r.address).toLowerCase() === addr) || null;
}

// ── Trending ─────────────────────────────────────────────────────────────────
async function bookTrending(chain, address, durationHours) {
  const out = await call("POST", "/api/internal/trending", { chain, address, durationHours });
  return out?.listing || null;
}

/** Clear ended slots in the store. Returns count cleared. */
async function expireTrending() {
  const out = await call("POST", "/api/internal/trending/expire", {});
  return (out && out.cleared) || 0;
}

// ── Banners ──────────────────────────────────────────────────────────────────
// Returns the booking as SCHEDULED by the site (its window can be later than
// the one requested when paid slots are full) plus `queued` — the bot has to
// tell the buyer which it is instead of promising "live now".
async function bookBanner(rec) {
  const out = await call("POST", "/api/internal/banners", rec);
  if (!out?.banner) return null;
  return { ...out.banner, queued: Boolean(out.queued) };
}

// ── Upload (multipart) ───────────────────────────────────────────────────────
/** Upload an image buffer; returns a "/api/media/<name>" URL. */
async function uploadImage(buffer, filename = "logo.png", mime = "image/png") {
  if (!INTERNAL_API_TOKEN) throw new Error("INTERNAL_API_TOKEN is not set");
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${DEXVRA_API_BASE}/api/internal/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`upload → ${res.status}: ${(json && json.error) || "failed"}`);
  // ⚠️ RELATIVE, exactly as the route answers it. This used to prefix
  // DEXVRA_API_BASE, producing `http://127.0.0.1:3005/api/media/<hex>.png` —
  // while the call site's comment read "relative /api/media/... (renders on the
  // site)". The site's validator accepted it (LOGO_RE takes http://), so a
  // localhost url was stored on a public listing; `logoSrc` proxied it,
  // /api/logo refused the host, and the browser drew a monogram over artwork on
  // this very disk. The relative form is the one shape every consumer on both
  // sides is built around (`mediaName`, `LOGO_RE`, `logoSrc`, `photoSource`).
  return json && json.url ? String(json.url) : null;
}

// The site refuses a token under this length outright (src/lib/internalAuth.ts
// MIN_LEN) — "not configured → closed". Mirrored here so the bot can say WHICH
// problem it is: a 401 over a token both halves agree on sends an operator
// hunting for a mismatch that does not exist.
const MIN_TOKEN_LEN = 24;

/**
 * CAN THIS BOT CREATE A LISTING RIGHT NOW — reads are not the same question.
 *
 * The auto-lister's whole failure mode was that nothing ever asked this: a
 * create the site refused was a `continue`, and 🔎 Test scan — the button whose
 * job is answering "why has nothing been listed?" — only ever exercised the
 * READ path, so it went on reporting "2 qualify" over a service that could not
 * publish anything at all. A guard is only honest while it measures the stack
 * the runner uses.
 *
 * ⚠️ Probed with a body the site's own validator refuses OUTRIGHT (`buildRow`
 * rejects an empty chain before `addListing` is ever reached), so this can never
 * create, promote or touch a row. A 400 back is the proof we wanted: the route
 * authorised us and then refused the payload.
 *
 * @returns {Promise<{ok: boolean, status: number|null, why: string|null}>}
 */
async function canCreate() {
  if (!INTERNAL_API_TOKEN) return { ok: false, status: null, why: "INTERNAL_API_TOKEN is not set" };
  if (INTERNAL_API_TOKEN.length < MIN_TOKEN_LEN) {
    return {
      ok: false,
      status: null,
      why: `INTERNAL_API_TOKEN is only ${INTERNAL_API_TOKEN.length} characters — the site refuses anything under ${MIN_TOKEN_LEN}, however exactly the two halves match`,
    };
  }
  try {
    await createListing({});
    return { ok: false, status: 200, why: "the site accepted an empty listing payload — its validator is not refusing what it should" };
  } catch (e) {
    const m = String(e.message);
    const status = Number((m.match(/→\s*(\d{3})/) || [])[1]) || null;
    // 400 = authorised, reachable, and the validator working. That IS the pass.
    if (status === 400) return { ok: true, status, why: null };
    if (status === 401 || status === 403) {
      return { ok: false, status, why: `the site refuses this bot's credentials (${status}) — INTERNAL_API_TOKEN must match the one the web app reads` };
    }
    return { ok: false, status, why: m };
  }
}

/** Best-effort health check of the internal API + token. */
/**
 * Point a listing at OUR OWN COPY of its artwork — a compare-and-swap on the
 * site (lib/logoWrite applyPinnedLogo): true only when the row still held
 * `fromUrl`. `false` is an ordinary answer, not an error — an admin changed the
 * logo in the window, and their decision wins.
 */
async function pinLogo({ chain, address, fromUrl, toUrl }) {
  const out = await call("POST", "/api/internal/listings/pin-logo", { chain, address, fromUrl, toUrl });
  return Boolean(out && out.pinned);
}

async function ping() {
  try {
    await getListings();
    return true;
  } catch (e) {
    log.warn(`[api] internal API not reachable: ${e.message}`);
    return false;
  }
}

module.exports = {
  deleteListing,
  createListing,
  canCreate,
  MIN_TOKEN_LEN,
  updateListing,
  getListings,
  boardRank,
  findListing,
  bookTrending,
  expireTrending,
  bookBanner,
  uploadImage,
  pinLogo,
  ping,
};
