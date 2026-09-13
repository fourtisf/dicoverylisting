"use client";

// Admin panel section: manage the Telegram bot's CHANNEL-POST banner templates
// (still artwork + GIF/video clips per kind) from the website — no Telegram
// needed. Uploads land in the bot's shared data dir; the bot uses them on its
// next post. The composited result (logo/$ticker drawn on) is produced by the
// bot at post time — this panel shows the RAW upload; preview the exact
// composite in @dexvraadminbot.
import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutEditor } from "./LayoutEditor";

type Clip = { type: string; ext: string; bytes: number; mtime: number; preview: "image" | "video" };
type Layout = {
  logoSize: number; logoX: number | "center"; logoY: number | "center"; showText: boolean;
  showChain: boolean; showPrice: boolean; showMcap: boolean;
  tickerFontSize: number; tickerX: number | "center"; tickerY: number; tickerColor: string;
  nameFontSize: number; nameOffsetY: number; nameColor: string;
  metaFontSize: number; metaX: number | "center"; metaY: number;
  pctX?: number | "center"; pctY?: number; pctFontSize?: number;
  priceX?: number | "center"; priceY?: number; priceFontSize?: number;
};
type Kind = {
  kind: string;
  label: string;
  note: string;
  artworkable: boolean;
  fillable: boolean;
  textOverlay: boolean;
  layout: Layout;
  hasArtwork: boolean;
  artworkMtime: number | null;
  clip: Clip | null;
};
type Status = { dir: string; writable: boolean; postingEnabled: boolean; kinds: Kind[] };

const mb = (b: number) => `${(b / 1048576).toFixed(2)} MB`;

