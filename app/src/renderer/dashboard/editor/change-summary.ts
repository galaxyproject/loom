/**
 * Saying what changed, when the editor did not make the change.
 *
 * Three things write this document: the editor, a widget saving its own config
 * through `WidgetContext.setConfig`, and the brain. Only the first knows what
 * it did. For the other two all the editor has is the document before and the
 * document after, so it works out a sentence from the difference -- because
 * "the dashboard was changed outside the editor" is a false and slightly
 * alarming thing to tell someone who just clicked a toggle in a panel header.
 *
 * `kind` separates those two cases. A `config` change is almost always the
 * person's own click on a widget's own control, so it is recorded (it is still
 * undoable) without interrupting them; anything structural is worth saying out
 * loud even when they are not editing.
 */

import type {
  DashboardDocument,
  DashboardPanel,
} from "../../../../../shared/dashboard-contract.js";

export type DocumentChangeKind = "config" | "structure";

export interface DocumentChange {
  /** What Undo would reverse, in the user's words. */
  label: string;
  kind: DocumentChangeKind;
}

/** Resolves a panel to the name shown in its header. */
export type PanelNamer = (panel: DashboardPanel) => string;

function quote(name: string): string {
  return "“" + name + "”";
}

/** The document with every panel config blanked, so the rest can be compared. */
function withoutConfigs(doc: DashboardDocument): string {
  return JSON.stringify({
    activeId: doc.activeId,
    dashboards: doc.dashboards.map((d) => ({
      id: d.id,
      title: d.title,
      panels: d.panels.map((p) => ({ ...p, config: 0 })),
    })),
  });
}

function allPanels(doc: DashboardDocument): Map<string, DashboardPanel> {
  const out = new Map<string, DashboardPanel>();
  for (const dashboard of doc.dashboards) {
    for (const panel of dashboard.panels) out.set(`${dashboard.id}/${panel.id}`, panel);
  }
  return out;
}

/**
 * A sentence for a change the editor did not make. Deliberately modest: it
 * names the common single-thing cases and otherwise says only that something
 * changed, rather than guessing at a diff it cannot summarise honestly.
 */
export function describeDocumentChange(
  before: DashboardDocument,
  after: DashboardDocument,
  nameOf: PanelNamer,
): DocumentChange {
  // Nothing but panel configs moved.
  if (withoutConfigs(before) === withoutConfigs(after)) {
    const was = allPanels(before);
    const changed = [...allPanels(after).entries()].filter(
      ([key, panel]) => JSON.stringify(was.get(key)?.config) !== JSON.stringify(panel.config),
    );
    if (changed.length === 1) {
      return { kind: "config", label: `Changed ${quote(nameOf(changed[0][1]))} settings` };
    }
    return { kind: "config", label: "Changed some panel settings" };
  }

  const beforeDashboards = new Set(before.dashboards.map((d) => d.id));
  const afterDashboards = new Set(after.dashboards.map((d) => d.id));
  const addedDashboard = after.dashboards.find((d) => !beforeDashboards.has(d.id));
  if (addedDashboard) {
    return { kind: "structure", label: `A dashboard was added: ${quote(addedDashboard.title)}` };
  }
  const goneDashboard = before.dashboards.find((d) => !afterDashboards.has(d.id));
  if (goneDashboard) {
    return { kind: "structure", label: `A dashboard was removed: ${quote(goneDashboard.title)}` };
  }

  const was = allPanels(before);
  const now = allPanels(after);
  const added = [...now.entries()].filter(([key]) => !was.has(key));
  if (added.length === 1) {
    return { kind: "structure", label: `${quote(nameOf(added[0][1]))} was added` };
  }
  if (added.length > 1) {
    return { kind: "structure", label: `${added.length} panels were added` };
  }
  const gone = [...was.entries()].filter(([key]) => !now.has(key));
  if (gone.length === 1) {
    return { kind: "structure", label: `${quote(nameOf(gone[0][1]))} was removed` };
  }
  if (gone.length > 1) {
    return { kind: "structure", label: `${gone.length} panels were removed` };
  }

  return { kind: "structure", label: "The dashboard was changed outside the editor" };
}
