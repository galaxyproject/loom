/**
 * The rule every flavor is held to: it reaches the core only through the package's exports, never
 * a relative path out of its own folder, never Orbit's renderer, never a path inside the package.
 * A flavor's boundary test runs flavorTrespasses over its own folder.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const CORE_PACKAGE = "@galaxyproject/orbit-browser";
// __dirname rather than import.meta.url, which a happy-dom test run doesn't give as a file URL.
const MANIFEST = join(__dirname, "..", "package.json");
const EXPORTS = Object.keys(JSON.parse(readFileSync(MANIFEST, "utf8")).exports);

/** A flavor's own sources: not what it installs, builds or snapshots. */
export function sources(dir: string, skip: string[] = [], ext = /\.(ts|js)$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return ["node_modules", "static", "dist", "skills", "__surface__", ...skip].includes(name)
        ? []
        : sources(path, skip, ext);
    }
    return ext.test(name) ? [path] : [];
  });
}

/** import.meta.glob takes one pattern or an array of them, and any of them can reach out. */
const GLOB = /\bimport\.meta\.glob\(\s*(\[[^\]]*\]|(["'`])[^"'`]*\2)/g;
const QUOTED = /(["'`])([^"'`$]+)\1/g;

/**
 * Every module a file names: imports, re-exports, dynamic imports, mocks, augmentations, worker
 * URLs and globs. A template with `${...}` in it can't be resolved here, so it is skipped.
 */
export function specifiers(text: string): string[] {
  const found = text.matchAll(
    /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\bnew\s+URL\(\s*|\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*|\bdeclare module\s+)(["'`])([^"'`$]+)\1/g,
  );
  const globbed = [...text.matchAll(GLOB)].flatMap((m) => [...m[1].matchAll(QUOTED)]);
  return [...found, ...globbed].map((m) => m[2]);
}

/** The text without its type-only imports, which the build erases. */
export function withoutTypeImports(text: string): string {
  return text
    .replace(/\b(?:import|export)\s+type\s[\s\S]*?from\s*["'][^"']+["']\s*;?/g, "")
    .replace(
      /\bimport\s*\{\s*(?:type\s+\w+(?:\s+as\s+\w+)?\s*,?\s*)+\}\s*from\s*["'][^"']+["']\s*;?/g,
      "",
    );
}

/** Why `spec`, named by `file` in the flavor at `root`, reaches past the core's exports. */
export function trespass(root: string, file: string, spec: string): string | undefined {
  if (spec.includes("app/src/renderer")) {
    return "Orbit's renderer belongs to the core";
  }
  if (spec.startsWith(".")) {
    // Named outright as well as resolved: a path that means the core is wrong from anywhere.
    if (/^(\.\.?\/)+core\//.test(spec)) {
      return "a relative path to the core";
    }
    const target = relative(root, resolve(dirname(file), spec));
    return target.startsWith("..") ? "a relative path out of the flavor" : undefined;
  }
  if (spec === CORE_PACKAGE || spec.startsWith(`${CORE_PACKAGE}/`)) {
    const entry = `.${spec.slice(CORE_PACKAGE.length)}`;
    return EXPORTS.includes(entry) ? undefined : `${entry} is not one of the core's exports`;
  }
  return undefined;
}

/** Every reach past the core's exports in the flavor at `root`, as "file: spec (why)". */
export function flavorTrespasses(root: string, except: string[] = []): string[] {
  return sources(root)
    .filter((file) => !except.includes(file))
    .flatMap((file) =>
      specifiers(readFileSync(file, "utf8")).flatMap((spec) => {
        const why = trespass(root, file, spec);
        return why ? [`${relative(root, file)}: ${spec} (${why})`] : [];
      }),
    );
}
