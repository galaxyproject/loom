/**
 * Per-panel settings, for someone who will never edit JSON.
 *
 * `WidgetDefinition` has no schema for its config -- only a `defaultConfig`
 * object -- so that object is the schema we have. Every key whose default is a
 * boolean, a number or a string gets a real control; anything else, and any key
 * the widget did not declare, is only reachable through the raw JSON editor,
 * and the form says so rather than pretending those settings are not there.
 *
 * The parsing and shaping live here as pure functions so the rules are testable
 * without a DOM.
 */

export type ConfigFieldKind = "boolean" | "number" | "string";

export interface ConfigField {
  key: string;
  /** `maxRows` -> `Max rows`. The widget author's key is all the label we have. */
  label: string;
  kind: ConfigFieldKind;
  value: boolean | number | string;
}

export type ConfigParse =
  { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `follow` -> `Follow`, `maxRows` -> `Max rows`, `tail_lines` -> `Tail lines`. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The controls to draw, in the widget author's declaration order. The current
 * value wins when it is the same kind as the default; a value of a different
 * kind is left to the JSON editor rather than silently coerced.
 */
export function describeConfigFields(
  defaultConfig: Record<string, unknown>,
  config: Record<string, unknown>,
): ConfigField[] {
  const fields: ConfigField[] = [];
  for (const key of Object.keys(defaultConfig ?? {})) {
    const fallback = defaultConfig[key];
    const kind =
      typeof fallback === "boolean"
        ? "boolean"
        : typeof fallback === "number" && Number.isFinite(fallback)
          ? "number"
          : typeof fallback === "string"
            ? "string"
            : null;
    if (!kind) continue;

    const current = config?.[key];
    const usable =
      (kind === "boolean" && typeof current === "boolean") ||
      (kind === "number" && typeof current === "number" && Number.isFinite(current)) ||
      (kind === "string" && typeof current === "string");
    fields.push({
      key,
      label: humanizeKey(key),
      kind,
      value: (usable ? current : fallback) as boolean | number | string,
    });
  }
  return fields;
}

/**
 * Keys the generated form cannot represent: a value the widget did not declare,
 * or one whose default is an object or an array. Their presence is what the
 * form discloses before sending someone to the JSON editor.
 */
export function unsupportedConfigKeys(
  defaultConfig: Record<string, unknown>,
  config: Record<string, unknown>,
): string[] {
  const covered = new Set(describeConfigFields(defaultConfig, config).map((f) => f.key));
  return Object.keys(config ?? {}).filter((key) => !covered.has(key));
}

/** JSON text from the raw editor. Empty means "no settings", not an error. */
export function parseConfigJson(text: string): ConfigParse {
  if (text.trim() === "") return { ok: true, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `That is not valid JSON: ${message}` };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: 'Settings have to be a JSON object, like { "follow": true }.',
    };
  }
  return { ok: true, config: parsed };
}

/** Apply one generated control's value over the config it came from. */
export function applyFieldValue(
  config: Record<string, unknown>,
  key: string,
  value: boolean | number | string,
): Record<string, unknown> {
  return { ...config, [key]: value };
}

export function formatConfigJson(config: Record<string, unknown>): string {
  try {
    return JSON.stringify(config ?? {}, null, 2);
  } catch {
    return "{}";
  }
}
