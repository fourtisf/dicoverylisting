"use client";

import { useState, type CSSProperties } from "react";
import { PageHead } from "@/components/PageHead";
import { ChainLogo } from "@/components/ChainLogo";
import {
  BOT_URL,
  BRAND_NAME,
  TELEGRAM_HANDLE,
  TELEGRAM_LISTING_HANDLE,
  TELEGRAM_TRENDING_HANDLE,
  TELEGRAM_URL,
  X_URL,
} from "@/config/brand";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import { LISTING_TIERS, fmtNative, nativeOf, tierPrice, tierTrendingHours } from "@/lib/packages";

// This page used to sell verification on its own for "1.5 SOL / one-time" — a
// price that appears in no package on the site and in no product in the bot, so
// nothing could quote it and nothing could collect it. Worse, the verified badge
// is already included in Diamond, Gold and Platinum: a project that had just
// paid 5 SOL for Diamond read this page and concluded it owed another 1.5 SOL
// for a badge it already had.
//
// The page now shows how verification is actually obtained — through the listing
// tiers — priced from the same LISTING_TIERS the bot charges from, in the
// chain's own coin, exactly like /advertise.
export default function VerifiedPage() {
  const [chain, setChain] = useState("solana");
  const native = nativeOf(chain);
  const withBadge = LISTING_TIERS.filter((t) => t.verified);
  // Xpress is shown here too: it is the cheapest way onto the board and it
  // moves you to the front of the review queue. It does NOT include the badge,
  // and its card says so with a × rather than leaving that to a footnote —
  // omitting the package entirely just sent people to /advertise to find it.
  const xpress = LISTING_TIERS.find((t) => t.instant);
  const cards = xpress ? [...withBadge, xpress] : withBadge;

  return (
    <section className="view">
      <PageHead
        icon="✅"
        title="Get Verified"
        sub={`The green check tells traders your project passed ${BRAND_NAME} review. It comes with the top listing tiers — there is no separate fee.`}
      />

      <div className="chain-pick" role="tablist" aria-label="Choose chain">
        {CHAIN_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={chain === id}
            className={`chip-chain ${chain === id ? "on" : ""}`}
            onClick={() => setChain(id)}
          >
            <ChainLogo chain={id} size={16} />
            {CHAINS[id].label}
            <span className="cc-native">{nativeOf(id)}</span>
          </button>
        ))}
      </div>

      <div className="panel" style={{ maxWidth: 720 }}>
        <div className="check-list">
          <div className="check">✓ Team identity reviewed by {BRAND_NAME}<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Contract &amp; LP lock checked on-chain<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Verified badge on every board &amp; ticker<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Announcement post on Telegram &amp; X<span className="cv ok">INCLUDED</span></div>
        </div>
      </div>

      <h3 className="pkg-h">Packages and verification</h3>
      <p className="pkg-sub">
        Priced in {CHAINS[chain].label}&rsquo;s own coin. These are the same packages at the same prices
        that <b>@dexvrabot</b> charges — this page and the bot read one list. Every package, Xpress
        included, is posted to <b>{TELEGRAM_LISTING_HANDLE}</b> and to X; the higher tiers add the{" "}
        <b>{TELEGRAM_HANDLE}</b> announcement and a trending run in <b>{TELEGRAM_TRENDING_HANDLE}</b>.
      </p>
      <div className="pkg-grid">
        {cards.map((tier) => {
          const price = tierPrice(tier.key, chain);
          const hours = tierTrendingHours(tier.key);
          // Built from the tier's own data, never written per card, and every
          // line traces to something fulfilment actually does:
          //   listing post  — post.sendMedia(CHANNELS.listing) runs for EVERY
          //                   package, Xpress included. It is the one thing
          //                   every buyer gets, and no card was naming it.
          //   X post        — x.postListing is called unconditionally too.
          //   @dexvraio     — gated on tierAnnounces, so announce tiers only.
          //   trending      — hours from the table the bot bills against.
          // A × means the tier genuinely does not include it.
          const perks = [
            { label: "Verified badge", has: tier.verified },
            { label: `Announcement post in ${TELEGRAM_HANDLE}`, has: tier.announce },
            {
              label: hours > 0 ? `Auto trending ${hours}h in ${TELEGRAM_TRENDING_HANDLE}` : "Auto trending",
              has: hours > 0,
            },
            { label: `Listing post in ${TELEGRAM_LISTING_HANDLE}`, has: true },
            { label: "Announcement on X", has: true },
            tier.instant
              ? { label: "Instant activation — no review wait", has: true }
              : { label: `Tier #${tier.rank} placement`, has: true },
          ];
          return (
            <div
              className={`pkg ${tier.rank === 1 ? "featured" : ""}`}
              key={tier.key}
              style={{ "--tc": tier.color } as CSSProperties}
            >
              {tier.rank === 1 && <span className="pkg-flag">BEST SELLER</span>}
              {tier.instant && <span className="pkg-flag alt">INSTANT</span>}
              <div className="pkg-name">
                <span className="pkg-glyph">{tier.glyph}</span>
                {tier.label}
                {tier.rank > 0 && <span className="pkg-rank">#{tier.rank}</span>}
              </div>
              <div className="pkg-price">{price != null ? fmtNative(price, native) : "—"}</div>
              <ul className="pkg-perks">
                {perks.map((p) => (
                  <li key={p.label} className={p.has ? "" : "no"}>
                    {p.label}
                  </li>
                ))}
              </ul>
              <a className="btn-primary pkg-cta" href={BOT_URL} target="_blank" rel="noopener noreferrer">
                List with {tier.label}
              </a>
            </div>
          );
        })}
      </div>

      <div className="panel soc-note" style={{ marginTop: 14 }}>
        <b>Listed on Silver or Bronze already?</b> Those tiers do not carry the badge, and neither does{" "}
        {xpress ? xpress.label : "Xpress"} on its own. The badge comes with{" "}
        {withBadge.map((t) => t.label).join(", ")}. Message us on Telegram and we will tell you what an
        upgrade costs from where you are.
      </div>

      <div className="verify-contact">
        Questions first? Reach {BRAND_NAME} on{" "}
        <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Telegram {TELEGRAM_HANDLE}</a>
        {" · "}
        <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
      </div>
    </section>
  );
}
