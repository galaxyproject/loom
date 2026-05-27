import { describe, it, expect } from "vitest";
import { parseLatestPlan } from "../evals/lib/notebook-parser";

describe("evals notebook-parser: parseLatestPlan", () => {
  it("returns null when no `## Plan X:` heading is present", () => {
    expect(parseLatestPlan("just some prose, no plan here")).toBeNull();
    expect(parseLatestPlan("## Notes\n\nstuff")).toBeNull();
  });

  it("parses the heading line and routing tag", () => {
    const plan = parseLatestPlan(
      ["## Plan A: RNA-seq DE [galaxy]", "", "### Steps", "- [ ] 1. **Align** -- bwa step"].join(
        "\n",
      ),
    );
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("A: RNA-seq DE");
    expect(plan!.routing).toBe("galaxy");
    expect(plan!.pendingSteps).toHaveLength(1);
  });

  it("returns the LATEST plan when the doc has multiple", () => {
    const content = [
      "## Plan A: Old plan [local]",
      "- [ ] 1. **Old step** -- old description",
      "",
      "## Plan B: New plan [hybrid]",
      "- [ ] 1. **New step** -- new description",
    ].join("\n");
    const plan = parseLatestPlan(content);
    expect(plan!.title).toBe("B: New plan");
    expect(plan!.routing).toBe("hybrid");
  });

  it("returns routing='unknown' when the heading has no routing tag", () => {
    const plan = parseLatestPlan("## Plan A: Untagged\n- [ ] 1. **Step** -- desc");
    expect(plan).not.toBeNull();
    expect(plan!.routing).toBe("unknown");
  });

  it("ignores completed steps and only collects `- [ ]` pending ones", () => {
    const content = [
      "## Plan A: Mixed [galaxy]",
      "- [x] 1. **Done step** -- already finished",
      "- [ ] 2. **Pending step** -- still to do",
      "- [x] 3. **Also done** -- finished too",
    ].join("\n");
    const plan = parseLatestPlan(content);
    expect(plan!.pendingSteps).toHaveLength(1);
    expect(plan!.pendingSteps[0].raw).toContain("Pending step");
  });

  it("folds sub-bullet text into the description length", () => {
    // Same step rendered two ways: title-only main line, content lives on sub-bullets.
    // Some models (Qwen3, Maverick) write plans this way; the parser must count it
    // as a real description rather than flagging the step as skinny.
    const content = [
      "## Plan A: Galaxy work [galaxy]",
      "- [ ] 1. **Trim adapters**",
      "  - Routing: galaxy",
      "  - Tool: fastp",
    ].join("\n");
    const plan = parseLatestPlan(content);
    expect(plan!.pendingSteps).toHaveLength(1);
    // sub-bullet text is "Routing: galaxy Tool: fastp" -> well above the 8-char gate
    expect(plan!.pendingSteps[0].descriptionLength).toBeGreaterThanOrEqual(8);
  });

  it("flags genuinely skinny steps (title only, no sub-bullets) below the 8-char gate", () => {
    const content = ["## Plan A: Skinny [galaxy]", "- [ ] 1. **X**"].join("\n");
    const plan = parseLatestPlan(content);
    expect(plan!.pendingSteps[0].descriptionLength).toBeLessThan(8);
  });

  it("strips `{#plan-X-step-N}` anchors from the description measurement", () => {
    // Anchors are syntactic scaffolding for invocation YAML refs, not content.
    // Two steps with identical descriptions but one anchored should measure the same.
    const anchored = parseLatestPlan(
      "## Plan A: Anchored [galaxy]\n- [ ] 1. **Step** {#plan-a-step-1} -- align reads",
    );
    const plain = parseLatestPlan("## Plan A: Plain [galaxy]\n- [ ] 1. **Step** -- align reads");
    expect(anchored!.pendingSteps[0].descriptionLength).toBe(
      plain!.pendingSteps[0].descriptionLength,
    );
  });

  it("stops collecting sub-bullets at the next top-level step", () => {
    // The sub-bullet between steps 1 and 2 belongs to step 1, not step 2.
    const content = [
      "## Plan A: Two steps [galaxy]",
      "- [ ] 1. **First**",
      "  - sub-bullet for first",
      "- [ ] 2. **Second** -- on the same line",
    ].join("\n");
    const plan = parseLatestPlan(content);
    expect(plan!.pendingSteps).toHaveLength(2);
    expect(plan!.pendingSteps[0].descriptionLength).toBeGreaterThanOrEqual(8);
    expect(plan!.pendingSteps[1].descriptionLength).toBeGreaterThanOrEqual(8);
  });

  it("stops collecting sub-bullets at the next `##` section", () => {
    const content = [
      "## Plan A: One step [galaxy]",
      "- [ ] 1. **Step**",
      "  - sub belongs to step",
      "## Parameters",
      "  - this paragraph is NOT a sub-bullet of the step",
    ].join("\n");
    const plan = parseLatestPlan(content);
    expect(plan!.pendingSteps).toHaveLength(1);
    // "sub belongs to step" -> 19 chars; the next-section paragraph must not bleed in.
    expect(plan!.pendingSteps[0].descriptionLength).toBe("sub belongs to step".length);
  });

  it("treats `[Galaxy]` (capitalized) as the galaxy routing tag", () => {
    const plan = parseLatestPlan("## Plan A: Caps [Galaxy]\n- [ ] 1. **Step** -- desc");
    expect(plan!.routing).toBe("galaxy");
  });
});
