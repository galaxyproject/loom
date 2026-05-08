/**
 * FileViewer — reads/edits files opened from the FilesPanel.
 *
 * Text files get an editor + optional markdown preview. Images render inline.
 * Binary files show a "cannot preview" placeholder. Save is gated on the
 * file being text and dirty.
 */

import { renderMarkdown } from "../chat/markdown.js";

type FileKind = "text" | "image" | "pdf" | "binary";

const TEXT_EXTS = new Set([
  // generic
  ".md",
  ".txt",
  ".log",
  ".rst",
  // code / config
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
  // tabular
  ".csv",
  ".tsv",
  ".tab",
  // bioinformatics text formats
  ".fa",
  ".fasta",
  ".fna",
  ".faa",
  ".ffn",
  ".fastq",
  ".fq",
  ".vcf",
  ".bed",
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

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

const PDF_EXTS = new Set([".pdf"]);

function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  // Handle .gz / .bz2 / .xz / .zst suffixes — strip and look at the inner ext.
  // (Useful for things like sample.vcf.gz that should still be recognized as
  // text in spirit; we treat the compressed version as binary because we
  // can't decompress in the renderer, but exposing the inner ext is harmless.)
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function kindOf(path: string): FileKind {
  const ext = extOf(path);
  if (!ext) return "text"; // no extension → treat as text
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (PDF_EXTS.has(ext)) return "pdf";
  return "binary";
}

function mimeForImage(ext: string): string {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export class FileViewer {
  private readonly container: HTMLElement;
  private currentPath: string | null = null;
  private currentKind: FileKind | null = null;
  private dirty = false;
  private editor: HTMLTextAreaElement | null = null;
  private preview: HTMLDivElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private editBtn: HTMLButtonElement | null = null;
  private previewBtn: HTMLButtonElement | null = null;
  private currentImageUrl: string | null = null;
  private currentPdfUrl: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getCurrentPath(): string | null {
    return this.currentPath;
  }

  /**
   * Replace the container with a viewer for `relPath`. Returns true if the
   * open went ahead, false if the user cancelled due to unsaved changes.
   *
   * `preview` is set when bytes is a head-only excerpt of a file too large
   * for full read; the text view renders read-only with a banner explaining
   * the truncation (#58).
   */
  open(
    relPath: string,
    bytes: Uint8Array,
    size: number,
    preview?: { kind: "head"; lineCount: number; byteBudgetHit: boolean },
  ): boolean {
    if (this.dirty && this.currentPath && this.currentPath !== relPath) {
      const ok = window.confirm(`Discard unsaved changes in ${this.currentPath}?`);
      if (!ok) return false;
    }
    this.teardownImage();
    this.container.innerHTML = "";
    this.currentPath = relPath;
    this.currentKind = kindOf(relPath);
    this.dirty = false;
    this.editor = null;
    this.preview = null;
    this.saveBtn = null;
    this.statusEl = null;
    this.editBtn = null;
    this.previewBtn = null;

    const root = document.createElement("div");
    root.className = "file-viewer-root";

    if (this.currentKind === "text") {
      this.renderText(root, relPath, bytes, preview, size);
    } else if (this.currentKind === "image") {
      this.renderImage(root, relPath, bytes, size);
    } else if (this.currentKind === "pdf") {
      this.renderPdf(root, relPath, bytes, size);
    } else {
      this.renderBinary(root, relPath, size);
    }

    this.container.appendChild(root);
    return true;
  }

  /**
   * Check whether the currently-open file has changed on disk, and update
   * the viewer if so. Safe to call on every files:changed event — no-ops
   * when there is no file open or the bytes are unchanged.
   *
   * - Text, clean: silent reload. Preserves scroll position and caret.
   * - Text, dirty: shows a non-destructive "file changed on disk" banner
   *   with Reload / Keep buttons so unsaved edits are never clobbered.
   * - Image: reloads the `<img>` source.
   * - Binary: no-op (nothing useful to refresh).
   */
  async refreshFromDisk(): Promise<void> {
    if (!this.currentPath || !this.currentKind) return;
    let res;
    try {
      res = await window.orbit.readFile(this.currentPath);
    } catch {
      return;
    }
    if (!res.ok) return;

    if (this.currentKind === "text") {
      if (!this.editor) return;
      const newText = new TextDecoder("utf-8").decode(res.bytes);
      if (this.editor.value === newText) return;
      if (this.dirty) {
        this.showStaleBanner(newText);
      } else {
        const scrollTop = this.editor.scrollTop;
        const selStart = this.editor.selectionStart;
        const selEnd = this.editor.selectionEnd;
        this.editor.value = newText;
        this.editor.scrollTop = scrollTop;
        const cap = newText.length;
        this.editor.setSelectionRange(Math.min(selStart, cap), Math.min(selEnd, cap));
        // Re-render markdown preview if it's the currently visible pane.
        if (this.preview && !this.preview.classList.contains("hidden")) {
          this.preview.innerHTML = renderMarkdown(newText);
        }
      }
    } else if (this.currentKind === "image") {
      this.reloadImage(res.bytes);
    }
  }

  private showStaleBanner(newText: string): void {
    // Replace any existing banner (subsequent external writes before the
    // user acts on the first one should just update the pending content).
    const existing = this.container.querySelector(".file-viewer-stale-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.className = "file-viewer-stale-banner";

    const msg = document.createElement("span");
    msg.textContent = "This file changed on disk. Your unsaved edits are preserved.";
    banner.appendChild(msg);

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "file-viewer-btn";
    reloadBtn.textContent = "Reload (discard my edits)";
    reloadBtn.addEventListener("click", () => {
      if (!this.editor) return;
      this.editor.value = newText;
      this.dirty = false;
      if (this.saveBtn) this.saveBtn.disabled = true;
      if (this.statusEl) {
        this.statusEl.textContent = "Saved";
        this.statusEl.className = "file-viewer-status saved";
      }
      if (this.preview && !this.preview.classList.contains("hidden")) {
        this.preview.innerHTML = renderMarkdown(newText);
      }
      banner.remove();
    });

    const keepBtn = document.createElement("button");
    keepBtn.type = "button";
    keepBtn.className = "file-viewer-btn";
    keepBtn.textContent = "Keep my edits";
    keepBtn.addEventListener("click", () => banner.remove());

    banner.appendChild(reloadBtn);
    banner.appendChild(keepBtn);

    // Insert at the very top, before the toolbar.
    const root = this.container.querySelector(".file-viewer-root");
    if (root) {
      root.insertBefore(banner, root.firstChild);
    }
  }

  private reloadImage(bytes: Uint8Array): void {
    const img = this.container.querySelector<HTMLImageElement>("img.file-viewer-image");
    if (!img) return;
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buf]);
    const nextUrl = URL.createObjectURL(blob);
    const prev = this.currentImageUrl;
    this.currentImageUrl = nextUrl;
    img.src = nextUrl;
    if (prev) URL.revokeObjectURL(prev);
  }

  /** Clear the viewer (e.g. when the cwd changes). */
  close(): void {
    this.teardownImage();
    this.container.innerHTML = "";
    this.currentPath = null;
    this.currentKind = null;
    this.dirty = false;
    this.editor = null;
    this.preview = null;
    this.saveBtn = null;
    this.statusEl = null;
    this.editBtn = null;
    this.previewBtn = null;
  }

  private teardownImage(): void {
    if (this.currentImageUrl) {
      URL.revokeObjectURL(this.currentImageUrl);
      this.currentImageUrl = null;
    }
    if (this.currentPdfUrl) {
      URL.revokeObjectURL(this.currentPdfUrl);
      this.currentPdfUrl = null;
    }
  }

  private renderText(
    root: HTMLElement,
    relPath: string,
    bytes: Uint8Array,
    headPreview?: { kind: "head"; lineCount: number; byteBudgetHit: boolean },
    size?: number,
  ): void {
    const ext = extOf(relPath);
    const isMarkdown = ext === ".md";
    const text = new TextDecoder("utf-8").decode(bytes);

    // Head-preview path: render read-only with a banner. Skip the
    // editor + Save toolbar + markdown preview toggle entirely — the
    // user can't usefully edit a 200 MB file's first 10 lines.
    if (headPreview) {
      const toolbar = document.createElement("div");
      toolbar.className = "file-viewer-toolbar";
      const filename = document.createElement("span");
      filename.className = "file-viewer-filename";
      filename.textContent = relPath;
      filename.title = relPath;
      toolbar.appendChild(filename);
      const sizeLabel = document.createElement("span");
      sizeLabel.className = "file-viewer-status";
      sizeLabel.textContent = typeof size === "number" ? formatBytes(size) : "";
      toolbar.appendChild(sizeLabel);
      root.appendChild(toolbar);

      const banner = document.createElement("div");
      banner.className = "file-viewer-preview-banner";
      const truncated = headPreview.byteBudgetHit
        ? `Preview only — first ${headPreview.lineCount} lines (truncated mid-line: lines longer than 64 KB are clipped).`
        : `Preview only — first ${headPreview.lineCount} lines.`;
      banner.textContent = `${truncated} Open externally to see the full file.`;
      root.appendChild(banner);

      const pre = document.createElement("pre");
      pre.className = "file-viewer-preview-text";
      pre.textContent = text;
      root.appendChild(pre);
      return;
    }

    // Toolbar ---------------------------------------------------------
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";

    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);

    // Preview/Edit toggle (markdown only)
    if (isMarkdown) {
      const editBtn = document.createElement("button");
      editBtn.className = "file-viewer-btn";
      editBtn.textContent = "Edit";
      const previewBtn = document.createElement("button");
      previewBtn.className = "file-viewer-btn";
      previewBtn.textContent = "Preview";

      editBtn.addEventListener("click", () => this.setMode("edit"));
      previewBtn.addEventListener("click", () => this.setMode("preview"));

      toolbar.appendChild(editBtn);
      toolbar.appendChild(previewBtn);

      this.editBtn = editBtn;
      this.previewBtn = previewBtn;
    }

    const saveBtn = document.createElement("button");
    saveBtn.className = "file-viewer-btn";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;
    saveBtn.addEventListener("click", () => void this.save());
    toolbar.appendChild(saveBtn);
    this.saveBtn = saveBtn;

    const status = document.createElement("span");
    status.className = "file-viewer-status saved";
    status.textContent = "Saved";
    toolbar.appendChild(status);
    this.statusEl = status;

    root.appendChild(toolbar);

    // Body ------------------------------------------------------------
    const body = document.createElement("div");
    body.className = "file-viewer-body";

    const editor = document.createElement("textarea");
    editor.className = "file-viewer-editor";
    editor.spellcheck = false;
    editor.value = text;
    editor.addEventListener("input", () => this.markDirty());
    editor.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void this.save();
      }
    });
    this.editor = editor;

    const preview = document.createElement("div");
    preview.className = "file-viewer-preview result-markdown";
    this.preview = preview;

    body.appendChild(editor);
    body.appendChild(preview);
    root.appendChild(body);

    // Default mode: preview for .md, edit otherwise.
    this.setMode(isMarkdown ? "preview" : "edit");
  }

  private setMode(mode: "edit" | "preview"): void {
    if (!this.editor || !this.preview) return;
    if (mode === "preview") {
      // Render preview from current (possibly dirty) editor contents.
      const html = renderMarkdown(this.editor.value);
      this.preview.innerHTML = html;
      this.editor.classList.add("hidden");
      this.preview.classList.remove("hidden");
      if (this.editBtn) this.editBtn.classList.remove("active");
      if (this.previewBtn) this.previewBtn.classList.add("active");
    } else {
      this.preview.classList.add("hidden");
      this.editor.classList.remove("hidden");
      if (this.editBtn) this.editBtn.classList.add("active");
      if (this.previewBtn) this.previewBtn.classList.remove("active");
    }
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      if (this.saveBtn) this.saveBtn.disabled = false;
      if (this.statusEl) {
        this.statusEl.textContent = "\u25CF Modified";
        this.statusEl.className = "file-viewer-status dirty";
      }
    }
  }

  private async save(): Promise<void> {
    if (!this.editor || !this.currentPath) return;
    const path = this.currentPath;
    const content = this.editor.value;
    if (this.statusEl) {
      this.statusEl.textContent = "Saving…";
      this.statusEl.className = "file-viewer-status";
    }
    try {
      const res = await window.orbit.writeFile(path, content);
      if (res.ok) {
        // Guard: the user may have switched files mid-save.
        if (this.currentPath !== path) return;
        this.dirty = false;
        if (this.saveBtn) this.saveBtn.disabled = true;
        if (this.statusEl) {
          this.statusEl.textContent = "Saved";
          this.statusEl.className = "file-viewer-status saved";
        }
      } else {
        if (this.statusEl) {
          this.statusEl.textContent = `Error: ${res.error}`;
          this.statusEl.className = "file-viewer-status error";
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) {
        this.statusEl.textContent = `Error: ${msg}`;
        this.statusEl.className = "file-viewer-status error";
      }
    }
  }

  private renderImage(root: HTMLElement, relPath: string, bytes: Uint8Array, size: number): void {
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";
    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "file-viewer-status";
    sizeLabel.textContent = formatBytes(size);
    toolbar.appendChild(sizeLabel);
    root.appendChild(toolbar);

    const wrap = document.createElement("div");
    wrap.className = "file-viewer-image-wrap";

    const ext = extOf(relPath);
    const mime = mimeForImage(ext);
    // Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing, which
    // requires a plain ArrayBuffer (not ArrayBufferLike).
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    this.currentImageUrl = url;

    const img = document.createElement("img");
    img.className = "file-viewer-image";
    img.src = url;
    img.alt = relPath;
    wrap.appendChild(img);

    root.appendChild(wrap);
  }

  private renderPdf(root: HTMLElement, relPath: string, bytes: Uint8Array, size: number): void {
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";
    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "file-viewer-status";
    sizeLabel.textContent = formatBytes(size);
    toolbar.appendChild(sizeLabel);
    root.appendChild(toolbar);

    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    this.currentPdfUrl = url;

    // <embed> renders inline via Chromium's built-in PDF viewer; <iframe> as
    // fallback works in Electron too. Either way, fills the body.
    const wrap = document.createElement("div");
    wrap.className = "file-viewer-pdf-wrap";

    const embed = document.createElement("embed");
    embed.className = "file-viewer-pdf";
    embed.src = url;
    embed.type = "application/pdf";
    wrap.appendChild(embed);

    root.appendChild(wrap);
  }

  private renderBinary(root: HTMLElement, relPath: string, size: number): void {
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";
    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);
    root.appendChild(toolbar);

    const msg = document.createElement("div");
    msg.className = "file-viewer-binary";
    msg.textContent = `Cannot preview — binary file (${formatBytes(size)}).`;
    root.appendChild(msg);
  }
}
