// Regenerate the committed static banner PNGs (assets/banner-*.png) from the
// canvas renderer — the /start welcome image + dynamic-render fallbacks. Run:
//   node scripts/gen-banners.js
// No Chromium/Playwright needed (uses @napi-rs/canvas, same as runtime).
const fss = require("node:fs");
const path = require("node:path");
// .env before anything reaches code that reads it — `loadEnv()` is the one owner
// of that (repo root, bot/, cwd).
require("../src/config/loadEnv").loadEnv();

const br = require("../src/bannerRender");

const OUT = path.join(__dirname, "..", "assets");
const jobs = [
  ["banner-main", br.renderMainBanner],
  ["banner-listing", br.renderStaticListing],
  ["banner-trending", br.renderStaticTrending],
];

(async () => {
  if (!br.available()) {
    console.error("@napi-rs/canvas unavailable — cannot generate banners");
    process.exit(1);
  }
  for (const [name, fn] of jobs) {
    const buf = await fn();
    if (!buf) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    fss.writeFileSync(path.join(OUT, `${name}.png`), buf);
    console.log(`wrote ${name}.png (${buf.length} bytes)`);
  }
  console.log("done");
})();
