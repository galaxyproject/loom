import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { maskCode } from "../scripts/sync-skills.mjs";
import {
  INVOCATION_FAILURE_REFERENCE,
  JOB_FAILURE_REFERENCE,
} from "../extensions/loom/invocation-failure-hint";
import {
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

  it("pins the commit it was vendored from", () => {
    // A tag would be a moving target; the commit is what makes "which version
    // shipped" answerable after the fact.
    const manifest = readVendorManifest()!;
    expect(manifest.repo).toBe("galaxyproject/agentic-plugins");
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a vendored file at the path its cast uses upstream", () => {
    const res = readVendoredSkill(INVOCATION_FAILURE_REFERENCE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("Invocation Message Reasons");
  });

  it("still resolves the bare names a resumed session may be holding", () => {
    // The tree was flat before targets mirrored their upstream path. Two of
    // these were handed to the model by name in a failed-invocation hint; the
    // third was listed to it every time a fetch missed.
    for (const [legacy, current] of [
      ["galaxy-workflow-invocation-failure-reference.md", INVOCATION_FAILURE_REFERENCE],
      ["galaxy-tool-job-failure-reference.md", JOB_FAILURE_REFERENCE],
      [
        "galaxy-collection-semantics.yml",
        "debug-galaxy-workflow-output/references/notes/galaxy-collection-semantics.yml",
      ],
    ]) {
      const viaLegacy = readVendoredSkill(legacy);
      const viaCurrent = readVendoredSkill(current);
      expect(viaCurrent.ok).toBe(true);
      expect(viaLegacy.ok).toBe(true);
      if (viaLegacy.ok && viaCurrent.ok) expect(viaLegacy.text).toBe(viaCurrent.text);
    }
  });

  it("answers a one-word path with the available list instead of throwing", () => {
    // `path` comes from the model. A plain-object alias lookup answers
    // "constructor" with a function, and the structured miss the caller expects
    // turns into an exception out of the tool.
    for (const guess of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      const res = readVendoredSkill(guess);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.available.length).toBeGreaterThan(0);
    }
  });

  it("lists what is available when a path misses", () => {
    const res = readVendoredSkill("nope.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.available).toContain(JOB_FAILURE_REFERENCE);
    }
  });

  it("names no path that only exists on the note author's machine", () => {
    // Not just the tilde form the rewrite looks for: the expanded
    // /Users/<someone>/ and /home/<someone>/ forms are the ones that also carry
    // an account name into a published package.
    for (const f of readVendorManifest()!.files) {
      const text = fs.readFileSync(path.join(vendorSkillsDir(), f.target), "utf-8");
      expect(text).not.toMatch(/~\/projects\/repositories/);
      expect(text).not.toMatch(/\/(?:Users|home)\/[^/\s"'`]+\//);
    }
  });

  it("leaves no bracket pair that the transform would have treated as a link", () => {
    // The rule, not the corpus. A surviving `[[...]]` is correct when it is an
    // array literal -- quote, comma or whitespace inside -- or when it is code.
    // Asserting "no [[ outside a fence" instead contradicts the sync test that
    // requires an unfenced `[["foo", "oo"]]` to survive, and passed only
    // because no vendored file happens to contain one yet.
    for (const f of readVendorManifest()!.files) {
      if (!f.target.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(vendorSkillsDir(), f.target), "utf-8");
      const survivors = [...maskCode(text).matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
      const linkShaped = survivors.filter((target) => !/[\s"',[\]]/.test(target));
      expect(linkShaped).toEqual([]);
    }
  });

  it("rewrote Galaxy source citations to resolvable URLs", () => {
    const res = readVendoredSkill(JOB_FAILURE_REFERENCE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/");
    }
  });

  it("rewrote Planemo source citations too", () => {
    const res = readVendoredSkill(
      "debug-galaxy-workflow-output/references/notes/planemo-workflow-test-architecture.md",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("https://github.com/galaxyproject/planemo/blob/master/planemo/");
    }
  });

  it("leaves the cast's feedback ledger behind", () => {
    // `_feedback.md` belongs to a review loop the Foundry runs and Loom does
    // not, so shipping it would be guidance pointing at a process we have no
    // part in.
    const targets = readVendorManifest()!.files.map((f) => f.target);
    expect(targets.some((t) => t.endsWith("_feedback.md"))).toBe(false);
    expect(targets).toContain("debug-galaxy-workflow-output/SKILL.md");
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
