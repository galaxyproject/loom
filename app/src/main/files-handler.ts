/**
 * Files sidebar — main-process IPC and file watcher.
 *
 * Exposes three IPC handles (`files:list`, `files:read`, `files:write`) plus
 * a per-cwd fs watcher that pushes `files:changed` to the renderer. Every
 * path is clamped to the active cwd so a compromised renderer cannot read
 * or write anywhere else on disk.
 */

import { ipcMain, BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface FileNode {
  name: string;
  relPath: string; // always "" for root, otherwise relative to cwd with forward slashes
  type: "file" | "directory";
  size?: number; // files only
  children?: FileNode[]; // directories only
}

const FS_BLOCKLIST = new Set([
  "node_modules",
  ".git",
  ".loom",
  ".orbit",
  ".vite",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".DS_Store",
]);

const MAX_DEPTH = 8;
const MAX_ENTRIES_PER_DIR = 2000; // refuse to enumerate pathological dirs
const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MB — full read up to here
const MAX_PREVIEW_BYTES = 1024 * 1024 * 1024; // 1 GB — hard refuse above this
const PREVIEW_LINE_COUNT = 10;
const PREVIEW_BYTE_BUDGET = 64 * 1024; // 64 KB cap on the head we read

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

/**
 * Clamp a user-supplied path to the current cwd. Throws if it escapes.
 * Returns the absolute, normalized path.
 *
 * Exported because file:open in ipc-handlers.ts uses the same security
 * boundary — the renderer must never be able to ask main to open a file
 * outside the current analysis cwd.
 */
export function resolveWithin(cwd: string, relPath: string): string {
  const normalized = path.normalize(relPath || "");
  const abs = path.resolve(cwd, normalized);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes working directory: ${relPath}`);
  }
  return abs;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// Whether p's real path stays inside cwd. Used to decide if a symlinked
// directory is safe to descend into -- mirrors the file-protocol guard in
// main.ts so symlinks can't expose content outside the working directory.
async function isWithinCwd(cwd: string, p: string): Promise<boolean> {
  try {
    const cwdReal = await fsp.realpath(cwd);
    const pReal = await fsp.realpath(p);
    return pReal === cwdReal || pReal.startsWith(cwdReal + path.sep);
  } catch {
    return false;
  }
}

export async function walkDir(
  cwd: string,
  relDir: string,
  includeHidden: boolean,
  depth: number,
): Promise<FileNode[]> {
  if (depth > MAX_DEPTH) return [];
  const absDir = resolveWithin(cwd, relDir);

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.length > MAX_ENTRIES_PER_DIR) {
    entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
  }

  const out: FileNode[] = [];
  for (const e of entries) {
    if (!includeHidden && FS_BLOCKLIST.has(e.name)) continue;
    if (!includeHidden && e.name.startsWith(".") && e.name !== "notebook.md") continue;

    const childRel = toPosix(path.join(relDir, e.name));
    const absPath = path.join(absDir, e.name);

    // Resolve symlinks to their target type so linked files/dirs still appear.
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    let recurse = isDir; // real directories always descend
    if (e.isSymbolicLink()) {
      try {
        const target = await fsp.stat(absPath);
        isDir = target.isDirectory();
        isFile = target.isFile();
        // Only descend into a linked directory whose real path stays inside
        // cwd, so a symlink can't expose content outside the working directory.
        recurse = isDir && (await isWithinCwd(cwd, absPath));
      } catch {
        // Broken symlink -- surface it as a file so it stays visible.
        isDir = false;
        isFile = true;
      }
    }

    if (isDir) {
      out.push({
        name: e.name,
        relPath: childRel,
        type: "directory",
        children: recurse ? await walkDir(cwd, childRel, includeHidden, depth + 1) : [],
      });
    } else if (isFile) {
      let size: number | undefined;
      try {
        const stat = await fsp.stat(absPath);
        size = stat.size;
      } catch {
        size = undefined;
      }
      out.push({ name: e.name, relPath: childRel, type: "file", size });
    }
    // Sockets / fifos / etc. are still ignored.
  }

  // Directories first, then files; alphabetical within each group.
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

// --- watcher ------------------------------------------------------------

let watcher: fs.FSWatcher | null = null;
let watchedCwd: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

function emitChange(window: BrowserWindow | null): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (window && !window.isDestroyed()) {
      window.webContents.send("files:changed");
    }
  }, 200);
}

export function startFilesWatcher(window: BrowserWindow, cwd: string): void {
  stopFilesWatcher();
  try {
    watcher = fs.watch(cwd, { recursive: true, persistent: false }, (_event, filename) => {
      // Ignore changes inside the blocklisted directories. `filename` is a
      // relative path on Linux/Mac and (sometimes) a basename on Windows.
      if (filename) {
        const firstSegment = String(filename).split(/[\\/]/)[0];
        if (FS_BLOCKLIST.has(firstSegment)) return;
      }
      emitChange(window);
    });
    watcher.on("error", (err) => {
      console.warn("[files] watcher error:", err.message);
    });
    watchedCwd = cwd;
  } catch (err) {
    // Recursive watch may not be supported on older Node / some filesystems.
    // Fall back to no watcher — the tree still works, just without live updates.
    console.warn("[files] watcher unavailable:", err instanceof Error ? err.message : err);
    watcher = null;
    watchedCwd = null;
  }
}

export function stopFilesWatcher(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }
  watchedCwd = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// --- IPC registration ---------------------------------------------------

export function registerFilesIpc(getCwd: () => string): void {
  ipcMain.handle("files:list", async (_e, opts?: { includeHidden?: boolean }) => {
    const cwd = getCwd();
    try {
      const children = await walkDir(cwd, "", opts?.includeHidden ?? false, 0);
      const root: FileNode = {
        name: path.basename(cwd) || cwd,
        relPath: "",
        type: "directory",
        children,
      };
      return { ok: true, root, cwd };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("files:read", async (_e, relPath: string, opts?: { tail?: boolean }) => {
    const cwd = getCwd();
    try {
      const abs = resolveWithin(cwd, relPath);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return { ok: false, error: "Not a regular file" };

      // Tail preview requested: bypass full read and read from the end.
      //
      // Known beta limitation: a single physical line longer than the budget
      // (activity.jsonl persists uncapped user-prompt text and tool args -- only
      // result summaries are capped at the source) can't be recovered whole. When
      // the newest line exceeds the budget we drop it as a partial first line, so
      // that event is omitted from the preview rather than shipped truncated. The
      // feedback tail degrades gracefully (missing event, never corrupt bytes); a
      // real fix is a source-side cap in activity-hooks, tracked separately.
      if (opts?.tail) {
        const readSize = Math.min(stat.size, PREVIEW_BYTE_BUDGET);
        const offset = stat.size - readSize;
        const fd = await fsp.open(abs, "r");
        try {
          const tailBuf = Buffer.alloc(readSize);
          const { bytesRead } = await fd.read(tailBuf, 0, readSize, offset);
          const tail = tailBuf.subarray(0, bytesRead).toString("utf-8");
          const lines = tail.split("\n");
          // A non-zero offset means we started mid-file, so the first element is a
          // partial line (or a multibyte boundary fragment) -- drop it.
          if (offset > 0 && lines.length > 1) {
            lines.shift();
          }
          return {
            ok: true,
            size: stat.size,
            // No preview metadata on the tail path: the only caller (the feedback
            // payload builder) reads bytes + size and ignores it.
            bytes: Buffer.from(lines.slice(-200).join("\n"), "utf-8"),
          };
        } finally {
          await fd.close();
        }
      }

      // Full read up to MAX_READ_BYTES.
      if (stat.size <= MAX_READ_BYTES) {
        const buf = await fsp.readFile(abs);
        return { ok: true, size: stat.size, bytes: buf };
      }

      // Hard refuse pathological sizes (>1 GB) — even a head preview
      // shouldn't justify opening it.
      if (stat.size > MAX_PREVIEW_BYTES) {
        return {
          ok: false,
          error: `File too large (${stat.size} bytes, hard limit ${MAX_PREVIEW_BYTES})`,
          size: stat.size,
        };
      }

      // Head preview only makes sense for text-like files. For images /
      // pdfs / binaries in the (5 MB, 1 GB] band, fall back to the
      // pre-existing "too large" rejection so the renderer surfaces a
      // clear error instead of trying to draw 64 KB of mangled bytes.
      if (!isTextLikeForPreview(path.basename(abs))) {
        return {
          ok: false,
          error: `File too large (${stat.size} bytes, limit ${MAX_READ_BYTES})`,
          size: stat.size,
        };
      }

      // Head preview: read at most PREVIEW_BYTE_BUDGET bytes from the
      // start, slice to the first PREVIEW_LINE_COUNT newlines. Single
      // very-long lines (uncompressed VCF data, packed JSON) get
      // truncated at the byte cap with a marker.
      const fd = await fsp.open(abs, "r");
      try {
        const headBuf = Buffer.alloc(PREVIEW_BYTE_BUDGET);
        const { bytesRead } = await fd.read(headBuf, 0, PREVIEW_BYTE_BUDGET, 0);
        const head = headBuf.subarray(0, bytesRead).toString("utf-8");
        const lines = head.split("\n").slice(0, PREVIEW_LINE_COUNT);
        const previewText = lines.join("\n");
        const truncatedAtByteBudget =
          bytesRead === PREVIEW_BYTE_BUDGET && lines.length < PREVIEW_LINE_COUNT;
        return {
          ok: true,
          size: stat.size,
          bytes: Buffer.from(previewText, "utf-8"),
          preview: {
            kind: "head" as const,
            lineCount: lines.length,
            byteBudgetHit: truncatedAtByteBudget,
          },
        };
      } finally {
        await fd.close();
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("files:write", async (_e, relPath: string, content: string) => {
    const cwd = getCwd();
    try {
      const abs = resolveWithin(cwd, relPath);
      await fsp.writeFile(abs, content, "utf8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
