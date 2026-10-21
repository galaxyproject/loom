export const LoomWidgetKey = {
  Plan: "plan",
  Steps: "steps",
  Results: "results",
  Parameters: "parameters",
  Notebook: "notebook",
  PlanView: "plan-view",
  Activity: "activity",
  GalaxyActivity: "galaxy-activity",
  // JSON, not markdown: the live Galaxy history projection (shared/galaxy-live-contract).
  GalaxyLive: "galaxy-live",
};

// An extension command: refreshes a read-only widget without invoking the LLM.
export const GALAXY_ACTIVITY_COMMAND = "/galaxy-activity";

export function encodeMarkdownWidget(markdown) {
  return [markdown];
}

export function decodeMarkdownWidget(lines) {
  return (lines || []).join("\n");
}

export function encodeJsonWidget(value) {
  return [JSON.stringify(value)];
}

export function decodeJsonWidget(lines) {
  if (!lines || lines.length === 0) {
    throw new Error("Widget payload missing");
  }
  return JSON.parse(lines[0]);
}
