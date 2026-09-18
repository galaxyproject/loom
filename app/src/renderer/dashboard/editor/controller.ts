/**
 * The layout editing UX: the toolbar above the grid and the controls in each
 * panel header.
 *
 * Constraints that shaped this file:
 *  - The host owns the grid and re-renders it wholesale on every document
 *    change. The editor owns exactly two things -- the toolbar element it is
 *    handed, and the `.dash-panel-tools` slot in each panel header -- and
 *    reaches for nothing else.
 *  - The pane is 280-400px wide. Sheets are inline and in the flow rather than
 *    overlaid: an overlay in a scrolling container either scrolls away from the
 *    button that opened it or covers it.
 *  - Nothing is drag-only. Every operation has a button, and the ones a mouse
 *    would be fiddly for also have a key.
 *  - Everything that reaches the DOM from the document goes through
 *    `textContent` or a form value. The document is untrusted -- it is written
 *    by a model and hand-editable on disk.
 */

import {
  DASHBOARD_PRESETS,
  KNOWN_WIDGET_TYPES,
  MAX_DASHBOARDS,
  MAX_PANELS,
  createDefaultDashboardDocument,
  validateDashboardDocument,
} from "../../../../../shared/dashboard-contract.js";
import type {
  Dashboard,
  DashboardDocument,
  DashboardPanel,
  PanelSpan,
} from "../../../../../shared/dashboard-contract.js";
import type {
  DashboardEditor,
  DashboardEditorContext,
  WidgetDefinition,
  WidgetDispose,
} from "../widget-api.js";
import {
  MAX_PANEL_ROWS,
  MIN_PANEL_ROWS,
  addPanel,
  configurePanel,
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  movePanel,
  removePanel,
  renameDashboard,
  renamePanel,
  resetDocument,
  resizePanel,
  selectDashboard,
} from "./operations.js";
import { UndoStack } from "./undo-stack.js";
import { describeDocumentChange } from "./change-summary.js";
import {
  applyFieldValue,
  describeConfigFields,
  formatConfigJson,
  parseConfigJson,
  unsupportedConfigKeys,
} from "./config-form.js";

export interface DashboardEditorOptions {
  /** How many changes back Undo reaches. */
  undoDepth?: number;
}

type SheetKind = "add-panel" | "new-dashboard" | "rename-dashboard" | "settings" | "confirm";

interface ConfirmSpec {
  title: string;
  detail: string;
  confirmLabel: string;
  run: () => void;
}

interface PendingFocus {
  panelId: string;
  /** `data-act` of the tool button to return to, or the panel itself. */
  act?: string;
}

const GLYPH_UP = "↑";
const GLYPH_DOWN = "↓";
const GLYPH_NARROW = "⇥";
const GLYPH_WIDE = "⇤";
const GLYPH_SETTINGS = "⚙";
const GLYPH_REMOVE = "✕";
const GLYPH_MINUS = "−";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, act: string): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.dataset.act = act;
  return node;
}

