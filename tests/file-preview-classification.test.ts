// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";

import { kindOf } from "../app/src/renderer/files/file-viewer.js";
import { isTextLikeForPreview } from "../app/src/main/file-preview-classification.js";

// Regression coverage for #269: Galaxy downloads tabular datasets as *.tabular,
// but the file viewer's text-extension allowlist only knew .tsv/.csv/.tab, so
// .tabular fell through to "Cannot preview -- binary file". These extensions are
// all plain text and Galaxy-common; both the renderer classifier (kindOf, which
// drives the binary placeholder) and the main-process head-preview gate
// (isTextLikeForPreview) must treat them as text.
const GALAXY_TEXT_EXTS = [
  ".tabular",
  ".interval",
  ".fastqsanger",
  ".fastqillumina",
  ".fastqsolexa",
  ".fastqcssanger",
];

describe("kindOf (renderer file viewer)", () => {
  it.each(GALAXY_TEXT_EXTS)("classifies %s as text", (ext) => {
    expect(kindOf(`data${ext}`)).toBe("text");
  });

  it("is case-insensitive about the extension", () => {
    expect(kindOf("DATA.TABULAR")).toBe("text");
  });

  it("still classifies the pre-existing tabular extensions as text", () => {
    expect(kindOf("a.tsv")).toBe("text");
    expect(kindOf("a.csv")).toBe("text");
    expect(kindOf("a.tab")).toBe("text");
  });

  it("keeps real binaries out of the text path", () => {
    expect(kindOf("reads.bam")).toBe("binary");
    expect(kindOf("index.bai")).toBe("binary");
    expect(kindOf("archive.gz")).toBe("binary");
    expect(kindOf("photo.png")).toBe("image");
    expect(kindOf("doc.pdf")).toBe("pdf");
  });

  it("keeps the gzipped Galaxy variant binary -- only the last extension counts", () => {
    // .fastqsanger is text now, but the compressed datatype is a distinct
    // (.gz) extension and must stay binary.
    expect(kindOf("reads.fastqsanger.gz")).toBe("binary");
  });
});

describe("isTextLikeForPreview (main-process head-preview gate)", () => {
  it.each(GALAXY_TEXT_EXTS)("treats %s as text-like", (ext) => {
    expect(isTextLikeForPreview(`data${ext}`)).toBe(true);
  });

  it("is case-insensitive about the extension", () => {
    expect(isTextLikeForPreview("DATA.TABULAR")).toBe(true);
  });

  it("keeps real binaries out of the head-preview path", () => {
    expect(isTextLikeForPreview("reads.bam")).toBe(false);
    expect(isTextLikeForPreview("archive.gz")).toBe(false);
    expect(isTextLikeForPreview("photo.png")).toBe(false);
  });

  it("keeps the gzipped Galaxy variant binary -- only the last extension counts", () => {
    expect(isTextLikeForPreview("reads.fastqsanger.gz")).toBe(false);
  });
});
