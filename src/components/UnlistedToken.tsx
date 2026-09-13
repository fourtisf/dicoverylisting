"use client";

/**
 * What a token page shows for a contract nobody has listed yet.
 *
 * It used to be "This token isn't a Dexvra listing (yet). Only paid listings
 * appear here." plus a Back button — a dead end, and the wrong one to build:
 * every buy-bot alert links here, the buy bot is free and runs on ANY contract,
 * so the majority of visitors arriving on this page are looking at a token that
 * is not listed. They were told nothing about the token they came to see and
 * given no way to change that.
 *
 * So: the contract, the network, the live price and market cap that
 * GeckoTerminal already publishes about it, and the two things a visitor can
 * actually do — list it, or go look at what is listed.
 *
 * A CANDLESTICK CHART IS NOT ON THAT LIST, and the note further down says why:
 * the price/cap come free with a request this page already makes, a chart is a
 * per-visit poll against a shared GeckoTerminal ceiling, and this page is
 * reachable by pasting any contract at all.
 */

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useApp } from "@/components/AppState";
import { ChainLogo } from "@/components/ChainLogo";
import { CHAINS } from "@/config/chains";
import { BOT_URL } from "@/config/socials";
import { BRAND_NAME } from "@/config/brand";
import { fmtCap, fmtPrice } from "@/lib/format";
import { logoSrc } from "@/lib/logo";

interface Preview {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  mcap: number | null;
  logoUrl: string | null;
}

export function UnlistedToken({ chain, address }: { chain: string; address: string }) {
  const { toast } = useApp();
  const [tok, setTok] = useState<Preview | null>(null);
  const [done, setDone] = useState(false);
  const c = CHAINS[chain];

  useEffect(() => {
    let live = true;
    if (!c || !address) {
      setDone(true);
      return;
    }
    fetch(`/api/token-preview?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((j) => {
        if (live) setTok(j?.token ?? null);
      })
      .catch(() => {})
      // `done` and not `!tok`: a contract GeckoTerminal has never seen answers
      // null, and that is an ANSWER. Keying the skeleton off the data would
      // spin forever on exactly the tokens this page exists for.
      .finally(() => live && setDone(true));
    return () => {
      live = false;
    };
  }, [chain, address, c]);

  const copyCa = () => {
    navigator.clipboard?.writeText(address).catch(() => {});
    toast("Contract address copied 📋");
  };

  const ticker = tok?.symbol ? `$${tok.symbol.replace(/^\$/, "")}` : null;

  return (
    <section className="view">
      <div className="panel unlisted">
        {logoSrc(tok?.logoUrl) ? (
          // Unoptimized: the source is a third-party CDN we do not control and
          // cannot add to next.config's remote allow-list one memecoin at a time
          // — and it goes through /api/logo for the same reason every other logo
          // on the site does (hotlink blocks, CORS, ipfs:// URIs).
          <Image className="unlisted-logo" src={logoSrc(tok?.logoUrl) as string} alt="" width={72} height={72} unoptimized />
        ) : (
          // An amber mark, not a "?" tile. A question mark reads as "we could
          // not load this", which is the wrong story: the token is fine, the
          // listing is what is missing — and amber says missing, not broken.
          <div className="unlisted-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
        )}

        <h1 className="unlisted-h">Token Not Yet Listed</h1>
        <p className="unlisted-p">
          {tok?.name ? <strong>{tok.name}</strong> : "This token"} hasn&apos;t been listed on{" "}
          <strong>{BRAND_NAME}</strong> yet. List it in under 2 minutes through our Telegram bot.
        </p>

        {done && (tok?.priceUsd != null || tok?.mcap != null) && (
          <div className="unlisted-live">
            {tok.priceUsd != null && (
              <div className="ds">
                <div className="k">Price</div>
                <div className="v">{fmtPrice(tok.priceUsd)}</div>
              </div>
            )}
            {tok.mcap != null && (
              <div className="ds">
                <div className="k">Market cap</div>
                <div className="v">{fmtCap(tok.mcap)}</div>
              </div>
            )}
          </div>
        )}

        <div className="unlisted-facts">
          <div className="ds">
            <div className="k">Network</div>
            <div className="v">
              <ChainLogo chain={chain} size={14} style={{ verticalAlign: "-2px" }} />{" "}
              <span style={{ color: c?.color }}>{c?.label ?? chain}</span>
            </div>
          </div>
          <div className="ds">
            <div className="k">Contract address</div>
            <div className="ca-box" style={{ border: 0, padding: 0, background: "none" }}>
              <code>{address}</code>
              <button className="copy-btn" onClick={copyCa}>COPY</button>
            </div>
          </div>
        </div>

        <div className="unlisted-cta">
          <a className="btn-primary" href={BOT_URL} target="_blank" rel="noopener noreferrer">
            List {ticker ?? "Your Token"} →
          </a>
          <Link className="btn-ghost2" href="/">Browse listed tokens</Link>
        </div>

        {/* NO CHART HERE, DELIBERATELY — and the ban on the third-party
            EMBED that used to sit here stands separately and for its own
            reason: it sat on "Loading chart settings…" for seconds and then
            planted a competitor's logo and wordmark across a Dexvra page.

            What was removed on top of that is our OWN candlestick chart, by
            the owner's call, and the quota argument is what makes it the right
            one. This page is reachable by pasting ANY contract — every buy-bot
            alert links here — so each visit charted a token nobody listed, and
            every one of those spent from the ~15 req/min GeckoTerminal share
            the site has to split with the bot suite on this box. A listed
            token's chart competing with an unlisted stranger's is the ceiling
            being spent on the pages that are not the product.

            The price and market cap above stay: they come from ONE cached
            /api/token-preview request that this page was already making, and
            they are why a visitor off a buy alert reads this as a product
            rather than a 404. Charting is what listing buys.
            unlisted.test.ts fails if a chart comes back here. */}
      </div>
    </section>
  );
}
