/**
 * FilesPanel — renders the cwd file tree in the left sidebar.
 *
 * Folders expand/collapse on click; expansion state is cached by relPath so
 * it survives refreshes. Files fire `onFileOpen(relPath)` on click. The
 * selected file gets a `.selected` class.
 */

import type { FileNode } from "../../preload/preload.js";

export class FilesPanel {
  private readonly container: HTMLElement;
  private readonly onFileOpen: (relPath: string) => void;
  private expanded = new Set<string>();
  private selectedPath: string | null = null;
  private showHidden = false;
  private loading = false;

  constructor(container: HTMLElement, onFileOpen: (relPath: string) => void) {
    this.container = container;
    this.onFileOpen = onFileOpen;
  }

  setShowHidden(value: boolean): void {
    if (this.showHidden === value) return;
    this.showHidden = value;
    void this.refresh();
  }

  isShowingHidden(): boolean {
    return this.showHidden;
  }

  /** Clear the tree + selection + expansion state (used on cwd change). */
  reset(): void {
    this.expanded.clear();
    this.selectedPath = null;
    this.container.innerHTML = "";
  }

  /** Update selection styling. Pass null to clear. */
  setSelected(relPath: string | null): void {
    this.selectedPath = relPath;
    for (const el of this.container.querySelectorAll<HTMLElement>(".files-tree-node")) {
      const p = el.dataset.relpath ?? null;
      el.classList.toggle("selected", !!relPath && p === relPath && el.dataset.type === "file");
    }
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const res = await window.orbit.listFiles({ includeHidden: this.showHidden });
      if (!res.ok) {
        this.container.innerHTML = "";
        const err = document.createElement("div");
        err.className = "files-tree-empty";
        err.textContent = `Error: ${res.error}`;
        this.container.appendChild(err);
        return;
      }
      this.render(res.root);
    } finally {
      this.loading = false;
    }
  }

  private render(root: FileNode): void {
    this.container.innerHTML = "";
    const children = root.children ?? [];
    if (children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "files-tree-empty";
      empty.textContent = "(empty directory)";
      this.container.appendChild(empty);
      return;
    }
    for (const child of children) {
      this.container.appendChild(this.renderNode(child, 0));
    }
  }

  private renderNode(node: FileNode, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "files-tree-wrap";
    wrap.dataset.relpath = node.relPath;

    const row = document.createElement("div");
    row.className = "files-tree-node";
    row.dataset.relpath = node.relPath;
    row.dataset.type = node.type;
    row.style.paddingLeft = `${10 + depth * 12}px`;

    const icon = document.createElement("span");
    icon.className = "files-tree-icon";

    const name = document.createElement("span");
    name.className = "files-tree-name";
    name.textContent = node.name;

    row.appendChild(icon);
    row.appendChild(name);

    if (node.type === "directory") {
      const isExpanded = this.expanded.has(node.relPath);
      icon.textContent = isExpanded ? "\u{1F4C2}" : "\u{1F4C1}";
      const count = node.children?.length;
      if (typeof count === "number") {
        const countEl = document.createElement("span");
        countEl.className = "files-tree-size";
        countEl.textContent = String(count);
        row.appendChild(countEl);
      }
      row.title = typeof count === "number" ? `${node.name} (${count} entries)` : node.name;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.expanded.has(node.relPath)) {
          this.expanded.delete(node.relPath);
        } else {
          this.expanded.add(node.relPath);
        }
        // Re-render just this subtree to preserve scroll position.
        const replacement = this.renderNode(node, depth);
        wrap.replaceWith(replacement);
      });
      wrap.appendChild(row);

      const childBox = document.createElement("div");
      childBox.className = "files-tree-children";
      if (!isExpanded) childBox.classList.add("hidden");
      const children = node.children ?? [];
      for (const child of children) {
        childBox.appendChild(this.renderNode(child, depth + 1));
      }
      wrap.appendChild(childBox);
    } else {
      icon.textContent = iconFor(node.name);
      row.title = node.name;

      if (typeof node.size === "number") {
        const size = document.createElement("span");
        size.className = "files-tree-size";
        size.textContent = formatSize(node.size);
        row.appendChild(size);
      }

      if (this.selectedPath && node.relPath === this.selectedPath) {
        row.classList.add("selected");
      }

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setSelected(node.relPath);
        this.onFileOpen(node.relPath);
      });

      wrap.appendChild(row);
    }
    return wrap;
  }
}

function iconFor(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  switch (ext) {
    case ".md":
      return "\u{1F4DD}";
    case ".py":
      return "\u{1F40D}";
    case ".csv":
    case ".tsv":
      return "\u{1F4CA}";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
      return "\u{1F5BC}\u{FE0F}";
    default:
      return "\u{1F4C4}";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
