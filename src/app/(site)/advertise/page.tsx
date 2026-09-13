"use client";

import { useState, type CSSProperties } from "react";
import { PageHead } from "@/components/PageHead";
import { ChainLogo } from "@/components/ChainLogo";
import { BOT_URL, TELEGRAM_HANDLE, TELEGRAM_LISTING_HANDLE } from "@/config/brand";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import {
  BANNERS,
  LISTING_TIERS,
  fmtNative,
  fmtUsd,
  nativeOf,
  tierPrice,
  tierTrendingHours,
  trendingForChain,
} from "@/lib/packages";

export default function AdvertisePage() {
  const [chain, setChain] = useState("solana");
  const native = nativeOf(chain);
  const trending = trendingForChain(chain);

  return (
    <section className="view">
      <PageHead
        icon="📢"
        title="Packages"
        sub="List, trend, and get seen. Every package is billed in the chain's own coin — pay on Solana in SOL, on BSC in BNB, on ETH/Base in ETH."
      />

      {/* Chain selector — drives which native prices are shown */}
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

      {/* ── Listing packages ─────────────────────────────────────────── */}
      <h3 className="pkg-h">Listing Packages</h3>
      <p className="pkg-sub">
        A one-time listing on Dexvra. Every package — Xpress included — is posted to{" "}
        <b>{TELEGRAM_LISTING_HANDLE}</b> and to X. Higher tiers add the <b>{TELEGRAM_HANDLE}</b>{" "}
        announcement, a trending run, and the verified badge. Your token carries its tier tag everywhere.
      </p>
      <div className="pkg-grid">
        {LISTING_TIERS.map((tier) => {
          const price = tierPrice(tier.key, chain);
          // Every listing is tweeted (fulfilment calls x.postListing for all of
          // them), the @dexvraio post is gated on the tier's announce flag, and
          // the trending hours come from the table the bot bills against. The
          // page used to name none of the three, so the strongest thing a tier
          // buys — Diamond carries two full days of trending — was invisible.
          const hrs = tierTrendingHours(tier.key);
          const perks = [
            tier.verified ? "Verified badge" : "Search + discovery indexed",
            tier.announce ? `Announcement post in ${TELEGRAM_HANDLE}` : `Listing post in ${TELEGRAM_LISTING_HANDLE}`,
            hrs > 0 ? `Auto trending for ${hrs}h` : "Instant activation — no review wait",
            "Announcement on X",
            tier.instant ? "Priority verification — reviewed first" : `Tier #${tier.rank} placement`,
          ];
          return (
            <div
              className={`pkg ${tier.rank === 1 ? "featured" : ""}`}
              key={tier.key}
              style={{ "--tc": tier.color } as CSSProperties}
            >
              {tier.rank === 1 && <span className="pkg-flag">TOP TIER</span>}
              {tier.instant && <span className="pkg-flag alt">INSTANT</span>}
              <div className="pkg-name">
                <span className="pkg-glyph">{tier.glyph}</span>
                {tier.label}
                {tier.rank > 0 && <span className="pkg-rank">#{tier.rank}</span>}
              </div>
              <div className="pkg-price">
                {price != null ? fmtNative(price, native) : "—"}
              </div>
              <ul className="pkg-perks">
                {perks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <a className="btn-primary pkg-cta" href={BOT_URL} target="_blank" rel="noopener noreferrer">
                List with {tier.label}
              </a>
            </div>
          );
        })}
      </div>

      {/* ── Trending packages ────────────────────────────────────────── */}
      <h3 className="pkg-h">
        Trending — <span style={{ color: CHAINS[chain].color }}>{CHAINS[chain].label}</span>
      </h3>
      <p className="pkg-sub">
        Time-boxed featured slots on the Trending board. Longer runs discount. 24H &amp; 48H are also
        posted to the announcement channel.
      </p>
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              <th>Duration</th>
              <th>Price</th>
              <th>Discount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trending.map((r) => (
              <tr key={r.duration}>
                <td className="pt-dur">{r.duration}</td>
                <td className="pt-price">{fmtNative(r.price, native)}</td>
                <td>{r.discount > 0 ? <span className="pt-off">−{r.discount}%</span> : <span className="pt-dim">—</span>}</td>
                <td className="pt-cta">
                  <a className="btn-ghost2 sm" href={BOT_URL} target="_blank" rel="noopener noreferrer">
                    Book
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Banner ads ───────────────────────────────────────────────── */}
      <h3 className="pkg-h">Banner Ads</h3>
      <p className="pkg-sub">Rotating homepage banner slots, billed in USD by run length.</p>
      <p className="pkg-sub">
        Both sizes run in the same homepage row, directly under the market pulse. A{" "}
        <b>Wide</b> banner takes half the row and sits on the left; <b>Standard</b> banners sit to its right, two of them filling the rest.
      </p>
      <div className="banner-grid">
        {BANNERS.map((b) => (
          <div className="pkg banner-card" key={b.name}>
            <div className="pkg-name">{b.name}</div>
            <div className="banner-size">{b.size}px</div>
            {/* A real example at this exact size — "which one am I buying?" was
                impossible to answer from a price table alone. The wrapper keeps
                the two cards' examples at their true RELATIVE widths, so Wide
                visibly reads wider than Standard instead of both filling their
                card identically. */}
            <div className="banner-example" aria-hidden>
              <img
                src={b.name.toLowerCase().includes("wide") ? "/ads/example-wide.png" : "/ads/example-standard.png"}
                alt=""
                // 600 vs 1200 — the example is shown at its true share of the row
                style={{ width: b.name.toLowerCase().includes("wide") ? "100%" : "50%" }}
              />
              <span className="banner-example-cap">
                {b.name.toLowerCase().includes("wide") ? "Half the row, on the left" : "A quarter of the row, on the right"}
              </span>
            </div>
            <table className="ptable flush">
              <tbody>
                {b.rows.map((r) => (
                  <tr key={r.duration}>
                    <td className="pt-dur">{r.duration}</td>
                    <td className="pt-price">{fmtUsd(r.usd)}</td>
                    <td><span className="pt-off">−{r.discount}%</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <a className="btn-ghost2 pkg-cta" href={BOT_URL} target="_blank" rel="noopener noreferrer">
              Book banner
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
