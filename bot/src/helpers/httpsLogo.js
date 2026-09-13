"use strict";
/**
 * `ipfs://<cid>` → a gateway url the two consumers can actually draw.
 *
 * THE ONE OWNER, and it is in its own module because it now has two producers.
 * An `ipfs://` logo is REAL ARTWORK AND AN UNUSABLE URL: `adminValidate`'s
 * LOGO_RE takes https or an upload and nothing else, so passing the URI through
 * verbatim would fail the WHOLE listing over its picture — the rule the
 * launchpad socials already carry ("losing a link beats losing the listing and
 * the link with it") — and no `<img>` anywhere loads that scheme.
 *
 * It lived inside `ponsChain` while the chain was the only source that could
 * publish one. The launchpad registry publishes them too now (`normalize
 * .logoUri`), and a second copy of a rewrite is how two callers end up on two
 * gateways — the shape this repo has already paid for with two pump.fun hosts
 * in two processes. `ponsChain.httpsLogo` re-exports this rather than keeping
 * its own.
 *
 * ⚠️ ONE GATEWAY HERE IS NOT "one hardcoded host". What this produces is handed
 * to `/api/logo`, which extracts the CID and fails over across IPFS_GATEWAYS —
 * a CID is the hash of the bytes, so another gateway serving it serves
 * byte-identical content. `PONS_IPFS_GATEWAY` moves the one named here.
 */
const { safeUrl } = require("../../../shared/launchpads/normalize");

const GATEWAY = (process.env.PONS_IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/*$/, "/");

function httpsLogo(v) {
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;
  const m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(s);
  return m ? safeUrl(GATEWAY + m[1]) : safeUrl(s);
}

module.exports = { httpsLogo, GATEWAY };
