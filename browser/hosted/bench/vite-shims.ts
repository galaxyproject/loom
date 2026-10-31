/**
 * The two Vite-only constructs on the boot path, done the way Vite does them, for a Node build:
 * core's skills.ts reads its packaged skills through an eager import.meta.glob, and python.ts
 * imports its realm with ?raw. Only the shapes those files use are handled.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const GLOB = /import\.meta\.glob\(\s*["'](\.\/[^"'*]+)\/\*\*\/\*["']\s*,\s*\{[^}]*\}\s*\)/g;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}

/** Replace each eager, ?raw, default-import glob of `./dir/**\/*` with the files' text. */
export function inlineGlobs(source: string, fileDir: string): string {
  return source.replace(GLOB, (_m, base: string) => {
    const root = resolve(fileDir, base);
    const entries = walk(root).map((file) => [
      `./${relative(fileDir, file)}`,
      readFileSync(file, "utf8"),
    ]);
    return `(${JSON.stringify(Object.fromEntries(entries))})`;
  });
}

export const RAW = /\?raw$/;

export const rawModule = (file: string) =>
  `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
