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

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-click on a file selects it, matching the convention of every
      // editor file tree. Directories have no selection visual (setSelected
      // only applies the class to type=file rows), so they're a no-op.
      if (node.type === "file") this.setSelected(node.relPath);
      showFilePathContextMenu(e.clientX, e.clientY, node.relPath);
    });

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

/**
 * Lightweight right-click menu for a file/folder row in the files panel.
 * Floats at the cursor; click anywhere outside (or Escape) closes it.
 * One submenu only — keep it short until users tell us they want more.
 */
function showFilePathContextMenu(x: number, y: number, relPath: string): void {
  // Tear down any prior menu first so a fast double-right-click doesn't
  // leave orphans.
  document.getElementById("files-tree-ctx-menu")?.remove();

  const menu = document.createElement("div");
  menu.id = "files-tree-ctx-menu";
  menu.className = "files-tree-ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const addItem = (label: string, onClick: () => void | Promise<void>): void => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "files-tree-ctx-item";
    item.textContent = label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      // Surface clipboard rejections (no secure context, permission
      // denied, etc.) instead of swallowing them — a silent copy menu is
      // the worst kind of broken.
      Promise.resolve(onClick())
        .catch((err) => console.warn(`[files-ctx-menu] "${label}" failed:`, err))
        .finally(close);
    });
    menu.appendChild(item);
  };

  const close = (): void => {
    menu.remove();
    document.removeEventListener("click", closeOnOutside, true);
    document.removeEventListener("keydown", closeOnEscape, true);
    window.removeEventListener("blur", close);
  };
  const closeOnOutside = (e: Event): void => {
    if (!menu.contains(e.target as Node)) close();
  };
  const closeOnEscape = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  addItem("Copy relative path", async () => {
    await navigator.clipboard.writeText(relPath);
  });
  addItem("Copy absolute path", async () => {
    const cwd = await window.orbit.getCwd();
    // cwd is OS-native; relPath uses forward slashes (per files-handler's
    // toPosix). Joining with "/" works on Linux/macOS and Windows accepts
    // mixed separators — good enough for clipboard fodder.
    const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
    await navigator.clipboard.writeText(`${cwd}${sep}${relPath}`);
  });
  addItem("Copy file name", async () => {
    const parts = relPath.split("/");
    await navigator.clipboard.writeText(parts[parts.length - 1] ?? relPath);
  });

  document.body.appendChild(menu);

  // Clamp to viewport so a right-click near the right/bottom edge doesn't
  // place the menu off-screen.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  }

  // Defer the outside-click handler so this very right-click doesn't
  // immediately close the menu we just opened.
  setTimeout(() => {
    document.addEventListener("click", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("blur", close);
  }, 0);
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
