/**
 * Dashboard document contract -- shared by the renderer (which draws it), the
 * shells (which persist it) and, later, the brain (which may write one).
 *
 * A dashboard is data: a versioned JSON document of named dashboards, each an
 * ordered list of panels. Validation is total -- it never throws on untrusted
 * input, because this document can come off disk, out of an agent turn, or from
 * a build newer than the one reading it. Anything repairable is repaired and
 * reported; only three things are fatal (not an object, no usable version, a
 * version from the future).
 *
 * Unknown widget types are deliberately preserved. Dropping them would silently
 * delete panels every time an older build opened a newer layout.
 */

export const DASHBOARD_SCHEMA_VERSION = 1;

/** Per-analysis layout file, beside notebook.md in the working directory. */
export const DASHBOARD_FILENAME = ".loom-dashboard.json";

/** Refuse to persist anything larger. Layout, not a blob store. */
export const DASHBOARD_MAX_BYTES = 256 * 1024;

/**
 * Advisory list used to build presets and to give the brain a vocabulary. It is
 * deliberately not the set of renderable widgets -- the renderer's registry is
 * that, and it includes flag-gated widgets this list should not advertise.
 * Validation never consults either.
 */
export const KNOWN_WIDGET_TYPES = [
  "notebook",
  "jobs",
  "plan",
  "activity",
  "results",
  "galaxy-history",
];

const DEFAULT_PRESET_ID = "current-analysis";
export const MIN_ROWS = 1;
export const MAX_ROWS = 6;
const DEFAULT_ROWS = 2;
/**
 * Validation enforces these by truncating and reporting a repair, which is the
 * right answer for a file off disk. A caller acting on someone's click wants to
 * refuse and say so instead, so it needs the same numbers rather than its own
 * copy of them.
 */
export const MAX_DASHBOARDS = 20;
export const MAX_PANELS = 40;
const MAX_REASON_CHARS = 280;
const MAX_NAME_CHARS = 200;
const MAX_WIDGET_TYPE_CHARS = 100;
// Config is the one place the document carries arbitrary shape, so it is the one
// place that needs walking rather than trusting. JSON.stringify recurses and
// JSON.parse does not, so a 16 KB file nested a few thousand deep blows the
// stack inside a structuredClone-by-JSON.
const MAX_CONFIG_DEPTH = 24;
const MAX_CONFIG_NODES = 5000;
const ADDED_BY = new Set(["user", "agent", "preset"]);

export const DASHBOARD_PRESETS = [
  {
    id: "current-analysis",
    label: "Current analysis",
    description: "Where the plan stands, what Galaxy is running, and the notebook.",
    dashboard: {
      id: "current-analysis",
      title: "Current analysis",
      panels: [
        {
          id: "p-plan",
          widget: "plan",
          config: {},
          layout: { span: 1, rows: 4 },
          addedBy: "preset",
        },
        {
          id: "p-jobs",
          widget: "jobs",
          config: {},
          layout: { span: 1, rows: 4 },
          addedBy: "preset",
        },
        {
          id: "p-notebook",
          widget: "notebook",
          config: { follow: true },
          layout: { span: 2, rows: 3 },
          addedBy: "preset",
        },
      ],
    },
  },
  {
    id: "monitoring",
    label: "Monitoring",
    description: "For a long run: jobs, plan progress, and the analysis log.",
    dashboard: {
      id: "monitoring",
      title: "Monitoring",
      panels: [
        {
          id: "p-jobs",
          widget: "jobs",
          config: {},
          layout: { span: 2, rows: 4 },
          addedBy: "preset",
        },
        {
          id: "p-plan",
          widget: "plan",
          config: {},
          layout: { span: 1, rows: 4 },
          addedBy: "preset",
        },
        {
          id: "p-activity",
          widget: "activity",
          config: {},
          layout: { span: 1, rows: 3 },
          addedBy: "preset",
        },
      ],
    },
  },
  {
    id: "results",
    label: "Results",
    description: "What the analysis produced, next to the notebook that explains it.",
    dashboard: {
      id: "results",
      title: "Results",
      panels: [
        {
          id: "p-results",
          widget: "results",
          config: {},
          layout: { span: 2, rows: 3 },
          addedBy: "preset",
        },
        {
          id: "p-notebook",
          widget: "notebook",
          config: { follow: false },
          layout: { span: 2, rows: 3 },
          addedBy: "preset",
        },
      ],
    },
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Copy a panel config defensively: bounded depth and node count, cycles cut,
 * anything JSON cannot carry dropped, and a property whose getter throws
 * skipped rather than propagated. Returns the copy, or null if it hit a limit.
 */
function copyConfig(raw) {
  let budget = MAX_CONFIG_NODES;
  const seen = new WeakSet();

  const walk = (value, depth) => {
    if (depth > MAX_CONFIG_DEPTH) return { over: true };
    if (budget-- <= 0) return { over: true };

    if (value === null) return { value: null };
    const kind = typeof value;
    if (kind === "string" || kind === "boolean") return { value };
    if (kind === "number") return Number.isFinite(value) ? { value } : { skip: true };
    if (kind !== "object") return { skip: true }; // function, symbol, bigint, undefined

    if (seen.has(value)) return { skip: true };
    seen.add(value);

    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        const result = walk(item, depth + 1);
        if (result.over) return result;
        out.push(result.skip ? null : result.value);
      }
      seen.delete(value);
      return { value: out };
    }

    const out = {};
    for (const key of Object.keys(value)) {
      // `out["__proto__"] = x` sets the object's prototype instead of adding a
      // property, so a config carrying one came back with a poisoned prototype:
      // a widget reading `ctx.config.anything` could get a value the layout
      // file never declared. Not global pollution -- `Object.prototype` is
      // untouched and the key does not survive serialization -- but the widget
      // sees it for the life of the panel, and no config has a legitimate
      // reason to carry these names.
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      let member;
      try {
        member = value[key];
      } catch {
        continue; // a throwing getter is not worth the whole document
      }
      const result = walk(member, depth + 1);
      if (result.over) return result;
      if (!result.skip) out[key] = result.value;
    }
    seen.delete(value);
    return { value: out };
  };

  const result = walk(raw, 0);
  return result.over || result.skip ? null : result.value;
}

