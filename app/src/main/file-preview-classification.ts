/**
 * Pure file-preview classification, split out from files-handler.ts so it can
 * be unit-tested without dragging in the latter's top-level `electron` import.
 * The root vitest run installs only root deps (no app/node_modules), so a test
 * that transitively imports `electron` fails to even resolve at transform time
 * -- which is exactly what broke the publish-npm prepublishOnly gate. Keeping
 * this module dependency-free (no electron, no node-only APIs) keeps it cheap
 * to test from anywhere.
 */

// Mirrors the renderer's TEXT_EXTS in file-viewer.ts -- the head-preview
// path only makes sense for files the renderer would draw as text. Returning
// 64 KB of head bytes for an image / pdf / binary would just produce a
// broken <img> or corrupted pdf in the renderer, with no useful signal to
// the user. Files outside this set in the (5 MB, 1 GB] band get the same
// "too large" rejection they got before head-preview existed.
const TEXT_PREVIEW_EXTS = new Set([
  ".md",
  ".txt",
  ".log",
  ".rst",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".rb",
  ".pl",
  ".r",
  ".go",
  ".rs",
  ".json",
  ".jsonl",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".csv",
  ".tsv",
  ".tab",
  ".tabular",
  ".fa",
  ".fasta",
  ".fna",
  ".faa",
  ".ffn",
  ".fastq",
  ".fq",
  ".fastqsanger",
  ".fastqillumina",
  ".fastqsolexa",
  ".fastqcssanger",
  ".vcf",
  ".bed",
  ".interval",
  ".bedgraph",
  ".wig",
  ".gff",
  ".gff3",
  ".gtf",
  ".sam",
  ".pdb",
  ".cif",
  ".nwk",
  ".newick",
  ".tree",
  ".phy",
  ".phylip",
]);

export function isTextLikeForPreview(name: string): boolean {
  const dot = name.lastIndexOf(".");
  // No extension -- the renderer treats these as text (READMEs, configs).
  if (dot <= 0) return true;
  return TEXT_PREVIEW_EXTS.has(name.slice(dot).toLowerCase());
}
