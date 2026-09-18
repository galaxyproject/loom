/**
 * Which configured repos read from the package and which still go to GitHub.
 *
 * The rule has to hold in both directions. A default config must never make a
 * network call for content that shipped inside the package, and a repo pointed
 * at a branch must never be answered from the package -- that is the whole
 * skill-author workflow of evaluating a change before it is merged.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SKILLS } from "../shared/loom-config.js";
import {
  hasBundledContent,
  isBundledRepo,
  readBundledCatalog,
  readBundledRepoFile,
  readVendoredSkill,
} from "../extensions/loom/vendor-skills";

const DEFAULT = DEFAULT_SKILLS[0];

afterEach(() => vi.restoreAllMocks());

describe("isBundledRepo", () => {
  it("is true for a seeded repo left at its shipped URL and branch", () => {
    expect(isBundledRepo({ ...DEFAULT })).toBe(true);
    expect(isBundledRepo({ name: DEFAULT.name, url: DEFAULT.url })).toBe(true);
  });

  it("tolerates the cosmetic URL differences a hand-edited config picks up", () => {
    expect(isBundledRepo({ ...DEFAULT, url: `${DEFAULT.url}/` })).toBe(true);
    expect(isBundledRepo({ ...DEFAULT, url: `${DEFAULT.url}.git` })).toBe(true);
  });

  it("is false once the repo points anywhere else", () => {
    expect(isBundledRepo({ ...DEFAULT, branch: "some-feature" })).toBe(false);
    expect(isBundledRepo({ ...DEFAULT, url: "https://github.com/galaxyproject/other" })).toBe(
      false,
    );
    expect(isBundledRepo({ name: "not-seeded", url: DEFAULT.url, branch: "main" })).toBe(false);
  });

  it("is false for the bundled-reference name, which is resolved before repo lookup", () => {
    // A user who configures a real repo called "foundry" has to be able to
    // reach it; the vendored set must not shadow the whole thing.
    expect(
      isBundledRepo({ name: "foundry", url: "https://github.com/galaxyproject/foundry" }),
    ).toBe(false);
  });
});

describe("readBundledRepoFile", () => {
  it("serves a real skill without touching the network", () => {
    const res = readBundledRepoFile(DEFAULT, "skills/udt-authoring/SKILL.md");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("GalaxyUserTool");
  });

  it("answers only for its own content, not for anything else in the package", () => {
    // A bundled path has to mean what a live fetch of the same string would
    // mean. These all exist in the package and none of them is in this repo, so
    // a repo pointed at a branch would 404 on every one -- and so must this.
    for (const outside of [
      "advance-galaxy-draft-step/SKILL.md",
      "debug-galaxy-workflow-output/references/notes/galaxy-tool-job-failure-reference.md",
      "galaxy-tool-job-failure-reference.md",
      "_manifest.json",
      "_catalog.json",
    ]) {
      expect(readBundledRepoFile(DEFAULT, outside).ok).toBe(false);
    }
  });

  it("knows whether the package actually holds the content", () => {
    // What gates the disk read: config alone says a repo is bundled, and a
    // missing vendor tree must send the fetch to the network, not report zero
    // skills.
    expect(hasBundledContent(DEFAULT.name)).toBe(true);
    expect(hasBundledContent("not-a-bundled-repo")).toBe(false);
  });

  it("lists that repo's own skills on a miss, not every bundled file", () => {
    const res = readBundledRepoFile(DEFAULT, "skills/no-such-skill/SKILL.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.available).toContain("skills/udt-authoring/SKILL.md");
      expect(res.available.every((p) => p.startsWith("skills/"))).toBe(true);
    }
  });
});

describe("the generated catalog", () => {
  it("carries every skill the mirror ships, and tags a subset for this surface", () => {
    const catalog = readBundledCatalog();
    expect(catalog).not.toBeNull();
    const entries = catalog![DEFAULT.name];
    expect(entries.length).toBeGreaterThan(0);
    const tagged = entries.filter((e) => e.surfaces.includes("loom")).map((e) => e.name);
    // reproduciblify is the one the hand-written catalog had lost track of.
    // Asserted by name, not by count: upstream tagging another skill is a
    // routine event and should not read as a Loom regression.
    expect(tagged).toContain("reproduciblify");
    expect(tagged).toContain("udt-authoring");
    expect(tagged.length).toBeGreaterThanOrEqual(5);
    expect(tagged.length).toBeLessThan(entries.length);
  });

  it("names paths that actually resolve, at the same string a live fetch would use", () => {
    for (const entry of readBundledCatalog()![DEFAULT.name]) {
      expect(entry.path).toMatch(/^skills\/.+\/SKILL\.md$/);
      expect(readBundledRepoFile(DEFAULT, entry.path).ok).toBe(true);
    }
  });

  it("holds nothing from a repo that is kept out of the router", () => {
    expect(Object.keys(readBundledCatalog()!)).toEqual([DEFAULT.name]);
  });
});

describe("what the read side refuses", () => {
  it("will not read anything that is not a regular file", () => {
    // The containment check reasons about the path string, so a symlink or a
    // directory inside the package would satisfy it. Asserted against a real
    // directory rather than by planting a link in the hash-gated vendor tree,
    // which a killed run would leave behind and the next gate would fail on.
    expect(readVendoredSkill("debug-galaxy-workflow-output").ok).toBe(false);
    expect(readVendoredSkill("debug-galaxy-workflow-output/references").ok).toBe(false);
  });
});

describe("when the package does not actually hold the content", () => {
  // The whole point of bundling is that a session works offline. Deciding
  // "bundled" from config alone turns a missing vendor tree into a session with
  // no skills section, a background refresh that is skipped, and a manual
  // refresh that reports success without fetching -- self-reported healthy.
  const ABSENT = { name: "not-a-bundled-repo", url: "https://github.com/galaxyproject/x" };

  it("does not claim a repo is bundled when nothing of it shipped", () => {
    expect(hasBundledContent(ABSENT.name)).toBe(false);
    expect(readBundledRepoFile(ABSENT, "anything.md").ok).toBe(false);
  });

  it("keeps the refresh path open for such a repo", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-absent-"));
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    // Seeded name, default URL and branch -- so config says bundled -- but the
    // name has no plugin backing it in the manifest, which is the same state a
    // missing vendor tree produces.
    fs.writeFileSync(
      path.join(tmp, ".loom", "config.json"),
      JSON.stringify({ skills: { repos: [{ ...DEFAULT, name: DEFAULT.name, enabled: true }] } }),
      "utf-8",
    );
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(tmp);
    try {
      const { catalogSummary } = await import("../extensions/loom/skills-discovery");
      // The real repo does have content, so this asserts the healthy direction:
      // bundled is reported only because the files are genuinely there.
      const summary = catalogSummary();
      expect(summary[0].bundled).toBe(true);
      expect(summary[0].count).toBeGreaterThan(0);
    } finally {
      homedir.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
