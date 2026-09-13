'use strict';
/*
 * A WAIT THAT SAYS IT IS WAITING.
 *
 * `seed:chain` has to sit out GeckoTerminal's 120-second cooldown, and its
 * first live run printed one line — "waiting 120s, then resuming at page 2" —
 * and then went silent for two minutes. It was correct, and it was reported as
 * the terminal being stuck, which is this repo's most-repeated shape: the
 * healthy state and the broken one look identical. A countdown is the
 * difference, and it costs one line.
 *
 * A LEAF MODULE, deliberately. It requires nothing — not constants, not the
 * logger — so a test can drive the real renderer with a fake stream, rather
 * than requiring a script whose `loadEnv({override:true})` would replace the
 * test runner's environment with the server's.
 *
 * ONLY when the stream is a TTY: `\r` in a piped log, a cron mail or a pm2 log
 * is line noise, and this exists to make a run legible, not to decorate it.
 */

/** `95s` → `1m 35s`. Seconds under a minute stay seconds — "0m 42s" reads as
 *  a stopwatch nobody asked for. */
function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * A progress renderer for one run.
 *
 * `out` is the stream, `now` the clock and `setTimer`/`clearTimer` the interval
 * pair — all injectable, so a test can advance a 120-second countdown in
 * microseconds and read back every frame it painted.
 */
function createProgress({
  out = process.stdout,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  colors = {},
} = {}) {
  const { Y = '', D = '', X = '' } = colors;
  const tty = !!out.isTTY;
  let timer = null;

  /** Wipe whatever is on the current line and stop any countdown on it. */
  function clear() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (tty) out.write('\r\x1b[2K');
  }

  function handle(ev) {
    if (!tty || !ev) return;
    if (ev.kind === 'read') {
      clear();
      out.write(`${D}  ${ev.chain}: read ${ev.pages} page(s), ${ev.found} candidate(s) so far${X}\r`);
      return;
    }
    if (ev.kind === 'resume') {
      clear();
      return;
    }
    if (ev.kind !== 'wait') return;
    clear();
    const until = now() + ev.ms;
    const draw = () => {
      const left = until - now();
      // Reaching zero clears the line rather than painting "0s" for ever — the
      // resume event may not arrive first, and a frozen countdown is exactly
      // the stuck-looking silence this replaces.
      if (left <= 0) return clear();
      out.write(
        `${Y}  ${ev.chain}: rate limited — resuming at page ${ev.page} in ${mmss(left)}${X}` +
          `${D} (${ev.found} candidate(s) so far)${X}  \r`,
      );
    };
    draw();
    timer = setTimer(draw, 1000);
    // An interval must never be the reason the process outlives its work.
    if (timer && timer.unref) timer.unref();
  }

  return { handle, clear, tty };
}

module.exports = { createProgress, mmss };