function problem(path, message) {
  return { path, message };
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A fresh copy of a preset's dashboard, or null if there is no such preset. */
export function dashboardFromPreset(presetId) {
  const preset = DASHBOARD_PRESETS.find((p) => p.id === presetId);
  return preset ? clone(preset.dashboard) : null;
}

/** The document a workspace starts with: one dashboard, the current-analysis preset. */
export function createDefaultDashboardDocument() {
  const dashboard = dashboardFromPreset(DEFAULT_PRESET_ID) ?? {
    // Only reachable if DEFAULT_PRESET_ID stops naming a preset. Returning an
    // empty dashboard beats turning the never-throws validator, which calls
    // this, into a thrower.
    id: DEFAULT_PRESET_ID,
    title: "Dashboard",
    panels: [],
  };
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    activeId: dashboard.id,
    dashboards: [dashboard],
  };
}

export function serializeDashboardDocument(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

/**
 * A short content fingerprint for the layout file, used as the compare-and-swap
 * token between a load and the save based on it. Not a security hash: FNV-1a in
 * plain JS because the renderer, the main process and the web server all have to
 * agree on it, and only one of the three can import node:crypto.
 */
export function dashboardRevision(raw) {
  if (typeof raw !== "string") return null;
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ ((code << 5) | (code >>> 3)), 0x85ebca6b) >>> 0;
  }
  return (
    high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0") + raw.length.toString(16)
  );
}

function normalizeLayout(raw, path, problems) {
  const layout = { span: 1, rows: DEFAULT_ROWS };
  if (raw === undefined) return layout;
  if (!isPlainObject(raw)) {
    problems.push(
      problem(path, `expected an object, got ${describe(raw)}; using the default size`),
    );
    return layout;
  }
  if (raw.span === 1 || raw.span === 2) {
    layout.span = raw.span;
  } else if (raw.span !== undefined) {
    problems.push(problem(`${path}.span`, "expected 1 or 2; using 1"));
  }
  if (typeof raw.rows === "number" && Number.isFinite(raw.rows)) {
    const rows = Math.round(raw.rows);
    layout.rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows));
    if (layout.rows !== rows) {
      problems.push(problem(`${path}.rows`, `clamped ${rows} to ${MIN_ROWS}..${MAX_ROWS}`));
    }
  } else if (raw.rows !== undefined) {
    problems.push(problem(`${path}.rows`, `expected a number; using ${DEFAULT_ROWS}`));
  }
  return layout;
}

/** Trim, and cap the length of a name-shaped string that ends up in the DOM. */
function capName(value, limit, path, field, problems) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  problems.push(problem(`${path}.${field}`, `longer than ${limit} characters; truncated`));
  return trimmed.slice(0, limit);
}

