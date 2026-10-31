/**
 * Weaker models send an object or array argument as JSON text -- run_tool `inputs: "{...}"`,
 * loom_propose `target: "{...}"` -- and pi's schema check rejects every such call before it runs,
 * so the model retries the same shape until the turn times out. pi has no object or array case
 * in its own coercion, so this parses the text back, only where the schema wants a container and
 * refuses a string, and only when the text parses to that container.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Schema = Record<string, unknown>;
type Container = "object" | "array";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function branches(schema: Schema): Schema[] {
  const out: Schema[] = [];
  for (const key of ["anyOf", "oneOf"] as const) {
    const list = schema[key];
    if (Array.isArray(list)) out.push(...list.filter(isObject));
  }
  return out;
}

function typesOf(schema: Schema): string[] {
  const t = schema.type;
  return typeof t === "string"
    ? [t]
    : Array.isArray(t)
      ? t.filter((x) => typeof x === "string")
      : [];
}

// $ref is not followed: no Orbit or galaxy-ops schema uses one, and an unresolved reference
// accepts nothing this walker can see, so it is left for pi to judge.
function isOpen(schema: Schema): boolean {
  return (
    typesOf(schema).length === 0 &&
    branches(schema).length === 0 &&
    !Array.isArray(schema.allOf) &&
    !("properties" in schema) &&
    !("items" in schema) &&
    !("const" in schema) &&
    !("enum" in schema) &&
    !("$ref" in schema)
  );
}

function acceptsString(schema: Schema): boolean {
  if (isOpen(schema)) return true;
  if (typesOf(schema).includes("string")) return true;
  if (typeof schema.const === "string") return true;
  if (Array.isArray(schema.enum) && schema.enum.some((v) => typeof v === "string")) return true;
  return branches(schema).some(acceptsString);
}

function accepts(schema: Schema, kind: Container): boolean {
  const types = typesOf(schema);
  if (types.includes(kind)) return true;
  if (types.length === 0 && (kind === "object" ? "properties" in schema : "items" in schema))
    return true;
  return branches(schema).some((b) => !isOpen(b) && accepts(b, kind));
}

/** The schemas that describe a value of this container kind, allOf parts included. */
function shapesFor(schema: Schema, kind: Container): Schema[] {
  const own =
    typesOf(schema).includes(kind) ||
    (kind === "object" ? "properties" in schema : "items" in schema);
  const out: Schema[] = own ? [schema] : [];
  if (Array.isArray(schema.allOf))
    for (const part of schema.allOf.filter(isObject)) out.push(...shapesFor(part, kind));
  const branch = branches(schema).find((b) => !isOpen(b) && accepts(b, kind));
  if (branch) out.push(...shapesFor(branch, kind));
  return out;
}

function childOf(shapes: Schema[], key: string): Schema | undefined {
  for (const shape of shapes) {
    const props = shape.properties;
    if (isObject(props) && isObject(props[key])) return props[key];
  }
  for (const shape of shapes)
    if (isObject(shape.additionalProperties)) return shape.additionalProperties;
  return undefined;
}

function itemOf(shapes: Schema[], index: number): Schema | undefined {
  for (const shape of shapes) {
    const items = shape.items;
    if (isObject(items)) return items;
    if (Array.isArray(items) && isObject(items[index])) return items[index];
  }
  return undefined;
}

function parseContainer(text: string, schema: Schema): unknown {
  if (isOpen(schema) || acceptsString(schema)) return undefined;
  const trimmed = text.trim();
  const kind: Container | undefined = trimmed.startsWith("{")
    ? "object"
    : trimmed.startsWith("[")
      ? "array"
      : undefined;
  if (!kind || !accepts(schema, kind)) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (kind === "object" ? isObject(parsed) : Array.isArray(parsed)) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function coerce(schema: Schema | undefined, value: unknown): unknown {
  if (!schema) return value;
  if (typeof value === "string") {
    const parsed = parseContainer(value, schema);
    return parsed === undefined ? value : coerce(schema, parsed);
  }
  if (Array.isArray(value)) {
    const shapes = shapesFor(schema, "array");
    if (shapes.length === 0) return value;
    let out: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = coerce(itemOf(shapes, i), item);
      if (next !== item) (out ??= [...value])[i] = next;
    });
    return out ?? value;
  }
  if (isObject(value)) {
    const shapes = shapesFor(schema, "object");
    if (shapes.length === 0) return value;
    let out: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(value)) {
      const next = coerce(childOf(shapes, key), child);
      if (next !== child) (out ??= { ...value })[key] = next;
    }
    return out ?? value;
  }
  return value;
}

/**
 * `args` with each JSON-text value parsed where the schema wants an object or array and takes no
 * string. Never mutates `args`, and hands back the same reference when nothing changed, which is
 * how pi tells that prepareArguments left a call alone.
 */
export function coerceJsonStringArgs(schema: unknown, args: unknown): unknown {
  return isObject(schema) ? coerce(schema, args) : args;
}

/** Give every tool registered through `pi` the coercion, ahead of its own prepareArguments. */
export function withJsonStringArgs(pi: ExtensionAPI): void {
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) =>
    register({
      ...tool,
      prepareArguments: (args: unknown) => {
        const coerced = coerceJsonStringArgs(tool.parameters, args);
        return tool.prepareArguments ? tool.prepareArguments(coerced) : (coerced as never);
      },
    });
}
