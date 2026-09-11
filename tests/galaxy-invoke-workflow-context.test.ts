import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../extensions/loom/config", () => ({
  loadConfig: () => ({ executionMode: "hybrid" }),
}));

import { buildGalaxyContextBlock } from "../extensions/loom/context";

let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };
  process.env.GALAXY_URL = "https://galaxy.test";
  process.env.GALAXY_API_KEY = "k";
});

afterEach(() => {
  process.env.GALAXY_URL = prev.url;
  process.env.GALAXY_API_KEY = prev.key;
});

describe("buildGalaxyContextBlock workflow-invocation guidance", () => {
  it("points at the input-template tool before invoking", () => {
    const block = buildGalaxyContextBlock();
    // Order matters -- guidance that named these the other way round would
    // steer the model into invoking first, which is the bug being fixed.
    expect(block).toMatch(/galaxy_get_workflow_input_template`? before `?galaxy_invoke_workflow/);
  });

  it("names inputs_template so the whole wrapper isn't passed as inputs", () => {
    const block = buildGalaxyContextBlock();
    // The tool's payload is {inputs_template, slots, inputs_by, warnings}
    // (under GalaxyResult.data); only the first is the inputs map, so the
    // prompt has to say which field to take.
    expect(block).toContain("`inputs_template`");
    expect(block).toMatch(/not the\s+whole wrapper/);
  });

  it("says to replace the template placeholders rather than send them", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/replace every placeholder/i);
    // All three literals build_workflow_input_template emits (_placeholder_for);
    // a model that submits any of them verbatim fails downstream.
    expect(block).toContain("<value>");
    expect(block).toContain("<dataset_id>");
    expect(block).toContain("<collection_id>");
  });

  it("routes data and non-data slots alike into inputs", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/non-data slots both belong in `inputs`/);
    expect(block).toContain('{"src":"hdca","id":');
    expect(block).toMatch(/bare scalar/);
  });

  it("allows optional slots to be omitted, keyed off what the template exposes", () => {
    const block = buildGalaxyContextBlock();
    // Galaxy accepts a missing input that is optional or defaulted, but the
    // slot contract only carries `optional` -- so the prompt scopes the
    // permission to the field a model can actually read back.
    expect(block).toMatch(/marks `optional` may be left out/);
    expect(block).not.toMatch(/carry a default/);
  });

  it("gives the pipe-separated inputs_by value verbatim", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain('inputs_by="step_index|step_uuid"');
  });

  it("explains why a scalar in params 400s, naming the exact error", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/Don't route workflow inputs through `params`/);
    expect(block).toContain("dict[str, dict]");
    // The error the model loops on, so it can match what it just saw. Compare
    // whitespace-normalized -- the prompt line-wraps and a reflow shouldn't
    // fail this.
    expect(block.replace(/\s+/g, " ")).toContain(
      "Input should be a valid dictionary in ('body','parameters',<key>)",
    );
  });

  it("blames the value type, not the key, without overclaiming", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/the key was never the problem/);
    // params CAN legally carry a parameter_input as {"input": v} via Galaxy's
    // legacy normalization, so the prompt must steer without asserting that
    // params can never work -- a claim the source contradicts.
    expect(block).not.toMatch(/never work/i);
    expect(block).not.toMatch(/inputs never go in `params`/i);
  });

  it("omits the guidance entirely when Galaxy is not connected", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("galaxy_get_workflow_input_template");
  });
});
