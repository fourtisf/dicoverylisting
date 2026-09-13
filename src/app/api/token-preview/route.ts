import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import { gtGet } from "@/lib/providers/gt";

export const dynamic = "force-dynamic";

const TTL = 5 * 60_000;

/**
 * Live market data for ANY contract on a supported chain — listed or not.
 *
 * This exists for the token page's not-yet-listed state. Every other market
 * read in the app is keyed off the listings store, which by definition knows
 * nothing about a token nobody has paid to list; without this the page could
 * show a ticker and a dead end, which is what it used to do.
 *
 * Deliberately read-only and unauthenticated: it returns what GeckoTerminal
 * already publishes about a public contract, nothing about Dexvra.
 */
interface Preview {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  mcap: number | null;
  logoUrl: string | null;
  poolAddress: string | null;
  /** WHICH source found this. The chart embed has to come from the same one —
   *  a pool GeckoTerminal has never indexed renders an empty GT frame, which is
   *  the exact case DexScreener is here to cover. */
  source: "dexscreener" | "geckoterminal";
}

const num = (s: unknown): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function fetchPreview(network: string, address: string): Promise<Preview | null> {
  const res = await gtGet<{
    data?: { attributes?: Record<string, unknown>; relationships?: { top_pools?: { data?: { id?: string }[] } } };
    included?: { id?: string; attributes?: { address?: string } }[];
  }>(`/networks/${network}/tokens/${address}`, { include: "top_pools" });
  // 404 is a real answer — that contract is not indexed — and must not be
  // retried or cached as an error. The page copes with a null.
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(res.reason ?? "GeckoTerminal failed");
  }
  const json = res.body ?? {};
  const a = json.data?.attributes;
  if (!a) return null;
  const topId = json.data?.relationships?.top_pools?.data?.[0]?.id;
  const pool = (json.included ?? []).find((p) => p.id === topId);
  const img = typeof a.image_url === "string" ? a.image_url : null;
  return {
    name: typeof a.name === "string" ? a.name : null,
    symbol: typeof a.symbol === "string" ? a.symbol : null,
    priceUsd: num(a.price_usd),
    // fdv is what a not-yet-circulating memecoin actually reports; market_cap
    // is frequently null on GT for exactly the tokens that land on this page.
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    logoUrl: img && !img.endsWith("missing.png") ? img : null,
    poolAddress: pool?.attributes?.address ?? topId?.split("_").slice(1).join("_") ?? null,
    source: "geckoterminal",
  };
}

/** DexScreener chain id → ours. */
const CHAIN_OF_DS = new Map(
  Object.values(CHAINS)
    .filter((c) => c.dexscreener)
    .map((c) => [c.dexscreener as string, c.id]),
);

interface DsPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  info?: { imageUrl?: string };
}

/**
 * DexScreener — ONE request, every chain, no key, and it carries the launches
 * GeckoTerminal has not indexed yet.
 *
 * This is the primary lookup, and the reason is a pump.fun mint that GT simply
 * does not have: GT indexes DEX pools, so a token that has not graduated to one
 * is invisible to it, and "not on any network we index" was the answer for a
 * token trading at a $250K cap. Tuning the GT probe further could never have
 * fixed that — it needed a second source.
 *
 * The DEEPEST pair wins. A token has pairs on several DEXes and sometimes
 * several chains (bridged, or a copycat at the same address); liquidity is the
 * honest tie-break, where "first in the array" is whatever order the upstream
 * happened to return.
 */