export function ChannelBannerManager() {
  const [data, setData] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/channel-banners", { cache: "no-store" });
      if (!r.ok) return;
      setData(await r.json());
    } catch {
      /* stays loading */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const upload = async (kind: string, type: "artwork" | "clip", file: File) => {
    setBusy(`${kind}:${type}`);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("type", type);
      fd.append("file", file);
      const r = await fetch("/api/admin/channel-banners", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.error || "Upload failed");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: string, type: "artwork" | "clip") => {
    setBusy(`${kind}:${type}`);
    setErr("");
    try {
      await fetch(`/api/admin/channel-banners?kind=${kind}&type=${type}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const togglePosting = async () => {
    if (!data) return;
    setBusy("posting");
    try {
      await fetch("/api/admin/channel-banners", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingEnabled: !data.postingEnabled }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggleText = async (kind: string, on: boolean) => {
    setBusy(`${kind}:text`);
    try {
      await fetch("/api/admin/channel-banners", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, textOverlay: on }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="asec">
      <div className="asec-h">
        Channel post banners
        {data && (
          <span className={`cnt ${data.postingEnabled ? "" : "pend"}`}>
            {data.postingEnabled ? "posting ON" : "posting OFF"}
          </span>
        )}
      </div>
      <div className="asec-body">
        <div className="a-chain" style={{ marginBottom: 10 }}>
          Artwork &amp; GIF/video the bot composites onto every Listing / Trending / Pump / Rank-up post. Uploads apply on
          the next post — no restart. This shows the <b>raw</b> upload; the exact composite (logo, $ticker, price drawn on)
          renders in <b>@dexvraadminbot</b>.
        </div>

        {data && !data.writable && (
          <div className="login-err" style={{ textAlign: "left", marginBottom: 10 }}>
            ⚠️ The banner folder isn&apos;t writable from the website: <code>{data.dir}</code>. Set{" "}
            <code>BANNER_TEMPLATE_DIR</code> on the web app to the bot&apos;s data dir (the same path the bot&apos;s
            <code> BOT_DATA_DIR</code> resolves to).
          </div>
        )}

        {data && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <button className={`abtn ${data.postingEnabled ? "ok" : "bad"}`} disabled={busy === "posting"} onClick={togglePosting}>
              {data.postingEnabled ? "🟢 Banner posts: ON" : "🔴 Banner posts: OFF"} — tap to toggle
            </button>
            <span className="a-chain" style={{ fontSize: 11 }}>
              Folder: <code>{data.dir}</code> {data.writable ? "· writable ✓" : ""}
            </span>
          </div>
        )}

        {err && <div className="login-err" style={{ textAlign: "left", marginBottom: 10 }}>{err}</div>}

        {data == null ? (
          <div className="a-chain">Loading…</div>
        ) : (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {data.kinds.map((k) => (
              <KindCard key={k.kind} k={k} busy={busy} onUpload={upload} onRemove={remove} onToggleText={toggleText} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function KindCard({
  k,
  busy,
  onUpload,
  onRemove,
  onToggleText,
}: {
  k: Kind;
  busy: string | null;
  onUpload: (kind: string, type: "artwork" | "clip", file: File) => void;
  onRemove: (kind: string, type: "artwork" | "clip") => void;
  onToggleText: (kind: string, on: boolean) => void;
}) {
  const artRef = useRef<HTMLInputElement>(null);
  const clipRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const fileUrl = (type: "artwork" | "clip", v: number) =>
    `/api/admin/channel-banners/file?kind=${k.kind}&type=${type}&v=${v}`;
  const backdrop = k.clip
    ? { url: fileUrl("clip", k.clip.mtime), kind: k.clip.preview }
    : k.hasArtwork && k.artworkMtime
      ? { url: fileUrl("artwork", k.artworkMtime), kind: "image" as const }
      : null;

  return (
    <div style={{ border: "1px solid rgba(255,255,255,.1)", borderRadius: 12, padding: 12, background: "rgba(255,255,255,.02)" }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{k.label}</div>
      <div className="a-chain" style={{ fontSize: 11, marginBottom: 10 }}>{k.note}</div>

      {/* Clip (all kinds) */}
      <div style={{ marginBottom: k.artworkable ? 12 : 0 }}>
        <div className="a-chain" style={{ fontSize: 11, marginBottom: 6, fontWeight: 700 }}>🎞 GIF / Video clip {k.clip ? "· set (overrides still)" : "· none"}</div>
        {k.clip && (
          <div style={{ marginBottom: 6 }}>
            {k.clip.preview === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl("clip", k.clip.mtime)} alt="" style={{ width: "100%", borderRadius: 8, border: "1px solid rgba(255,255,255,.1)" }} />
            ) : (
              <video src={fileUrl("clip", k.clip.mtime)} autoPlay loop muted playsInline style={{ width: "100%", borderRadius: 8, border: "1px solid rgba(255,255,255,.1)" }} />
            )}
            <div className="a-chain" style={{ fontSize: 10, marginTop: 3 }}>{k.clip.type} · .{k.clip.ext} · {mb(k.clip.bytes)}</div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <label className="abtn" style={{ cursor: "pointer" }}>
            {busy === `${k.kind}:clip` ? "…" : k.clip ? "Replace clip" : "⬆ Upload clip"}
            <input
              ref={clipRef}
              type="file"
              accept=".gif,.mp4,.webm,.mov,image/gif,video/mp4,video/webm,video/quicktime"
              hidden
              disabled={busy === `${k.kind}:clip`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onUpload(k.kind, "clip", f);
              }}
            />
          </label>
          {k.clip && (
            <button className="abtn bad" disabled={busy === `${k.kind}:clip`} onClick={() => onRemove(k.kind, "clip")}>
              🗑 Remove
            </button>
          )}
        </div>
        {k.fillable && (
          <button
            className={`abtn ${k.textOverlay ? "" : "ok"}`}
            style={{ marginTop: 8, width: "100%" }}
            disabled={busy === `${k.kind}:text`}
            onClick={() => onToggleText(k.kind, !k.textOverlay)}
          >
            {k.textOverlay ? "🔤 Auto-text: ON — tap to hide (fixes overlap)" : "🔤 Auto-text: OFF — logo only"}
          </button>
        )}
      </div>

      {/* Still artwork (listing / trending / banner) */}
      {k.artworkable && (
        <div>
          <div className="a-chain" style={{ fontSize: 11, marginBottom: 6, fontWeight: 700 }}>🖼 Still artwork {k.hasArtwork ? "· custom" : "· bundled default"}</div>
          {k.hasArtwork && k.artworkMtime && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl("artwork", k.artworkMtime)} alt="" style={{ width: "100%", borderRadius: 8, border: "1px solid rgba(255,255,255,.1)", marginBottom: 6 }} />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <label className="abtn" style={{ cursor: "pointer" }}>
              {busy === `${k.kind}:artwork` ? "…" : k.hasArtwork ? "Replace artwork" : "⬆ Upload artwork"}
              <input
                ref={artRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                disabled={busy === `${k.kind}:artwork`}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onUpload(k.kind, "artwork", f);
                }}
              />
            </label>
            {k.hasArtwork && (
              <button className="abtn bad" disabled={busy === `${k.kind}:artwork`} onClick={() => onRemove(k.kind, "artwork")}>
                🗑 Remove
              </button>
            )}
          </div>
        </div>
      )}

      {/* Visual position editor (listing/trending) — drag logo/text on the template */}
      {k.fillable && k.textOverlay && (
        <div style={{ marginTop: 12 }}>
          <button className="abtn" style={{ width: "100%" }} onClick={() => setEditing((v) => !v)}>
            {editing ? "▲ Close position editor" : "🎛 Position editor — drag logo · $ticker · chips"}
          </button>
          {editing && <LayoutEditor kind={k.kind} layout={k.layout} backdrop={backdrop} onSaved={() => {}} />}
        </div>
      )}
    </div>
  );
}
