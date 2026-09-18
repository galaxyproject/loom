/**
 * Layout editing UX.
 *
 * The host imports `dashboardEditor` and, when it is not null, calls `attach`
 * once with a toolbar it owns outright and `decoratePanel` for each panel with
 * that panel's header slot. Everything the editing UX needs -- read the
 * document, write a new one, list the available widgets, switch dashboards --
 * is on `ctx.host`, so none of this required `host.ts` to change.
 *
 * The implementation is in `editor/`. This file stays a one-line export so the
 * host has a single, stable thing to import, and so a test can build its own
 * isolated editor with `createDashboardEditor()` rather than sharing the
 * singleton's undo stack.
 */

import { createDashboardEditor } from "./editor/controller.js";
import type { DashboardEditor } from "./widget-api.js";

export { createDashboardEditor } from "./editor/controller.js";
export type { DashboardEditorOptions } from "./editor/controller.js";

export const dashboardEditor: DashboardEditor | null = createDashboardEditor();