async function fromDexScreener(address: string, wantChain?: string): Promise<{ chain: string; token: Preview } | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`, {
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { pairs?: DsPair[] | null };
  const want = address.toLowerCase();
  const usable = (json.pairs ?? [])
    .filter((p) => (p.baseToken?.address ?? "").toLowerCase() === want)
    .filter((p) => {
      const chain = CHAIN_OF_DS.get(p.chainId ?? "");
      return chain && (!wantChain || chain === wantChain);
    })
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = usable[0];
  if (!top) return null;
  const price = Number(top.priceUsd);
  return {
    chain: CHAIN_OF_DS.get(top.chainId ?? "") as string,
    token: {
      name: top.baseToken?.name ?? null,
      symbol: top.baseToken?.symbol ?? null,
      priceUsd: Number.isFinite(price) ? price : null,
      // marketCap when the supply is known, fdv otherwise — for a fresh launch
      // fdv is the only one either source reports.
      mcap: top.marketCap ?? top.fdv ?? null,
      logoUrl: top.info?.imageUrl ?? null,
      poolAddress: top.pairAddress ?? null,
      source: "dexscreener",
    },
  };
}

/**
 * Which chains a raw address could possibly be on.
 *
 * Every chain already declares its own `addressPattern`, so that is what
 * decides — nothing here lists chains by hand. The first cut did, naming eight
 * EVM chains out of fifteen, so a token on Berachain, Sonic, HyperEVM,
 * Abstract, ApeChain, Blast, Sei, Unichain or Robinhood came back as "not on
 * any network we index" — about a network we index. A hand-kept subset is a
 * silent wrong answer that nobody notices until a customer pastes the address.
 *
 * Sui and Aptos share the 0x prefix with EVM but their patterns allow the
 * ::module suffix and a shorter body, so a 40-hex address correctly matches
 * both families and both get probed. That is the safe direction to be wrong in.
 */
const candidateChains = (address: string): string[] =>
  Object.values(CHAINS)
    .filter((c) => c.geckoNetwork && c.addressPattern.test(address))
    .map((c) => c.id);

/** geckoNetwork → our chain id. */
const CHAIN_OF_NETWORK = new Map(
  Object.values(CHAINS)
    .filter((c) => c.geckoNetwork)
    .map((c) => [c.geckoNetwork as string, c.id]),
);

/**
 * GeckoTerminal stores EVM addresses lowercased, and a pasted address is
 * usually EIP-55 checksummed — mixed case. Only the hex families are folded:
 * a Solana mint, a Tron address and a TON address are base58/base64 and case
 * is MEANINGFUL there, so lowercasing one turns a valid address into a 404.
 */
const forQuery = (address: string): string =>
  /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : address;

/**
 * Ask GeckoTerminal which network a contract is on — ONE request, every network
 * it indexes, including the ones we would not have thought to probe.
 *
 * Fanning out per chain instead means fifteen requests per search against a
 * 30-a-minute budget shared with the listing and trending pipelines: one person
 * typing would starve the rest of the site. Returns null on anything unexpected
 * so the caller falls back to the per-chain probe.
 */
async function searchNetwork(address: string): Promise<{ chain: string; token: string } | null> {
  const res = await gtGet<{
    data?: { relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }[];
  }>(`/search/pools`, { query: forQuery(address), page: 1 });
  // ⚠️ A 404 IS "no pool matches"; A COOLDOWN IS "we never asked". Both used to
  // return null here, and null means "not on any network we index" to the
  // caller — a statement about somebody's token, made on the strength of our
  // own rate limit. fetchPreview above draws this line correctly; this call
  // site did not.
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(res.reason ?? "GeckoTerminal failed");
  }
  const json = res.body ?? {};
  const want = forQuery(address).toLowerCase();
  for (const pool of json.data ?? []) {
    // Token ids are "<network>_<address>". The BASE token is checked first: a
    // search for a token also returns pools where it is the QUOTE side, and
    // naming those after the other token would show the wrong coin entirely.
    for (const side of [pool.relationships?.base_token, pool.relationships?.quote_token]) {
      const id = side?.data?.id;
      if (!id) continue;
      const cut = id.indexOf("_");
      if (cut < 0) continue;
      const network = id.slice(0, cut);
      const token = id.slice(cut + 1);
      if (token.toLowerCase() !== want) continue;
      const chain = CHAIN_OF_NETWORK.get(network);
      if (chain) return { chain, token };
    }
  }
  return null;
}

/**
 * Find a contract on whichever chain actually has it.
 *
 * Search first, because it is one request and covers every network. The
 * per-chain probe is the fallback for the case search misses — a token so new
 * it is not in the search index yet, which is exactly the kind of token that
 * lands here. Ties there break on market cap: the same address is deployed on
 * several chains often enough (a bridged token, a copycat) that "first to
 * answer" would be a race deciding which one a user sees.
 */
async function findAnyChain(address: string): Promise<{ chain: string; token: Preview } | null> {
  try {
    const ds = await fromDexScreener(address);
    if (ds) return ds;
  } catch {
    /* fall through to GeckoTerminal */
  }
  try {
    const hit = await searchNetwork(address);
    if (hit) {
      const network = CHAINS[hit.chain].geckoNetwork as string;
      const token = await cached(`preview:${network}:${hit.token}`, TTL, () => fetchPreview(network, hit.token));
      if (token) return { chain: hit.chain, token };
    }
  } catch {
    /* fall through to the probe */
  }
  const found = await Promise.all(
    candidateChains(address).map(async (chain) => {
      try {
        const network = CHAINS[chain].geckoNetwork as string;
        const token = await cached(`preview:${network}:${address}`, TTL, () => fetchPreview(network, forQuery(address)));
        return token ? { chain, token } : null;
      } catch {
        return null;
      }
    }),
  );
  const hits = found.filter((x): x is { chain: string; token: Preview } => !!x);
  hits.sort((a, b) => (b.token.mcap ?? 0) - (a.token.mcap ?? 0));
  return hits[0] ?? null;
}

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  // The address goes into an upstream URL path, so it is bounded and character
  // -restricted here rather than trusted — the same guard /api/pool uses.
  if (!address || address.length > 90 || /[^A-Za-z0-9:_-]/.test(address)) {
    return NextResponse.json({ token: null, chain: null }, { status: 200 });
  }
  // ?debug=1 reports which sources were asked and what each said. Read-only and
  // returns nothing private — it exists because "no token matches" is
  // indistinguishable from "the upstream 404'd" from the outside, and guessing
  // between those cost two deploys.
  if (req.nextUrl.searchParams.get("debug") === "1") {
    const tried: Record<string, unknown> = {};
    // Which BUILD answered. The absence of this field is itself the answer:
    // an older bundle has no debug branch at all and replies { token, chain }.
    tried.build = process.env.NEXT_PUBLIC_BUILD ?? "unknown";
    tried.candidates = candidateChains(address);
    tried.dexscreener = await fromDexScreener(address, chain || undefined).catch((e) => `error: ${String(e)}`);
    tried.gtSearch = await searchNetwork(address).catch((e) => `error: ${String(e)}`);
    return NextResponse.json({ address, chain: chain || null, tried });
  }
  try {
    // No chain given — the search box has a pasted CA and nothing else. Work
    // out which chain it is on rather than making the person pick.
    if (!chain) {
      const hit = await findAnyChain(address);
      return NextResponse.json({ token: hit?.token ?? null, chain: hit?.chain ?? null });
    }
    if (!CHAINS[chain]) return NextResponse.json({ token: null, chain: null }, { status: 200 });
    // Same order as the no-chain path, for the same reason: the token page is
    // reached from a buy alert, and a buy alert fires on tokens far too new for
    // GeckoTerminal. Scoped to the chain the URL names so a copycat at the same
    // address on another chain cannot answer for it.
    // ⚠️ THE CATCH IS OUTSIDE THE CACHE, and the difference is five minutes of
    // being wrong. Inside the loader it RESOLVED to null, so `cached()` stored
    // "DexScreener has no pair for this token" — a claim about the token — for
    // every transport failure. That matters more now than it did: DexScreener
    // is the source that carries this whole site while GeckoTerminal's per-IP
    // cooldown holds, so its bad minute must not become the app's bad five.
    const ds = await cached(`ds:${chain}:${address}`, TTL, () => fromDexScreener(address, chain)).catch(() => null);
    if (ds) return NextResponse.json({ token: ds.token, chain });
    const network = CHAINS[chain].geckoNetwork;
    if (!network) return NextResponse.json({ token: null, chain: null }, { status: 200 });
    const token = await cached(`preview:${network}:${address}`, TTL, () => fetchPreview(network, forQuery(address)));
    return NextResponse.json({ token, chain: token ? chain : null });
  } catch {
    // A feed outage must not turn the page into an error screen — it still has
    // the network, the contract and the way to list it.
    return NextResponse.json({ token: null, chain: null });
  }
}
