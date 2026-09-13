"use client";

// Admin panel section: edit the homepage carousel's "Pumped on Dexvra" showcase
// (the example highlight — shipped as $WARCHEST 412×). Changes go live on the
// site immediately (the carousel reads /api/promo).
import { useCallback, useEffect, useState } from "react";

type Promo = { emoji: string; symbol: string; multiplier: string; mcap: string; ath: string; chain: string };

const FIELDS: { k: keyof Promo; label: string; placeholder: string }[] = [
  { k: "emoji", label: "Coin emoji", placeholder: "⚔️" },
  { k: "symbol", label: "Ticker", placeholder: "$WARCHEST" },
  { k: "multiplier", label: "Multiplier", placeholder: "412×" },
  { k: "mcap", label: "Entry MCAP", placeholder: "$310K" },
  { k: "ath", label: "ATH MCAP", placeholder: "$128.4M" },
  { k: "chain", label: "Chain", placeholder: "Solana" },
];

export function PromoManager() {
  const [form, setForm] = useState<Promo | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/promo", { cache: "no-store" });
      if (!r.ok) return;
      setForm(await r.json());
    } catch {
      /* stays loading */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const set = (k: keyof Promo) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setForm((s) => (s ? { ...s, [k]: e.target.value } : s));
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setErr("");
    setSaved(false);
    try {
      const r = await fetch("/api/admin/promo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setForm(j);
        setSaved(true);
      } else {
        setErr(j.error || "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="asec">
      <div className="asec-h">
        Homepage showcase {saved && <span className="cnt" style={{ color: "#4EE6A8" }}>saved ✓</span>}
      </div>
      <div className="asec-body">
        <div className="a-chain" style={{ marginBottom: 12 }}>
          The <b>&quot;Pumped on Dexvra&quot;</b> highlight in the homepage carousel (and the hero&apos;s
          <b> {form ? `${form.symbol} +${form.multiplier}` : "$TICKER +N×"} </b> tag). Set a real featured token — changes
          are live on the site immediately.
        </div>

        {form == null ? (
          <div className="a-chain">Loading…</div>
        ) : (
          <>
            {/* live preview of the pumped line */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                padding: "10px 14px",
                border: "1px solid rgba(120,220,210,.2)",
                borderRadius: 12,
                background: "rgba(255,255,255,.02)",
                marginBottom: 14,
              }}
            >
              <span style={{ fontSize: 22 }}>{form.emoji || "🪙"}</span>
              <b style={{ color: "#4EE6A8", fontSize: 20 }}>{form.multiplier || "—"}</b>
              <span className="a-chain">
                MCAP <b style={{ color: "#EAF6F2" }}>{form.mcap || "—"}</b> → ATH{" "}
                <b style={{ color: "#EAF6F2" }}>{form.ath || "—"}</b> ·{" "}
                <b style={{ color: "#EAF6F2" }}>{form.symbol || "—"}</b> · {form.chain || "—"}
              </span>
            </div>

            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              {FIELDS.map((f) => (
                <label key={f.k} style={{ display: "grid", gap: 4 }}>
                  <span className="a-chain">{f.label}</span>
                  <input className="a-input" value={form[f.k]} onChange={set(f.k)} placeholder={f.placeholder} />
                </label>
              ))}
            </div>

            {err && <div className="login-err" style={{ textAlign: "left", marginTop: 10 }}>{err}</div>}
            <div style={{ marginTop: 12 }}>
              <button className="abtn p" onClick={save} disabled={saving} style={{ padding: "9px 18px" }}>
                {saving ? "Saving…" : "Save showcase"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
