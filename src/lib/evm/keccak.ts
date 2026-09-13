// keccak-256 (the Ethereum variant — 0x01 padding, NOT the FIPS SHA3-256 that
// node:crypto ships). Implemented here rather than pulling in ethers/viem: the
// app has zero runtime dependencies beyond next/react and we only need hashing
// to derive function selectors and event topics, which happens once per process.
// Verified against known vectors in scripts/test-pons.mjs.

const MASK = (1n << 64n) - 1n;
const RATE = 136; // 1088-bit rate for keccak-256

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rho rotation offsets, indexed by lane = x + 5y
const ROT: number[] = [
   0,  1, 62, 28, 27,
  36, 44,  6, 55, 20,
   3, 10, 43, 25, 39,
  41, 45, 15, 21,  8,
  18,  2, 61, 56, 14,
];

const rotl = (x: bigint, n: number): bigint =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function keccakF(a: bigint[]): void {
  const b = new Array<bigint>(25);
  const c = new Array<bigint>(5);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
      }
    }
    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
      }
    }
    // iota
    a[0] ^= RC[round];
  }
}

/** keccak-256 digest of `input`. */
export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // Pad: message || 0x01 || 0x00* || 0x80, to a multiple of the rate.
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        word = (word << 8n) | BigInt(padded[off + lane * 8 + byte]);
      }
      state[lane] ^= word;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

const encoder = new TextEncoder();

/** keccak-256 of a UTF-8 string, as a 0x-prefixed hex digest. */
export function keccak256Hex(text: string): string {
  const digest = keccak256(encoder.encode(text));
  let hex = "0x";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
