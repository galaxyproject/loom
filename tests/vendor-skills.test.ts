import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  VENDOR_REPO_NAME,
  readVendorManifest,
  readVendoredSkill,
  resolveVendorPath,
  vendorSkillsDir,
} from "../extensions/loom/vendor-skills";

describe("vendored skills", () => {
  it("ships every file the manifest declares", () => {
    const manifest = readVendorManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.files.length).toBeGreaterThan(0);
    for (const f of manifest!.files) {
      expect(fs.existsSync(path.join(vendorSkillsDir(), f.target))).toBe(true);
    }
  });

  it("pins the Foundry ref it was vendored from", () => {
    const manifest = readVendorManifest()!;
    expect(manifest.repo).toBe("galaxyproject/foundry");
    expect(manifest.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a vendored file", () => {
    const res = readVendoredSkill("galaxy-workflow-invocation-failure-reference.md");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("Invocation Message Reasons");
  });

  it("lists what is available when a path misses", () => {
    const res = readVendoredSkill("nope.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.available).toContain("galaxy-tool-job-failure-reference.md");
    }
  });

  it("carries no local-checkout paths -- the sync rewrites them", () => {
    for (const f of readVendorManifest()!.files) {
      if (!f.target.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(vendorSkillsDir(), f.target), "utf-8");
      expect(text).not.toContain("~/projects/repositories");
      expect(text).not.toMatch(/\[\[/);
    }
  });

  it("rewrote Galaxy source citations to resolvable URLs", () => {
    const res = readVendoredSkill("galaxy-tool-job-failure-reference.md");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/");
    }
  });

  it("reserves a repo name that cannot collide with a configured repo", () => {
    // Configured repos are allowlisted to github.com/galaxyproject/*, and a
    // user-added repo named "foundry" would otherwise shadow the bundled set.
    // skills_fetch checks the bundled name first, so assert it stays stable.
    expect(VENDOR_REPO_NAME).toBe("foundry");
  });
});

describe("resolveVendorPath", () => {
  it("resolves a flat name", () => {
    expect(resolveVendorPath("a.md")).toBe(path.join(vendorSkillsDir(), "a.md"));
  });

  it("rejects traversal, absolute escapes, and empties", () => {
    expect(resolveVendorPath("../secrets")).toBeNull();
    expect(resolveVendorPath("a/../../b")).toBeNull();
    expect(resolveVendorPath("")).toBeNull();
    expect(resolveVendorPath("/")).toBeNull();
  });

  it("rejects any `..` substring, encoded or not, without decoding first", () => {
    // The guard is a blanket `..` reject rather than a decode-then-resolve, so
    // percent-encoded traversal never gets a chance to become a separator.
    expect(resolveVendorPath("..%2fb")).toBeNull();
    expect(resolveVendorPath("%2e%2e/b")).not.toBeNull(); // no literal `..`; resolve contains it
    expect(resolveVendorPath("%2e%2e/b")).toBe(path.join(vendorSkillsDir(), "%2e%2e", "b"));
  });

  it("strips leading slashes rather than escaping to the filesystem root", () => {
    expect(resolveVendorPath("/a.md")).toBe(path.join(vendorSkillsDir(), "a.md"));
  });

  it("normalizes backslash separators", () => {
    expect(resolveVendorPath("a\\b.md")).toBe(path.join(vendorSkillsDir(), "a", "b.md"));
    expect(resolveVendorPath("..\\..\\b")).toBeNull();
  });
});
