/**
 * What the skills router is allowed to cost, and what it is not allowed to name.
 *
 * The rendered section is assembled into the system prompt and paid on every
 * cached turn, so it is the one place where "vendor more content" turns into a
 * recurring bill. Foundry casts are reached through hints and commands instead;
 * nothing about them belongs here, whatever the manifest grows to hold.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSkillsContext, renderSkillsSection } from "../extensions/loom/context";
import { readVendorManifest } from "../extensions/loom/vendor-skills";
import { DEFAULT_SKILLS } from "../shared/loom-config.js";

const REPOS = (DEFAULT_SKILLS as ReadonlyArray<{ name: string; url: string; branch: string }>).map(
  (d) => ({ name: d.name, url: d.url, branch: d.branch }),
);
const BUNDLED = new Set(REPOS.map((r) => r.name));

/**
 * The section a default install actually gets, assembled the way the system
 * prompt assembles it: real config on disk, real repo resolution, real catalog
 * lookup. Rendering from hand-picked inputs would measure the renderer and not
 * the thing that is paid for on every turn.
 */
function renderDefaultRouter(): string {
  return buildSkillsContext();
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-router-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
  fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".loom", "config.json"),
    JSON.stringify({ skills: { repos: REPOS.map((r) => ({ ...r, enabled: true })) } }),
    "utf-8",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Room for a few more skills over what a default install renders today, and
// nowhere near enough for a cast allowlist to slip in unnoticed: the twelve
// casts alone would be several times this. Raise it deliberately when upstream
// tags a skill for this surface; do not raise it to make a leak go away.
const ROUTER_BUDGET_BYTES = 6144;

describe("the rendered skills router", () => {
  it("stays inside its byte budget", () => {
    const size = Buffer.byteLength(renderDefaultRouter(), "utf-8");
    expect(size).toBeGreaterThan(0);
    expect(
      size,
      `the rendered router is ${size} bytes against a ${ROUTER_BUDGET_BYTES} budget. If upstream ` +
        `tagged another skill for this surface, raise the budget. If a Foundry cast has reached ` +
        `the router, that is the bug.`,
    ).toBeLessThanOrEqual(ROUTER_BUDGET_BYTES);
  });

  it("names nothing from a plugin that is kept out of the router", () => {
    // Everything bundled outside the catalog -- every cast and every reference
    // note under it -- must be unreachable from the prompt, because anything
    // named here is paid for on every turn of every session. Driven off the
    // manifest so it keeps holding as the vendored set grows.
    const manifest = readVendorManifest()!;
    const routed = new Set(
      (manifest.plugins ?? []).filter((p) => p.router === "catalog").map((p) => p.plugin),
    );
    const offLimits = new Set(
      manifest.files
        .filter((f) => !routed.has(f.plugin))
        .map((f) => f.target.split("/")[0])
        .filter(Boolean),
    );
    expect(offLimits.size).toBeGreaterThan(0);
    const rendered = renderDefaultRouter();
    expect([...offLimits].filter((name) => rendered.includes(name))).toEqual([]);
  });

  it("says the catalog is bundled when every repo is, and does not promise a refresh", () => {
    const rendered = renderDefaultRouter();
    expect(rendered).toContain("ships with Loom");
    expect(rendered).not.toContain("refreshes each session");
    expect(rendered).toContain("(bundled)");
  });

  it("goes back to the network wording as soon as one repo is live", () => {
    const live = [
      ...REPOS,
      { name: "wip", url: "https://github.com/galaxyproject/wip", branch: "x" },
    ];
    const entries = new Map(live.map((r) => [r.name, [] as never[]]));
    const rendered = renderSkillsSection(live, entries, BUNDLED);
    expect(rendered).toContain("refreshes each session");
    expect(rendered).toContain("branch: x");
  });
});
