import { describe, it, expect } from "vitest";
import { extOf, mimeForImage, imagePreviewBlob } from "../app/src/renderer/files/image-preview.js";

// Regression coverage for #188: SVG previews paint once, then turn into a
// broken-image icon. The first render tagged the blob image/svg+xml, but the
// on-disk reload path rebuilt a *typeless* blob. Chromium content-sniffs raster
// formats out of a typeless blob: URL, but it will NOT sniff SVG — an <img>
// pointed at a typeless blob of SVG bytes fails to load. The fix routes both the
// initial render and the reload through imagePreviewBlob, so the MIME type is
// always present. These tests pin that invariant on the shared builder.

const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);

describe("extOf", () => {
  it("lower-cases the extension and is case-insensitive", () => {
    expect(extOf("chart.SVG")).toBe(".svg");
    expect(extOf("a/b/photo.JPG")).toBe(".jpg");
  });
});

describe("mimeForImage", () => {
  it("maps SVG to image/svg+xml", () => {
    expect(mimeForImage(".svg")).toBe("image/svg+xml");
  });

  it("maps the raster formats", () => {
    expect(mimeForImage(".png")).toBe("image/png");
    expect(mimeForImage(".jpg")).toBe("image/jpeg");
    expect(mimeForImage(".jpeg")).toBe("image/jpeg");
    expect(mimeForImage(".gif")).toBe("image/gif");
    expect(mimeForImage(".webp")).toBe("image/webp");
  });
});

describe("imagePreviewBlob", () => {
  it("tags an SVG blob with image/svg+xml so <img> can load it (#188)", () => {
    const blob = imagePreviewBlob("figure.svg", SVG_BYTES);
    expect(blob.type).toBe("image/svg+xml");
  });

  it("is case-insensitive about the extension", () => {
    expect(imagePreviewBlob("Figure.SVG", SVG_BYTES).type).toBe("image/svg+xml");
  });

  it("tags raster previews with their own type", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(imagePreviewBlob("a.png", bytes).type).toBe("image/png");
    expect(imagePreviewBlob("a.jpg", bytes).type).toBe("image/jpeg");
  });

  it("preserves the exact bytes", async () => {
    const blob = imagePreviewBlob("figure.svg", SVG_BYTES);
    expect(blob.size).toBe(SVG_BYTES.byteLength);
    const roundTrip = new Uint8Array(await blob.arrayBuffer());
    expect(roundTrip).toEqual(SVG_BYTES);
  });

  it("copies the bytes into a standalone buffer (no shared view aliasing)", () => {
    // reloadImage hands us a Uint8Array that may be a view into a larger
    // buffer; the blob must own an independent copy.
    const backing = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);
    const view = backing.subarray(2, 5); // [1,2,3]
    const blob = imagePreviewBlob("a.png", view);
    expect(blob.size).toBe(3);
  });
});
