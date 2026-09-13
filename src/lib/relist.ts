// WHAT A RE-LIST MAY DO TO A LISTING THAT ALREADY EXISTS.
//
// `addListing` treats a chain+address it already holds as the SAME listing and
// keeps its id — but it then wrote the incoming row over the old one whole:
//
//     created = { ...rec, id: rows[dupIdx].id, … };
//     rows[dupIdx] = created;
//
// and `buildRow` renders an absent optional field as `undefined`
// (`logoUrl: input.logoUrl ? String(input.logoUrl) : undefined`). So every
// re-POST of a token the site already carries ERASED whatever it did not
// re-supply: the logo a project uploaded on the listing form, the socials they
// typed, the overview, and a paid trending window that was still running.
//
// Nothing announced it and nothing failed. From outside it is exactly the
// report this module exists for — "project ini punya logo pas listing mengapa
// skrg sudah ilang" — a row that had artwork on the day it was sold and draws
// a monogram now.
//
// ⚠️ THE RULE IS "ABSENT MUST NOT ERASE", NOT "NEVER CHANGE". A re-list that
// carries a value still wins: an operator re-listing with a new logo gets the
// new logo, and the auto-lister refreshing a token's socials still refreshes
// them. What it may no longer do is turn something into nothing by saying
// nothing — the same asymmetry `applyResolvedLogo` is built on, pointing the
// other way.
//
// CLEARING A FIELD IS THE EDIT PATH'S JOB. `sanitizePatch` reads `""` as
// "clear this" precisely because a PATCH is an edit and an edit can mean it;
// a POST is a create, and a create that arrives without a field is not a
// statement about that field.
//
// PURE, and in its own module, because "a re-list cannot erase" is a MUTATION
// property: a source scan cannot tell a guard from a comment about one, and
// store.ts is unreachable from the node:test runner (it imports "./listings"
// with no extension, which only Next resolves). Same split as logoWrite.ts.

/** The fields a re-list may only ever FILL, never blank. Each is something a
 *  person decided or paid for, and none of them is re-supplied by every caller
 *  that has a reason to re-POST a token. */
export const PRESERVED_ON_RELIST = [
  // artwork + identity a project gave us on the listing form
  "logoUrl",
  "website",
  "twitter",
  "telegram",
  "overview",
  // …and a trending slot that is still running. A re-list that dropped these
  // ended a window somebody had paid for, mid-flight, with no refund path and
  // nothing in any log.
  "trendingRank",
  "trendStart",
  "trendExp",
] as const;

export type PreservedKey = (typeof PRESERVED_ON_RELIST)[number];

/** The shape this rule touches. Structural rather than `ListingRow` so the
 *  test runner can load this file without pulling in the Next-aliased half of
 *  the app — the reason logoWrite.ts declares its own `LogoRow`. */
export type Relistable = Partial<Record<PreservedKey, unknown>>;

/**
 * Merge an incoming re-list over the row already stored.
 *
 * Everything else on `next` wins as before — the market figures, the name, the
 * ticker, the tier. Only the fields above fall back to `prev`, and only when
 * the incoming value is absent: `undefined`, `null`, or a string that is blank
 * once trimmed (which is what an empty form field becomes on its way through
 * `buildRow`).
 *
 * Returns a NEW object; neither argument is mutated.
 */
export function mergeRelist<T extends Relistable>(prev: Relistable, next: T): T {
  const out = { ...next };
  for (const k of PRESERVED_ON_RELIST) {
    if (!absent(out[k])) continue; // the re-list said something — it wins
    const kept = prev[k];
    if (absent(kept)) continue; // nothing to keep either
    (out as Relistable)[k] = kept;
  }
  return out;
}

/** "The payload did not carry this." A blank string counts: it is what an
 *  untouched form field and a stripped-out value both arrive as, and reading
 *  it as an instruction to delete is the whole defect. */
function absent(v: unknown): boolean {
  if (v == null) return true;
  return typeof v === "string" && v.trim() === "";
}


// ── and the half a re-list does not carry: the row's STANDING ────────────────

/**
 * A create may PROMOTE a listing's status. It may never demote one.
 *
 * ⚠️ `/api/submit` is unauthenticated and calls `addListing(row, {status:
 * "pending"})`. On a duplicate, `addListing` keeps the existing row's id — so a
 * submission for an address that is already an APPROVED paid listing took that
 * row over and set it back to `pending`. `approvedRows()` filters on
 * `status === "approved"`, so **the listing simply left the site**: a stranger
 * could unpublish a paying customer by typing their contract into the public
 * form, five times per IP per ten minutes.
 *
 * The submit route now refuses a duplicate outright — one token, one listing,
 * the rule the bot's own listing flow states before it will even take a form.
 * This is the second lock, and it is at the STORE for the reason
 * `deleteListing`'s guard is: *a caller can be wrong about what it is holding,
 * and the store cannot.*
 *
 * Demotion is still perfectly possible — through `setStatus`, which is what an
 * admin rejecting a listing calls. What may not happen is a row losing its
 * standing as a SIDE EFFECT of somebody creating something.
 */
const RANK: Record<string, number> = { rejected: 0, pending: 1, approved: 2 };

export function keepStatus(prev: string | undefined, next: string): string {
  const p = RANK[String(prev ?? "")];
  const n = RANK[String(next)];
  // An unknown status on either side is not something to reason about: hand
  // back what the caller asked for rather than inventing a ranking for it.
  if (p == null || n == null) return next;
  return p > n ? String(prev) : next;
}
