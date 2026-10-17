/** The artifact pane: whether it is showing, the shortcut that toggles it, and the divider. */

import { DEFAULT_BRAND, type Brand } from "./agent/brand";

const BREAKPOINT = 700;
const MIN_CHAT_PERCENT = 25;
const MAX_CHAT_PERCENT = 75;

/** Collapsed unless the user has said otherwise; a blocked store only costs the preference. */
function readPreference(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function writePreference(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key, collapsed ? "1" : "0");
  } catch {
    // Nothing to do: the pane still works, it just will not be remembered.
  }
}

export interface ArtifactPane {
  /** Show the pane because something was produced for it. */
  reveal(): void;
}

/** `signal` ends what the pane attached to the container and outside it, for a page that unmounts
 * it and may mount again into the same element. */
export function mountArtifactPane(
  container: HTMLElement,
  signal?: AbortSignal,
  brand: Brand = DEFAULT_BRAND,
): ArtifactPane {
  const collapsedKey = `${brand.id}.artifactCollapsed`;
  const chatPane = container.querySelector<HTMLElement>("#chat-pane")!;
  const divider = container.querySelector<HTMLElement>("#divider")!;
  const appMain = container.querySelector<HTMLElement>("#app-main")!;
  const button = container.querySelector<HTMLButtonElement>("#artifact-btn")!;
  const content = container.querySelector<HTMLElement>("#artifact-content")!;

  // What the user last chose, which a narrow window overrides without overwriting.
  let preferred = readPreference(collapsedKey);

  /** An empty pane has nothing to show, whatever the remembered preference says. */
  const empty = () => content.childElementCount === 0;

  const show = (collapsed: boolean) => {
    const wasHidden = document.body.classList.contains("artifact-collapsed");
    const hide = collapsed || empty();
    document.body.classList.toggle("artifact-collapsed", hide);
    button.classList.toggle("hidden", empty());
    if (hide) {
      chatPane.style.flex = "";
    } else if (wasHidden) {
      // A chart drawn while the pane was hidden measured it as 0x0, and vega-embed only
      // measures its container again on a window resize.
      window.dispatchEvent(new Event("resize"));
    }
  };
  const set = (collapsed: boolean) => {
    preferred = collapsed;
    writePreference(collapsedKey, collapsed);
    show(collapsed);
  };
  const collapsed = () => document.body.classList.contains("artifact-collapsed");

  let narrow = window.innerWidth < BREAKPOINT;
  show(narrow || preferred);

  // The pane reads its own contents rather than trusting a caller to announce them.
  const observer = new MutationObserver(() => show(narrow || preferred));
  observer.observe(content, { childList: true });
  signal?.addEventListener("abort", () => observer.disconnect());

  // Charts sized to their container measure it again only on a window resize, so whatever
  // opens or resizes the pane announces it as one; a chart drawn while it was shut is 0x0.
  const resized = new ResizeObserver(() => {
    if (content.clientWidth && content.clientHeight) {
      window.dispatchEvent(new Event("resize"));
    }
  });
  resized.observe(content);
  signal?.addEventListener("abort", () => resized.disconnect());

  window.addEventListener(
    "resize",
    () => {
      const isNarrow = window.innerWidth < BREAKPOINT;
      if (isNarrow === narrow) {
        return;
      }
      narrow = isNarrow;
      show(isNarrow ? true : preferred);
    },
    { signal },
  );

  button.addEventListener("click", () => set(!collapsed()));
  container.addEventListener(
    "keydown",
    (e) => {
      const ev = e as KeyboardEvent;
      // Guarded: the button is hidden with nothing to show, so the shortcut must not open it.
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "\\" && !empty()) {
        ev.preventDefault();
        set(!collapsed());
      }
    },
    { signal },
  );

  // Clamped so neither pane can be dragged away entirely.
  let dragging = false;
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!dragging) {
        return;
      }
      const width = appMain.getBoundingClientRect().width;
      const left = chatPane.getBoundingClientRect().left;
      const pct = (((e as MouseEvent).clientX - left) / width) * 100;
      chatPane.style.flex = `0 0 ${Math.max(MIN_CHAT_PERCENT, Math.min(MAX_CHAT_PERCENT, pct))}%`;
    },
    { signal },
  );
  document.addEventListener(
    "mouseup",
    () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      divider.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    { signal },
  );

  return {
    reveal: () => set(false),
  };
}
