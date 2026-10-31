// @vitest-environment node
/**
 * Orbit's vendored skills in the worker, with a flavor's own skill offered beside them (slice 3,
 * commit 16): skills_fetch reads it from the shipped galaxy-skills repo, and the router lists it.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  readBundledCatalog,
  readBundledRepoFile,
  setVendorSkillsSource,
} from "../../../../../extensions/orbit/vendor-skills";
import { ownSkillFiles, vendorSkills } from "./skills";

const SKILL = `---
name: visualization
description: Render a dataset with one of Galaxy's installed visualizations.
---

# Visualization

Call list_visualizations first.
`;

afterEach(() => setVendorSkillsSource(null));

describe("a flavor's own skill in the worker's skills tree", () => {
  const own = ownSkillFiles(
    {
      "./skills/own/visualization/SKILL.md": SKILL,
      "./skills/galaxy-skills/x/SKILL.md": "not own",
    },
    "olit",
  );

  it("names only the flavor's own files, under the brand", () => {
    expect(own.map((f) => f.target)).toEqual(["skills/olit-visualization/SKILL.md"]);
  });

  it("is listed with the shipped skills and read from the shipped repo", async () => {
    setVendorSkillsSource(vendorSkills(own));
    const listed = readBundledCatalog()?.["galaxy-skills"] ?? [];
    expect(listed.find((s) => s.name === "visualization")).toMatchObject({
      path: "skills/olit-visualization/SKILL.md",
      surfaces: ["loom"],
    });
    // Shipped ones are still there.
    expect(listed.some((s) => s.name === "collection-manipulation")).toBe(true);
    const read = await readBundledRepoFile(
      { name: "galaxy-skills" },
      "skills/olit-visualization/SKILL.md",
    );
    expect(read).toMatchObject({ ok: true, text: SKILL });
  });

  it("answers nothing for a target the tree doesn't hold", async () => {
    const source = vendorSkills(own);
    expect(await source.read("skills/nope/SKILL.md")).toBeNull();
  });
});
