import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

// The browser suite only runs when browser/ changes, so a skills bump that touches just the
// manifest and Orbit's vendor tree would leave the browser's committed lock behind unnoticed.
describe("browser skills lock", () => {
  it("pins the galaxy-skills commit Orbit vendors as skills", () => {
    const manifest = read("extensions/orbit/vendor/skills/_manifest.json");
    const plugin = manifest.plugins.find((p: { repo?: string }) => p.repo === "galaxy-skills");
    const repo = plugin.upstream.repository
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "");
    const lock = read("browser/core/skills.lock.json");
    expect(
      { repo: lock.repo, sha: lock.sha },
      "browser/core/skills.lock.json is behind Orbit's skills manifest -- run node browser/core/scripts/install_skills.js and commit the lock",
    ).toEqual({ repo, sha: plugin.upstream.commit });
  });
});
