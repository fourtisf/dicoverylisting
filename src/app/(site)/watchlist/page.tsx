"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { byChange } from "@/lib/home";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";

export default function WatchlistPage() {
  const { data, watchlist } = useApp();

  // Through `byChange`, not the raw field — a starred token with an above-bound
  // reading (GT has published +5,191,162%) or a real percentage on five cents of
  // volume would otherwise take rank 1 and the gold medal on the one board a
  // user built by hand. Same owner as the home board and /trending.
  const list = useMemo(
    () => byChange((data?.tokens ?? []).filter((t) => watchlist.has(t.key)), "24h", -1),
    [data, watchlist],
  );

  return (
    <section className="view">
      <PageHead icon="⭐" title="Watchlist" sub="Your starred tokens, live. Tap ★ anywhere to add more." />
      {data && list.length === 0 ? (
        <div className="panel big-empty">
          <div className="em">⭐</div>
          <p>Nothing here yet. Star any token from the board and it lands in your watchlist.</p>
          <Link href="/" className="btn-primary">
            Browse trending →
          </Link>
        </div>
      ) : (
        <StdBoard tokens={list} loading={!data} />
      )}
    </section>
  );
}
