import test from "node:test";
import assert from "node:assert/strict";
import { PRESERVED_ON_RELIST, keepStatus, mergeRelist } from "./relist.ts";

// The row as it sits in the store: a project's uploaded artwork, the socials
// they typed, and a trending slot somebody paid for and is still running.
const STORED = {
  chain: "solana",
  address: "VJdpSDDLof7HuZiNmsRUSL4YCncsk1FGiVoHyAJpump",
  sym: "$BREAKING",
  logoUrl: "/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.png",
  website: "https://breaking.example",
  twitter: "https://x.com/breaking",
  telegram: "https://t.me/breaking",
  overview: "A token.",
  trendingRank: 1,
  trendStart: 1_000,
  trendExp: 9_000,
  mcap: 1,
};

/** What `buildRow` produces for a re-POST that carried none of the optional
 *  fields: they are not missing keys, they are keys set to `undefined`. */
const BARE = {
  chain: "solana",
  address: "VJdpSDDLof7HuZiNmsRUSL4YCncsk1FGiVoHyAJpump",
  sym: "$BREAKING",
  logoUrl: undefined,
  website: undefined,
  twitter: undefined,
  telegram: undefined,
  overview: undefined,
  trendingRank: undefined,
  trendStart: undefined,
  trendExp: undefined,
  mcap: 2,
};

test("THE BUG: a re-list that says nothing about the logo does not delete it", () => {
  // "project ini punya logo pas listing mengapa skrg sudah ilang" — the row was
  // sold with artwork and re-POSTed later by a caller that had none.
  const out = mergeRelist(STORED, BARE);
  assert.equal(out.logoUrl, STORED.logoUrl);
});

test("…and the same is true of every field somebody typed or paid for", () => {
  const out = mergeRelist(STORED, BARE) as Record<string, unknown>;
  for (const k of PRESERVED_ON_RELIST)
    assert.equal(out[k], (STORED as Record<string, unknown>)[k], `${k} survived the re-list`);
});

test("a re-list that DOES carry a value still wins — this is not a freeze", () => {
  const out = mergeRelist(STORED, { ...BARE, logoUrl: "https://cdn.example/new.png", twitter: "https://x.com/moved" });
  assert.equal(out.logoUrl, "https://cdn.example/new.png");
  assert.equal(out.twitter, "https://x.com/moved");
  // …and the untouched ones are still kept.
  assert.equal(out.website, STORED.website);
});

test("everything outside the preserved set is the re-list's to change", () => {
  const out = mergeRelist(STORED, BARE) as Record<string, unknown>;
  assert.equal(out.mcap, 2, "market figures are exactly what a re-list is for");
  assert.equal(out.sym, "$BREAKING");
});

test("a blank string is ABSENT, not an instruction to delete", () => {
  // An untouched form field and a stripped-out value both arrive as "", and
  // reading that as "clear this" is the defect. Clearing is the PATCH path's
  // job (sanitizePatch), where "" is an edit somebody made on purpose.
  const out = mergeRelist(STORED, { ...BARE, logoUrl: "", website: "   " });
  assert.equal(out.logoUrl, STORED.logoUrl);
  assert.equal(out.website, STORED.website);
});

test("nothing stored, nothing supplied → still nothing (no key invented)", () => {
  const out = mergeRelist({ chain: "solana", address: "x" }, { ...BARE });
  assert.equal(out.logoUrl, undefined);
  assert.equal(out.trendExp, undefined);
});

test("neither argument is mutated", () => {
  const prev = { ...STORED };
  const next = { ...BARE };
  mergeRelist(prev, next);
  assert.deepEqual(prev, STORED);
  assert.deepEqual(next, BARE);
});

test("a trending window that is still running is not ended by a re-list", () => {
  // It is money: the slot was bought for a period, and a re-POST that dropped
  // trendExp ended it mid-flight with nothing anywhere saying so.
  const out = mergeRelist(STORED, BARE);
  assert.equal(out.trendExp, 9_000);
  assert.equal(out.trendingRank, 1);
});


// ── a create may promote a row, never demote it ─────────────────────────────

test("⚠️ THE TAKEOVER: a public submission cannot unpublish a live listing", () => {
  // `/api/submit` is unauthenticated and creates with `pending`. On a duplicate
  // `addListing` keeps the existing row's id, so the submission did not create
  // anything — it took the row over and set it back to pending, and
  // `approvedRows()` filters on approved. The listing simply left the site.
  assert.equal(keepStatus("approved", "pending"), "approved");
  assert.equal(keepStatus("approved", "rejected"), "approved");
});

test("…but a create may still PROMOTE one", () => {
  // An admin adding a token that is sitting in the pending queue, or the bot
  // creating an approved listing over a rejected row, are both real.
  assert.equal(keepStatus("pending", "approved"), "approved");
  assert.equal(keepStatus("rejected", "approved"), "approved");
  assert.equal(keepStatus("rejected", "pending"), "pending");
});

test("a brand-new row gets exactly what the caller asked for", () => {
  assert.equal(keepStatus(undefined, "pending"), "pending");
  assert.equal(keepStatus(undefined, "approved"), "approved");
});

test("an unknown status is not something to invent a ranking for", () => {
  assert.equal(keepStatus("archived", "pending"), "pending");
  assert.equal(keepStatus("approved", "whatever"), "whatever");
});

test("demotion is still possible — it just is not a side effect of a create", () => {
  // `setStatus` is what an admin rejecting a listing calls, and it is untouched.
  // This rule is only about what CREATING something may do to a row that exists.
  assert.notEqual(keepStatus("approved", "pending"), "pending");
});
