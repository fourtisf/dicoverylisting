// USD → native-coin conversion for USD-priced Banner Ads. Native coin USD prices
// from CoinGecko's free simple-price endpoint, cached 60s.
const { nativeOf } = require("./config/chains");
const log = require("./helpers/logger");

const IDS = { SOL: "solana", ETH: "ethereum", BNB: "binancecoin", TRX: "tron", TON: "the-open-network" };

let cache = { at: 0, data: null };

async function usdPrices() {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  try {
    const ids = Object.values(IDS).join(",");
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = await res.json();
    const out = {};
    for (const [sym, id] of Object.entries(IDS)) out[sym] = j[id] && j[id].usd;
    cache = { at: Date.now(), data: out };
    return out;
  } catch (e) {
    log.warn(`[price] native USD prices: ${e.message}`);
    return cache.data || {};
  }
}

/** USD amount → { amount:number, human:string } in the chain's native coin, or null. */
async function usdToNative(chain, usd) {
  const sym = nativeOf(chain);
  const prices = await usdPrices();
  const px = prices[sym];
  if (!px || !(px > 0)) return null;
  const amount = usd / px;
  const human = amount >= 100 ? String(Math.ceil(amount)) : amount.toFixed(4);
  return { amount, human, native: sym };
}

module.exports = { usdPrices, usdToNative };
