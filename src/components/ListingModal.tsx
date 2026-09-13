"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type CSSProperties } from "react";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import { LISTING_TIERS, fmtNative, nativeOf, tierPrice } from "@/lib/packages";
import { useApp } from "./AppState";

const URL_RE = /^https?:\/\/[^\s]+$/i;

const emptyForm = {
  name: "",
  sym: "",
  chain: "solana",
  emoji: "",
  ca: "",
  x: "",
  tg: "",
};

export function ListingModal() {
  const { listingOpen, closeListing, addListing, toast } = useApp();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(emptyForm);
  const [tierKey, setTierKey] = useState("DIAMOND");
  const [submitting, setSubmitting] = useState(false);

  const native = nativeOf(form.chain);
  const tier = useMemo(() => LISTING_TIERS.find((t) => t.key === tierKey) ?? LISTING_TIERS[0], [tierKey]);
  const price = tierPrice(tier.key, form.chain);

  if (!listingOpen) return null;

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const close = () => {
    closeListing();
    setStep(1);
  };

  const next1 = () => {
    if (!form.name.trim() || !form.sym.trim() || !form.ca.trim()) {
      toast("Fill in name, ticker, and CA first 🙏");
      return;
    }
    if (!CHAINS[form.chain].addressPattern.test(form.ca.trim())) {
      toast(`That doesn't look like a ${CHAINS[form.chain].label} address 🤔`);
      return;
    }
    for (const [v, label] of [[form.x, "X"], [form.tg, "Telegram"]] as const) {
      if (v.trim() && !URL_RE.test(v.trim())) {
        toast(`${label} link must be a full https:// URL`);
        return;
      }
    }
    setStep(2);
  };

  /**
   * Push the submission to the server's pending queue, then tell the submitter.
   *
   * ⚠️ IN THAT ORDER, AND THAT IS THE WHOLE OF THIS FUNCTION. It used to fire
   * the request and forget it — `void fetch(…).catch(() => {})` — write the
   * local "My listings" record, and go straight to "Submission received!".
   * So every way the server can say no showed the project a green tick and a
   * queue entry that did not exist: a malformed address (400), a rate limit
   * (429), a dead network, and now the one that matters most — a token that is
   * ALREADY listed (409), which is refused so that a submission can never take
   * over somebody else's live row.
   *
   * A success screen over a refusal is the reassuring reading this repo keeps
   * paying for, and here it is aimed at a paying customer.
   */
  const pay = async () => {
    if (submitting) return; // a second tap is a second queue entry
    setSubmitting(true);
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain: form.chain,
          address: form.ca.trim(),
          sym: form.sym.trim(),
          name: form.name.trim(),
          emoji: form.emoji.trim(),
          tier: tier.key,
          twitter: form.x.trim() || undefined,
          telegram: form.tg.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server's own sentence: "already listed" and "already in the
        // queue" are different things to the person typing, and neither is a
        // fault on their side.
        toast(j.error || "Couldn't submit that listing — try again in a moment.");
        return;
      }
    } catch {
      toast("Couldn't reach the server — nothing was submitted.");
      return;
    } finally {
      setSubmitting(false);
    }
    // Only now: a local record of a listing the server refused is a "My
    // listings" row that will never become anything.
    addListing({
      symbol: "$" + form.sym.trim().toUpperCase().replace(/^\$+/, ""),
      name: form.name.trim(),
      emoji: form.emoji.trim() || "🆕",
      chain: form.chain,
      tier: tier.key,
      status: "IN REVIEW",
    });
    setStep(4);
  };

  const ca = form.ca.trim();

  const perksFor = (t: (typeof LISTING_TIERS)[number]) =>
    t.instant
      ? ["Instant activation", "TG + trending board", "Priority verification"]
      : [
          t.rank <= 3 ? "Announcement post" : "Standard listing",
          t.rank <= 3 ? "Verified badge" : "Discovery indexed",
          `Tier #${t.rank} placement`,
        ];

  return (
    <div className="modal-ov on" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <button className="modal-x" onClick={close}>✕</button>
        <div className="m-title">⚡ List your token</div>
        <div className="stepdots">
          {[1, 2, 3].map((i) => (
            <span key={i} className={`sdot ${i <= Math.min(step, 3) ? "on" : ""}`} />
          ))}
        </div>

        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="frow">
              <div className="fld"><label>Token name</label><input value={form.name} onChange={set("name")} placeholder="e.g. Trench Cat" /></div>
              <div className="fld"><label>Ticker</label><input value={form.sym} onChange={set("sym")} placeholder="e.g. TRENCHCAT" /></div>
            </div>
            <div className="frow">
              <div className="fld">
                <label>Chain</label>
                <select value={form.chain} onChange={set("chain")}>
                  {CHAIN_IDS.map((id) => (
                    <option key={id} value={id}>{CHAINS[id].label} · pays in {nativeOf(id)}</option>
                  ))}
                </select>
              </div>
              <div className="fld"><label>Logo (emoji for now)</label><input value={form.emoji} onChange={set("emoji")} placeholder="🐸" maxLength={4} /></div>
            </div>
            <div className="fld"><label>Contract address</label><input value={form.ca} onChange={set("ca")} placeholder="Paste CA…" /></div>
            <div className="frow">
              <div className="fld"><label>X / Twitter</label><input value={form.x} onChange={set("x")} placeholder="https://x.com/…" /></div>
              <div className="fld"><label>Telegram</label><input value={form.tg} onChange={set("tg")} placeholder="https://t.me/…" /></div>
            </div>
            <div className="m-actions">
              <button className="btn-primary" onClick={next1}>Choose package →</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="tier-hint">
              Paying on <b>{CHAINS[form.chain].label}</b> — prices in <b>{native}</b>.
            </div>
            <div className="tier-grid pkg-modal-grid">
              {LISTING_TIERS.map((t) => {
                const p = tierPrice(t.key, form.chain);
                return (
                  <div
                    key={t.key}
                    className={`tier ${tierKey === t.key ? "sel" : ""}`}
                    style={{ "--tc": t.color } as CSSProperties}
                    onClick={() => setTierKey(t.key)}
                  >
                    {t.rank === 1 && <span className="pop">TOP</span>}
                    {t.instant && <span className="pop alt">INSTANT</span>}
                    <div className="tname">
                      <span className="pkg-glyph">{t.glyph}</span> {t.label}
                      {t.rank > 0 && <span className="pkg-rank">#{t.rank}</span>}
                    </div>
                    <div className="tprice">{p != null ? fmtNative(p, native) : "—"}</div>
                    <ul>
                      {perksFor(t).map((perk) => (
                        <li key={perk}>{perk}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div className="m-actions">
              <button className="btn-ghost2" onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" onClick={() => setStep(3)}>Review →</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="check-list">
              <div className="check">
                Token
                <span className="cv ok" style={{ background: "none", color: "var(--text)" }}>
                  {form.emoji || "🆕"} {form.name} (${form.sym.toUpperCase().replace(/^\$+/, "")})
                </span>
              </div>
              <div className="check">
                Chain
                <span className="cv ok" style={{ background: "none", color: "var(--text)" }}>{CHAINS[form.chain].label}</span>
              </div>
              <div className="check">
                Contract
                <span className="cv ok" style={{ background: "none", color: "var(--muted)", fontSize: 10 }}>
                  {ca.slice(0, 8)}…{ca.slice(-6)}
                </span>
              </div>
              <div className="check">
                Package
                <span className="cv ok">{tier.glyph} {tier.label} · {price != null ? fmtNative(price, native) : "—"}</span>
              </div>
            </div>
            <div className="m-actions">
              <button className="btn-ghost2" onClick={() => setStep(2)}>← Back</button>
              <button className="btn-primary" onClick={pay} disabled={submitting}>
                {submitting ? "Submitting…" : "Pay & submit ⚡"}
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="success-wrap">
            <div className="success-ic">✓</div>
            <div className="m-title" style={{ justifyContent: "center" }}>Submission received!</div>
            <p style={{ color: "var(--muted)", fontSize: 13, maxWidth: "38ch" }}>
              Your token is in the review queue. Track its status anytime from your account.
            </p>
            <div className="m-actions" style={{ justifyContent: "center", width: "100%" }}>
              <button className="btn-ghost2" onClick={close}>Close</button>
              <button
                className="btn-primary"
                onClick={() => {
                  close();
                  router.push("/account");
                }}
              >
                View my listings →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
