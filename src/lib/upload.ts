// Multipart file guard for the upload routes.
//
// WHY THIS IS NOT `instanceof File`
// `File` only became a Node GLOBAL in Node 20. On Node 18 — which is what the
// production VPS runs (v18.19.1) — the identifier does not exist at all, so
// `file instanceof File` does not evaluate to false: it throws
// `ReferenceError: File is not defined`, and the route 500s before it can
// reject anything. Every upload path was affected: the admin logo uploader,
// the channel-banner uploader, and `/api/internal/upload`, which is how the
// listing bot pushes a token's logo to the site. In the App Router a route
// handler throwing surfaces with `NextNodeServer.renderToResponseImpl` in the
// stack, which is why this read as a page-render fault in the logs rather than
// as an upload bug.
//
// Duck-typing the shape we actually consume fixes it on every runtime and, as a
// bonus, accepts undici's own File implementation — which is what `req.formData()`
// really hands back on Node 18 regardless of whether the global exists.
//
// The alternative (require Node >= 20) is the better long-term answer and
// `package.json` now declares it, but a version bump on a box that also runs the
// custodial trade bot is not something a page render should depend on.

/** The subset of the web File API the upload routes actually use. */
export interface UploadFile {
  size: number;
  type: string;
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * True when `v` is a multipart file entry rather than a plain form field.
 *
 * `FormData.get()` returns a string for ordinary fields, so the `arrayBuffer`
 * check is what separates the two — a string has no such method. `size` is
 * checked as a finite number because it gates the max-size limit immediately
 * after; a NaN there would compare false against every bound and let an
 * unbounded body through.
 */
export function isUploadFile(v: unknown): v is UploadFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<UploadFile>;
  return typeof f.arrayBuffer === "function" && typeof f.size === "number" && Number.isFinite(f.size);
}
