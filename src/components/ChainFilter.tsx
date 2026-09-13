"use client";

import { useState } from "react";
import { chainOf } from "@/config/chains";
import { splitChains, type ChainCount } from "@/lib/home";
import { ChainLogo } from "./ChainLogo";

/**
 * The one chain control for the whole market area.
 *
 * Two deliberate departures from the wall of pills this page used to open with:
 *
 *  · it offers only chains that HAVE listings, derived from the data, so a new
 *    chain in `chains.ts` appears here on its first listing and no dead filter
 *    ever appears at all;
 *  · it shows a handful and keeps the rest behind "+N more" — one row, scrolled
 *    sideways on a phone, instead of three wrapped rows of chrome above the
 *    first token.
 *
 * The COUNT on each pill is the point of the counts: it says why the filter is
 * worth tapping before you tap it, and a chain sitting at 1 explains a short
 * board without anyone having to guess.
 */
export function ChainFilter({
  counts,
  value,
  onChange,
  total,
}: {
  counts: ChainCount[];
  value: string;
  onChange: (id: string) => void;
  total: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = splitChains(counts);
  // ⚠️ The expanded row is shown + hidden — hidden now carries the registry's
  // EMPTY chains too, which `counts` never has. Rendering `counts` here made
  // the button promise "+18 more" and deliver four: the label counted the
  // hidden list while the render ignored it. Caught by clicking it.
  const all = [...shown, ...hidden];
  // A chain picked from behind "+N more" must not disappear when the row
  // collapses — the active pill would vanish while still filtering the board.
  const visible = expanded || hidden.some((c) => c.id === value) ? all : shown;

  if (counts.length < 2) return null;

  return (
    <div className="chain-row" role="group" aria-label="Filter by chain">
      <button
        className={`chain-chip ${value === "all" ? "active" : ""}`}
        onClick={() => onChange("all")}
        aria-pressed={value === "all"}
      >
        <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
        </svg>
        All chains
        <span className="chain-n">{total}</span>
      </button>

      {visible.map((c) => (
        <button
          key={c.id}
          className={`chain-chip ${value === c.id ? "active" : ""} ${c.count === 0 ? "chain-zero" : ""}`}
          onClick={() => onChange(c.id)}
          aria-pressed={value === c.id}
        >
          <ChainLogo chain={c.id} size={15} />
          {chainOf(c.id)?.label ?? c.id}
          {/* the 0 stays visible — it says BEFORE the tap why the board will
              be empty, and an empty chain is an invitation, not a dead end */}
          <span className="chain-n">{c.count}</span>
        </button>
      ))}

      {hidden.length > 0 && (
        <button className="chain-chip chain-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Less" : `+${hidden.length} more`}
        </button>
      )}
    </div>
  );
}