function sameDocument(a: DashboardDocument, b: DashboardDocument): boolean {
  // Both sides come out of the validator, which builds every object in a fixed
  // key order, so text comparison is a safe deep equality here.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Curly quotes around a user-supplied name, so a name with quotes in it reads right. */
function quote(name: string): string {
  return "“" + name + "”";
}

export class DashboardEditorController implements DashboardEditor {
  private ctx: DashboardEditorContext | null = null;
  private root: HTMLElement | null = null;
  private editing = false;

  private undo: UndoStack<DashboardDocument>;
  /** What the editor last saw, so a change by anybody else can be noticed. */
  private lastKnown: DashboardDocument | null = null;
  /**
   * Whether anything has yet replaced the document the host starts with. The
   * first thing that does is the saved layout arriving from disk, which is not
   * a change to anything the user has seen.
   */
  private sawFirstExternalChange = false;
  /** The validated default, for comparison. Cached; it never varies. */
  private pristine: DashboardDocument | null = null;

  private panels = new Map<string, HTMLElement>();
  private pendingFocus: PendingFocus | null = null;
  private gridObserver: MutationObserver | null = null;

  private toolsRow!: HTMLElement;
  private hintRow!: HTMLElement;
  private noteRow!: HTMLElement;
  private noteText!: HTMLElement;
  private liveRegion!: HTMLElement;
  private sheetEl!: HTMLElement;
  private select!: HTMLSelectElement;
  private editBtn!: HTMLButtonElement;
  private addBtn!: HTMLButtonElement;
  private newBtn!: HTMLButtonElement;
  private renameBtn!: HTMLButtonElement;
  private duplicateBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;
  private selectSignature = "";

  private sheetKind: SheetKind | null = null;
  private sheetPanelId: string | null = null;
  private sheetConfirm: ConfirmSpec | null = null;
  private sheetOpener: HTMLElement | null = null;
  private sheetFocus: string | null = null;
  private sheetError = "";

  constructor(opts: DashboardEditorOptions = {}) {
    this.undo = new UndoStack<DashboardDocument>(opts.undoDepth);
  }

  // -- Lifecycle --------------------------------------------------------------

  attach(ctx: DashboardEditorContext): void {
    this.ctx = ctx;
    this.root = ctx.toolbar.parentElement;
    this.sawFirstExternalChange = false;
    this.lastKnown = ctx.host.getDocument();
    this.buildToolbar(ctx.toolbar);
    this.watchGrid();
    this.renderToolbar();
  }

  /**
   * `decoratePanel` is the synchronous signal that a render happened, and it is
   * enough for every dashboard that has panels. A render that draws none --
   * an empty dashboard, or one emptied by somebody else -- would otherwise
   * leave the dashboard list and the button states describing the document
   * before it. The grid's own child list is the signal that covers that.
   */
  private watchGrid(): void {
    const grid = this.root?.querySelector(".dash-grid");
    if (!grid || typeof MutationObserver === "undefined") return;
    this.gridObserver = new MutationObserver(() => {
      this.syncExternalChange();
      this.renderToolbar();
    });
    this.gridObserver.observe(grid, { childList: true });
  }

  detach(): void {
    this.gridObserver?.disconnect();
    this.gridObserver = null;
    this.root?.classList.remove("dash-editing");
    if (this.ctx) {
      this.ctx.toolbar.classList.remove("dash-editor");
      this.ctx.toolbar.textContent = "";
    }
    this.panels.clear();
    this.undo.clear();
    this.sheetKind = null;
    this.sheetConfirm = null;
    this.ctx = null;
    this.root = null;
    this.editing = false;
  }

  // -- Per-panel chrome -------------------------------------------------------

  decoratePanel(
    panel: DashboardPanel,
    tools: HTMLElement,
    ctx: DashboardEditorContext,
  ): WidgetDispose | void {
    this.syncExternalChange();
    const section = tools.closest(".dash-panel") as HTMLElement | null;
    const dashboard = ctx.host.getActiveDashboard();
    if (!section || !dashboard) return;
    const index = dashboard.panels.findIndex((p) => p.id === panel.id);
    const total = dashboard.panels.length;

    this.panels.set(panel.id, section);
    this.buildPanelTools(tools, dashboard.id, panel, index, total);
    this.applyPanelState(section, panel, index, total);

    const onKeydown = (event: KeyboardEvent): void =>
      this.onPanelKeydown(event, dashboard.id, panel, section);
    section.addEventListener("keydown", onKeydown);

    // The dashboard the toolbar describes may have just changed under us.
    this.renderToolbar();

    return () => {
      section.removeEventListener("keydown", onKeydown);
      if (this.panels.get(panel.id) === section) this.panels.delete(panel.id);
    };
  }

  private buildPanelTools(
    tools: HTMLElement,
    dashboardId: string,
    panel: DashboardPanel,
    index: number,
    total: number,
  ): void {
    tools.textContent = "";
    const name = this.panelName(panel);

    const up = button("dash-editor-tool", GLYPH_UP, "move-up");
    up.disabled = index <= 0;
    this.label(up, `Move ${name} up`);
    up.addEventListener("click", () =>
      this.movePanelBy(dashboardId, panel, -1, { panelId: panel.id, act: "move-up" }),
    );

    const down = button("dash-editor-tool", GLYPH_DOWN, "move-down");
    down.disabled = index < 0 || index >= total - 1;
    this.label(down, `Move ${name} down`);
    down.addEventListener("click", () =>
      this.movePanelBy(dashboardId, panel, 1, { panelId: panel.id, act: "move-down" }),
    );

    const wide = panel.layout.span === 2;
    const width = button("dash-editor-tool", wide ? GLYPH_NARROW : GLYPH_WIDE, "toggle-width");
    this.label(width, wide ? `Make ${name} half width` : `Make ${name} full width`);
    width.addEventListener("click", () =>
      this.setPanelWidth(dashboardId, panel, wide ? 1 : 2, {
        panelId: panel.id,
        act: "toggle-width",
      }),
    );

    const settings = button("dash-editor-tool", GLYPH_SETTINGS, "settings");
    this.label(settings, `Settings for ${name}`);
    settings.addEventListener("click", () => this.openSettings(panel.id, settings));

    const remove = button("dash-editor-tool", GLYPH_REMOVE, "remove");
    this.label(remove, `Remove ${name}`);
    remove.addEventListener("click", () => this.removePanel(dashboardId, panel));

    tools.append(up, down, width, settings, remove);
  }

  private applyPanelState(
    section: HTMLElement,
    panel: DashboardPanel,
    index: number,
    total: number,
  ): void {
    if (!this.editing) {
      section.removeAttribute("tabindex");
      section.removeAttribute("aria-label");
      return;
    }
    // Only a tab stop while it can be operated on. Outside edit mode every
    // panel would be a dead stop on the way to the content inside it.
    section.tabIndex = 0;
    section.setAttribute(
      "aria-label",
      `${this.panelName(panel)}, panel ${index + 1} of ${total}, ` +
        `${panel.layout.span === 2 ? "full width" : "half width"}, ` +
        `${panel.layout.rows} row${panel.layout.rows === 1 ? "" : "s"} tall`,
    );
  }

  private onPanelKeydown(
    event: KeyboardEvent,
    dashboardId: string,
    panel: DashboardPanel,
    section: HTMLElement,
  ): void {
    if (!this.editing) return;
    // Delete only when the panel itself has focus. A widget may put a filter
    // box in its header, and Delete inside a text field belongs to the field.
    if (event.key === "Delete" && event.target === section) {
      event.preventDefault();
      this.removePanel(dashboardId, panel);
      return;
    }
    if (!event.altKey) return;
    switch (event.key) {
      // Focus goes back to the panel, not to a button: the whole point of the
      // keys is pressing them again, and the render in between destroys the
      // element the browser was focused on.
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        if (event.shiftKey) {
          this.setPanelRows(dashboardId, panel, panel.layout.rows + delta, { panelId: panel.id });
        } else {
          this.movePanelBy(dashboardId, panel, delta, { panelId: panel.id });
        }
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        this.setPanelWidth(dashboardId, panel, event.key === "ArrowRight" ? 2 : 1, {
          panelId: panel.id,
        });
        break;
      }
      default:
        break;
    }
  }

  // -- Panel operations -------------------------------------------------------

  private movePanelBy(
    dashboardId: string,
    panel: DashboardPanel,
    delta: number,
    focus: PendingFocus | null,
  ): void {
    const doc = this.document();
    if (!doc) return;
    const next = movePanel(doc, dashboardId, panel.id, delta);
    const name = this.panelName(panel);
    if (next === doc) {
      this.announce(`${name} is already ${delta < 0 ? "first" : "last"}`);
      return;
    }
    const moved = next.dashboards.find((d) => d.id === dashboardId);
    const position = moved ? moved.panels.findIndex((p) => p.id === panel.id) + 1 : 0;
    const total = moved ? moved.panels.length : 0;
    this.pendingFocus = focus;
    // Moving is its own opposite, so it does not spend an Undo slot; the same
    // control in the other direction puts it back.
    this.apply(next, null);
    this.announce(`${name} moved to position ${position} of ${total}`);
  }

  private setPanelWidth(
    dashboardId: string,
    panel: DashboardPanel,
    span: PanelSpan,
    focus: PendingFocus | null,
  ): void {
    const doc = this.document();
    if (!doc) return;
    const next = resizePanel(doc, dashboardId, panel.id, { span });
    const name = this.panelName(panel);
    if (next === doc) {
      this.announce(`${name} is already ${span === 2 ? "full" : "half"} width`);
      return;
    }
    this.pendingFocus = focus;
    this.apply(next, null);
    this.announce(`${name} is now ${span === 2 ? "full" : "half"} width`);
  }

  private setPanelRows(
    dashboardId: string,
    panel: DashboardPanel,
    rows: number,
    focus: PendingFocus | null,
  ): void {
    const doc = this.document();
    if (!doc) return;
    const next = resizePanel(doc, dashboardId, panel.id, { rows });
    const name = this.panelName(panel);
    if (next === doc) {
      this.announce(
        rows <= MIN_PANEL_ROWS
          ? `${name} is already as short as it goes`
          : `${name} is already as tall as it goes`,
      );
      return;
    }
    const dashboard = next.dashboards.find((d) => d.id === dashboardId);
    const applied = dashboard?.panels.find((p) => p.id === panel.id)?.layout.rows ?? rows;
    this.pendingFocus = focus;
    this.apply(next, null);
    this.announce(`${name} is now ${applied} row${applied === 1 ? "" : "s"} tall`);
  }

  private removePanel(dashboardId: string, panel: DashboardPanel): void {
    const doc = this.document();
    if (!doc) return;
    const name = this.panelName(panel);
    const next = removePanel(doc, dashboardId, panel.id);
    if (next === doc) return;
    // Focus the panel that takes its place, or the one before it.
    const dashboard = doc.dashboards.find((d) => d.id === dashboardId);
    const index = dashboard ? dashboard.panels.findIndex((p) => p.id === panel.id) : -1;
    const neighbour = dashboard?.panels[index + 1] ?? dashboard?.panels[index - 1] ?? null;
    if (neighbour) this.pendingFocus = { panelId: neighbour.id };
    if (this.sheetKind === "settings" && this.sheetPanelId === panel.id) {
      this.closeSheet({ restoreFocus: false });
    }
    this.apply(next, `Removed ${quote(name)}`);
    this.announce(`${name} removed. Undo is in the toolbar.`);
  }

  // -- Toolbar ----------------------------------------------------------------

  private buildToolbar(toolbar: HTMLElement): void {
    toolbar.textContent = "";
    toolbar.classList.add("dash-editor");
    // The select below is brand new and empty, so the cached signature from a
    // previous attach must not convince `renderToolbar` it is already filled.
    this.selectSignature = "";

    const mainRow = el("div", "dash-editor-row");
    this.select = el("select", "dash-editor-select");
    this.select.dataset.act = "select-dashboard";
    this.select.setAttribute("aria-label", "Dashboard");
    this.select.addEventListener("change", () => this.onSelectDashboard());

    this.editBtn = button("dash-editor-btn", "Edit layout", "toggle-edit");
    this.editBtn.setAttribute("aria-pressed", "false");
    this.editBtn.addEventListener("click", () => this.toggleEditing());
    mainRow.append(this.select, el("span", "dash-editor-spacer"), this.editBtn);

    this.toolsRow = el("div", "dash-editor-row");
    this.toolsRow.hidden = true;
    this.addBtn = button("dash-editor-btn dash-editor-btn-primary", "+ Add panel", "add-panel");
    this.addBtn.addEventListener("click", () => this.openAddPanel());
    this.newBtn = button("dash-editor-btn", "New", "new-dashboard");
    this.newBtn.title = "Create another dashboard";
    this.newBtn.addEventListener("click", () => this.openNewDashboard());
    this.renameBtn = button("dash-editor-btn", "Rename", "rename-dashboard");
    this.renameBtn.addEventListener("click", () => this.openRenameDashboard());
    this.duplicateBtn = button("dash-editor-btn", "Duplicate", "duplicate-dashboard");
    this.duplicateBtn.addEventListener("click", () => this.duplicateActiveDashboard());
    this.deleteBtn = button("dash-editor-btn", "Delete", "delete-dashboard");
    this.deleteBtn.addEventListener("click", () => this.confirmDeleteDashboard());
    const resetBtn = button("dash-editor-btn dash-editor-btn-quiet", "Reset to default", "reset");
    resetBtn.addEventListener("click", () => this.confirmReset());
    this.toolsRow.append(
      this.addBtn,
      this.newBtn,
      this.renameBtn,
      this.duplicateBtn,
      this.deleteBtn,
      resetBtn,
    );

    // A disclosure rather than a permanent strip: spelled out it is two lines
    // of a 400px pane, and it is worth reading once, not on every edit.
    this.hintRow = el("details", "dash-editor-hint");
    this.hintRow.hidden = true;
    const hints = el("div", "dash-editor-hint-body");
    hints.append(
      this.hintSpan("Tab", "to a panel, then"),
      this.hintSpan("Alt", "+ arrows to move and widen"),
      this.hintSpan("Alt+Shift", "+ up/down for height"),
      this.hintSpan("Delete", "to remove"),
    );
    this.hintRow.append(el("summary", undefined, "Keyboard shortcuts"), hints);

    this.noteRow = el("div", "dash-editor-note");
    this.noteRow.hidden = true;
    this.noteText = el("span", "dash-editor-note-text");
    const undoBtn = button("dash-editor-btn", "Undo", "undo");
    undoBtn.addEventListener("click", () => this.performUndo());
    this.noteRow.append(this.noteText, undoBtn);

    this.sheetEl = el("div", "dash-editor-sheet");
    this.sheetEl.hidden = true;
    this.sheetEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSheet();
      }
    });

    this.liveRegion = el("p", "dash-editor-live");
    this.liveRegion.setAttribute("role", "status");
    this.liveRegion.setAttribute("aria-live", "polite");

    toolbar.append(
      mainRow,
      this.toolsRow,
      this.hintRow,
      this.noteRow,
      this.sheetEl,
      this.liveRegion,
    );
  }

  private hintSpan(key: string, rest: string): HTMLElement {
    const span = el("span");
    span.append(el("kbd", undefined, key), document.createTextNode(` ${rest}`));
    return span;
  }

  private renderToolbar(): void {
    const doc = this.document();
    if (!doc) return;

    // JSON rather than a delimiter: a title can contain anything, and a
    // separator byte in the source is invisible in an editor and turns the
    // whole file binary to `grep`.
    const signature = JSON.stringify(doc.dashboards.map((d) => [d.id, d.title]));
    if (signature !== this.selectSignature) {
      this.selectSignature = signature;
      this.select.textContent = "";
      for (const dashboard of doc.dashboards) {
        const option = el("option", undefined, dashboard.title);
        option.value = dashboard.id;
        this.select.append(option);
      }
    }
    this.select.value = doc.activeId;

    const active = doc.dashboards.find((d) => d.id === doc.activeId);
    this.addBtn.disabled = !active || active.panels.length >= MAX_PANELS;
    this.addBtn.title = this.addBtn.disabled
      ? `A dashboard holds at most ${MAX_PANELS} panels.`
      : "";
    const full = doc.dashboards.length >= MAX_DASHBOARDS;
    this.newBtn.disabled = full;
    this.duplicateBtn.disabled = full;
    this.deleteBtn.disabled = doc.dashboards.length <= 1;
    this.deleteBtn.title = this.deleteBtn.disabled
      ? "This is the only dashboard. Use Reset to default instead."
      : "";

    this.toolsRow.hidden = !this.editing;
    this.hintRow.hidden = !this.editing;

    const entry = this.undo.peek();
    // Outside edit mode the strip is reserved for a change the user did not
    // make, which is the one they need told about and offered a way back from.
    // A widget saving its own config is not that, so `external-config` is left
    // for edit mode.
    this.noteRow.hidden = !entry || (!this.editing && entry.source !== "external");
    if (entry) {
      this.noteText.textContent = entry.label;
      // The strip names what Undo reverses, which is not always the last thing
      // that happened -- moving and resizing do not queue -- so the button says
      // which one it means rather than leaving it to the strip's position.
      const undoBtn = this.noteRow.querySelector<HTMLElement>('[data-act="undo"]');
      undoBtn?.setAttribute("aria-label", `Undo: ${entry.label}`);
      if (undoBtn) undoBtn.title = `Undo: ${entry.label}`;
    }
  }

  private onSelectDashboard(): void {
    const doc = this.document();
    if (!doc) return;
    const id = this.select.value;
    const next = selectDashboard(doc, id);
    if (next === doc) return;
    // Switching is navigation, not an edit, so it does not spend an Undo slot.
    this.apply(next, null);
    const title = next.dashboards.find((d) => d.id === id)?.title ?? id;
    this.announce(`Showing ${title}`);
  }

  private toggleEditing(): void {
    this.editing = !this.editing;
    this.editBtn.textContent = this.editing ? "Done" : "Edit layout";
    this.editBtn.setAttribute("aria-pressed", String(this.editing));
    this.root?.classList.toggle("dash-editing", this.editing);
    if (!this.editing) this.closeSheet({ restoreFocus: false });
    // Entering edit mode must not re-render: that would re-mount every widget
    // and throw away, for instance, the notebook's scroll position. The panel
    // tools are already built; only their visibility and the tab order change.
    this.refreshPanelStates();
    this.renderToolbar();
    this.announce(this.editing ? "Editing the layout" : "Finished editing");
  }

  private refreshPanelStates(): void {
    const dashboard = this.ctx?.host.getActiveDashboard();
    if (!dashboard) return;
    dashboard.panels.forEach((panel, index) => {
      const section = this.panels.get(panel.id);
      if (section) this.applyPanelState(section, panel, index, dashboard.panels.length);
    });
  }

  // -- Sheets -----------------------------------------------------------------

  private openSheet(kind: SheetKind, opener: HTMLElement | null): void {
    this.sheetKind = kind;
    this.sheetOpener = opener;
    this.sheetError = "";
    this.sheetFocus = null;
    this.renderSheet();
  }

  private closeSheet(opts: { restoreFocus?: boolean } = {}): void {
    if (!this.sheetKind) return;
    const opener = this.sheetOpener;
    const panelId = this.sheetPanelId;
    this.sheetKind = null;
    this.sheetPanelId = null;
    this.sheetConfirm = null;
    this.sheetOpener = null;
    this.sheetError = "";
    this.sheetEl.textContent = "";
    this.sheetEl.hidden = true;
    if (opts.restoreFocus === false) return;
    // A settings sheet is opened from a button in a panel header, and the host
    // destroys those on every render -- so after any edit made inside the
    // sheet, the thing that opened it is gone.
    if (opener?.isConnected) {
      opener.focus();
      return;
    }
    const panel = panelId ? this.panels.get(panelId) : null;
    (panel ?? this.editBtn).focus();
  }

  private renderSheet(): void {
    if (!this.sheetKind) {
      this.sheetEl.hidden = true;
      this.sheetEl.textContent = "";
      return;
    }
    this.sheetEl.hidden = false;
    this.sheetEl.textContent = "";
    switch (this.sheetKind) {
      case "add-panel":
        this.renderAddPanelSheet();
        break;
      case "new-dashboard":
        this.renderNewDashboardSheet();
        break;
      case "rename-dashboard":
        this.renderRenameDashboardSheet();
        break;
      case "settings":
        this.renderSettingsSheet();
        break;
      case "confirm":
        this.renderConfirmSheet();
        break;
    }
    // One-shot: a later successful action in the same sheet re-renders without
    // an error and the message goes, instead of lingering under a control that
    // has since worked.
    this.sheetError = "";
    this.restoreSheetFocus();
  }

  private sheetHead(title: string): HTMLElement {
    const head = el("div", "dash-editor-sheet-head");
    head.append(el("span", "dash-editor-sheet-head-title", title));
    const close = button("dash-editor-btn dash-editor-btn-quiet", "Close", "close-sheet");
    close.addEventListener("click", () => this.closeSheet());
    head.append(close);
    return head;
  }

  private restoreSheetFocus(): void {
    const act = this.sheetFocus;
    this.sheetFocus = null;
    if (!act) return;
    const target = this.sheetEl.querySelector<HTMLElement>(`[data-act="${act}"]`);
    if (target) target.focus();
  }

  private openAddPanel(): void {
    this.openSheet("add-panel", this.addBtn);
    this.sheetEl.querySelector<HTMLElement>(".dash-editor-gallery-card")?.focus();
  }

  private renderAddPanelSheet(): void {
    const doc = this.document();
    const active = doc ? doc.dashboards.find((d) => d.id === doc.activeId) : undefined;
    if (!active) {
      this.closeSheet({ restoreFocus: false });
      return;
    }
    this.sheetEl.append(this.sheetHead("Add a panel"));

    // The registry is the set of widgets that can be DRAWN; `KNOWN_WIDGET_TYPES`
    // is the set this build is willing to OFFER, and the difference is on
    // purpose -- a flag-gated widget is registered so an existing layout still
    // renders, without the picker inviting someone to add one.
    const widgets = (this.ctx?.host.listWidgets() ?? []).filter((w) =>
      KNOWN_WIDGET_TYPES.includes(w.type),
    );
    if (widgets.length === 0) {
      this.sheetEl.append(
        el(
          "p",
          "dash-editor-sheet-detail",
          "This build has no widgets to offer. Ask the agent for the view you want instead.",
        ),
      );
      return;
    }

    const used = new Set(active.panels.map((p) => p.widget));
    const gallery = el("div", "dash-editor-gallery");
    for (const widget of widgets) {
      const card = button("dash-editor-gallery-card", "", `add-${widget.type}`);
      card.append(el("b", undefined, widget.label));
      if (widget.description) card.append(el("small", undefined, widget.description));
      if (used.has(widget.type)) card.append(el("em", undefined, "Already on this dashboard"));
      card.addEventListener("click", () => {
        const now = this.document();
        if (!now || now.activeId !== active.id) {
          // The dashboard moved on while the picker was open; adding to the one
          // that is no longer on screen would look like nothing happened.
          this.announce("You are looking at a different dashboard now. Pick again.");
          this.renderSheet();
          return;
        }
        this.addPanel(active.id, widget);
      });
      gallery.append(card);
    }
    this.sheetEl.append(gallery);
  }

  private addPanel(dashboardId: string, widget: WidgetDefinition): void {
    const doc = this.document();
    if (!doc) return;
    const target = doc.dashboards.find((d) => d.id === dashboardId);
    const next = addPanel(doc, dashboardId, widget.type, { addedBy: "user" });
    if (next === doc) {
      this.announce(
        !target
          ? "That dashboard is no longer here."
          : `This dashboard already holds the most panels it can (${MAX_PANELS}).`,
      );
      this.renderSheet();
      return;
    }
    const dashboard = next.dashboards.find((d) => d.id === dashboardId);
    const added = dashboard ? dashboard.panels[dashboard.panels.length - 1] : null;
    if (added) this.pendingFocus = { panelId: added.id };
    this.closeSheet({ restoreFocus: false });
    this.apply(next, `Added ${quote(widget.label)}`);
    this.announce(`${widget.label} added at the end`);
  }

  private openNewDashboard(): void {
    this.openSheet("new-dashboard", this.newBtn);
    this.sheetEl.querySelector<HTMLInputElement>('[data-act="new-title"]')?.focus();
  }

  private renderNewDashboardSheet(): void {
    this.sheetEl.append(this.sheetHead("New dashboard"));

    const field = el("label", "dash-editor-field");
    field.append(el("span", undefined, "Name"));
    const input = el("input");
    input.type = "text";
    input.dataset.act = "new-title";
    input.placeholder = "My dashboard";
    field.append(input);
    this.sheetEl.append(field);

    this.sheetEl.append(el("p", "dash-editor-sheet-detail", "Start empty, or from one of these:"));

    const actions = el("div", "dash-editor-actions");
    const blank = button("dash-editor-btn dash-editor-btn-primary", "Empty dashboard", "new-blank");
    blank.addEventListener("click", () => this.createNewDashboard(input.value, undefined));
    actions.append(blank);
    for (const preset of DASHBOARD_PRESETS) {
      const btn = button("dash-editor-btn", preset.label, `new-preset-${preset.id}`);
      btn.title = preset.description;
      btn.addEventListener("click", () => this.createNewDashboard(input.value, preset.id));
      actions.append(btn);
    }
    this.sheetEl.append(actions);
  }

  private createNewDashboard(title: string, presetId: string | undefined): void {
    const doc = this.document();
    if (!doc) return;
    const next = createDashboard(doc, { title: title.trim() || undefined, presetId });
    if (next === doc) {
      this.announce(
        doc.dashboards.length >= MAX_DASHBOARDS
          ? `You already have the most dashboards this file holds (${MAX_DASHBOARDS}).`
          : "That template is not in this build.",
      );
      return;
    }
    const created = next.dashboards.find((d) => d.id === next.activeId);
    this.closeSheet({ restoreFocus: false });
    this.apply(next, `Added dashboard ${quote(created?.title ?? "")}`);
    this.announce(`${created?.title ?? "Dashboard"} created and shown`);
    this.editBtn.focus();
  }

  private openRenameDashboard(): void {
    this.openSheet("rename-dashboard", this.renameBtn);
    this.sheetEl.querySelector<HTMLInputElement>('[data-act="rename-title"]')?.focus();
  }

  private renderRenameDashboardSheet(): void {
    const active = this.ctx?.host.getActiveDashboard();
    if (!active) {
      this.closeSheet({ restoreFocus: false });
      return;
    }
    this.sheetEl.append(this.sheetHead("Rename this dashboard"));

    const field = el("label", "dash-editor-field");
    field.append(el("span", undefined, "Name"));
    const input = el("input");
    input.type = "text";
    input.dataset.act = "rename-title";
    input.value = active.title;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.applyDashboardRename(active.id, input.value);
      }
    });
    field.append(input);
    this.sheetEl.append(field);

    if (this.sheetError) this.sheetEl.append(el("p", "dash-editor-error", this.sheetError));

    const actions = el("div", "dash-editor-actions");
    const save = button("dash-editor-btn dash-editor-btn-primary", "Save", "rename-save");
    save.addEventListener("click", () => this.applyDashboardRename(active.id, input.value));
    actions.append(save);
    this.sheetEl.append(actions);
  }

  private applyDashboardRename(dashboardId: string, title: string): void {
    const doc = this.document();
    if (!doc) return;
    if (!title.trim()) {
      this.sheetError = "A dashboard needs a name.";
      this.sheetFocus = "rename-title";
      this.renderSheet();
      return;
    }
    const next = renameDashboard(doc, dashboardId, title);
    if (next === doc) {
      this.closeSheet();
      return;
    }
    const renamed = next.dashboards.find((d) => d.id === dashboardId);
    this.closeSheet({ restoreFocus: false });
    this.apply(next, `Renamed dashboard to ${quote(renamed?.title ?? "")}`);
    this.announce(`Renamed to ${renamed?.title ?? ""}`);
    this.renameBtn.focus();
  }

  private duplicateActiveDashboard(): void {
    const doc = this.document();
    if (!doc) return;
    const next = duplicateDashboard(doc, doc.activeId);
    if (next === doc) {
      this.announce(`You already have the most dashboards this file holds (${MAX_DASHBOARDS}).`);
      return;
    }
    const copy = next.dashboards.find((d) => d.id === next.activeId);
    this.apply(next, `Duplicated to ${quote(copy?.title ?? "")}`);
    this.announce(`${copy?.title ?? "Copy"} created and shown`);
  }

  private confirmDeleteDashboard(): void {
    const doc = this.document();
    const active = doc ? doc.dashboards.find((d) => d.id === doc.activeId) : undefined;
    if (!active) return;
    const count = active.panels.length;
    this.sheetConfirm = {
      title: `Delete ${quote(active.title)}?`,
      detail:
        `Its ${count} panel${count === 1 ? "" : "s"} go with it. ` +
        "Your other dashboards are untouched, and this is one Undo away.",
      confirmLabel: "Delete dashboard",
      run: () => {
        const current = this.document();
        if (!current) return;
        const next = deleteDashboard(current, active.id);
        if (next === current) return;
        this.closeSheet({ restoreFocus: false });
        this.apply(next, `Deleted dashboard ${quote(active.title)}`);
        this.announce(`${active.title} deleted`);
        // Deleting down to one dashboard disables the button that was pressed.
        (this.deleteBtn.disabled ? this.editBtn : this.deleteBtn).focus();
      },
    };
    this.openSheet("confirm", this.deleteBtn);
  }

  private confirmReset(): void {
    const doc = this.document();
    if (!doc) return;
    const count = doc.dashboards.length;
    this.sheetConfirm = {
      title: "Reset to the default dashboard?",
      detail:
        `This replaces ${count === 1 ? "your dashboard" : `all ${count} of your dashboards`} ` +
        "with the one a new analysis starts with. It is one Undo away.",
      confirmLabel: "Reset to default",
      run: () => {
        this.closeSheet({ restoreFocus: false });
        this.apply(resetDocument(), "Reset to the default dashboard");
        this.announce("Reset to the default dashboard");
        this.editBtn.focus();
      },
    };
    this.openSheet("confirm", null);
  }

  private renderConfirmSheet(): void {
    const spec = this.sheetConfirm;
    if (!spec) {
      this.closeSheet({ restoreFocus: false });
      return;
    }
    this.sheetEl.append(this.sheetHead(spec.title));
    this.sheetEl.append(el("p", "dash-editor-sheet-detail", spec.detail));
    const actions = el("div", "dash-editor-actions");
    const cancel = button("dash-editor-btn", "Cancel", "confirm-cancel");
    cancel.addEventListener("click", () => this.closeSheet());
    const go = button("dash-editor-btn dash-editor-btn-primary", spec.confirmLabel, "confirm-go");
    go.addEventListener("click", () => spec.run());
    // Cancel first and focused: this is the destructive path, and the reader
    // has not finished the sentence above when focus lands.
    actions.append(cancel, go);
    this.sheetEl.append(actions);
    cancel.focus();
  }

  // -- Panel settings ---------------------------------------------------------

  private openSettings(panelId: string, opener: HTMLElement): void {
    this.sheetPanelId = panelId;
    this.openSheet("settings", opener);
    this.sheetEl.querySelector<HTMLElement>('[data-act="panel-title"]')?.focus();
  }

  private findPanel(
    doc: DashboardDocument,
    panelId: string,
  ): { dashboard: Dashboard; panel: DashboardPanel } | null {
    const dashboard = doc.dashboards.find((d) => d.id === doc.activeId);
    const panel = dashboard?.panels.find((p) => p.id === panelId);
    return dashboard && panel ? { dashboard, panel } : null;
  }

  /**
   * The panel as the document has it now. A sheet control closes over the panel
   * the sheet was drawn from, and between the draw and the click the agent, a
   * widget's own `setConfig` or a keypress on the panel may have moved it on --
   * so a stepper that counted from the captured value, or a settings form that
   * wrote back the captured config, would undo somebody else's change.
   */
  private currentPanel(dashboardId: string, panelId: string): DashboardPanel | null {
    const doc = this.document();
    // Null when that dashboard is no longer the one on screen, so the caller
    // re-renders the sheet (which closes it) rather than making an edit the
    // user cannot see on a dashboard they have left.
    if (!doc || doc.activeId !== dashboardId) return null;
    const dashboard = doc.dashboards.find((d) => d.id === dashboardId);
    return dashboard?.panels.find((p) => p.id === panelId) ?? null;
  }

  private renderSettingsSheet(): void {
    const doc = this.document();
    const found = doc && this.sheetPanelId ? this.findPanel(doc, this.sheetPanelId) : null;
    if (!found) {
      // The panel went away underneath -- removed here, or by the agent.
      this.closeSheet({ restoreFocus: false });
      return;
    }
    const { dashboard, panel } = found;
    const def = this.ctx?.host.listWidgets().find((w) => w.type === panel.widget);
    this.sheetEl.append(this.sheetHead(`${this.panelName(panel)} settings`));

    const titleField = el("label", "dash-editor-field");
    titleField.append(el("span", undefined, "Panel title"));
    const titleInput = el("input");
    titleInput.type = "text";
    titleInput.dataset.act = "panel-title";
    titleInput.value = panel.title ?? "";
    titleInput.placeholder = def?.label ?? panel.widget;
    titleInput.addEventListener("change", () => {
      this.sheetFocus = "panel-title";
      const now = this.currentPanel(dashboard.id, panel.id);
      if (now) this.applyPanelTitle(dashboard.id, now, titleInput.value);
      else this.renderSheet();
    });
    titleField.append(titleInput);
    this.sheetEl.append(titleField);

    const widthField = el("div", "dash-editor-field dash-editor-field-row");
    widthField.append(el("span", "dash-editor-field-label", "Width"));
    const half = button("dash-editor-btn", "Half", "panel-half");
    half.setAttribute("aria-pressed", String(panel.layout.span === 1));
    half.addEventListener("click", () => {
      this.sheetFocus = "panel-half";
      const now = this.currentPanel(dashboard.id, panel.id);
      if (now) this.setPanelWidth(dashboard.id, now, 1, null);
      this.renderSheet();
    });
    const fullWidth = button("dash-editor-btn", "Full", "panel-full");
    fullWidth.setAttribute("aria-pressed", String(panel.layout.span === 2));
    fullWidth.addEventListener("click", () => {
      this.sheetFocus = "panel-full";
      const now = this.currentPanel(dashboard.id, panel.id);
      if (now) this.setPanelWidth(dashboard.id, now, 2, null);
      this.renderSheet();
    });
    widthField.append(half, fullWidth);
    this.sheetEl.append(widthField);

    const heightField = el("div", "dash-editor-field dash-editor-field-row");
    heightField.append(el("span", "dash-editor-field-label", "Height"));
    const stepper = el("div", "dash-editor-stepper");
    const shorter = button("dash-editor-btn", GLYPH_MINUS, "panel-shorter");
    shorter.disabled = panel.layout.rows <= MIN_PANEL_ROWS;
    this.label(shorter, "Make this panel shorter");
    shorter.addEventListener("click", () => {
      this.sheetFocus = "panel-shorter";
      const now = this.currentPanel(dashboard.id, panel.id);
      if (now) this.setPanelRows(dashboard.id, now, now.layout.rows - 1, null);
      this.renderSheet();
    });
    const readout = el(
      "output",
      undefined,
      `${panel.layout.rows} row${panel.layout.rows === 1 ? "" : "s"}`,
    );
    const taller = button("dash-editor-btn", "+", "panel-taller");
    taller.disabled = panel.layout.rows >= MAX_PANEL_ROWS;
    this.label(taller, "Make this panel taller");
    taller.addEventListener("click", () => {
      this.sheetFocus = "panel-taller";
      const now = this.currentPanel(dashboard.id, panel.id);
      if (now) this.setPanelRows(dashboard.id, now, now.layout.rows + 1, null);
      this.renderSheet();
    });
    stepper.append(shorter, readout, taller);
    heightField.append(stepper);
    this.sheetEl.append(heightField);

    this.renderWidgetSettings(dashboard.id, panel, def);
  }

  /**
   * A widget declares no schema for its config, only a `defaultConfig`, so that
   * object is the schema: a control per primitive key, and a JSON editor for
   * everything else. The disclosure is deliberate -- a settings form that
   * silently cannot reach half of the settings is worse than no form.
   */
  private renderWidgetSettings(
    dashboardId: string,
    panel: DashboardPanel,
    def: WidgetDefinition | undefined,
  ): void {
    const defaults = (def?.defaultConfig ?? {}) as Record<string, unknown>;
    const fields = describeConfigFields(defaults, panel.config);
    const extras = unsupportedConfigKeys(defaults, panel.config);

    if (!def) {
      this.sheetEl.append(
        el(
          "p",
          "dash-editor-sheet-detail",
          `This build has no ${quote(panel.widget)} widget, so its settings can only be edited as JSON.`,
        ),
      );
    } else if (fields.length === 0 && extras.length === 0) {
      this.sheetEl.append(
        el("p", "dash-editor-sheet-detail", "This panel has nothing else to configure."),
      );
    }

    for (const field of fields) {
      const act = `config-${field.key}`;
      const row = el("div", "dash-editor-field dash-editor-field-row");
      const label = el("label", "dash-editor-field-label", field.label);
      const input = el("input");
      input.dataset.act = act;
      input.id = `dash-cfg-${panel.id}-${field.key}`;
      label.htmlFor = input.id;

      if (field.kind === "boolean") {
        input.type = "checkbox";
        input.checked = field.value === true;
        input.addEventListener("change", () => {
          this.sheetFocus = act;
          const now = this.currentPanel(dashboardId, panel.id);
          if (!now) return this.renderSheet();
          this.applyConfig(dashboardId, now, applyFieldValue(now.config, field.key, input.checked));
        });
        row.append(input, label);
      } else {
        input.type = field.kind === "number" ? "number" : "text";
        input.value = String(field.value);
        input.addEventListener("change", () => {
          this.sheetFocus = act;
          if (field.kind === "number") {
            const value = Number(input.value);
            if (input.value.trim() === "" || !Number.isFinite(value)) {
              this.sheetError = `${field.label} has to be a number.`;
              this.renderSheet();
              return;
            }
            const now = this.currentPanel(dashboardId, panel.id);
            if (!now) return this.renderSheet();
            this.applyConfig(dashboardId, now, applyFieldValue(now.config, field.key, value));
            return;
          }
          const now = this.currentPanel(dashboardId, panel.id);
          if (!now) return this.renderSheet();
          this.applyConfig(dashboardId, now, applyFieldValue(now.config, field.key, input.value));
        });
        row.append(label, input);
      }
      this.sheetEl.append(row);
    }

    if (extras.length > 0) {
      this.sheetEl.append(
        el(
          "p",
          "dash-editor-sheet-detail",
          `${extras.join(", ")} ${extras.length === 1 ? "is" : "are"} only editable as JSON, below.`,
        ),
      );
    }

    const details = el("details");
    details.append(el("summary", undefined, "Settings as JSON"));
    const jsonField = el("label", "dash-editor-field");
    const area = el("textarea");
    area.dataset.act = "config-json";
    // What the box was seeded with, so a click on Apply can tell "the user
    // rewrote this" from "the document moved on underneath it".
    const seeded = formatConfigJson(panel.config);
    area.value = seeded;
    area.setAttribute("aria-label", "Settings as JSON");
    area.spellcheck = false;
    jsonField.append(area);
    details.append(jsonField);
    const apply = button("dash-editor-btn", "Apply JSON", "config-json-apply");
    apply.addEventListener("click", () => {
      this.sheetFocus = "config-json";
      const now = this.currentPanel(dashboardId, panel.id);
      if (!now) {
        this.renderSheet();
        return;
      }
      if (formatConfigJson(now.config) !== seeded) {
        // Applying the box now would quietly drop whatever was added to the
        // config since it was drawn, which is the one thing a text box full of
        // JSON must not do.
        this.sheetError =
          "These settings changed somewhere else while this was open. " +
          "Here they are as they stand now -- check them and apply again.";
        this.renderSheet();
        return;
      }
      const parsed = parseConfigJson(area.value);
      if (!parsed.ok) {
        this.sheetError = parsed.error;
        this.renderSheet();
        return;
      }
      this.applyConfig(dashboardId, now, parsed.config);
    });
    details.append(apply);
    if (this.sheetError) details.open = true;
    this.sheetEl.append(details);

    if (this.sheetError) this.sheetEl.append(el("p", "dash-editor-error", this.sheetError));
  }

  private applyPanelTitle(dashboardId: string, panel: DashboardPanel, title: string): void {
    const doc = this.document();
    if (!doc) return;
    const before = this.panelName(panel);
    const next = renamePanel(doc, dashboardId, panel.id, title);
    if (next === doc) {
      this.renderSheet();
      return;
    }
    this.apply(next, `Renamed ${quote(before)}`);
    this.announce(
      title.trim() ? `Panel renamed to ${title.trim()}` : "Panel is back to its widget's own name",
    );
    this.renderSheet();
  }

  private applyConfig(
    dashboardId: string,
    panel: DashboardPanel,
    config: Record<string, unknown>,
  ): void {
    const doc = this.document();
    if (!doc) return;
    this.sheetError = "";
    const next = configurePanel(doc, dashboardId, panel.id, config);
    if (next !== doc) {
      const name = this.panelName(panel);
      this.apply(next, `Changed ${quote(name)} settings`);
      this.announce(`${name} settings saved`);
    }
    this.renderSheet();
  }

  // -- Undo -------------------------------------------------------------------

  private performUndo(): void {
    const entry = this.undo.pop();
    if (!entry) return;
    const result = validateDashboardDocument(entry.state);
    if (!result.ok) {
      console.error("[dashboard] an undo entry no longer validates:", result.problems);
      this.announce("That change could not be undone.");
      this.renderToolbar();
      return;
    }
    this.lastKnown = result.document;
    this.ctx?.host.setDocument(result.document);
    this.lastKnown = this.ctx?.host.getDocument() ?? null;
    this.renderToolbar();
    this.refreshPanelStates();
    this.announce(`Undone: ${entry.label}`);
    const stillThere = this.noteRow.hidden
      ? null
      : this.noteRow.querySelector<HTMLElement>('[data-act="undo"]');
    (stillThere ?? this.editBtn).focus();
  }

  /**
   * Somebody else -- the brain, a widget's own `setConfig`, another window
   * whose save this one adopted -- changed the document. Record it so the user
   * has a way back, with a sentence saying what actually happened.
   *
   * Two things are deliberately not recorded, and both are about the document
   * being replaced wholesale rather than edited.
   */
  private syncExternalChange(): void {
    const current = this.document();
    const before = this.lastKnown;
    if (!current) return;
    this.lastKnown = current;
    if (!before || sameDocument(before, current)) return;

    // The shell puts the pristine default back when the analysis directory
    // changes, and then loads that workspace's layout over it. An Undo that
    // reached across that boundary would write the previous analysis's layout
    // into the new analysis's file, so the history starts again here.
    if (this.isPristineDefault(current)) {
      this.undo.clear();
      this.sawFirstExternalChange = false;
      return;
    }

    const change = describeDocumentChange(before, current, (panel) => this.panelName(panel));

    // The saved layout arriving from disk is not a change to anything the user
    // has seen -- it is the first thing they see. Recognised by what it
    // replaces rather than by a clock, so a slow read is still the first read.
    // Only a structural change can be that load: a workspace with nothing saved
    // sits on the default until somebody edits it, and treating the first
    // widget saving its own config as the load would cost them that Undo.
    if (change.kind === "structure") {
      const firstStructuralChange = !this.sawFirstExternalChange && this.isPristineDefault(before);
      this.sawFirstExternalChange = true;
      if (firstStructuralChange) return;
    }

    this.undo.push(change.label, before, change.kind === "config" ? "external-config" : "external");
  }

  /**
   * Is this the document a workspace with no saved layout starts with? Compared
   * against the validated default, not the literal: `sameDocument` is a text
   * comparison and only the validator guarantees the key order.
   */
  private isPristineDefault(doc: DashboardDocument): boolean {
    if (!this.pristine) {
      const result = validateDashboardDocument(createDefaultDashboardDocument());
      this.pristine = result.ok ? result.document : createDefaultDashboardDocument();
    }
    return sameDocument(doc, this.pristine);
  }

  // -- Plumbing ---------------------------------------------------------------

  private document(): DashboardDocument | null {
    return this.ctx ? this.ctx.host.getDocument() : null;
  }

  private panelName(panel: DashboardPanel): string {
    if (panel.title) return panel.title;
    const def = this.ctx?.host.listWidgets().find((w) => w.type === panel.widget);
    return def?.label ?? panel.widget;
  }

  private label(node: HTMLElement, text: string): void {
    node.title = text;
    node.setAttribute("aria-label", text);
  }

  private announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  /**
   * The one place a document change leaves the editor. It validates first, so a
   * bug here becomes a refused edit rather than a layout file the next build
   * cannot read, and so the host never has repairs to make.
   */
  private apply(next: DashboardDocument, label: string | null): boolean {
    const host = this.ctx?.host;
    const current = this.document();
    if (!host || !current) return false;

    const result = validateDashboardDocument(next);
    if (!result.ok) {
      console.error("[dashboard] the editor refused its own change:", result.problems);
      this.announce("That change could not be made.");
      return false;
    }
    if (result.problems.length > 0) {
      console.warn("[dashboard] an editor change needed repairs:", result.problems);
    }
    // Validation can normalize a change into no change at all, and so can an
    // operation that rebuilt an identical document. Writing it would spend an
    // Undo slot and a disk write on nothing.
    if (sameDocument(result.document, current)) {
      this.pendingFocus = null;
      return false;
    }
    // A null label means the change is its own opposite -- move, resize, switch
    // -- and does not queue: the same control in the other direction puts it
    // back, and queueing would push the removal the user does want out of reach.
    if (label !== null) this.undo.push(label, current, "editor");

    // Before the write, not after: `setDocument` renders synchronously and the
    // render calls back into `syncExternalChange`, which would otherwise see
    // the editor's own change as somebody else's and stack a second, wrong
    // undo entry on top of the right one.
    this.lastKnown = result.document;
    host.setDocument(result.document);
    this.lastKnown = host.getDocument();
    this.renderToolbar();
    this.consumePendingFocus();
    return true;
  }

  /**
   * A document change re-renders the whole grid, so the button the user just
   * pressed no longer exists. Put focus back on its replacement, or a keyboard
   * user is dumped on the body after every move.
   */
  private consumePendingFocus(): void {
    const target = this.pendingFocus;
    this.pendingFocus = null;
    if (!target) return;
    const section = this.panels.get(target.panelId);
    if (!section) return;
    const replacement = target.act
      ? section.querySelector<HTMLButtonElement>(`.dash-panel-tools [data-act="${target.act}"]`)
      : null;
    if (replacement && !replacement.disabled) replacement.focus();
    else section.focus();
  }
}

export function createDashboardEditor(opts?: DashboardEditorOptions): DashboardEditorController {
  return new DashboardEditorController(opts);
}
