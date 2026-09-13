// What a VISITOR is told when an upstream could not be read.
//
// The reasons this app produces internally are written for an OPERATOR, and
// they are good ones — gt.ts deliberately names US rather than blaming
// GeckoTerminal, because reporting our own pacing as "GeckoTerminal 429" sends
// somebody off to check a service that is perfectly healthy. What was never
// separated is the AUDIENCE. That sentence travelled through readWhy() straight
// into a JSON `why` and onto a public token page, so a project's investors read
//
//   Couldn't read recent trades just now (over this process's GeckoTerminal
//   budget (5/min, shared with the bot suite on this IP) — raise GT_MAX_RPM or
//   set GECKOTERMINAL_API_KEY).
//
// Two env var names, our process's budget, and the fact that a bot suite shares
// this IP — none of which a visitor can act on, and all of which reads as a
// broken site. The chart note was worse: it carried the upstream's own
// Cloudflare probe (`window.__CF$cv$params={r:'a36be9ab…'}`) verbatim.
//
// So the internal reason keeps its full detail and goes to the LOG, and this is
// the one owner of what reaches a browser. A denylist of forbidden words would
// be the fragile version of this — the next sentence nobody thought of walks
// straight through it — so the mapping is by CLASS, and anything unrecognised
// falls to the vaguest of the three rather than to the raw text.

/** The classes a visitor can actually distinguish, and act on. */
export type PublicKind = "busy" | "unavailable";

const BUSY =
  /rate.?limit|429|cooling|cool.?down|budget|too many requests|quota|slow down|retry.?after/i;

/**
 * Classify an internal upstream reason for a public surface.
 *
 * "busy" is the one worth telling apart: it passes on its own, every poll gets
 * closer to working, and the panel retries — so the sentence promises exactly
 * that. Everything else is reported as a read that did not land, without
 * guessing whose fault it was: a 404 from one source and a dead socket from
 * another are the same fact to somebody reading a token page.
 */
export function publicKind(internal: unknown): PublicKind {
  const msg = typeof internal === "string" ? internal : String((internal as { message?: string })?.message ?? "");
  return BUSY.test(msg) ? "busy" : "unavailable";
}

/**
 * The sentence itself. `subject` names what could not be read ("recent trades",
 * "the chart") so one helper serves every panel without each growing its own
 * copy of the wording.
 *
 * Both sentences say the page fixes ITSELF, because both are true — the trades
 * panel polls and the chart fast-retries — and because "try again later" on a
 * surface that is already retrying is an instruction to do nothing.
 *
 * ⚠️ BOTH SENTENCES MUST CARRY "Couldn't read". CandleChart classifies
 * error-vs-answer on exactly that substring (`/couldn't read/i`), and only an
 * ERROR gets the fast retry that makes a chart appear the moment a GT cooldown
 * lifts. A friendlier "Live data is busy right now" with the words dropped
 * reads as "this pool has no candles", which never retries — so the most
 * common failure would have been the one that stayed blank until a reload.
 * Caught by dsChart.test.ts, which had that contract written down; the first
 * cut of this file broke it.
 *
 * ⚠️ The subject is a NOUN PHRASE and the sentence must not agree with it in
 * number or take an article of its own. The first cut read
 * `Live ${subject} are busy` — fine for "recent trades", and "Live the chart
 * are busy right now" one caller over; the second took a pronoun and produced
 * "recent trades will appear by itself". Both were caught by PRINTING every
 * subject, not by reading the template.
 */
export function publicNote(subject: string, internal: unknown): string {
  return publicKind(internal) === "busy"
    ? `Couldn't read ${subject} just now — live data is busy; this refreshes by itself in a moment.`
    : `Couldn't read ${subject} just now — this refreshes by itself.`;
}
