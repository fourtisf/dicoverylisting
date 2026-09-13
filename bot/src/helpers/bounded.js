// A deadline for work that is allowed to fail.
//
// Fulfilment is full of steps whose own comments call them best-effort — the
// animated custom emoji ("a failure NEVER blocks a paid listing"), the ffmpeg
// clip composite ("any failure falls back to the raw clip"). Every one of them
// was unbounded, and BEST-EFFORT WITHOUT A DEADLINE IS NOT BEST-EFFORT, IT IS A
// HANG: the fallback only runs if the step finishes, and an ffmpeg that never
// returns never fails either.
//
// Reported 2026-09-06: an Xpress listing sat on "Running your order — hang
// tight…" for TEN MINUTES. Detaching fulfilment from Telegraf's 120s timeout
// stopped it being killed; it did nothing about how long it takes.
//
// ⚠️ THE TIMER IS NOT unref'd. Something is awaiting this, and an unref'd timer
// does not hold the event loop open — a process with nothing else pending exits
// with the caller hung for ever. This file's own subject has that scar twice
// already (tradebot's bounded(), and the first cut of fulfilDetached.test.js).
//
// The timer is CLEARED on the winning path either way, or a 60s budget keeps
// the loop alive for 60s after a step that finished in 200ms.
function bounded(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(typeof onTimeout === "function" ? onTimeout() : null), ms);
    }),
  ]);
}

module.exports = { bounded };
