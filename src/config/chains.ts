// Adding a chain = adding one entry here. Nothing else in the app may
// hardcode a chain id.
export interface ChainConfig {
  id: string;
  label: string;
  color: string;
  /** GeckoTerminal network id; null = no market-data provider coverage yet */
  geckoNetwork: string | null;
  /**
   * DexScreener's chain id — a SECOND, independent market source.
   *
   * Not redundancy for its own sake: GeckoTerminal indexes DEX pools and misses
   * brand-new launches, which is exactly what someone pastes into the search
   * box. DexScreener carries pump.fun and day-one pairs that GT has never seen.
   * null = DexScreener does not carry that chain (Robinhood).
   */
  dexscreener: string | null;
  /**
   * CoinGecko's asset-platform id — a THIRD spelling of the same set, used by
   * the token-logo resolver (CoinGecko is curated, so it is the one source
   * where a human has actually looked at the artwork).
   *
   * null = CoinGecko has no platform for that chain, which costs one logo
   * source and never a failure. A WRONG id costs the same: the lookup 404s.
   * The values here are the ones the bot's own resolver already runs on
   * (bot/src/services/tokenLogo.js) — deliberately not a second guess at them.
   */
  coingecko: string | null;
  /** GoPlus numeric chain id for EVM security scans; null = non-EVM */
  goPlusChainId: string | null;
  /**
   * Launchpad whose CONTRACTS this chain's tokens launch from, when there is
   * one worth reading directly. Distinct from the HTTP launchpad registry in
   * shared/launchpads: this is an on-chain read, so it still answers when a
   * third-party API moves or goes down. Used as the last-resort market source
   * and by the scanner — never as a priority over an indexed pool.
   */
  launchpad?: "pons-v2";
  /** Address explorer URL for a token address */
  explorer: (address: string) => string;
  /** Buy deeplink — we never swap on-site, only deep-link out */
  buyUrl: (address: string) => string;
  /** Loose per-chain contract-address shape used for input validation */
  addressPattern: RegExp;
}

