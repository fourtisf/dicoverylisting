// On-chain reads against the Pons v2 launchpad. Everything the provider knows
// about a launch comes from three places, in this order:
//   1. PonsV2LaunchFactory.getLaunchedToken(token) — the launch record
//   2. the launch's PonsV2BondingCurve — reserves, while it is still on-curve
//   3. the graduated Uniswap V4 pool — price, once the curve has been swept
// Reads are batched; an unreadable token degrades to null rather than throwing.
import { PONS, ZERO_ADDRESS, GRADUATION_PHASES, type GraduationPhase } from "@/config/pons";
import { decodeReturn, encodeCall, type AbiType } from "@/lib/evm/abi";
import { keccak256 } from "@/lib/evm/keccak";
import { unanswered, ethCall, rpcBatch, type RpcOutcome } from "@/lib/evm/rpc";
import { tokenLogo } from "./logo";

const call = (to: string, data: string) => ethCall(to, data);

// ── ILaunchpadV2.IPonsV2LaunchFactory.LaunchedToken ───────────────────────
// A fully static struct, so the return data is the members inline, in order.
const LAUNCHED_TOKEN_TYPES: AbiType[] = [
  "address", // token
  "address", // curve
  "address", // deployer
  "address", // creatorFeeRecipient
  "address", // pairToken
  "uint256", // graduationThreshold
  "uint24", //  poolFee
  "int24", //   tickSpacing
  "uint16", //  creatorTaxBps
  "bool", //    buybackEnabled
  "uint8", //   phase (GraduationPhase)
  "uint256", // sweptQuote
  "uint256", // sweptTokens
  "uint256", // sweptAt
  "bool", //    exists
];

export interface LaunchRecord {
  token: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  nativeQuote: boolean;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: GraduationPhase;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: number;
}

export interface CurveState {
  quoteReserve: bigint; // includes the phantom reserve — this is the marginal price side
  tokenReserve: bigint;
  realQuoteReserve: bigint; // quote actually held, net of pending fees
  sellableTokens: bigint;
  graduated: boolean;
}

