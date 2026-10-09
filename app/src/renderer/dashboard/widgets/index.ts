/**
 * Every widget the dashboard can draw, registered at module load.
 *
 * The contract for anyone building one of the stubs: replace your own file's
 * body, keep its exported symbol name and its `type` string, and this file
 * needs no edit. That is deliberate -- several people build widgets in
 * parallel and this is the file they would otherwise all be editing.
 *
 * A widget also stays directly importable from its own test, so nothing has to
 * touch the shared registry to be tested.
 */

import { registerWidget } from "../registry.js";
import { notebookWidget } from "./notebook.js";
import { jobsWidget } from "./jobs.js";
import { planWidget } from "./plan.js";
import { activityWidget } from "./activity.js";
import { resultsWidget } from "./results.js";
import { htmlSandboxWidget } from "./html-sandbox.js";
import { galaxyHistoryWidget } from "./galaxy-history.js";

export const BUILT_IN_WIDGETS = [
  notebookWidget,
  jobsWidget,
  planWidget,
  activityWidget,
  resultsWidget,
  htmlSandboxWidget,
  galaxyHistoryWidget,
];

for (const widget of BUILT_IN_WIDGETS) registerWidget(widget);