function normalizePanel(raw, path, index, ids, problems) {
  if (!isPlainObject(raw)) {
    problems.push(problem(path, `expected an object, got ${describe(raw)}; dropped`));
    return null;
  }
  if (typeof raw.widget !== "string" || raw.widget.trim() === "") {
    problems.push(problem(`${path}.widget`, "missing a widget type; panel dropped"));
    return null;
  }

  let id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : "";
  if (id) {
    id = capName(id, MAX_NAME_CHARS, path, "id", problems);
    if (ids.taken.has(id)) {
      let suffix = 2;
      while (ids.taken.has(`${id}-${suffix}`)) suffix++;
      problems.push(problem(`${path}.id`, `"${id}" is already used; renamed to "${id}-${suffix}"`));
      id = `${id}-${suffix}`;
    }
  } else {
    // Skip anything another panel declared for itself: a generated id must
    // never push an explicitly named panel off its own id, because that id is
    // what a config change is written through.
    let n = index + 1;
    while (ids.taken.has(`panel-${n}`) || ids.declared.has(`panel-${n}`)) n++;
    id = `panel-${n}`;
    problems.push(problem(`${path}.id`, `missing; using "${id}"`));
  }
  ids.taken.add(id);

  const panel = {
    id,
    widget: capName(raw.widget, MAX_WIDGET_TYPE_CHARS, path, "widget", problems),
    config: {},
    layout: normalizeLayout(raw.layout, `${path}.layout`, problems),
  };
  if (typeof raw.title === "string" && raw.title.trim() !== "") {
    panel.title = capName(raw.title, MAX_NAME_CHARS, path, "title", problems);
  } else if (raw.title !== undefined) {
    problems.push(problem(`${path}.title`, "expected a non-empty string; using the widget label"));
  }
  if (isPlainObject(raw.config)) {
    const config = copyConfig(raw.config);
    if (config === null) {
      problems.push(
        problem(`${path}.config`, "too large or too deeply nested to keep; using an empty config"),
      );
    } else {
      panel.config = config;
    }
  } else if (raw.config !== undefined) {
    problems.push(problem(`${path}.config`, `expected an object, got ${describe(raw.config)}`));
  }

  // Provenance. Nothing renders it yet -- it is here so that an agent which
  // curates the dashboard later can say who added a panel and why, and why the
  // user pinned it, without a schema migration.
  if (typeof raw.addedBy === "string" && ADDED_BY.has(raw.addedBy)) {
    panel.addedBy = raw.addedBy;
  } else if (raw.addedBy !== undefined) {
    problems.push(problem(`${path}.addedBy`, "expected user, agent or preset; dropped"));
  }
  if (typeof raw.reason === "string" && raw.reason.trim() !== "") {
    panel.reason = raw.reason.trim().slice(0, MAX_REASON_CHARS);
  } else if (raw.reason !== undefined) {
    problems.push(problem(`${path}.reason`, "expected a non-empty string; dropped"));
  }
  if (typeof raw.pinned === "boolean") {
    panel.pinned = raw.pinned;
  } else if (raw.pinned !== undefined) {
    problems.push(problem(`${path}.pinned`, "expected a boolean; dropped"));
  }

  return panel;
}

function normalizeDashboard(raw, path, index, seenIds, problems) {
  if (!isPlainObject(raw)) {
    problems.push(problem(path, `expected an object, got ${describe(raw)}; dropped`));
    return null;
  }

  let id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : "";
  if (!id) {
    id = `dashboard-${index + 1}`;
    problems.push(problem(`${path}.id`, `missing; using "${id}"`));
  } else {
    id = capName(id, MAX_NAME_CHARS, path, "id", problems);
  }
  if (seenIds.has(id)) {
    let suffix = 2;
    while (seenIds.has(`${id}-${suffix}`)) suffix++;
    problems.push(problem(`${path}.id`, `"${id}" is already used; renamed to "${id}-${suffix}"`));
    id = `${id}-${suffix}`;
  }
  seenIds.add(id);

  let title = "Dashboard";
  if (typeof raw.title === "string" && raw.title.trim() !== "") {
    title = capName(raw.title, MAX_NAME_CHARS, path, "title", problems);
  } else if (raw.title !== undefined) {
    problems.push(problem(`${path}.title`, 'expected a non-empty string; using "Dashboard"'));
  }

  let rawPanels = Array.isArray(raw.panels) ? raw.panels : [];
  if (!Array.isArray(raw.panels) && raw.panels !== undefined) {
    problems.push(problem(`${path}.panels`, `expected an array, got ${describe(raw.panels)}`));
  }
  if (rawPanels.length > MAX_PANELS) {
    problems.push(
      problem(`${path}.panels`, `${rawPanels.length} panels; keeping the first ${MAX_PANELS}`),
    );
    rawPanels = rawPanels.slice(0, MAX_PANELS);
  }

  // Collect every id a panel declares for itself before assigning any, so a
  // generated fallback cannot steal one that appears later in the list.
  const declared = new Set();
  for (const rawPanel of rawPanels) {
    if (isPlainObject(rawPanel) && typeof rawPanel.id === "string" && rawPanel.id.trim() !== "") {
      declared.add(rawPanel.id.trim().slice(0, MAX_NAME_CHARS));
    }
  }
  const ids = { declared, taken: new Set() };
  const panels = [];
  rawPanels.forEach((rawPanel, i) => {
    const panel = normalizePanel(rawPanel, `${path}.panels[${i}]`, i, ids, problems);
    if (panel) panels.push(panel);
  });

  return { id, title, panels };
}