export interface TokenMeta {
  decimals: number;
  totalSupply: bigint;
  symbol: string;
  name: string;
  logo: string | null;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

export interface LaunchSnapshot {
  launch: LaunchRecord;
  curve: CurveState | null;
  meta: TokenMeta | null;
  pool: PoolState | null;
  /** The node's own reason when the curve or the token metadata could not be
   *  READ — null when they were. A `curve: null` with a reason is "the RPC
   *  refused to say"; without one it is "the curve answered nothing". The
   *  first was rendered as the second for a whole deploy: name, symbol, logo
   *  and price all null, "the creator filled nothing in", TBA on the post —
   *  over a public node answering HTTP 429. */
  readWhy: string | null;
}

const ok = <T,>(outcome: RpcOutcome<unknown> | undefined, decode: (hex: string) => T): T | null => {
  if (!outcome?.ok) return null;
  try {
    return decode(String(outcome.value));
  } catch {
    return null;
  }
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : "the pool read failed");

const one = <T,>(types: AbiType[], hex: string): T => decodeReturn(types, hex)[0] as T;

// ── Launch records ────────────────────────────────────────────────────────
/**
 * The records AND the addresses whose read FAILED, with the node's reason.
 *
 * ⚠️ AN ADDRESS WHOSE RECORD COULD NOT BE READ IS NOT "NOT A PONS LAUNCH".
 * A failed address is OMITTED from `records`, and an omitted address reads
 * downstream exactly like one Pons never launched. The all-fail throw below
 * has always covered the single-address read (`fetchPonsLaunch`) — but it
 * carried NO REASON ("Pons RPC unavailable"), so a 429 and a dead socket
 * were one sentence on the box; and a refused item inside a healthy
 * multi-address batch was simply dropped, with nothing anywhere saying
 * which. The reason travels now, per address, so a caller can tell "the
 * node refused to say" from "not a Pons launch" — the two answers the bot
 * memos differently.
 */
export async function readLaunchRecordsX(
  addresses: string[],
): Promise<{ records: Map<string, LaunchRecord>; failed: Map<string, string> }> {
  const out = new Map<string, LaunchRecord>();
  const failed = new Map<string, string>();
  if (addresses.length === 0) return { records: out, failed };

  const results = await rpcBatch(
    PONS.rpcUrls,
    addresses.map((address) => call(PONS.factoryV2, encodeCall("getLaunchedToken(address)", [address]))),
    PONS.rpcTimeoutMs,
  );

  let failures = 0;
  addresses.forEach((address, i) => {
    const decoded = ok(results[i], (hex) => decodeReturn(LAUNCHED_TOKEN_TYPES, hex));
    if (!decoded) {
      failures++;
      const r = results[i];
      failed.set(address.toLowerCase(), r && !r.ok ? r.error : "undecodable answer");
      return;
    }
    const [
      token, curve, deployer, creatorFeeRecipient, pairToken, graduationThreshold,
      poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase,
      sweptQuote, sweptTokens, sweptAt, exists,
    ] = decoded as [
      string, string, string, string, string, bigint,
      bigint, bigint, bigint, boolean, bigint,
      bigint, bigint, bigint, boolean,
    ];
    // `exists` false means the factory has never launched this token.
    if (!exists || token === ZERO_ADDRESS) return;
    out.set(address.toLowerCase(), {
      token,
      curve,
      deployer,
      creatorFeeRecipient,
      pairToken,
      nativeQuote: pairToken === ZERO_ADDRESS,
      graduationThreshold,
      poolFee: Number(poolFee),
      tickSpacing: Number(tickSpacing),
      creatorTaxBps: Number(creatorTaxBps),
      buybackEnabled,
      phase: GRADUATION_PHASES[Number(phase)] ?? "NotGraduated",
      sweptQuote,
      sweptTokens,
      sweptAt: Number(sweptAt),
    });
  });

  // An address Pons never launched still answers — with a zeroed record. Every
  // call failing means the endpoint is down, which callers must be able to
  // tell apart from "not a Pons launch".
  if (failures === addresses.length) {
    const why = [...failed.values()][0];
    throw new Error(`Pons RPC unavailable${why ? ` — ${why}` : ""}`);
  }
  return { records: out, failed };
}

// ── Curve + token metadata ────────────────────────────────────────────────
const CURVE_CALLS = [
  "getReserves()",
  "realQuoteReserve()",
  "sellableTokens()",
  "graduated()",
] as const;

const TOKEN_CALLS = ["decimals()", "totalSupply()", "symbol()", "name()", "logo()"] as const;

const PER_TOKEN_CALLS = CURVE_CALLS.length + TOKEN_CALLS.length;

async function readCurvesAndMeta(
  records: LaunchRecord[],
): Promise<Map<string, { curve: CurveState | null; meta: TokenMeta | null; why: string | null }>> {
  const calls = records.flatMap((r) => [
    ...CURVE_CALLS.map((sig) => call(r.curve, encodeCall(sig))),
    ...TOKEN_CALLS.map((sig) => call(r.token, encodeCall(sig))),
  ]);
  const results = await rpcBatch(PONS.rpcUrls, calls, PONS.rpcTimeoutMs);

  const out = new Map<string, { curve: CurveState | null; meta: TokenMeta | null; why: string | null }>();
  records.forEach((record, index) => {
    const base = index * PER_TOKEN_CALLS;
    // The FIRST read of this token's nine that the node did NOT ANSWER — a
    // refusal, a dead socket, a timeout. ⚠️ Not the first that FAILED: a
    // `logo()` that reverts is the contract answering "no logo", an
    // `execution reverted` on a curve read is the curve answering, and
    // calling either "the node refused" would re-key a perfectly healthy
    // record under the short TTL for ever (readWhy → unpricedByUs) and send
    // the check to blame the node for a token's own answer. And it is read
    // whether or not curve/meta decoded: name, symbol and logo can be refused
    // while decimals and totalSupply answer, and that record is still one
    // OUR reason left incomplete.
    const own = results.slice(base, base + PER_TOKEN_CALLS);
    const refused = own.find((r) => unanswered(r)) as { ok: false; error: string } | undefined;
    const reserves = ok(results[base], (hex) => decodeReturn(["uint256", "uint256"], hex) as bigint[]);
    const realQuote = ok(results[base + 1], (hex) => one<bigint>(["uint256"], hex));
    const sellable = ok(results[base + 2], (hex) => one<bigint>(["uint256"], hex));
    const graduated = ok(results[base + 3], (hex) => one<boolean>(["bool"], hex));
    const decimals = ok(results[base + 4], (hex) => Number(one<bigint>(["uint8"], hex)));
    const totalSupply = ok(results[base + 5], (hex) => one<bigint>(["uint256"], hex));
    const symbol = ok(results[base + 6], (hex) => one<string>(["string"], hex));
    const name = ok(results[base + 7], (hex) => one<string>(["string"], hex));
    const logo = ok(results[base + 8], (hex) => one<string>(["string"], hex));

    const curve: CurveState | null =
      reserves && realQuote !== null && sellable !== null && graduated !== null
        ? {
            quoteReserve: reserves[0],
            tokenReserve: reserves[1],
            realQuoteReserve: realQuote,
            sellableTokens: sellable,
            graduated,
          }
        : null;

    const meta: TokenMeta | null =
      decimals !== null && totalSupply !== null
        ? {
            decimals,
            totalSupply,
            symbol: symbol ?? "",
            name: name ?? "",
            logo: tokenLogo(logo),
          }
        : null;

    const why = refused ? refused.error : null;
    out.set(record.token.toLowerCase(), { curve, meta, why });
  });
  return out;
}

// ── Graduated Uniswap V4 pool ─────────────────────────────────────────────
// PoolId = keccak256 of the five PoolKey words; the PoolManager exposes pool
// state through extsload at keccak256(poolId . POOLS_SLOT) (StateLibrary).
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;

const word = (value: bigint): string => {
  const masked = value < 0n ? (1n << 256n) + value : value; // two's complement for int24
  return masked.toString(16).padStart(64, "0");
};

const hexToBytes = (hex: string): Uint8Array => {
  const body = hex.replace(/^0x/, "");
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export function poolId(key: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}): string {
  const packed =
    word(BigInt(key.currency0)) +
    word(BigInt(key.currency1)) +
    word(BigInt(key.fee)) +
    word(BigInt(key.tickSpacing)) +
    word(BigInt(key.hooks));
  return bytesToHex(keccak256(hexToBytes(packed)));
}

const poolStateSlot = (id: string): bigint =>
  BigInt(bytesToHex(keccak256(hexToBytes(id.slice(2) + word(POOLS_SLOT)))));

/** Sorted (currency0, currency1) for a launch, matching Uniswap's ordering. */
export const sortCurrencies = (a: string, b: string): [string, string] =>
  BigInt(a) < BigInt(b) ? [a, b] : [b, a];

/** The node's own reason the last wiring read failed — a wiring we could not
 *  ASK for is not a chain with no pools. */
let lastWiringWhy: string | null = null;
let cachedFactoryWiring: Promise<{ poolManager: string; memeHook: string } | null> | null = null;

/** poolManager + memeHook, read from the factory rather than hardcoded. */
export function readFactoryWiring(): Promise<{ poolManager: string; memeHook: string } | null> {
  cachedFactoryWiring ??= (async () => {
    lastWiringWhy = null;
    const results = await rpcBatch(
      PONS.rpcUrls,
      [
        call(PONS.factoryV2, encodeCall("poolManager()")),
        call(PONS.factoryV2, encodeCall("memeHook()")),
      ],
      PONS.rpcTimeoutMs,
    );
    const poolManager = ok(results[0], (hex) => one<string>(["address"], hex));
    const memeHook = ok(results[1], (hex) => one<string>(["address"], hex));
    const refused = results.find((r) => unanswered(r)) as { ok: false; error: string } | undefined;
    if (refused) lastWiringWhy = refused.error;
    if (!poolManager || !memeHook || poolManager === ZERO_ADDRESS) return null;
    return { poolManager, memeHook };
  })().catch(() => null);
  // A failed lookup shouldn't be cached forever — retry on the next refresh.
  cachedFactoryWiring.then((value) => {
    if (!value) cachedFactoryWiring = null;
  });
  return cachedFactoryWiring;
}

/** Pool states, and per token the node's own reason when one could not be
 *  READ. ⚠️ A GRADUATED launch prices off its POOL, so a refused pool read is
 *  exactly the same fact as a refused curve read one function up — and it was
 *  the one path still rendering as "the curve and the pool answered no price",
 *  with `readWhy` null and the record cached for the full TTL. */
async function readPoolStates(
  records: LaunchRecord[],
): Promise<{ pools: Map<string, PoolState>; why: Map<string, string> }> {
  const out = new Map<string, PoolState>();
  const why = new Map<string, string>();
  if (records.length === 0) return { pools: out, why };
  const wiring = await readFactoryWiring();
  if (!wiring) {
    // No wiring, no slot to read: the pools are unknown for OUR reason, and a
    // silent empty map is what let that read as a token with no pool.
    const reason = lastWiringWhy ?? "the factory's poolManager/memeHook could not be read";
    for (const r of records) why.set(r.token.toLowerCase(), reason);
    return { pools: out, why };
  }

  const slots = records.map((record) => {
    const [currency0, currency1] = sortCurrencies(record.pairToken, record.token);
    const id = poolId({
      currency0,
      currency1,
      fee: record.poolFee,
      tickSpacing: record.tickSpacing,
      hooks: wiring.memeHook,
    });
    const base = poolStateSlot(id);
    return { slot0: `0x${word(base)}`, liquidity: `0x${word(base + LIQUIDITY_OFFSET)}` };
  });

  const results = await rpcBatch(
    PONS.rpcUrls,
    slots.flatMap((s) => [
      call(wiring.poolManager, encodeCall("extsload(bytes32)", [s.slot0])),
      call(wiring.poolManager, encodeCall("extsload(bytes32)", [s.liquidity])),
    ]),
    PONS.rpcTimeoutMs,
  );

  records.forEach((record, index) => {
    const refused = [results[index * 2], results[index * 2 + 1]].find((r) => unanswered(r)) as
      | { ok: false; error: string }
      | undefined;
    // EITHER read: a refused slot0 costs the price, and a refused liquidity
    // read renders as a depth of ZERO — a fabricated figure on a public card,
    // and the shape "0 reads as a rug" already names one field over. The price
    // still publishes (a real number beats none); the record carries the
    // reason, which is what stops it being served for the full TTL and what
    // lets `pons:check` name the node rather than the token.
    if (refused) why.set(record.token.toLowerCase(), refused.error);
    const packed = ok(results[index * 2], (hex) => BigInt(hex));
    const liquidity = ok(results[index * 2 + 1], (hex) => BigInt(hex));
    if (packed === null) return;
    const sqrtPriceX96 = packed & ((1n << 160n) - 1n);
    // A wrong or uninitialised slot reads back as zero — we drop the pool
    // rather than publish a price derived from an empty read.
    if (sqrtPriceX96 === 0n) return;
    out.set(record.token.toLowerCase(), { sqrtPriceX96, liquidity: liquidity ?? 0n });
  });
  return { pools: out, why };
}

/** One batched snapshot per address: launch record, curve state, metadata and
 *  — for graduated launches — the V4 pool. Unknown addresses are omitted. */
export async function readLaunchSnapshots(addresses: string[]): Promise<Map<string, LaunchSnapshot>> {
  return (await readLaunchSnapshotsX(addresses)).snapshots;
}

/** The snapshots AND the addresses whose launch RECORD could not be read —
 *  see `readLaunchRecordsX` for why an omitted address is not an answer. */
export async function readLaunchSnapshotsX(
  addresses: string[],
): Promise<{ snapshots: Map<string, LaunchSnapshot>; failed: Map<string, string> }> {
  const { records, failed } = await readLaunchRecordsX(addresses);
  const list = [...records.values()];
  if (list.length === 0) return { snapshots: new Map(), failed };

  const graduated = list.filter((r) => r.phase === "PoolCreated");
  const [details, poolRead] = await Promise.all([
    readCurvesAndMeta(list),
    // A throw out of the pool read is still OUR failure, not a chain with no
    // pools: the reason travels rather than the whole graduated set reading as
    // unpriced for a cause nobody recorded.
    readPoolStates(graduated).catch((err) => ({
      pools: new Map<string, PoolState>(),
      why: new Map<string, string>(graduated.map((r) => [r.token.toLowerCase(), errText(err)])),
    })),
  ]);

  const out = new Map<string, LaunchSnapshot>();
  for (const record of list) {
    const key = record.token.toLowerCase();
    const detail = details.get(key);
    out.set(key, {
      launch: record,
      curve: detail?.curve ?? null,
      meta: detail?.meta ?? null,
      pool: poolRead.pools.get(key) ?? null,
      // The curve/metadata batch's reason first — it is the one that empties a
      // record — then the POOL's, which is what a graduated launch prices off.
      readWhy: detail?.why ?? poolRead.why.get(key) ?? null,
    });
  }
  return { snapshots: out, failed };
}

export interface TokenSocials {
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  website: string | null;
  farcaster: string | null;
}

export interface TokenProfile {
  socials: TokenSocials;
  description: string | null;
}

/**
 * What the creator wrote at launch — the five socials and the description —
 * straight off the token, in one batch.
 *
 * ⚠️ Deliberately NOT part of the bulk snapshot. The launch feed reads up to 20
 * tokens at a time and would pay this on every one of them; the caller that
 * needs it is the listing form, which asks about ONE token.
 */
export async function readTokenProfile(token: string): Promise<TokenProfile | null> {
  const results = await rpcBatch(
    PONS.rpcUrls,
    [call(token, encodeCall("socials()")), call(token, encodeCall("description()"))],
    PONS.rpcTimeoutMs,
  );
  const decoded = ok(results[0], (hex) => decodeReturn(["string", "string", "string", "string", "string"], hex) as string[]);
  const about = ok(results[1], (hex) => one<string>(["string"], hex));
  if (!decoded) return null;
  // A creator who filled nothing in leaves empty strings; "" is not a link.
  const clean = (v: string): string | null => (v && v.trim() ? v.trim().slice(0, 200) : null);
  const [twitter, telegram, discord, website, farcaster] = decoded;
  return {
    socials: {
      twitter: clean(twitter),
      telegram: clean(telegram),
      discord: clean(discord),
      website: clean(website),
      farcaster: clean(farcaster),
    },
    description: about && about.trim() ? about.trim().slice(0, 1000) : null,
  };
}

const decimalsCache = new Map<string, number>();

/** Test seam: forget the decimals cache. It only CLEARS — the rule under test
 *  is what may be written into it. */
export const __resetDecimalsCache = (): void => {
  decimalsCache.clear();
};

/** Decimals of the token a curve dispenses. Cached — it never changes. */
export async function readCurveTokenDecimals(curve: string): Promise<number> {
  const key = curve.toLowerCase();
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;

  const [tokenResult] = await rpcBatch(PONS.rpcUrls, [call(curve, encodeCall("token()"))], PONS.rpcTimeoutMs);
  const token = ok(tokenResult, (hex) => one<string>(["address"], hex));
  if (!token || token === ZERO_ADDRESS) return 18;

  const [decimalsResult] = await rpcBatch(PONS.rpcUrls, [call(token, encodeCall("decimals()"))], PONS.rpcTimeoutMs);
  const decimals = ok(decimalsResult, (hex) => Number(one<bigint>(["uint8"], hex)));
  const value = decimals != null && decimals >= 0 && decimals <= 36 ? decimals : 18;
  // ⚠️ ONLY AN ANSWER IS REMEMBERED. This is cached "because it never
  // changes" — true of the token's decimals and false of a read the node
  // refused, and 18 stored for a 6-decimal token is every price off by a
  // million for the life of the process. A read that did not answer falls
  // back for THIS call and is asked again on the next one.
  if (!unanswered(decimalsResult)) decimalsCache.set(key, value);
  return value;
}
