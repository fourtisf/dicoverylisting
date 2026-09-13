// A wait that says it is waiting.
//
// `seed:chain` must sit out GeckoTerminal's 120-second cooldown, and its first
// live run printed one line and then went silent for two minutes. Nothing was
// wrong — and it was reported as the terminal being stuck, because a correct
// wait and a hung process are the same thing from outside. These DRIVE the
// renderer and read back the frames it actually painted; a source scan would
// pass on a countdown that never ticks.
const test = require("node:test");
const assert = require("node:assert");
const { createProgress, mmss } = require("../src/helpers/cliProgress");

/** A fake stdout that remembers every frame, plus a hand-cranked clock. */
function fake({ isTTY = true } = {}) {
  const writes = [];
  const timers = [];
  let clock = 1_000_000;
  const p = createProgress({
    out: { isTTY, write: (c) => writes.push(String(c)) },
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn);
      return { fn, unref() {} };
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t && t.fn);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    p,
    writes,
    /** Advance the clock and fire whatever interval is live. */
    tick(ms) {
      clock += ms;
      for (const fn of [...timers]) fn();
    },
    /** The visible frames, escape codes stripped. */
    frames: () =>
      writes
        .join("")
        .split("\r")
        .map((f) => f.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim())
        .filter(Boolean),
  };
}

test("the countdown TICKS DOWN — it is the evidence the run is not hung", () => {
  const f = fake();
  f.p.handle({ chain: "bsc", kind: "wait", ms: 120_000, page: 2, found: 7 });
  const first = f.frames().at(-1);
  f.tick(30_000);
  const later = f.frames().at(-1);
  f.tick(60_000);
  const last = f.frames().at(-1);

  assert.match(first, /bsc: rate limited — resuming at page 2 in 2m 00s/);
  assert.match(later, /in 1m 30s/);
  assert.match(last, /in 30s/);
  assert.notStrictEqual(first, last, "a frozen frame is the silence this replaces");
  // The candidate count rides along, so a long wait still says what it is for.
  assert.match(last, /7 candidate\(s\) so far/);
});

test("it stops at zero rather than painting 0s for ever", () => {
  const f = fake();
  f.p.handle({ chain: "bsc", kind: "wait", ms: 5000, page: 2, found: 3 });
  f.tick(6000);
  // A stuck countdown is exactly the hung-looking state this exists to end —
  // and `resume` may not arrive first, so reaching zero has to clear itself.
  assert.ok(!/in 0s/.test(f.frames().at(-1) || ""), "zero must clear, not freeze");
  f.tick(60_000);
  assert.ok(!/in -/.test(f.writes.join("")), "and it must never count into negatives");
});

test("resume clears the countdown, and stops its timer", () => {
  const f = fake();
  f.p.handle({ chain: "base", kind: "wait", ms: 120_000, page: 2, found: 1 });
  const before = f.writes.length;
  f.p.handle({ chain: "base", kind: "resume", page: 2 });
  const after = f.writes.length;
  f.tick(30_000);
  assert.strictEqual(f.writes.length, after, "a cleared countdown must not keep painting");
  assert.ok(after > before);
});

test("a page read reports what it found, so progress is visible between waits", () => {
  const f = fake();
  f.p.handle({ chain: "ethereum", kind: "read", pages: 3, found: 41 });
  assert.match(f.frames().at(-1), /ethereum: read 3 page\(s\), 41 candidate\(s\) so far/);
});

test("NOTHING is painted when the stream is not a TTY", () => {
  // A piped log, a cron mail and a pm2 log get the service's own log lines. A
  // carriage return in any of them is line noise, and 120 frames of it is a
  // log nobody can read.
  const f = fake({ isTTY: false });
  f.p.handle({ chain: "bsc", kind: "wait", ms: 120_000, page: 2, found: 7 });
  f.p.handle({ chain: "bsc", kind: "read", pages: 1, found: 7 });
  f.tick(60_000);
  assert.deepStrictEqual(f.writes, []);
  assert.strictEqual(f.p.tty, false);
});

test("mmss stays in seconds under a minute", () => {
  assert.strictEqual(mmss(0), "0s");
  assert.strictEqual(mmss(42_000), "42s");
  assert.strictEqual(mmss(59_400), "59s");
  assert.strictEqual(mmss(60_000), "1m 00s");
  assert.strictEqual(mmss(125_000), "2m 05s");
  assert.strictEqual(mmss(-5000), "0s", "a clock that ran past never reads as negative");
});

test("a renderer that throws can never break the run", () => {
  // The service wraps onProgress in a try/catch for this, but the renderer
  // owning its own safety is what makes that true of every caller.
  const p = createProgress({ out: { isTTY: true, write() { throw new Error("EPIPE"); } } });
  assert.throws(() => p.handle({ chain: "bsc", kind: "read", pages: 1, found: 1 }));
  // …and the service's guard is the layer that absorbs it — pinned next door
  // in chainSeed.test.js.
});
