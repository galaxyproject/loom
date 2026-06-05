/**
 * Minimal .env loader for the eval runner. Reads evals/.env (gitignored) if
 * present and sets any unset variables in process.env. Lines like KEY=value;
 * blanks and `#`-comments ignored; surrounding quotes on the value stripped.
 *
 * Tiny on purpose -- the eval runner needs at most a handful of creds, and
 * pulling in dotenv just for that doesn't earn its keep.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const evalsDir = path.resolve(path.dirname(__filename), "..");

export function loadDotEnv(): void {
  const envPath = path.join(evalsDir, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