/**
 * Normalize an untrusted value into a dashboard document.
 *
 * `{ok: true}` carries the document plus every repair that was made.
 * `{ok: false}` means the input could not be repaired into anything meaningful:
 * it was not an object, it had no usable version, or its version is newer than
 * this build. Callers fall back to the default document and, per the design,
 * leave the file on disk alone.
 */
export function validateDashboardDocument(input) {
  // "Never throws" is a promise the callers rely on -- `parseDashboardDocument`
  // is awaited with no try/catch, so a throw here becomes an unhandled
  // rejection and a silently empty dashboard. The bounded walks below should
  // make this unreachable; this is the backstop that keeps the promise true
  // whatever a future edit does.
  try {
    return normalizeDocument(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [problem("", `could not be read: ${message}`)] };
  }
}

function normalizeDocument(input) {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      problems: [problem("", `expected a dashboard document object, got ${describe(input)}`)],
    };
  }

  const version = input.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return {
      ok: false,
      problems: [problem("version", `expected a schema version, got ${describe(version)}`)],
    };
  }
  if (version > DASHBOARD_SCHEMA_VERSION) {
    return {
      ok: false,
      problems: [
        problem(
          "version",
          `schema version ${version} is newer than this build understands (${DASHBOARD_SCHEMA_VERSION})`,
        ),
      ],
    };
  }

  const problems = [];
  let rawDashboards = Array.isArray(input.dashboards) ? input.dashboards : [];
  if (!Array.isArray(input.dashboards)) {
    problems.push(problem("dashboards", `expected an array, got ${describe(input.dashboards)}`));
  }
  if (rawDashboards.length > MAX_DASHBOARDS) {
    problems.push(
      problem(
        "dashboards",
        `${rawDashboards.length} dashboards; keeping the first ${MAX_DASHBOARDS}`,
      ),
    );
    rawDashboards = rawDashboards.slice(0, MAX_DASHBOARDS);
  }

  const seenIds = new Set();
  const dashboards = [];
  rawDashboards.forEach((raw, i) => {
    const dashboard = normalizeDashboard(raw, `dashboards[${i}]`, i, seenIds, problems);
    if (dashboard) dashboards.push(dashboard);
  });

  if (dashboards.length === 0) {
    problems.push(problem("dashboards", "no usable dashboards; using the default"));
    dashboards.push(dashboardFromPreset(DEFAULT_PRESET_ID));
  }

  let activeId = typeof input.activeId === "string" ? input.activeId.trim() : "";
  if (!dashboards.some((d) => d.id === activeId)) {
    if (input.activeId !== undefined) {
      problems.push(
        problem(
          "activeId",
          `${activeId ? `"${activeId}"` : describe(input.activeId)} is not a dashboard in this document; using "${dashboards[0].id}"`,
        ),
      );
    }
    activeId = dashboards[0].id;
  }

  return {
    ok: true,
    document: { version: DASHBOARD_SCHEMA_VERSION, activeId, dashboards },
    problems,
  };
}

/** JSON text -> validated document. Same total-function guarantee. */
export function parseDashboardDocument(raw) {
  if (typeof raw !== "string") {
    return { ok: false, problems: [problem("", `expected JSON text, got ${describe(raw)}`)] };
  }
  if (raw.trim() === "") {
    return { ok: false, problems: [problem("", "empty")] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [problem("", `not valid JSON: ${message}`)] };
  }
  return validateDashboardDocument(parsed);
}
