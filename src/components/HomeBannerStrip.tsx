"use client";

// The homepage ad row: every LIVE banner booking (sold by the Telegram bot,
// stored via /api/internal/banners) rendered side by side on a 4-column grid —
// a Wide banner takes 2 columns and always sits on the LEFT, Standard banners
// take 1 each to its right. A row that isn't sold out stretches to fill the
// width, so a single booking runs full-bleed rather than sitting in a quarter.
//
// WHY A ROW AND NOT ONE BANNER: this used to render banners[0] only, so with two
// advertisers running at once the earlier one vanished from the site even though
// it had been paid for and its slot was still live. /advertise sells "Rotating
// homepage banner slots", so showing one forever was a broken promise, not a
// design choice. Everything active is now visible at once; only when there are
// more bookings than fit does the row page through them.
//
// Deliberately ONE placement. More ad spots on the page would read as spam —
// extra inventory belongs in this row, not in a new strip somewhere else.
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./AppState";
import { packBannerRows, unitsOf, slotLabel, aspectOf } from "@/lib/bannerRows";

type Banner = {
  slot: string;
  size: string;
  imageUrl: string;
  linkUrl: string;
  title: string | null;
};

const PAGE_MS = 8000;

export function HomeBannerStrip() {
  const { reducedMotion } = useApp();
  const [banners, setBanners] = useState<Banner[]>([]);
  const [page, setPage] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/banners")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const rows: Banner[] = (j?.banners ?? []).filter((b: Banner) => b?.imageUrl && b?.linkUrl);
        if (alive) setBanners(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const pages = useMemo(() => packBannerRows(banners), [banners]);

  // Page through only when there's more inventory than fits in one row, so a
  // single advertiser never flickers for no reason.
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (pages.length < 2 || reducedMotion) return;
    timer.current = setInterval(() => setPage((p) => (p + 1) % pages.length), PAGE_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [pages.length, reducedMotion]);

  // A booking can expire between fetches — never index past the end.
  const current = pages[Math.min(page, Math.max(0, pages.length - 1))];
  if (!current || !current.length) return null;

  return (
    <div className="home-ads" aria-label="Sponsored banners">
      <div className="home-ads-row">
        {current.map((b, i) => (
          <a
            key={`${b.imageUrl}:${i}`}
            className="home-banner"
            // Flex weight, not a fixed column: a sold-out row splits 2:1:1 while
            // a half-empty one stretches to fill instead of leaving a gap.
            // --u = flex weight; aspect-ratio comes from the SOLD size, so every
            // booking of the same slot is the same height whatever the
            // advertiser uploaded.
            style={{ "--u": unitsOf(b), aspectRatio: String(aspectOf(b.size, b.slot)) } as React.CSSProperties}
            href={b.linkUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={b.title ?? "Sponsored banner"}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.imageUrl} alt={b.title ?? ""} />
            {/* "Ad" is the disclosure every visitor needs; the slot name next to
                it tells a prospective advertiser exactly which package this is —
                the row doubles as the inventory's own shop window. */}
            <span className="home-banner-tag">
              Ad{slotLabel(b.slot) && <i> · {slotLabel(b.slot)}</i>}
            </span>
          </a>
        ))}
      </div>
      {pages.length > 1 && (
        <div className="home-ads-dots">
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              className={i === page ? "on" : ""}
              onClick={() => setPage(i)}
              aria-label={`Banner set ${i + 1} of ${pages.length}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
