/**
 * Image-preview helpers, kept free of any DOM/Electron imports so they can be
 * unit-tested in a plain Node environment.
 *
 * The one rule that matters here: a preview Blob must always carry the correct
 * MIME type. Chromium will content-sniff raster formats (PNG/JPEG/GIF/WebP) out
 * of a typeless blob: URL, but it refuses to sniff SVG — an <img> pointed at a
 * typeless blob of SVG bytes silently fails to load and shows the broken-image
 * icon. The first render and every on-disk reload must go through the same
 * builder so neither path can drift back to a typeless blob. (#188)
 */

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  // Handle .gz / .bz2 / .xz / .zst suffixes — strip and look at the inner ext.
  // (Useful for things like sample.vcf.gz that should still be recognized as
  // text in spirit; we treat the compressed version as binary because we
  // can't decompress in the renderer, but exposing the inner ext is harmless.)
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function mimeForImage(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * Build an object-URL-ready Blob for an image preview, tagged with the MIME
 * type implied by `path`'s extension. Copies into a fresh ArrayBuffer so the
 * Blob owns its bytes (the caller may hand us a Uint8Array that is a view into
 * a larger buffer) and to satisfy Blob's BlobPart typing.
 */
export function imagePreviewBlob(path: string, bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: mimeForImage(extOf(path)) });
}
