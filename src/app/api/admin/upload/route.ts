import { NextRequest, NextResponse } from "next/server";
import { isUploadFile } from "@/lib/upload";
import { MEDIA_MAX_BYTES, saveMedia } from "@/lib/mediaStore";
import { isAdmin, unauthorized } from "@/lib/adminGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = MEDIA_MAX_BYTES;
// Stored under data/ (gitignored, writable, survives restarts) and served by
// the /api/media/[name] route — next start does not serve files written to
// public/ after the build.


export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();

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
