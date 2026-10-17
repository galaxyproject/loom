/**
 * The core imports no flavor: no other workspace package, by path or by name, and none of the packages
 * only a visualization flavor needs. A kind, tool or renderer that needs one of these belongs in
 * the flavor that adds it. Olit's name itself still appears in the core; LAYOUT.md's "Not split
 * yet" says where and why.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { specifiers } from "./flavor-boundary";

const CORE = join(__dirname, "..");
const SHARED = resolve(CORE, "..", "..", "shared");
const RENDERER = resolve(CORE, "..", "..", "app", "src", "renderer");
const FLAVOR_ONLY = [
  "galaxy-charts",
  "galaxy-charts-xml-parser",
  "vega",
  "vega-lite",
  "vega-embed",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return ["node_modules", "skills"].includes(name) ? [] : sources(path);
    }
    return /\.(ts|js)$/.test(name) ? [path] : [];
  });
}

/** The workspace's other packages: every flavor, by folder and by package name. */
const FLAVORS = (
  JSON.parse(readFileSync(join(CORE, "..", "package.json"), "utf8")).workspaces as string[]
)
  .filter((folder) => folder !== "core")
  .map((folder) => ({
    folder,
    name: JSON.parse(readFileSync(join(CORE, "..", folder, "package.json"), "utf8")).name as string,
  }));

function flavored(file: string, spec: string): string | undefined {
  if (spec.startsWith(".")) {
    const target = relative(join(CORE, ".."), resolve(dirname(file), spec));
    const flavor = FLAVORS.find((f) => target === f.folder || target.startsWith(`${f.folder}/`));
    return flavor ? `a path into ${flavor.folder}/` : undefined;
  }
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const flavor = FLAVORS.find((f) => f.name === name);
  if (flavor) return `the ${flavor.folder} package`;
  return FLAVOR_ONLY.includes(name) ? `${name}, which only a visualization flavor uses` : undefined;
}

const inShared = (path: string) => path.startsWith(`${SHARED}/`);

function resolved(file: string, spec: string): string {
  const path = resolve(dirname(file), spec);
  return existsSync(path) || !existsSync(`${path}.js`) ? path : `${path}.js`;
}

/** The renderer source a relative import names: `.js` specifiers there are compiled from `.ts`. */
function rendererSource(path: string): string | undefined {
  return [path, path.replace(/\.js$/, ".ts"), `${path}.ts`].find(
    (candidate) => /\.(ts|js)$/.test(candidate) && existsSync(candidate),
  );
}

/**
 * The shared modules `files` import, directly or through Orbit's renderer, which the core
 * mounts and so ships alongside its own code.
 */
function sharedImports(files: string[]): string[] {
  const queue = [...files];
  const seen = new Set<string>();
  const found = new Set<string>();
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const path = resolved(file, spec);
      if (inShared(path)) {
        found.add(path);
      } else if (path.startsWith(`${RENDERER}/`)) {
        const source = rendererSource(path);
        if (source) queue.push(source);
      }
    }
  }
  return [...found];
}

/**
 * What the shared modules reachable from `start` name that a browser can't load: a node:
 * builtin, a bare package (which a browser-only install doesn't have), or a path out of shared/.
 */
function unloadable(start: string[]): string[] {
  const queue = [...start];
  const seen = new Set<string>();
  const found: string[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const where = relative(join(SHARED, ".."), file);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) {
        found.push(
          `${where}: ${spec} (${spec.startsWith("node:") ? "a node builtin" : "a package"})`,
        );
      } else if (inShared(resolved(file, spec))) {
        queue.push(resolved(file, spec));
      } else {
        found.push(`${where}: ${spec} (a path out of shared/)`);
      }
    }
  }
  return found;
}

describe("the core", () => {
  it("imports no flavor and nothing only a flavor needs", () => {
    // This file's own fixtures name the reaches on purpose.
    const found = sources(CORE)
      .filter((file) => file !== __filename)
      .flatMap((file) =>
        specifiers(readFileSync(file, "utf8")).flatMap((spec) => {
          const why = flavored(file, spec);
          return why ? [`${relative(CORE, file)}: ${spec} (${why})`] : [];
        }),
      );
    expect(found).toEqual([]);
  });

  it("reaches only shared modules a browser can load, all the way down", () => {
    // Shipped code only: build scripts and tests run in Node and may use what they like.
    const shipped = sources(join(CORE, "src")).filter((file) => !/\.test\.ts$/.test(file));
    const reached = sharedImports(shipped);
    // Pin both ways in: the agent's direct imports, and the contracts reached only through Orbit's
    // chat panel, which a walk that stopped at the core's own imports would miss.
    expect(reached).toEqual(
      expect.arrayContaining([
        join(SHARED, "confusables.js"),
        join(SHARED, "sra-import.js"),
        join(SHARED, "record-excerpt.js"),
        join(SHARED, "galaxy-page-cells.js"),
        join(SHARED, "redirect-guard.js"),
        join(SHARED, "skills-router.js"),
        join(SHARED, "galaxy-guidance.js"),
        join(SHARED, "gtn.js"),
        join(SHARED, "prompt-blocks.js"),
        join(SHARED, "team-dispatch-contract.js"),
        join(SHARED, "loom-shell-contract.js"),
      ]),
    );
    expect(unloadable(reached)).toEqual([]);
    // The walk itself, started at a shared module that is Node-only.
    expect(unloadable([join(SHARED, "loom-config.js")])).toContain(
      "shared/loom-config.js: node:fs (a node builtin)",
    );
  });

  it("catches each way of naming one", () => {
    const file = join(CORE, "src", "shell.ts");
    expect(flavored(file, "../../olit/src/agent/flavor")).toBeDefined();
    expect(flavored(file, "@galaxyproject/olit")).toBeDefined();
    expect(flavored(file, "vega-embed")).toBeDefined();
    expect(flavored(file, "galaxy-charts/runtime")).toBeDefined();
    expect(flavored(file, "vegafusion")).toBeUndefined();
    expect(flavored(file, "./artifacts/kinds")).toBeUndefined();
    expect(
      specifiers(
        [
          'new Worker(new URL("../../olit/src/worker.ts", import.meta.url));',
          'import.meta.glob("../../olit/src/agent/skills/**/*");',
          'import.meta.glob(["./skills/**/*", "../../olit/src/agent/skills/**/*"]);',
          'vi.importActual("../../olit/src/agent/flavor");',
          'vi.doMock("vega-embed");',
          "import(`../../olit/src/main`);",
          "import(`./${name}`);",
        ].join("\n"),
      ),
    ).toEqual([
      "../../olit/src/worker.ts",
      "../../olit/src/agent/flavor",
      "vega-embed",
      "../../olit/src/main",
      "../../olit/src/agent/skills/**/*",
      "./skills/**/*",
      "../../olit/src/agent/skills/**/*",
    ]);
  });
});
