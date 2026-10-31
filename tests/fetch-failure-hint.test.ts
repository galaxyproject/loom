import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchFailureHint, fetchFailureHintForText } from "../extensions/orbit/fetch-failure-hint";
import { applySkillTriggers, skillTriggers } from "../extensions/orbit/skill-triggers";
import {
  galaxyToolFamily,
  registerGalaxyTools,
  setGalaxyToolSource,
} from "../extensions/orbit/galaxy-tool-source";
import { renderGalaxyResult } from "../extensions/orbit/galaxy-tool-wrap";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const ENA_FAILURE = {
  id: "d1",
  name: "SRR390728_1.fastq.gz",
  state: "error",
  misc_info:
    "Failed to fetch url https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR390728/001/" +
    "SRR390728_1.fastq.gz. 404 Client Error: Not Found for url: " +
    "https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR390728/001/SRR390728_1.fastq.gz",
};

const OTHER_FAILURE = {
  id: "d2",
  name: "1.fastq.gz",
  state: "error",
  misc_info:
    "Failed to fetch url https://raw.githubusercontent.com/galaxyproject/training-data/" +
    "master/short-read/fastq/1.fastq.gz. 404 Client Error: Not Found",
};

const RUNNING = { id: "d3", name: "SRR390728_1.fastq.gz", state: "running", misc_info: null };

describe("fetchFailureHint", () => {
  it("names the lookup for an archive fetch failure", () => {
    const out = fetchFailureHint(ENA_FAILURE)!;
    expect(out).toContain("ena_runs");
    expect(out).toContain("not derivable");
    expect(out).not.toMatch(/fastq_dump|fasterq_dump/);
  });

  it("refuses a second guess for any other fetch failure", () => {
    const out = fetchFailureHint(OTHER_FAILURE)!;
    expect(out).toContain("from memory");
    expect(out).not.toContain("ena_runs");
  });

  it("recognises an archive by an accession in the url", () => {
    const mirrored = {
      ...ENA_FAILURE,
      misc_info: "Failed to fetch url https://mirror.invalid/SRR390728_1.fastq.gz. 404",
    };
    expect(fetchFailureHint(mirrored)).toContain("ena_runs");
  });

  it("gives a healthy result nothing", () => {
    expect(fetchFailureHint(RUNNING)).toBeNull();
    expect(fetchFailureHint({ id: "d4", state: "ok" })).toBeNull();
    expect(fetchFailureHint([])).toBeNull();
  });

  it("gives an error that is not a fetch failure nothing", () => {
    expect(
      fetchFailureHint({ id: "d5", state: "error", misc_info: "Job was killed by the cluster" }),
    ).toBeNull();
  });

  it.each(["outputs", "datasets"])("finds a dataset nested under %s", (key) => {
    expect(fetchFailureHint({ [key]: [RUNNING, ENA_FAILURE] })).toContain("ena_runs");
  });

  it("searches a history listing too", () => {
    expect(fetchFailureHint([RUNNING, ENA_FAILURE])).toContain("ena_runs");
  });

  it("reads the payload out of a Galaxy tool's envelope, and leaves prose alone", () => {
    expect(fetchFailureHintForText(JSON.stringify({ data: ENA_FAILURE }))).toContain("ena_runs");
    expect(fetchFailureHintForText("Failed to fetch url https://x.invalid/a")).toBeNull();
  });
});

describe("the fetch-failed trigger", () => {
  beforeEach(() => {
    setCapabilityProfile(profileFromEnv({}));
    setGalaxyToolSource(null);
    registerGalaxyTools({ registerTool: vi.fn() } as unknown as ExtensionAPI);
  });
  afterEach(() => {
    setGalaxyToolSource(null);
    setCapabilityProfile(null);
  });

  const triggers = () => skillTriggers(galaxyToolFamily());
  const rendered = (data: unknown) =>
    renderGalaxyResult("get_dataset_details", { success: true, data } as never, 0)
      .content as Array<{
      type: string;
      text: string;
    }>;

  it("appends the hint to a Galaxy result that shows a failed fetch, once", () => {
    const content = rendered(ENA_FAILURE);
    const applied = applySkillTriggers(
      { toolName: "get_dataset_details", isError: false, content },
      () => [],
      triggers(),
    )!;
    expect(applied.fired.map((f) => f.id)).toEqual(["fetch-failed"]);
    expect(applied.content[0].text).toContain("ena_runs");
    expect(
      applySkillTriggers(
        { toolName: "get_dataset_details", isError: false, content: applied.content },
        () => [],
        triggers(),
      ),
    ).toBeNull();
  });

  it("leaves a tool that isn't Galaxy's alone, however its text reads", () => {
    const content = rendered(ENA_FAILURE);
    expect(
      applySkillTriggers({ toolName: "read", isError: false, content }, () => [], triggers()),
    ).toBeNull();
  });
});
