// Pons launchpad (ponsfamily.com) on Robinhood Chain — deployment constants.
//
// Pons has no HTTP API: the factory and the per-launch bonding curves are the
// source of truth, so this integration reads them over JSON-RPC. Every value
// here is env-overridable so ops can point at a paid RPC or a redeployment
// without a code change.
//
// Addresses are the ones published in the official contracts repository
// (github.com/ponsdotdev/ponsfamily). V1 is listed for completeness; only the
// V2 factory is read.

const env = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : fallback;
};

const envNumber = (key: string, fallback: number): number => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const PONS = {
  /** Dexvra chain id this launchpad backs (see config/chains.ts). */
  chain: "robinhood",
  /** Robinhood Chain — EVM L2 on the Arbitrum Orbit stack, ETH gas token. */
  chainId: 4663,
  rpcUrl: env("PONS_RPC_URL", "https://rpc.mainnet.chain.robinhood.com").split(",")[0].trim(),
  /** The same variable as a LIST — comma-separated, first host asked first.
   *  A node that refuses this box (HTTP 429 from the public Robinhood RPC, on
   *  a box where the site, the bot, the trade bot and every check share one
   *  IP) is parked and the next host takes the same calls, so a second node
   *  is a line in `.env`, not a deploy. `rpcUrl` stays the first entry for
   *  the callers that need one. */
  rpcUrls: env("PONS_RPC_URL", "https://rpc.mainnet.chain.robinhood.com")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
  explorer: env("PONS_EXPLORER", "https://robinhoodchain.blockscout.com"),
  app: env("PONS_APP", "https://ponsfamily.com"),
  /** Path segment of a token's page on that app — see `ponsTokenUrl`. */
  tokenPath: env("PONS_TOKEN_PATH", "launchpad").replace(/^\/+|\/+$/g, ""),

  /** PonsV2LaunchFactory — emits TokenLaunched / LaunchSwept / PoolGraduated. */
  factoryV2: env("PONS_FACTORY", "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e").toLowerCase(),
  /** PonsLaunchFactory (V1, Uniswap V3). Not read — kept for reference. */
  factoryV1: "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb",

  /** Native quote asset of a `pairToken == address(0)` launch. */
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  /** WETH on Ethereum mainnet — how the native quote gets a USD price. */
  nativeUsdRef: { network: "eth", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },

  rpcTimeoutMs: envNumber("PONS_RPC_TIMEOUT_MS", 9000),
  /** Max block span per eth_getLogs call — public gateways cap this. */
  logChunkBlocks: Math.floor(envNumber("PONS_LOG_CHUNK_BLOCKS", 10_000)),
  /** Log requests per curve per refresh, so a cold start can't stall a page. */
  logChunksPerRefresh: Math.floor(envNumber("PONS_LOG_CHUNKS_PER_REFRESH", 6)),
  /** How much trade history to keep, and to backfill towards. */
  historyMinutes: Math.floor(envNumber("PONS_HISTORY_MINUTES", 1440)),
  /** Fallback block time; refined once per process from two real blocks. */
  blockSeconds: envNumber("PONS_BLOCK_SECONDS", 0.25),

  // ── Launch discovery (the TokenLaunched feed and the listing bot) ──────
  /** How far back the launch feed reaches, and backfills towards. */
  launchWindowMinutes: Math.floor(envNumber("PONS_LAUNCH_WINDOW_MINUTES", 4320)),
  /** Log requests spent on the factory per refresh. */
  launchChunksPerRefresh: Math.floor(envNumber("PONS_LAUNCH_CHUNKS_PER_REFRESH", 8)),
  /** Newest launches enriched with price and curve state per refresh. */
  launchEnrichLimit: Math.floor(envNumber("PONS_LAUNCH_ENRICH_LIMIT", 20)),
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Graduation phases, in the order declared by ILaunchpadV2.GraduationPhase. */
export const GRADUATION_PHASES = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;
export type GraduationPhase = (typeof GRADUATION_PHASES)[number];

/**
 * The token's page on Pons — `/launchpad/<address>`, NOT `/token/<address>`.
 *
 * ⚠️ THIS WAS `/token/`, AND EVERY LINK THIS REPO GENERATED 404'd. The path was
 * never measured; it was assumed from the shape of every other explorer here
 * (`ponsExplorerUrl` beside it really is `/token/`, which is what made the
 * guess look right). The operator settled it by sending a screenshot with their
 * own address bar in it:
 *
 *     https://www.ponsfamily.com/launchpad/0xfCd4CdEabe055315b1036A189eA54ca627Df390a
 *
 * A dead link is the quiet kind of wrong: it reaches the listing review card
 * and the "🚀 Still bonding" line as ordinary blue text, and nothing anywhere
 * says the destination does not exist — the reader simply concludes the pad is
 * broken. `PONS_TOKEN_PATH` makes a future move a line in `.env` rather than a
 * deploy, the contract every guessed launchpad path in this repo carries.
 */
export const ponsTokenUrl = (address: string): string =>
  `${PONS.app}/${PONS.tokenPath}/${address}`;
export const ponsExplorerUrl = (address: string): string => `${PONS.explorer}/token/${address}`;
