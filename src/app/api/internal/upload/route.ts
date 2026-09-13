import { NextRequest, NextResponse } from "next/server";
import { isUploadFile } from "@/lib/upload";
import { MEDIA_MAX_BYTES, saveMedia } from "@/lib/mediaStore";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/upload  (multipart: field "file")
// Bot-side logo/creative upload. The sniff, the bound and the write live in
// lib/mediaStore — one owner, shared with the admin upload and the logo pin.
// Returns { url: "/api/media/<24hex>.<ext>" }, which passes the LOGO_RE gate.
const MAX = MEDIA_MAX_BYTES;


export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();

  const len = Number(req.headers.get("content-length") || 0);
  if (len && len > MAX + 4096) {
    return NextResponse.json({ error: "File too large (max 3 MB)" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!isUploadFile(file)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ error: "File too large (max 3 MB)" }, { status: 413 });

  const saved = await saveMedia(new Uint8Array(await file.arrayBuffer()));
  if (!saved) return NextResponse.json({ error: "Only PNG, JPG, WEBP, or GIF images" }, { status: 415 });

  return NextResponse.json({ url: saved.url });
}
