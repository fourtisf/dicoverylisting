// Minimal ABI codec — only the shapes the Pons v2 provider actually reads:
// static value types, static tuples (flattened by the caller) and strings.
// Deliberately not a general-purpose ABI library; anything it can't express is
// out of scope for a read-only integration.
import { keccak256Hex } from "./keccak";

export type AbiType =
  | "address"
  | "bool"
  | "uint8"
  | "uint16"
  | "uint24"
  | "uint256"
  | "int24"
  | "string";

const DYNAMIC: ReadonlySet<AbiType> = new Set<AbiType>(["string"]);

const INT_BITS: Partial<Record<AbiType, number>> = {
  uint8: 8,
  uint16: 16,
  uint24: 24,
  uint256: 256,
  int24: 24,
};

/** 4-byte function selector for a canonical signature, e.g. `decimals()`. */
export const selector = (signature: string): string => keccak256Hex(signature).slice(0, 10);

/** 32-byte event topic0 for a canonical event signature. */
export const topic0 = (signature: string): string => keccak256Hex(signature);

/** An address as a 32-byte topic word, for indexed-parameter log filters. */
export const addressTopic = (address: string): string =>
  `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

const strip = (hex: string): string => hex.replace(/^0x/, "");

/** ABI-encodes a call. Supports address / uint256 / bool arguments only. */
export function encodeCall(signature: string, args: (string | bigint | boolean)[] = []): string {
  let data = selector(signature);
  for (const arg of args) {
    if (typeof arg === "string") data += strip(addressTopic(arg));
    else if (typeof arg === "boolean") data += (arg ? 1n : 0n).toString(16).padStart(64, "0");
    else data += arg.toString(16).padStart(64, "0");
  }
  return data;
}

const wordAt = (body: string, index: number): string => body.slice(index * 64, index * 64 + 64);

function toBigInt(word: string): bigint {
  return word.length ? BigInt(`0x${word}`) : 0n;
}

/** Two's-complement read for the signed types we use. */
function toSigned(word: string, bits: number): bigint {
  const raw = toBigInt(word);
  const limit = 1n << BigInt(bits - 1);
  const modulus = 1n << BigInt(bits);
  // Solidity sign-extends to 32 bytes, so read the low `bits` and re-interpret.
  const masked = raw & (modulus - 1n);
  return masked >= limit ? masked - modulus : masked;
}

function decodeString(body: string, byteOffset: number): string {
  const head = byteOffset * 2;
  const length = Number(toBigInt(body.slice(head, head + 64)));
  if (!Number.isFinite(length) || length <= 0) return "";
  const bytes = body.slice(head + 64, head + 64 + length * 2);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += `%${bytes.slice(i, i + 2)}`;
  try {
    return decodeURIComponent(out);
  } catch {
    return "";
  }
}

/**
 * Decodes `eth_call` return data against a flat list of types. A static struct
 * return is encoded inline, so pass its members flattened in declaration order.
 * Throws on empty/short data so callers can fall back per token.
 */
export function decodeReturn(types: AbiType[], data: string): unknown[] {
  const body = strip(data);
  if (body.length < types.length * 64) throw new Error("short return data");
  return types.map((type, index) => {
    const word = wordAt(body, index);
    if (DYNAMIC.has(type)) return decodeString(body, Number(toBigInt(word)));
    if (type === "address") return `0x${word.slice(24)}`;
    if (type === "bool") return toBigInt(word) !== 0n;
    const bits = INT_BITS[type] ?? 256;
    return type.startsWith("int") ? toSigned(word, bits) : toBigInt(word);
  });
}

/** Decodes the non-indexed parameters carried in a log's `data` field. */
export const decodeLogData = decodeReturn;

/** Reads an indexed `address` topic back to a checksum-less address. */
export const topicToAddress = (topic: string): string => `0x${strip(topic).slice(24)}`;

/** Scales a raw token amount to a JS number. Safe for display-sized values. */
export function fromUnits(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const value = Number(whole) + Number(fraction) / Number(base);
  return negative ? -value : value;
}

export const toHexQuantity = (value: number | bigint): string => `0x${BigInt(value).toString(16)}`;
