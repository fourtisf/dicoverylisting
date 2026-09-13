// Remembers the listing/announcement channel message ids for each token so pump
// alerts can reply to the original listing post (like fourtis). Persisted map
// keyed by `${chain}:${address}` → { listingMsgId, annMsgId }.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "postids.json";
const map = loadJSONSync(FILE, {});
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

async function set(chain, address, ids) {
  const k = keyOf(chain, address);
  map[k] = { ...(map[k] || {}), ...ids };
  await saveJSON(FILE, map).catch(() => {});
}
function get(chain, address) {
  return map[keyOf(chain, address)] || {};
}

module.exports = { set, get };
