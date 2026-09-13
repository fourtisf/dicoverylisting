"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoredListing } from "@/lib/store";
import type { ListingTier } from "@/lib/types";
import { CHAIN_IDS, CHAINS } from "@/config/chains";
import { LISTING_TIERS, tierLabel } from "@/lib/packages";
import { fmtAge, fmtCap, fmtPrice } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { BannerManager } from "@/components/admin/BannerManager";
import { ChannelBannerManager } from "@/components/admin/ChannelBannerManager";
import { PromoManager } from "@/components/admin/PromoManager";

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

// Pons launch queue — tokens the launchpad's factory has just minted on
// Robinhood Chain, read off chain. Nothing here is listed: Dexvra is
// paid-listing only, so promoting one stays a deliberate press of a button.
interface PonsQueueItem {
  address: string;
  symbol: string | null;
  name: string | null;
  ageMinutes: number;
  graduated: boolean;
  phase: string;
  progressPct: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  ponsUrl: string;
  existing: { id: string; status: string } | null;
}

const emptyAdd = {
  chain: "solana",
  address: "",
  sym: "",
  name: "",
  emoji: "",
  tier: "DIAMOND" as ListingTier,
  logoUrl: "",
  website: "",
  twitter: "",
  telegram: "",
};

export default function AdminDashboard() {
  const [rows, setRows] = useState<StoredListing[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [add, setAdd] = useState(emptyAdd);
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [ef, setEf] = useState({ name: "", emoji: "", logoUrl: "", website: "", twitter: "", telegram: "", overview: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [pons, setPons] = useState<PonsQueueItem[] | null>(null);
  const [ponsLive, setPonsLive] = useState(true);
  const [ponsTier, setPonsTier] = useState<ListingTier>("BRONZE");
  const [ponsErr, setPonsErr] = useState("");
  const [hrs, setHrs] = useState<Record<string, string>>({}); // per-row trending-hours draft

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/listings", { cache: "no-store" });
      if (r.status === 401) {
        window.location.assign(window.location.pathname.replace(/\/$/, "") || "/");
        return;
      }
      const j = await r.json();
      setRows(j.listings ?? []);
    } catch {
      setErr("Failed to load listings");
    }
  }, []);

  const loadPons = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/pons", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setPons(j.launches ?? []);
      setPonsLive(j.live !== false);
    } catch {
      setPons([]);
      setPonsLive(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadPons();
  }, [load, loadPons]);

  const listLaunch = async (address: string) => {
    setPonsErr("");
    setBusy(address);
    try {
      const r = await fetch("/api/admin/pons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, tier: ponsTier }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPonsErr(j.error ?? "Could not create the listing");
        return;
      }
      await Promise.all([load(), loadPons()]);
    } finally {
      setBusy(null);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/listings/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  // Set a trending slot to run for an arbitrary number of hours (0/empty clears
  // it). Stamps trendStart=now, trendExp=now+hours so the site + bot sweeper
  // honour a real window — not just the on/off Featured flag.
  const setTrendHours = (id: string, raw: string) => {
    const h = Math.max(0, Math.round(Number(raw) || 0));
    if (!h) return patch(id, { trendingRank: null, trendStart: null, trendExp: null });
    const now = Date.now();
    return patch(id, { trendingRank: 1, trendStart: now, trendExp: now + h * 3_600_000 });
  };
  const remHours = (r: StoredListing): number | null =>
    r.trendExp ? Math.max(0, Math.ceil((r.trendExp - Date.now()) / 3_600_000)) : null;

  const setStatus = async (id: string, status: string) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/listings/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this listing permanently?")) return;
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/listings/${id}`, { method: "DELETE" });
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddErr("");
    setAdding(true);
    try {
      const r = await fetch("/api/admin/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(add),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setAdd(emptyAdd);
        await load();
      } else {
        setAddErr(j.error || "Could not add listing");
      }
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (r: StoredListing) => {
    setEditId(r.id);
    setEditErr("");
    setEf({
      name: r.name ?? "",
      emoji: r.emoji ?? "",
      logoUrl: r.logoUrl ?? "",
      website: r.website ?? "",
      twitter: r.twitter ?? "",
      telegram: r.telegram ?? "",
      overview: r.overview ?? "",
    });
  };

  const saveEdit = async (id: string) => {
    setSavingEdit(true);
    setEditErr("");
    try {
      const r = await fetch(`/api/admin/listings/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ef),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setEditId(null);
        await load();
      } else {
        setEditErr(j.error || "Could not save");
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const setE = (k: keyof typeof ef) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEf((s) => ({ ...s, [k]: e.target.value }));

  const uploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setUploading(true);
    setEditErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.url) setEf((s) => ({ ...s, logoUrl: j.url }));
      else setEditErr(j.error || "Upload failed");
    } catch {
      setEditErr("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    window.location.assign(window.location.pathname.replace(/\/$/, "") || "/");
  };

  const pending = useMemo(() => (rows ?? []).filter((r) => r.status === "pending"), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = rows ?? [];
    return q
      ? all.filter((r) => (r.sym + r.name + r.address).toLowerCase().includes(q))
      : all;
  }, [rows, search]);
  const stats = useMemo(() => {
    const all = rows ?? [];
    return {
      total: all.length,
      approved: all.filter((r) => r.status === "approved").length,
      pending: all.filter((r) => r.status === "pending").length,
      trending: all.filter((r) => r.trendingRank != null && r.status === "approved").length,
    };
  }, [rows]);

  const setA = (k: keyof typeof emptyAdd) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setAdd((s) => ({ ...s, [k]: e.target.value }));

  return (
    <>
      <header className="admin-top">
        <div className="admin-brand">
          <div className="brand-logo"><Logo size={36} /></div>
          <div className="admin-name">Dexvra<span>Admin Console</span></div>
        </div>
        <div className="admin-top-actions">
          <a className="abtn" href="https://dexvra.io" target="_blank" rel="noopener noreferrer">View site ↗</a>
          <button className="abtn bad" onClick={logout}>Log out</button>
        </div>
      </header>

      <div className="admin-wrap">
        {err && <div className="login-err">{err}</div>}

        <div className="admin-stats">
          <div className="astat"><div className="k">Listings</div><div className="v">{stats.total}</div></div>
          <div className="astat"><div className="k">Approved</div><div className="v">{stats.approved}</div></div>
          <div className="astat pend"><div className="k">Pending</div><div className="v">{stats.pending}</div></div>
          <div className="astat"><div className="k">Trending</div><div className="v">{stats.trending}</div></div>
        </div>

        {/* Homepage carousel "Pumped on Dexvra" showcase (editable example) */}
        <PromoManager />

        {/* Homepage banner (upload + click-through link) */}
        <BannerManager />

        {/* Channel-post banner templates (artwork + GIF/video, per kind) */}
        <ChannelBannerManager />

        {/* Pending submissions */}
        <section className="asec">
          <div className="asec-h">Pending submissions <span className="cnt">{pending.length}</span></div>
          <div className="asec-body">
            {rows == null ? (
              <div className="a-chain">Loading…</div>
            ) : pending.length === 0 ? (
              <div className="a-chain">No submissions waiting for review.</div>
            ) : (
              <div className="pend-grid">
                {pending.map((r) => (
                  <div className="pend-card" key={r.id}>
                    <div className="pend-top">
                      <span style={{ fontSize: 20 }}>{r.emoji}</span>
                      <div>
                        <div className="pend-sym">{r.sym}</div>
                        <div className="a-chain">{r.name} · {CHAINS[r.chain]?.label ?? r.chain}</div>
                      </div>
                    </div>
                    <div className="pend-meta">{r.address}</div>
                    <div className="pend-actions">
                      <button className="abtn ok" disabled={busy === r.id} onClick={() => setStatus(r.id, "approved")}>Approve</button>
                      <button className="abtn bad" disabled={busy === r.id} onClick={() => setStatus(r.id, "rejected")}>Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Pons launch queue */}
        <section className="asec">
          <div className="asec-h">
            Pons launches · Robinhood <span className="cnt">{pons?.length ?? 0}</span>
            <select
              className="a-select asec-search"
              value={ponsTier}
              onChange={(e) => setPonsTier(e.target.value as ListingTier)}
              title="Tier applied when you list a launch"
            >
              {LISTING_TIERS.map((t) => (
                <option key={t.key} value={t.key}>List as {tierLabel(t.key)}</option>
              ))}
            </select>
          </div>
          <div className="asec-body">
            {ponsErr && <div className="login-err" style={{ textAlign: "left", marginBottom: 10 }}>{ponsErr}</div>}
            {pons == null ? (
              <div className="a-chain">Reading the Pons factory…</div>
            ) : !ponsLive ? (
              <div className="a-chain">Robinhood Chain RPC unreachable — try again shortly.</div>
            ) : pons.length === 0 ? (
              <div className="a-chain">No launches inside the scanned window yet.</div>
            ) : (
              <div className="pend-grid">
                {pons.map((l) => (
                  <div className="pend-card" key={l.address}>
                    <div className="pend-top">
                      <span style={{ fontSize: 20 }}>🏹</span>
                      <div>
                        <div className="pend-sym">{l.symbol ? `$${l.symbol}` : short(l.address)}</div>
                        <div className="a-chain">
                          {l.name || "Unnamed"} · {fmtAge(l.ageMinutes)} old ·{" "}
                          {l.graduated ? l.phase : `curve ${(l.progressPct ?? 0).toFixed(0)}%`}
                        </div>
                      </div>
                    </div>
                    <div className="pend-meta">{l.address}</div>
                    <div className="a-chain">
                      {l.priceUsd != null ? fmtPrice(l.priceUsd) : "no price"} ·{" "}
                      {l.mcapUsd != null ? fmtCap(l.mcapUsd) : "—"} mcap
                    </div>
                    <div className="pend-actions">
                      {l.existing ? (
                        <span className="a-chain">Already listed ({l.existing.status})</span>
                      ) : (
                        <button
                          className="abtn ok"
                          disabled={busy === l.address || !l.symbol}
                          title={l.symbol ? "" : "Launch has no on-chain ticker"}
                          onClick={() => listLaunch(l.address)}
                        >
                          {busy === l.address ? "Listing…" : "List it"}
                        </button>
                      )}
                      <a className="abtn" href={l.ponsUrl} target="_blank" rel="noopener noreferrer">Pons ↗</a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* All listings */}
        <section className="asec">
          <div className="asec-h">
            All listings <span className="cnt">{search ? `${shown.length}/${rows?.length ?? 0}` : rows?.length ?? 0}</span>
            <input
              className="asec-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ticker, name, or CA…"
            />
          </div>
          <div className="atable-wrap">
            <table className="atable">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Chain</th>
                  <th>Contract</th>
                  <th>Tier</th>
                  <th>Trending</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.flatMap((r) => [
                  <tr key={r.id}>
                    <td>
                      <div className="a-sym">
                        <span className="a-logo">
                          {r.logoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.logoUrl} alt="" />
                          ) : (
                            r.emoji
                          )}
                        </span>
                        {r.sym}
                      </div>
                      <div className="a-chain">{r.name}</div>
                    </td>
                    <td className="a-chain">{CHAINS[r.chain]?.label ?? r.chain}</td>
                    <td className="a-ca" title={r.address}>{short(r.address)}</td>
                    <td style={{ minWidth: 130 }}>
                      <select
                        className="a-select"
                        value={r.tier}
                        disabled={busy === r.id}
                        onChange={(e) => patch(r.id, { tier: e.target.value })}
                      >
                        {LISTING_TIERS.map((t) => (
                          <option key={t.key} value={t.key}>{tierLabel(t.key)}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="a-check">
                        <input
                          type="checkbox"
                          checked={r.trendingRank != null}
                          disabled={busy === r.id}
                          onChange={(e) =>
                            e.target.checked
                              ? setTrendHours(r.id, hrs[r.id] || "24")
                              : patch(r.id, { trendingRank: null, trendStart: null, trendExp: null })
                          }
                        />
                        Featured
                      </label>
                      <div className="a-trend-hrs">
                        <input
                          type="number"
                          min={1}
                          className="a-hrs-in"
                          placeholder="hrs"
                          value={hrs[r.id] ?? (remHours(r) != null ? String(remHours(r)) : "")}
                          disabled={busy === r.id}
                          onChange={(e) => setHrs((s) => ({ ...s, [r.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") setTrendHours(r.id, (e.target as HTMLInputElement).value);
                          }}
                        />
                        <button
                          className="abtn"
                          disabled={busy === r.id}
                          onClick={() => setTrendHours(r.id, hrs[r.id] ?? "")}
                        >
                          Set
                        </button>
                        {remHours(r) != null && <span className="a-hrs-left">{remHours(r)}h left</span>}
                      </div>
                    </td>
                    <td><span className={`a-status ${r.status}`}>{r.status}</span></td>
                    <td>
                      <div className="a-row-actions">
                        <button className="abtn" disabled={busy === r.id} onClick={() => (editId === r.id ? setEditId(null) : startEdit(r))}>
                          {editId === r.id ? "Close" : "Edit"}
                        </button>
                        {r.status !== "approved" ? (
                          <button className="abtn ok" disabled={busy === r.id} onClick={() => setStatus(r.id, "approved")}>Approve</button>
                        ) : (
                          <button className="abtn" disabled={busy === r.id} onClick={() => setStatus(r.id, "rejected")}>Unlist</button>
                        )}
                        <button className="abtn bad" disabled={busy === r.id} onClick={() => remove(r.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>,
                  editId === r.id && (
                    <tr className="edit-row" key={`${r.id}-edit`}>
                      <td colSpan={7}>
                        <div className="edit-panel">
                          <div className="edit-grid">
                            <div className="add-fld"><label>Name</label><input className="a-input" value={ef.name} onChange={setE("name")} /></div>
                            <div className="add-fld"><label>Emoji (fallback)</label><input className="a-input" value={ef.emoji} onChange={setE("emoji")} maxLength={4} placeholder="🐕" /></div>
                            <div className="add-fld">
                              <label>Preview</label>
                              <div className="edit-logo-box">
                                {ef.logoUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={ef.logoUrl} alt="" />
                                ) : (
                                  <span>{ef.emoji || "🪙"}</span>
                                )}
                              </div>
                            </div>
                            <div className="add-fld wide">
                              <label>Logo — upload a file or paste an image URL</label>
                              <div className="logo-row">
                                <label className={`abtn upload-btn ${uploading ? "busy" : ""}`}>
                                  {uploading ? "Uploading…" : "⬆ Upload"}
                                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadLogo} hidden disabled={uploading} />
                                </label>
                                <input className="a-input" value={ef.logoUrl} onChange={setE("logoUrl")} placeholder="https://…/logo.png  or upload →" />
                              </div>
                            </div>
                            <div className="add-fld"><label>Website</label><input className="a-input" value={ef.website} onChange={setE("website")} placeholder="https://…" /></div>
                            <div className="add-fld"><label>X / Twitter</label><input className="a-input" value={ef.twitter} onChange={setE("twitter")} placeholder="https://x.com/…" /></div>
                            <div className="add-fld"><label>Telegram</label><input className="a-input" value={ef.telegram} onChange={setE("telegram")} placeholder="https://t.me/…" /></div>
                            <div className="add-fld wide"><label>Overview — short project description (token page + channel posts; empty = none)</label><input className="a-input" value={ef.overview} onChange={setE("overview")} placeholder="1-3 sentences about the project" /></div>
                          </div>
                          {editErr && <div className="login-err" style={{ textAlign: "left" }}>{editErr}</div>}
                          <div className="edit-actions">
                            <button className="abtn p" disabled={savingEdit} onClick={() => saveEdit(r.id)}>{savingEdit ? "Saving…" : "Save changes"}</button>
                            <button className="abtn" onClick={() => setEditId(null)}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                ])}
              </tbody>
            </table>
          </div>
        </section>

        {/* Add listing */}
        <section className="asec">
          <div className="asec-h">Add listing</div>
          <div className="asec-body">
            <form className="add-grid" onSubmit={submitAdd}>
              <div className="add-fld">
                <label>Chain</label>
                <select className="a-select" value={add.chain} onChange={setA("chain")}>
                  {CHAIN_IDS.map((id) => (<option key={id} value={id}>{CHAINS[id].label}</option>))}
                </select>
              </div>
              <div className="add-fld">
                <label>Ticker</label>
                <input className="a-input" value={add.sym} onChange={setA("sym")} placeholder="BONK" />
              </div>
              <div className="add-fld">
                <label>Name</label>
                <input className="a-input" value={add.name} onChange={setA("name")} placeholder="Bonk" />
              </div>
              <div className="add-fld">
                <label>Tier</label>
                <select className="a-select" value={add.tier} onChange={setA("tier")}>
                  {LISTING_TIERS.map((t) => (<option key={t.key} value={t.key}>{tierLabel(t.key)}</option>))}
                </select>
              </div>
              <div className="add-fld wide">
                <label>Contract address</label>
                <input className="a-input" value={add.address} onChange={setA("address")} placeholder="Paste CA…" />
              </div>
              <div className="add-fld">
                <label>Emoji</label>
                <input className="a-input" value={add.emoji} onChange={setA("emoji")} placeholder="🐕" maxLength={4} />
              </div>
              <div className="add-fld wide">
                <label>Logo image URL (optional)</label>
                <input className="a-input" value={add.logoUrl} onChange={setA("logoUrl")} placeholder="https://…/logo.png" />
              </div>
              <div className="add-fld">
                <label>Website</label>
                <input className="a-input" value={add.website} onChange={setA("website")} placeholder="https://…" />
              </div>
              <div className="add-fld">
                <label>X / Twitter</label>
                <input className="a-input" value={add.twitter} onChange={setA("twitter")} placeholder="https://x.com/…" />
              </div>
              <div className="add-fld">
                <label>Telegram</label>
                <input className="a-input" value={add.telegram} onChange={setA("telegram")} placeholder="https://t.me/…" />
              </div>
              {addErr && <div className="add-fld wide"><div className="login-err" style={{ textAlign: "left" }}>{addErr}</div></div>}
              <div className="add-fld wide">
                <button className="abtn p" type="submit" disabled={adding} style={{ padding: "10px 18px" }}>
                  {adding ? "Adding…" : "Add listing (goes live)"}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}
