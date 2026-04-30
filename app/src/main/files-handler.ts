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
const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MB — protect the renderer from huge files

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

async function walkDir(
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
    if (e.isDirectory()) {
      out.push({
        name: e.name,
        relPath: childRel,
        type: "directory",
        children: await walkDir(cwd, childRel, includeHidden, depth + 1),
      });
    } else if (e.isFile()) {
      let size: number | undefined;
      try {
        const stat = await fsp.stat(path.join(absDir, e.name));
        size = stat.size;
      } catch {
        size = undefined;
      }
      out.push({ name: e.name, relPath: childRel, type: "file", size });
    }
    // Symlinks / sockets / etc. are ignored.
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

  ipcMain.handle("files:read", async (_e, relPath: string) => {
    const cwd = getCwd();
    try {
      const abs = resolveWithin(cwd, relPath);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return { ok: false, error: "Not a regular file" };
      if (stat.size > MAX_READ_BYTES) {
        return {
          ok: false,
          error: `File too large (${stat.size} bytes, limit ${MAX_READ_BYTES})`,
          size: stat.size,
        };
      }
      const buf = await fsp.readFile(abs);
      return { ok: true, size: stat.size, bytes: buf };
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
