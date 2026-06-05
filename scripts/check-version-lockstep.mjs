// Fail the release if root and app/ package.json versions disagree -- the CLI's
// --version must never report a different number than the Orbit build shipped
// alongside it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootV = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
const appV = JSON.parse(readFileSync(join(root, "app", "package.json"), "utf-8")).version;

if (rootV !== appV) {
  console.error(`Version mismatch: root package.json is ${rootV} but app/package.json is ${appV}.`);
  process.exit(1);
}
console.log(`Versions in lockstep: ${rootV}`);
