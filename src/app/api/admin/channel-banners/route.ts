// Admin management of the Telegram bot's CHANNEL-POST banner templates (still
// artwork + GIF/video clips per kind). Writes into the bot's shared data dir;
// the bot picks changes up on its next post. Auth: same cookie guard as the
// rest of the panel (plus the middleware gate on /api/admin/*).
import { NextRequest, NextResponse } from "next/server";
import { isUploadFile } from "@/lib/upload";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import {
  CHANNEL_KINDS,
  ARTWORK_KINDS,
  statusAll,
  saveArtwork,
  saveClip,
  removeArtwork,
  removeClip,
  setPostingEnabled,
  setTextOverlay,
  setLayout,
  type ChannelKind,
} from "@/lib/channelBanners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB ceiling (Telegram bot fetch limit is ~20 MB)
const isKind = (k: string): k is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(k);
const extOf = (name: string): string => {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
};

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  return NextResponse.json(statusAll());
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload" }, { status: 400 });
  }
  const kind = String(form.get("kind") || "");
  const type = String(form.get("type") || ""); // "artwork" | "clip"
  const file = form.get("file");
  if (!isKind(kind)) return NextResponse.json({ error: "Unknown banner kind" }, { status: 400 });
  if (type !== "artwork" && type !== "clip") return NextResponse.json({ error: "type must be artwork or clip" }, { status: 400 });
  if (type === "artwork" && !ARTWORK_KINDS.has(kind)) {
    return NextResponse.json({ error: `${kind} has no still-artwork slot (clip only)` }, { status: 400 });
  }
  if (!isUploadFile(file)) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "The uploaded file is empty" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `File too large (max ${MAX_BYTES / 1048576} MB)` }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    if (type === "artwork") {
      await saveArtwork(kind, buf);
      return NextResponse.json({ ok: true, kind, type, bytes: buf.length });
    }
    // clip — derive the extension from the filename, else the mime type, else mp4
    let ext = extOf(file.name);
    if (!["gif", "mp4", "webm", "mov"].includes(ext)) {
      const t = (file.type || "").toLowerCase();
      ext = t.includes("gif") ? "gif" : t.includes("webm") ? "webm" : t.includes("quicktime") ? "mov" : "mp4";
    }
    const saved = await saveClip(kind, buf, ext);
    return NextResponse.json({ ok: true, kind, ...saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Save failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const kind = req.nextUrl.searchParams.get("kind") || "";
  const type = req.nextUrl.searchParams.get("type") || "";
  if (!isKind(kind)) return NextResponse.json({ error: "Unknown banner kind" }, { status: 400 });
  if (type === "artwork") await removeArtwork(kind);
  else if (type === "clip") await removeClip(kind);
  else return NextResponse.json({ error: "type must be artwork or clip" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const body = await req.json().catch(() => ({}));
  // Per-kind layout save: { kind, layout: {...positions} }
  if (isKind(String(body.kind || "")) && body.layout && typeof body.layout === "object") {
    const layout = await setLayout(String(body.kind), body.layout);
    return NextResponse.json({ ok: true, kind: body.kind, layout });
  }
  // Per-kind text-overlay toggle: { kind, textOverlay: boolean }
  if (isKind(String(body.kind || "")) && typeof body.textOverlay === "boolean") {
    const on = await setTextOverlay(String(body.kind), body.textOverlay);
    return NextResponse.json({ ok: true, kind: body.kind, textOverlay: on });
  }
  // Global posting toggle: { postingEnabled: boolean }
  if (typeof body.postingEnabled === "boolean") {
    const on = await setPostingEnabled(body.postingEnabled);
    return NextResponse.json({ ok: true, postingEnabled: on });
  }
  return NextResponse.json({ error: "nothing to update" }, { status: 400 });
}
