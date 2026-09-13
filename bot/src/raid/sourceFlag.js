// Who owns "is this keyless X source switched on?" — one implementation, read
// by xEmbed.js and xGuest.js.
//
// THE DEFAULT IS ON, and that is a reversal worth explaining, because the two
// modules it gates still carry (correct) warnings about why they used to ship
// off.
//
// Both keyless sources were opt-in, and `X_BEARER_TOKEN` ships blank. So a
// stock Dexvra had NO X source at all: `xMetrics.anySource()` was false, every
// raid launched crew-only, and likes/replies/reposts could never appear on a
// card. From inside Telegram that is indistinguishable from a broken feature —
// the panel says "Likes +15", the raid starts, and the number never moves.
// Shipping a metrics reader that reads nothing by default is a worse failure
// than the datacenter-IP risk the off-default was protecting against, and the
// reference bot this feature is modelled on runs with both flags ON.
//
// So: absent or blank means ON. An operator who wants the old behaviour writes
// `RAID_FREE_METRICS=0`, and that still wins — turning a source off must always
// be expressible, or the warnings in those two files describe a state nobody
// can reach.
//
// The blank case is deliberate and is NOT the same as `bool()` in
// config/constants.js, which treats "" as false. A `.env` carrying a bare
// `RAID_GUEST_METRICS=` reads as "the operator has not decided", not as "off" —
// that line is what `.env.example` used to ship, and reading it as an explicit
// refusal would keep the source dark on exactly the boxes that copied the
// template without editing it.

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;

/**
 * @param {string} name  the env var, e.g. "RAID_GUEST_METRICS"
 * @returns {boolean}
 */
function sourceEnabled(name) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return true; // unset or blank → never configured → on
  if (OFF.test(raw)) return false; // an explicit refusal always wins
  if (ON.test(raw)) return true;
  // Anything else is a typo (`RAID_GUEST_METRICS=true please`). Treating it as
  // OFF would silently blind the raid for a reason nothing reports; the
  // configured intent was plainly not "disable", so keep the default.
  return true;
}

module.exports = { sourceEnabled };