// Order here drives the chain-filter / selector order across the app:
// Solana → BSC → Ethereum → Base → Robinhood → Tron → TON.
export const CHAINS: Record<string, ChainConfig> = {
  solana: {
    id: "solana",
    label: "Solana",
    color: "#14F195",
    geckoNetwork: "solana",
    dexscreener: "solana",
    coingecko: "solana",
    goPlusChainId: null,
    explorer: (a) => `https://solscan.io/token/${a}`,
    buyUrl: (a) => `https://jup.ag/swap/SOL-${a}`,
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  },
  bsc: {
    id: "bsc",
    label: "BSC",
    color: "#F0B90B",
    geckoNetwork: "bsc",
    dexscreener: "bsc",
    coingecko: "binance-smart-chain",
    goPlusChainId: "56",
    explorer: (a) => `https://bscscan.com/token/${a}`,
    buyUrl: (a) => `https://pancakeswap.finance/swap?outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  ethereum: {
    id: "ethereum",
    label: "Ethereum",
    color: "#9AA5FF",
    geckoNetwork: "eth",
    dexscreener: "ethereum",
    coingecko: "ethereum",
    goPlusChainId: "1",
    explorer: (a) => `https://etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  base: {
    id: "base",
    label: "Base",
    color: "#3B82F6",
    geckoNetwork: "base",
    dexscreener: "base",
    coingecko: "base",
    goPlusChainId: "8453",
    explorer: (a) => `https://basescan.org/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  robinhood: {
    id: "robinhood",
    label: "Robinhood",
    color: "#CCFF00",
    geckoNetwork: "robinhood", // GT indexes Robinhood Chain → live price/mcap/liq + chart embed
    // DexScreener added Robinhood Chain (~July 2026, dexscreener.com/new-pairs/robinhood).
    // This was null from the chain's launch — and null made Robinhood the ONE
    // chain with no second source, which is why it lost the shared GT budget
    // race every cycle and rendered 0/66 priced. Whether DS actually answers
    // for a given token is measured on the box: npm run market:check -- robinhood.
    dexscreener: "robinhood",
    coingecko: null,
    goPlusChainId: null, // GoPlus doesn't cover chain 4663
    // Pons is where essentially every Robinhood token launches; its factory and
    // bonding curves are readable on chain, which is the one source that cannot
    // go stale or move. Bottom of the priority list — see fetchChainMarket.
    launchpad: "pons-v2",
    explorer: (a) => `https://robinhoodchain.blockscout.com/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/robinhood/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  tron: {
    id: "tron",
    label: "Tron",
    color: "#FF060A",
    geckoNetwork: "tron",
    dexscreener: "tron",
    coingecko: "tron",
    goPlusChainId: null, // GoPlus token_security doesn't cover Tron; scanner falls back to basic info
    explorer: (a) => `https://tronscan.org/#/token20/${a}`,
    buyUrl: (a) => `https://sunswap.com/#/home?tokenAddress=${a}`,
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  },
  ton: {
    id: "ton",
    label: "TON",
    color: "#0098EA",
    geckoNetwork: "ton",
    dexscreener: "ton",
    coingecko: "the-open-network",
    goPlusChainId: null,
    explorer: (a) => `https://tonviewer.com/${a}`,
    buyUrl: (a) => `https://app.ston.fi/swap?ft=TON&tt=${a}`,
    addressPattern: /^(EQ|UQ|0:)[A-Za-z0-9_-]{40,66}$/,
  },
  sui: {
    id: "sui",
    label: "Sui",
    color: "#4DA2FF",
    geckoNetwork: "sui-network",
    dexscreener: "sui",
    coingecko: "sui",
    goPlusChainId: null,
    explorer: (a) => `https://suivision.xyz/coin/${encodeURIComponent(a)}`,
    buyUrl: (a) => `https://app.cetus.zone/swap/?to=${encodeURIComponent(a)}`,
    // Sui coin type: 0x<hex>::module::SYMBOL (bare object addresses accepted)
    addressPattern: /^0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){0,2}$/,
  },
  plasma: {
    id: "plasma",
    label: "Plasma",
    color: "#00FF9C",
    geckoNetwork: "plasma",
    dexscreener: "plasma",
    coingecko: null,
    goPlusChainId: null,
    explorer: (a) => `https://plasmascan.to/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/plasma/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  // ── More EVM chains (billed in BNB by the bot via BSC). Registered here so
  //    listings validate + render + get live market data; settlement currency
  //    for the web price display lives in src/lib/packages.ts (NATIVE map). ──
  polygon: {
    id: "polygon",
    label: "Polygon",
    color: "#8247E5",
    geckoNetwork: "polygon_pos",
    dexscreener: "polygon",
    coingecko: "polygon-pos",
    goPlusChainId: "137",
    explorer: (a) => `https://polygonscan.com/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=polygon&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  arbitrum: {
    id: "arbitrum",
    label: "Arbitrum",
    color: "#28A0F0",
    geckoNetwork: "arbitrum",
    dexscreener: "arbitrum",
    coingecko: "arbitrum-one",
    goPlusChainId: "42161",
    explorer: (a) => `https://arbiscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=arbitrum&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  optimism: {
    id: "optimism",
    label: "Optimism",
    color: "#FF0420",
    geckoNetwork: "optimism",
    dexscreener: "optimism",
    coingecko: "optimistic-ethereum",
    goPlusChainId: "10",
    explorer: (a) => `https://optimistic.etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=optimism&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  avalanche: {
    id: "avalanche",
    label: "Avalanche",
    color: "#E84142",
    geckoNetwork: "avax",
    dexscreener: "avalanche",
    coingecko: "avalanche",
    goPlusChainId: "43114",
    explorer: (a) => `https://snowtrace.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=avalanche&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  berachain: {
    id: "berachain",
    label: "Berachain",
    color: "#B8651B",
    geckoNetwork: "berachain",
    dexscreener: "berachain",
    coingecko: "berachain",
    goPlusChainId: null,
    explorer: (a) => `https://berascan.com/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/berachain/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  sonic: {
    id: "sonic",
    label: "Sonic",
    color: "#5AB8F0",
    geckoNetwork: "sonic",
    dexscreener: "sonic",
    coingecko: "sonic",
    goPlusChainId: null,
    explorer: (a) => `https://sonicscan.org/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/sonic/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  hyperevm: {
    id: "hyperevm",
    label: "HyperEVM",
    color: "#4FD1C5",
    geckoNetwork: "hyperevm",
    dexscreener: "hyperevm",
    coingecko: null,
    goPlusChainId: null,
    explorer: (a) => `https://www.geckoterminal.com/hyperevm/tokens/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/hyperevm/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  abstract: {
    id: "abstract",
    label: "Abstract",
    color: "#3CE68B",
    geckoNetwork: "abstract",
    dexscreener: "abstract",
    coingecko: null,
    goPlusChainId: null,
    explorer: (a) => `https://abscan.org/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/abstract/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  apechain: {
    id: "apechain",
    label: "ApeChain",
    color: "#0054FA",
    geckoNetwork: "apechain",
    dexscreener: "apechain",
    coingecko: null,
    goPlusChainId: null,
    explorer: (a) => `https://apescan.io/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/apechain/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  blast: {
    id: "blast",
    label: "Blast",
    color: "#FCFC03",
    geckoNetwork: "blast",
    dexscreener: "blast",
    coingecko: "blast",
    goPlusChainId: "81457",
    explorer: (a) => `https://blastscan.io/token/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/blast/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  sei: {
    id: "sei",
    label: "Sei",
    color: "#9E1C1C",
    geckoNetwork: "sei-evm",
    dexscreener: "seiv2",
    coingecko: "sei-v2",
    goPlusChainId: null,
    explorer: (a) => `https://seitrace.com/token/${a}?chain=pacific-1`,
    buyUrl: (a) => `https://www.geckoterminal.com/sei-evm/tokens/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  aptos: {
    id: "aptos",
    label: "Aptos",
    color: "#8CA0B8",
    geckoNetwork: "aptos",
    dexscreener: "aptos",
    coingecko: "aptos",
    goPlusChainId: null, // non-EVM → GoPlus token_security doesn't cover it
    explorer: (a) => `https://www.geckoterminal.com/aptos/tokens/${a}`,
    buyUrl: (a) => `https://www.geckoterminal.com/aptos/tokens/${a}`,
    // Aptos coin type (0x…::module::SYMBOL) or a bare object / FA address.
    addressPattern: /^0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){0,2}$/,
  },
  unichain: {
    id: "unichain",
    label: "Unichain",
    color: "#F50DB4",
    geckoNetwork: "unichain",
    dexscreener: "unichain",
    coingecko: "unichain",
    goPlusChainId: null,
    explorer: (a) => `https://uniscan.xyz/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=unichain&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);
export const chainOf = (id: string): ChainConfig | undefined => CHAINS[id];
