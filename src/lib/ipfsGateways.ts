// The IPFS gateway ladder — ONE owner.
//
// It lived inline in /api/logo/route.ts until the site's logo RESOLVER
// (providers/tokenLogo.ts) needed the same list: a Pons token's artwork is the
// `ipfs://<cid>` its contract publishes, and verifying that against ONE gateway
// would write a twelve-hour "no artwork" miss over a picture every other
// gateway serves. A CID is the hash of the bytes, so a gateway 404 is a fact
// about the GATEWAY and never about the artwork — which is the whole reason a
// ladder exists, and why two copies of it would eventually disagree about
// which gateway is asked first (the $GG round: pump.fun's own pin was
// allowlisted in one place and missing from the other).
//
// Alias-free on purpose (relative imports only), so `npm test` can load it and
// the resolver that imports it.

export const IPFS_GATEWAYS: string[] = (process.env.IPFS_GATEWAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(
    process.env.IPFS_GATEWAYS
      ? []
      : [
          "https://ipfs.io/ipfs/",
          // ⚠️ PUMP.FUN'S OWN PIN, and it was allowlisted (mypinata.cloud) but
          // never LISTED here — so for a pump.fun CID the one gateway that is
          // guaranteed to hold it was never asked, and a paid post's artwork
          // depended on whether ipfs.io or dweb.link happened to have it cached
          // that minute. $GG loaded on two deploys and failed on two with zero
          // lines changed on this path; that flip is this omission.
          "https://pump.mypinata.cloud/ipfs/",
          // dweb.link is ipfs.io's SIBLING (the same backend), so with the
          // caller's ipfs.io url in slot one it was spending a 5s slot re-asking
          // what had just failed. Ordered so four serial tries are three
          // distinct operators. A judgement the box has to measure — which is
          // why IPFS_GATEWAYS stays env-overridable.
          "https://gateway.pinata.cloud/ipfs/",
          "https://w3s.link/ipfs/",
          "https://dweb.link/ipfs/",
          "https://nftstorage.link/ipfs/",
        ],
  );

/** The `<cid>/<path…>` of an IPFS url, or null when this is not one.
 *
 *  Recognised in BOTH spellings, because a stored logo is usually already an
 *  https gateway url (`https://ipfs.io/ipfs/<cid>`) rather than the `ipfs://`
 *  URI a launchpad's metadata carries — and it is the https one that had no
 *  second chance. */
export function ipfsPath(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (/^ipfs:\/\//i.test(s)) {
    const p = s.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    return p || null;
  }
  const m = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(s);
  return m ? m[1] : null;
}

/**
 * Every https url worth trying for one IPFS artwork, ladder order — the
 * gateway the CALLER named first (a working one must not be demoted), then the
 * others with the same CID. `[]` for anything that is not an IPFS url: a 404
 * from a CDN IS an answer about the token, and has no ladder.
 *
 * No allowlist here: `/api/logo` re-checks every candidate against its own
 * host allowlist, and the resolver verifies each by fetching it.
 */
export function ipfsCandidates(raw: string, max = Infinity): string[] {
  const cid = ipfsPath(raw);
  if (!cid) return [];
  const s = String(raw).trim();
  const out: string[] = [];
  if (/^https?:\/\//i.test(s)) out.push(s);
  for (const gw of IPFS_GATEWAYS) {
    if (out.length >= max) break;
    const u = gw + cid;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, max);
}
