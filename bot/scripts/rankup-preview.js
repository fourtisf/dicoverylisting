// Preview the trending-up (rank-up) banner with sample data → /tmp.
const fs = require("node:fs");
// .env before anything reaches code that reads it — `loadEnv()` is the one owner
// of that (repo root, bot/, cwd).
require("../src/config/loadEnv").loadEnv();

const bannerRender = require("../src/bannerRender");

(async () => {
  const coin = {
    symbol: "$CUBEMAN",
    name: "Cubeman",
    chain: "Solana",
    price: "$0.0056",
    mcap: "$5.6M",
    links: { website: "https://x", twitter: "https://x", telegram: "https://x" },
  };
  const cases = [
    { rank: 1, change: 120.4 },
    { rank: 2, change: 68.2 },
    { rank: 3, change: 42.8 },
  ];
  for (const c of cases) {
    const buf = await bannerRender.renderRankUpBanner(coin, null, c);
    if (!buf) return console.log("render returned null (canvas unavailable?)");
    const out = `/tmp/rankup-${c.rank}.png`;
    fs.writeFileSync(out, buf);
    console.log("rendered", out, buf.length, "bytes");
  }
})();
