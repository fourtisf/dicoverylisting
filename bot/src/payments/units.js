// Smallest-unit conversion per chain. Everything on the payment path is a BigInt
// in the chain's smallest unit (wei / lamports / sun / nanoton) and compared
// with >=. ethers.parseUnits handles any decimal count exactly.
const { ethers } = require("ethers");
const { decimalsOf, nativeOf } = require("../config/chains");

/** human amount (e.g. 0.06, "5") → BigInt smallest unit for the chain.
 *  Uses the value's shortest round-trip string (so 0.06 stays 0.06, not
 *  0.059999…) and truncates excess fraction digits by string slicing — never
 *  Number.toFixed, which reintroduces binary float error. */
function toSmallest(chain, human) {
  const d = decimalsOf(chain);
  let s = typeof human === "string" ? human.trim() : String(human);
  if (/[eE]/.test(s)) s = Number(s).toFixed(d); // expand rare scientific notation
  const [int, frac = ""] = s.split(".");
  const fracTrim = frac.slice(0, d);
  s = fracTrim ? `${int}.${fracTrim}` : int || "0";
  return ethers.parseUnits(s, d);
}

/**
 * Add two package prices EXACTLY.
 *
 * ⚠️ `1.15 + 0.15` is `1.2999999999999998` in float, and both operands are
 * ordinary decimal literals out of config/packages.js — so a Platinum listing
 * on BSC with the broadcast add-on put `Amount: 1.2999999999999998 BNB` on the
 * pay card. Measured before this existed, not feared: 0.06 + 0.05 happens to
 * come out clean and 1.15 + 0.15 does not, which is exactly the shape that
 * survives a casual test and reaches the one screen that takes the money.
 *
 * Scaled to integers at the wider of the two operands' own decimal counts, so
 * nothing is rounded that the caller did not already write down. Kept beside
 * toSmallest because this is the only other place in the bot where a money
 * amount is computed rather than read from a table.
 *
 * DEC_CAP bounds the scale: a float that has already lost precision can report
 * 17 decimals, and 10**17 is past the exact-integer range. Package prices have
 * at most four, so the cap can only ever bite a value that was already wrong.
 */
const DEC_CAP = 9;
const decimalsIn = (n) => Math.min((String(n).split(".")[1] || "").length, DEC_CAP);
function addAmount(a, b) {
  const d = Math.max(decimalsIn(a), decimalsIn(b));
  const scale = 10 ** d;
  return (Math.round(Number(a) * scale) + Math.round(Number(b) * scale)) / scale;
}

/**
 * Take the add-on back off — the exact inverse, on the same integer scale.
 *
 * ⚠️ NOT `a - b`. The pay-card add-on is a TOGGLE (fourtis: "tap to remove"), so
 * the removal has to land back on the package's own listed price to the digit:
 * `1.3 - 0.15` is `1.1500000000000001` in float, and a buyer who added the
 * broadcast and changed their mind would be quoted a number that is in no price
 * table, on the card that takes the money.
 */
const subAmount = (a, b) => addAmount(a, -Number(b));

/** BigInt smallest unit → human string (trailing zeros trimmed). */
function toHuman(chain, amount) {
  const d = decimalsOf(chain);
  const s = ethers.formatUnits(BigInt(amount), d);
  return s.replace(/\.?0+$/, "") || "0";
}

/** e.g. "0.06 ETH" for display. */
function humanWithSymbol(chain, amount) {
  return `${toHuman(chain, amount)} ${nativeOf(chain)}`;
}

module.exports = { toSmallest, toHuman, humanWithSymbol, addAmount, subAmount };
