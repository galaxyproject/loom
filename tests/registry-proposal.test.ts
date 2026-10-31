import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegistryStore,
  specRevision,
  canonicalJson,
  sha256Hex,
} from "../extensions/orbit/registry";
import {
  approveProposal,
  canonicalizeProposal,
  checkInputFormats,
  findDrift,
  mappedOverSlots,
  newProposalId,
  parseProposalFields,
  parsePredicate,
  pendingProposals,
  PROPOSAL_ID_RE,
  renderProposalTable,
  revokeDrifted,
  revokeProposal,
  templateShape,
  validateProposal,
  type Proposal,
  type ProposalSighting,
} from "../extensions/orbit/registry-proposal";
import { SERVER, T0, tmpAnalysisDir } from "./registry-fixtures";
import { datatypeAccepts } from "../extensions/orbit/registry-templates";
import {
  CONVERTERS,
  DATATYPES,
  MANIFEST_ID,
  NANOPLOT_SNAPSHOT,
  TOOL_SNAPSHOT,
  UDT_SNAPSHOT,
  UDT_UUID,
  WORKFLOW_SNAPSHOT,
  nanoplotProposal,
  toolProposal,
} from "./registry-proposal-fixtures";

let dir: string;
let now: number;
const clock = () => now;
const NOW = "2026-10-07T12:00:00.000Z";

function store(sessionId = "s-a", serverUrl = SERVER): RegistryStore {
  const s = new RegistryStore({ analysisDir: dir, serverUrl, sessionId, fs, clock, pid: 100 });
  s.open();
  return s;
}

function approve(s: RegistryStore, proposal: Proposal, snapshot = TOOL_SNAPSHOT) {
  return approveProposal(s, { proposal, snapshot, assertionDefinitions: new Map(), now: NOW });
}

const seen = (p: Proposal | null, id = p?.proposalId ?? "prop-abc123"): ProposalSighting => ({
  proposalId: id,
  proposal: p,
});

beforeEach(() => {
  dir = tmpAnalysisDir();
  now = T0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("proposal validated against the template (v3 §13)", () => {
  const shape = templateShape("tool", TOOL_SNAPSHOT);

  it("accepts a proposal that names real slots and parameters", () => {
    expect(validateProposal(toolProposal(), shape)).toEqual([]);
  });

  it("refuses a slot the template doesn't have, and lists the real ones", () => {
    const problems = validateProposal(
      toolProposal({
        inputs: [
          { slot: "reads", src: "hda", id: "a1" },
          { slot: "fastq", src: "hda", id: "a2" },
        ],
      }),
      shape,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/"fastq" is not a dataset input/);
    expect(problems[0]).toMatch(/reads \(Reads\)/);
  });

  it("refuses when a required input is missing", () => {
    const problems = validateProposal(toolProposal({ inputs: [] }), shape);
    expect(problems).toEqual([
      expect.stringMatching(/required input "reads" \(Reads\) is not given/),
    ]);
  });

  it("refuses a parameter name the template doesn't have", () => {
    const problems = validateProposal(
      toolProposal({ overrides: [{ param: "thread", value: 4, rationale: "typo" }] }),
      shape,
    );
    expect(problems).toEqual([expect.stringMatching(/"thread" is not a parameter of this tool/)]);
  });

  it("reads nested parameters in Galaxy's flat form, with repeat indices", () => {
    const ok = toolProposal({
      overrides: [
        { param: "filter_options|length_required", value: 30, rationale: "short reads" },
        { param: "single_paired|single_paired_selector", value: "single", rationale: "SE run" },
        { param: "queries_2|tag", value: "x", rationale: "third repeat" },
      ],
    });
    expect(validateProposal(ok, shape)).toEqual([]);
  });

  it("does not require a dataset inside a conditional or an optional one", () => {
    // in1/in2 live in a conditional; adapters and pool are optional.
    const s = templateShape("tool", TOOL_SNAPSHOT);
    expect(s.slots.get("single_paired|in1")?.required).toBe(false);
    expect(s.slots.get("adapters")?.required).toBe(false);
    expect(s.slots.get("reads")?.required).toBe(true);
  });

  it("refuses a dataset given to a collection slot", () => {
    const problems = validateProposal(
      toolProposal({ inputs: [...toolProposal().inputs, { slot: "pool", src: "hda", id: "d1" }] }),
      shape,
    );
    expect(problems).toEqual([expect.stringMatching(/"pool" takes a collection/)]);
  });

  describe("a collection on a tool's one-dataset slot maps over it (#615)", () => {
    const nanoplot = templateShape("tool", NANOPLOT_SNAPSHOT);

    it("accepts Scott's NanoPlot proposal over a 62-element list", () => {
      expect(validateProposal(nanoplotProposal(), nanoplot)).toEqual([]);
      expect(mappedOverSlots(nanoplotProposal(), nanoplot)).toEqual(["mode|reads|files"]);
    });

    it("says in the table it runs once per element", () => {
      const table = renderProposalTable(nanoplotProposal(), { shape: nanoplot, plain: true });
      expect(table).toMatch(
        /input mode\|reads\|files +hdca a1c62e0f5b3d7790 -- runs once per element, one job each/,
      );
    });

    it("reads the branch the proposal picks: combined mode takes the list in one job", () => {
      const combined = nanoplotProposal({
        overrides: [{ param: "mode|choice", value: "combined", rationale: "one report" }],
      });
      expect(validateProposal(combined, nanoplot)).toEqual([]);
      expect(mappedOverSlots(combined, nanoplot)).toEqual([]);
      expect(renderProposalTable(combined, { shape: nanoplot })).not.toMatch(/once per element/);
    });

    it("refuses a selector value no branch names, so it can't hide a map-over", () => {
      for (const value of ["bogus", null]) {
        const p = nanoplotProposal({
          overrides: [{ param: "mode|choice", value, rationale: "x" }],
        });
        expect(validateProposal(p, nanoplot)).toEqual([
          '"mode|choice" chooses a branch; it takes batch or combined',
        ]);
      }
    });

    it("says it may run per element when the branch can't be pinned down", () => {
      const body = structuredClone(NANOPLOT_SNAPSHOT.body) as {
        inputs: Array<{ test_param: { value?: string } }>;
      };
      delete body.inputs[0].test_param.value;
      const undecided = templateShape("tool", { ...NANOPLOT_SNAPSHOT, body });
      expect(mappedOverSlots(nanoplotProposal(), undecided)).toEqual(["mode|reads|files"]);
    });

    it("counts datasets against the branch picked, not any branch", () => {
      const two = (choice: string) =>
        nanoplotProposal({
          inputs: [
            { slot: "mode|reads|files", src: "hda", id: "d1" },
            { slot: "mode|reads|files", src: "hda", id: "d2" },
          ],
          overrides: [{ param: "mode|choice", value: choice, rationale: "x" }],
        });
      expect(validateProposal(two("batch"), nanoplot)).toEqual([
        'input slot "mode|reads|files" takes one dataset but is given 2',
      ]);
      expect(validateProposal(two("combined"), nanoplot)).toEqual([]);
    });

    it("refuses datasets and collections mixed on one slot, as Galaxy does", () => {
      const given = (srcs: Array<"hda" | "hdca">) =>
        nanoplotProposal({
          inputs: srcs.map((src, n) => ({ slot: "mode|reads|files", src, id: `x${n}` })),
          overrides: [{ param: "mode|choice", value: "combined", rationale: "x" }],
        });
      expect(validateProposal(given(["hda", "hdca"]), nanoplot)).toEqual([
        expect.stringMatching(/"mode\|reads\|files" is given both datasets and collections/),
      ]);
      expect(validateProposal(given(["hdca", "hdca"]), nanoplot)).toEqual([]);
      expect(validateProposal(given(["hda", "hda"]), nanoplot)).toEqual([]);
    });

    it("maps over a tool's plain one-dataset slot too", () => {
      const p = toolProposal({ inputs: [{ slot: "reads", src: "hdca", id: "c1" }] });
      expect(validateProposal(p, shape)).toEqual([]);
      expect(mappedOverSlots(p, shape)).toEqual(["reads"]);
    });
  });

  it("says what would work when a collection lands on a one-dataset slot (#615)", () => {
    const [problem] = validateProposal(
      canonicalizeProposal(
        {
          ...toolProposal(),
          target: { kind: "workflow", workflow_id: "f2db41e1fa331b3e", version: "unpinned" },
          inputs: [
            { slot: "forward", src: "hdca", id: "c62" },
            { slot: "samples", src: "hdca", id: "c1" },
          ],
          overrides: [],
        },
        templateShape("workflow", WORKFLOW_SNAPSHOT),
      ),
      templateShape("workflow", WORKFLOW_SNAPSHOT),
    );
    expect(problem).toMatch(/"0" takes one dataset/);
    expect(problem).toMatch(/id of one dataset \(src hda\)/);
    expect(problem).toMatch(/to a slot that takes one: 1$/);
  });

  it("takes a collection on a multiple-dataset slot, flattened into one job (#615)", () => {
    const problems = validateProposal(
      toolProposal({
        inputs: [
          { slot: "reads", src: "hda", id: "4b6e2f1a9c3d5e70" },
          { slot: "bundle", src: "hdca", id: "c62" },
        ],
      }),
      shape,
    );
    expect(problems).toEqual([]);
  });

  it("refuses a dataset input passed as an override, and a duplicate override", () => {
    const problems = validateProposal(
      toolProposal({
        overrides: [
          { param: "reads", value: "x", rationale: "r" },
          { param: "threads", value: 1, rationale: "r" },
          { param: "threads", value: 2, rationale: "r" },
        ],
      }),
      shape,
    );
    expect(problems).toEqual([
      expect.stringMatching(/"reads" is a dataset input/),
      expect.stringMatching(/"threads" is overridden twice/),
    ]);
  });

  it("refuses a pinned version Galaxy didn't give", () => {
    const problems = validateProposal(
      toolProposal({ target: { kind: "tool", tool_id: "fastp", version: "0.20.1" } }),
      shape,
    );
    expect(problems).toEqual([expect.stringMatching(/version 0.20.1 was asked for/)]);
  });

  it("reads workflow slots by step index and canonicalizes a unique label", () => {
    const wf = templateShape("workflow", WORKFLOW_SNAPSHOT);
    const p = canonicalizeProposal(
      toolProposal({
        target: { kind: "workflow", workflow_id: "f2db41e1fa331b3e", version: "unpinned" },
        inputs: [
          { slot: "forward", src: "hda", id: "a1" },
          { slot: "1", src: "hdca", id: "c1" },
        ],
        overrides: [{ param: "min length", value: 20, rationale: "short amplicons" }],
      }),
      wf,
    );
    expect(p.inputs.map((i) => i.slot)).toEqual(["0", "1"]);
    expect(p.overrides[0].param).toBe("2");
    expect(validateProposal(p, wf)).toEqual([]);
    const missing = validateProposal({ ...p, inputs: [p.inputs[0]] }, wf);
    expect(missing).toEqual([expect.stringMatching(/required input "1" \(samples\)/)]);
  });

  it("reads a user-defined tool's inputs from its representation", () => {
    const udt = templateShape("udt", UDT_SNAPSHOT);
    expect([...udt.slots.keys()]).toEqual(["table"]);
    expect(udt.params.has("skip")).toBe(true);
  });
});

describe("dataset formats checked against the slot (#618)", () => {
  const nanoplot = templateShape("tool", NANOPLOT_SNAPSHOT);
  const accepts = datatypeAccepts(DATATYPES, CONVERTERS);
  const formats = (exts: Record<string, string[] | null>) => ({
    extensions: new Map(Object.entries(exts)),
    accepts,
  });
  const manifest = nanoplotProposal({
    inputs: [{ slot: "mode|reads|files", src: "hda", id: MANIFEST_ID }],
  });

  it("reads each branch's formats from the template", () => {
    const files = nanoplot.slots.get("mode|reads|files")!;
    expect(files.variants).toHaveLength(6);
    expect(files.variants[0]).toEqual({
      when: [
        { param: "mode|choice", value: "batch", default: "batch" },
        { param: "mode|reads|type", value: "fastq", default: "fastq" },
      ],
      collection: false,
      multiple: false,
      accepts: ["fastq", "fastq.gz", "fastq.bz2", "vcf_bgzip"],
    });
    expect(templateShape("udt", UDT_SNAPSHOT).slots.get("table")?.variants[0].accepts).toEqual([
      "tabular",
    ]);
  });

  it("refuses Scott's TSV manifest in NanoPlot's FASTQ slot, naming both formats", () => {
    const { problems } = checkInputFormats(
      manifest,
      nanoplot,
      formats({ [`hda:${MANIFEST_ID}`]: ["tsv"] }),
    );
    expect(problems).toEqual([
      `input slot "mode|reads|files" takes fastq, fastq.gz, fastq.bz2 or vcf_bgzip (or a subtype), ` +
        `but dataset ${MANIFEST_ID} is tsv. Give it one in a format the slot takes; if the data ` +
        `is right but mislabeled, change its datatype in Galaxy first`,
    ]);
  });

  it("takes the 62 runs as fastqsanger.gz, and a collection with one bad element is named", () => {
    const ok = checkInputFormats(
      nanoplotProposal(),
      nanoplot,
      formats({ "hdca:a1c62e0f5b3d7790": ["fastqsanger.gz"] }),
    );
    expect(ok).toEqual({ problems: [], unchecked: [] });
    const mixed = checkInputFormats(
      nanoplotProposal(),
      nanoplot,
      formats({ "hdca:a1c62e0f5b3d7790": ["fastqsanger.gz", "tsv"] }),
    );
    expect(mixed.problems).toEqual([
      expect.stringMatching(/but collection a1c62e0f5b3d7790 holds tsv\./),
    ]);
  });

  it("checks against the branch the proposal picks", () => {
    const summary = {
      ...manifest,
      overrides: [{ param: "mode|reads|type", value: "summary", rationale: "a summary file" }],
    };
    const r = checkInputFormats(summary, nanoplot, formats({ [`hda:${MANIFEST_ID}`]: ["tsv"] }));
    expect(r.problems).toEqual([]);
  });

  it("lets through, and lists, what it can't judge", () => {
    expect(
      checkInputFormats(manifest, nanoplot, formats({ [`hda:${MANIFEST_ID}`]: null })),
    ).toEqual({ problems: [], unchecked: [expect.stringMatching(/didn't say what format/)] });
    expect(
      checkInputFormats(manifest, nanoplot, {
        extensions: new Map([[`hda:${MANIFEST_ID}`, ["tsv"]]]),
        accepts: null,
      }),
    ).toEqual({ problems: [], unchecked: [expect.stringMatching(/hierarchy couldn't be read/)] });
    expect(
      checkInputFormats(manifest, nanoplot, formats({ [`hda:${MANIFEST_ID}`]: ["fast5_tar"] })),
    ).toEqual({ problems: [], unchecked: [expect.stringMatching(/can't tell whether fast5_tar/)] });
  });

  it("skips a slot that names no formats", () => {
    const shape = templateShape("tool", TOOL_SNAPSHOT);
    expect(
      checkInputFormats(toolProposal(), shape, formats({ "hda:4b6e2f1a9c3d5e70": ["tsv"] })),
    ).toEqual({ problems: [], unchecked: [] });
  });

  it("checks a workflow input against its accepted formats", () => {
    const body = structuredClone(WORKFLOW_SNAPSHOT.body) as { slots: Record<string, unknown>[] };
    body.slots[0].accepted_formats = ["fastqsanger"];
    const wf = templateShape("workflow", { ...WORKFLOW_SNAPSHOT, body });
    const p = {
      ...toolProposal(),
      target: { kind: "workflow" as const, workflow_id: "f2db41e1fa331b3e", version: "unpinned" },
      inputs: [
        { slot: "0", src: "hda" as const, id: "d1" },
        { slot: "1", src: "hdca" as const, id: "c1" },
      ],
      overrides: [],
    };
    const r = checkInputFormats(p, wf, formats({ "hda:d1": ["tabular"], "hdca:c1": ["tabular"] }));
    expect(r.problems).toEqual([expect.stringMatching(/"0" takes fastqsanger .* is tabular/)]);
  });
});

describe("branch resolution follows Galaxy's conditionals (review follow-ups)", () => {
  const accepts = datatypeAccepts(DATATYPES, CONVERTERS);
  const tool = (inputs: unknown[]) =>
    templateShape("tool", { version: "1", body: { id: "t", version: "1", inputs } });
  const proposal = (inputs: Proposal["inputs"], choices: Record<string, unknown>) =>
    toolProposal({
      target: { kind: "tool", tool_id: "t", version: "unpinned" },
      inputs,
      overrides: Object.entries(choices).map(([param, value]) => ({
        param,
        value,
        rationale: "x",
      })),
    });
  const branchy = (name: string, test: Record<string, unknown>, cases: unknown[]) => ({
    name,
    type: "conditional",
    test_param: test,
    cases,
  });

  it("reads each repeat instance's selector from that instance", () => {
    const shape = tool([
      {
        name: "rows",
        type: "repeat",
        inputs: [
          branchy("mode", { name: "choice", type: "select", value: "one" }, [
            { value: "one", inputs: [{ name: "reads", type: "data", extensions: ["fastq"] }] },
            {
              value: "many",
              inputs: [{ name: "reads", type: "data", multiple: true, extensions: ["tabular"] }],
            },
          ]),
        ],
      },
    ]);
    const p = proposal(
      [
        { slot: "rows_0|mode|reads", src: "hda", id: "fq" },
        { slot: "rows_1|mode|reads", src: "hdca", id: "tabs" },
      ],
      { "rows_0|mode|choice": "one", "rows_1|mode|choice": "many" },
    );
    expect(validateProposal(p, shape)).toEqual([]);
    expect(mappedOverSlots(p, shape)).toEqual([]);
    expect(
      checkInputFormats(p, shape, {
        extensions: new Map([
          ["hda:fq", ["fastqsanger"]],
          ["hdca:tabs", ["tabular"]],
        ]),
        accepts,
      }),
    ).toEqual({ problems: [], unchecked: [] });
  });

  it("names a boolean selector's branches by its truevalue and falsevalue", () => {
    const shape = tool([
      branchy(
        "paired",
        { name: "on", type: "boolean", truevalue: "yes", falsevalue: "no", value: false },
        [
          { value: "yes", inputs: [{ name: "r2", type: "data", extensions: ["tabular"] }] },
          { value: "no", inputs: [{ name: "r2", type: "data", extensions: ["fastq"] }] },
        ],
      ),
    ]);
    const formats = { extensions: new Map([["hda:d", ["tabular"]]]), accepts };
    const on = proposal([{ slot: "paired|r2", src: "hda", id: "d" }], { "paired|on": true });
    expect(validateProposal(on, shape)).toEqual([]);
    expect(checkInputFormats(on, shape, formats).problems).toEqual([]);
    const byDefault = proposal([{ slot: "paired|r2", src: "hda", id: "d" }], {});
    expect(checkInputFormats(byDefault, shape, formats).problems).toHaveLength(1);
  });

  it("reads a boolean selector's value the way Galaxy's boolean parameter does", () => {
    const shape = tool([
      branchy(
        "paired",
        { name: "on", type: "boolean", truevalue: "enabled", falsevalue: "disabled" },
        [
          { value: "enabled", inputs: [{ name: "r2", type: "data", extensions: ["tabular"] }] },
          { value: "disabled", inputs: [{ name: "r2", type: "data", extensions: ["fastq"] }] },
        ],
      ),
    ]);
    const formats = { extensions: new Map([["hda:d", ["tabular"]]]), accepts };
    const with_ = (v: unknown) =>
      proposal([{ slot: "paired|r2", src: "hda", id: "d" }], { "paired|on": v });
    for (const v of [true, "true", "True", "yes", "on", 1, "1"]) {
      expect(validateProposal(with_(v), shape)).toEqual([]);
      expect(checkInputFormats(with_(v), shape, formats).problems).toEqual([]);
    }
    for (const v of [false, "false", "no", 0, "disabled"]) {
      expect(validateProposal(with_(v), shape)).toEqual([]);
      expect(checkInputFormats(with_(v), shape, formats).problems).toHaveLength(1);
    }
    // Galaxy reads any other string as false, so its truevalue would pick the false branch.
    expect(validateProposal(with_("enabled"), shape)).toEqual([
      expect.stringMatching(/"paired\|on" is a boolean; give true or false/),
    ]);
  });

  it("takes a select option no case names, which Galaxy runs with no extra inputs", () => {
    const shape = tool([
      branchy(
        "trim",
        {
          name: "how",
          type: "select",
          value: "none",
          options: [
            ["None", "none", true],
            ["Adapters", "adapters", false],
          ],
        },
        [{ value: "adapters", inputs: [{ name: "adapters", type: "data", optional: true }] }],
      ),
    ]);
    expect(validateProposal(proposal([], { "trim|how": "none" }), shape)).toEqual([]);
    expect(validateProposal(proposal([], { "trim|how": "other" }), shape)).toEqual([
      '"trim|how" chooses a branch; it takes adapters or none',
    ]);
  });

  it("keeps every value a selector path takes under any parent branch", () => {
    const inner = (v: string) =>
      branchy("inner", { name: "choice", type: "select" }, [{ value: v, inputs: [] }]);
    const shape = tool([
      branchy("outer", { name: "sel", type: "select" }, [
        { value: "A", inputs: [inner("a")] },
        { value: "B", inputs: [inner("b")] },
      ]),
    ]);
    expect(
      validateProposal(proposal([], { "outer|sel": "A", "outer|inner|choice": "a" }), shape),
    ).toEqual([]);
  });

  it("refuses an input the chosen branch doesn't declare, chosen or by default", () => {
    const shape = tool([
      branchy("sel", { name: "choice", type: "select", value: "b" }, [
        { value: "a", inputs: [{ name: "x", type: "data", extensions: ["fastqsanger"] }] },
        { value: "b", inputs: [{ name: "n", type: "integer" }] },
      ]),
    ]);
    const given = [{ slot: "sel|x", src: "hda" as const, id: "d1" }];
    const unused = [expect.stringMatching(/"sel\|x" isn't used.*sel\|choice is a/)];
    expect(validateProposal(proposal(given, { "sel|choice": "b" }), shape)).toEqual(unused);
    expect(validateProposal(proposal(given, {}), shape)).toEqual(unused);
    expect(validateProposal(proposal(given, { "sel|choice": "a" }), shape)).toEqual([]);
  });

  it("refuses an inner choice that only another outer branch offers, when it hides the input", () => {
    const inner = (v: string, reads: Record<string, unknown>) =>
      branchy("inner", { name: "choice", type: "select" }, [
        { value: v, inputs: [{ name: "reads", type: "data", ...reads }] },
      ]);
    const shape = tool([
      branchy("outer", { name: "sel", type: "select" }, [
        { value: "A", inputs: [inner("a", { extensions: ["fastqsanger"] })] },
        { value: "B", inputs: [inner("b", { multiple: true, extensions: ["tabular"] })] },
      ]),
    ]);
    const p = proposal(
      [
        { slot: "outer|inner|reads", src: "hda", id: "t1" },
        { slot: "outer|inner|reads", src: "hda", id: "t2" },
      ],
      { "outer|sel": "A", "outer|inner|choice": "b" },
    );
    expect(validateProposal(p, shape)).toEqual([
      expect.stringMatching(/"outer\|inner\|reads" isn't used/),
    ]);
  });

  it("reads dataset-or-collection per branch, in either declaration order", () => {
    for (const order of [
      ["c", "d"],
      ["d", "c"],
    ]) {
      const cases = order.map((v) => ({
        value: v,
        inputs: [{ name: "x", type: v === "c" ? "data_collection" : "data" }],
      }));
      const shape = tool([branchy("k", { name: "sel", type: "select", value: "c" }, cases)]);
      const hda = [{ slot: "k|x", src: "hda" as const, id: "d1" }];
      expect(validateProposal(proposal(hda, { "k|sel": "d" }), shape)).toEqual([]);
      expect(validateProposal(proposal(hda, { "k|sel": "c" }), shape)).toEqual([
        expect.stringMatching(/"k\|x" takes a collection/),
      ]);
    }
  });
});

describe("parsing the block's fields", () => {
  const raw: Record<string, string> = {
    proposal_id: "prop-abc123",
    step_anchor: "plan-a-step-1",
    target: '{"kind":"tool","tool_id":"cat1"}',
    server_url: SERVER,
    history_id: "h1",
    inputs: '[{"slot":"input1","src":"hda","id":"d1"}]',
    overrides: "[]",
    predicate: '{"kind":"manual"}',
  };

  it("reads a minimal block, defaulting version to unpinned and assertions to none", () => {
    const { proposal, errors } = parseProposalFields((k) => raw[k]);
    expect(errors).toEqual([]);
    expect(proposal?.target).toEqual({ kind: "tool", tool_id: "cat1", version: "unpinned" });
    expect(proposal?.assertions).toEqual([]);
  });

  it("ignores unknown keys and never reads a spec_revision", () => {
    const { proposal } = parseProposalFields(
      (k) => ({ ...raw, from_the_future: "x", spec_revision: "f".repeat(64) })[k],
    );
    expect(proposal).not.toBeNull();
    expect(JSON.stringify(proposal)).not.toContain("ffff");
  });

  it("says what is wrong instead of returning a half-read proposal", () => {
    const { proposal, errors } = parseProposalFields(
      (k) =>
        ({
          ...raw,
          target: '{"kind":"tool","workflow_id":"x"}',
          overrides: '[{"param":"p","value":1}]',
        })[k],
    );
    expect(proposal).toBeNull();
    expect(errors).toEqual([
      expect.stringMatching(/target.tool_id is required/),
      expect.stringMatching(/needs a rationale/),
    ]);
  });
});

describe("parsePredicate", () => {
  it("reads a predicate a model sent as JSON text", () => {
    const errors: string[] = [];
    expect(parsePredicate('{"kind":"exists_with_ext","ext":"tabular"}', errors)).toEqual({
      kind: "exists_with_ext",
      ext: "tabular",
    });
    expect(errors).toEqual([]);
  });

  it("still refuses text that is not an object", () => {
    for (const text of ['"manual"', "manual", "[1]", "null", "{bad"]) {
      const errors: string[] = [];
      expect(parsePredicate(text, errors), text).toBeNull();
      expect(errors, text).toEqual(["predicate must be an object"]);
    }
  });
});

describe("approve freezes and hashes (v3 §13)", () => {
  it("records a live user approval on a fresh attempt, with the template frozen", () => {
    const s = store();
    const result = approve(s, toolProposal());
    if (!result.ok) throw new Error(result.problems.join("; "));
    const a = s.snapshot().attempts[result.attemptId];
    expect(a.approval).toMatchObject({
      proposal_id: "prop-abc123",
      status: "live",
      by: "user",
      spec_revision: result.specRevision,
    });
    expect(a.binding.step_anchor).toBe("plan-a-step-1");
    // Unpinned resolves to what Galaxy said.
    expect(a.approval?.spec_snapshot.target.version).toBe("0.23.4+galaxy0");
    expect(result.specRevision).toBe(specRevision(result.spec));
    // The template body is on disk under its digest, exactly.
    const digest = result.spec.template_ref.digest;
    expect(digest).toBe(sha256Hex(canonicalJson(TOOL_SNAPSHOT.body)));
    expect(s.getTemplate(digest)).toEqual(TOOL_SNAPSHOT.body);
    expect(result.spec.inputs).toEqual([
      { slot: "reads", src: "hda", id: "4b6e2f1a9c3d5e70", required: true },
    ]);
  });

  it("refuses what validation refuses, and writes nothing", () => {
    const s = store();
    const result = approve(s, toolProposal({ inputs: [] }));
    expect(result.ok).toBe(false);
    expect(Object.keys(s.snapshot().attempts)).toEqual([]);
  });

  it("refuses a proposal for another server", () => {
    const s = store();
    const result = approve(s, toolProposal({ serverUrl: "https://elsewhere.example" }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.problems[0]).toMatch(/this session is connected to/);
  });

  it("refuses assertions it has no definition to freeze", () => {
    const s = store();
    const result = approve(s, toolProposal({ assertions: ["a1"] }));
    expect(result).toEqual({ ok: false, problems: ['assertion "a1" has no definition to freeze'] });
  });

  it("freezes a user-defined tool's definition digest", () => {
    const s = store();
    const result = approve(
      s,
      toolProposal({
        target: { kind: "udt", tool_uuid: UDT_UUID, version: "unpinned" },
        inputs: [{ slot: "table", src: "hda", id: "d1" }],
        overrides: [],
      }),
      UDT_SNAPSHOT,
    );
    if (!result.ok) throw new Error(result.problems.join("; "));
    const rep = (UDT_SNAPSHOT.body as { representation: unknown }).representation;
    expect(result.spec.target.definition_digest).toBe(sha256Hex(canonicalJson(rep)));
  });

  it("approving the same Spec twice changes nothing", () => {
    const s = store();
    const first = approve(s, toolProposal());
    const second = approve(s, toolProposal());
    expect(second).toMatchObject({ ok: true, unchanged: true });
    if (first.ok && second.ok) expect(second.attemptId).toBe(first.attemptId);
  });

  it("re-approval after a change starts a fresh attempt and revokes the old one", () => {
    const s = store();
    const first = approve(s, toolProposal());
    now += 1000;
    const second = approve(
      s,
      toolProposal({ overrides: [{ param: "threads", value: 8, rationale: "more cores" }] }),
    );
    if (!first.ok || !second.ok) throw new Error("expected both to approve");
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.superseded).toEqual([first.attemptId]);
    const reg = s.snapshot();
    expect(reg.attempts[first.attemptId].approval?.status).toBe("revoked");
    // Inherits nothing: no submission, reservation, evaluation.
    const fresh = reg.attempts[second.attemptId];
    expect(fresh.reservation).toBeUndefined();
    expect(fresh.submission).toBeUndefined();
    expect(fresh.evaluation).toBeUndefined();
  });

  it("refuses to record from a read-only store", () => {
    const writer = store("s-a");
    const reader = store("s-b");
    expect(reader.mode).toBe("read-only");
    expect(() => approve(reader, toolProposal())).toThrow(/read-only/);
    writer.close();
  });
});

describe("edit after approve revokes (v3 §13)", () => {
  function approved() {
    const s = store();
    const r = approve(s, toolProposal());
    if (!r.ok) throw new Error(r.problems.join("; "));
    return { s, attemptId: r.attemptId };
  }

  it("leaves an unchanged proposal alone, including a label edit", () => {
    const { s } = approved();
    expect(findDrift(s.snapshot(), [seen(toolProposal())])).toEqual([]);
    expect(findDrift(s.snapshot(), [seen(toolProposal({ label: "renamed" }))])).toEqual([]);
  });

  it("revokes when an input, a parameter, the history or the step changes", () => {
    const edits: Partial<Proposal>[] = [
      { inputs: [{ slot: "reads", src: "hda", id: "0000000000000bad" }] },
      { overrides: [{ param: "threads", value: 64, rationale: "the queue gives four cores" }] },
      { overrides: [{ param: "threads", value: 4, rationale: "a different reason" }] },
      { historyId: "another-history" },
      { stepAnchor: "plan-a-step-9" },
      { predicate: { kind: "manual" } },
      { target: { kind: "tool", tool_id: "a-different-tool", version: "unpinned" } },
      { target: { kind: "tool", tool_id: TOOL_SNAPSHOT.body.id, version: "9.9" } },
    ];
    for (const edit of edits) {
      const { s, attemptId } = approved();
      expect(findDrift(s.snapshot(), [seen(toolProposal(edit))])).toEqual([
        { attemptId, proposalId: "prop-abc123", reason: "edited" },
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
      dir = tmpAnalysisDir();
    }
  });

  it("pinning the version approval resolved is not an edit", () => {
    const { s } = approved();
    const pinned = toolProposal({
      target: { kind: "tool", tool_id: TOOL_SNAPSHOT.body.id, version: "0.23.4+galaxy0" },
    });
    expect(findDrift(s.snapshot(), [seen(pinned)])).toEqual([]);
  });

  it("revokes when the block is removed, duplicated, or unreadable", () => {
    const { s, attemptId } = approved();
    const base = { attemptId, proposalId: "prop-abc123" };
    expect(findDrift(s.snapshot(), [])).toEqual([{ ...base, reason: "removed" }]);
    expect(findDrift(s.snapshot(), [seen(toolProposal()), seen(toolProposal())])).toEqual([
      { ...base, reason: "duplicated" },
    ]);
    expect(findDrift(s.snapshot(), [seen(null, "prop-abc123")])).toEqual([
      { ...base, reason: "unreadable" },
    ]);
  });

  it("revokeDrifted flips the status in the signed registry", () => {
    const { s, attemptId } = approved();
    const drift = revokeDrifted(s, [seen(toolProposal({ historyId: "other" }))]);
    expect(drift).toHaveLength(1);
    expect(s.snapshot().attempts[attemptId].approval?.status).toBe("revoked");
    const onDisk = JSON.parse(fs.readFileSync(s.registryPath, "utf-8"));
    expect(onDisk.attempts[attemptId].approval.status).toBe("revoked");
  });

  it("/revoke revokes every live approval of the proposal and nothing else", () => {
    const { s, attemptId } = approved();
    const other = approve(s, toolProposal({ proposalId: "prop-zzz999" }));
    expect(revokeProposal(s, "prop-abc123")).toEqual([attemptId]);
    expect(revokeProposal(s, "prop-abc123")).toEqual([]);
    if (other.ok) expect(s.snapshot().attempts[other.attemptId].approval?.status).toBe("live");
  });

  it("/revoke also withdraws a restored approval a reconcile check could rely on (Codex, slice 4)", () => {
    const { s, attemptId } = approved();
    s.close();
    // A new session: what the first one wrote comes back restored.
    const next = store("s-b");
    expect(next.snapshot().attempts[attemptId].approval?.status).toBe("restored");
    expect(revokeProposal(next, "prop-abc123")).toEqual([attemptId]);
    expect(next.snapshot().attempts[attemptId].approval?.status).toBe("revoked");
    next.close();
  });
});

describe("/pending (v3 §13)", () => {
  it("lists proposals without a live approval, saying why", () => {
    const s = store();
    const a = toolProposal({ proposalId: "prop-aaaaaa" });
    const b = toolProposal({ proposalId: "prop-bbbbbb" });
    const c = toolProposal({ proposalId: "prop-cccccc" });
    approve(s, a);
    approve(s, c);
    revokeProposal(s, "prop-cccccc");
    const pending = pendingProposals(s.snapshot(), [
      seen(a),
      seen(b),
      seen(c),
      seen(null, "prop-dddddd"),
    ]);
    expect(pending.map((p) => [p.sighting.proposalId, p.state])).toEqual([
      ["prop-bbbbbb", "unapproved"],
      ["prop-cccccc", "revoked"],
      ["prop-dddddd", "invalid"],
    ]);
  });
});

describe("import of a foreign registry leaves approvals restored, never live (v3 §13)", () => {
  it("a new session reads the old approval as restored and lists the proposal as pending", () => {
    const first = store("s-a");
    const r = approve(first, toolProposal());
    if (!r.ok) throw new Error("approve failed");
    first.close();
    // A later session has a different in-memory key, so the file is an import.
    const second = store("s-b");
    const a = second.snapshot().attempts[r.attemptId];
    expect(a.approval?.status).toBe("restored");
    expect(findDrift(second.snapshot(), [seen(toolProposal())])).toEqual([]);
    expect(pendingProposals(second.snapshot(), [seen(toolProposal())])).toEqual([
      { sighting: seen(toolProposal()), state: "restored" },
    ]);
    // And it can be approved afresh, on a new attempt.
    const again = approve(second, toolProposal());
    expect(again).toMatchObject({ ok: true, unchanged: false });
  });

  it("a hand-made registry claiming a live approval imports as restored", () => {
    const s0 = store("s-a");
    const r = approve(s0, toolProposal());
    if (!r.ok) throw new Error("approve failed");
    s0.close();
    const file = path.join(dir, ".loom", "state", "registry.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf-8"));
    doc.session_sig = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(doc));
    const s1 = store("s-b");
    expect(s1.snapshot().attempts[r.attemptId].approval?.status).toBe("restored");
  });
});

describe("ids and rendering", () => {
  it("mints short ids that don't collide with taken ones", () => {
    let n = 0;
    const random = (k: number) => new Uint8Array(k).fill(n++ < 1 ? 0 : 1);
    const taken = new Set(["prop-000000"]);
    const id = newProposalId(random, taken);
    expect(id).toBe("prop-111111");
    expect(PROPOSAL_ID_RE.test(id)).toBe(true);
  });

  it("renders the table from the proposal, escaping pipes and newlines", () => {
    const table = renderProposalTable(
      toolProposal({
        overrides: [{ param: "threads", value: 4, rationale: "a | b\nc" }],
      }),
      { resolvedVersion: "0.23.4+galaxy0", specRevision: "e".repeat(64) },
    );
    expect(table).toContain("| Proposal | prop-abc123 |");
    expect(table).toContain("@ 0.23.4+galaxy0 (resolved)");
    expect(table).toContain("a \\| b c");
    expect(table).toContain("| spec_revision | eeeeeeeeeeee |");
  });
});

describe("review follow-ups", () => {
  const shape = templateShape("tool", TOOL_SNAPSHOT);

  it("never shortens a value in the table someone approves from", () => {
    const long = "x".repeat(200) + "TAIL";
    const p = toolProposal({ overrides: [{ param: "threads", value: long, rationale: "r" }] });
    expect(renderProposalTable(p)).toContain("TAIL");
    expect(renderProposalTable(p, { compact: true })).not.toContain("TAIL");
    // And a string never looks like a number.
    const s = toolProposal({ overrides: [{ param: "threads", value: "4", rationale: "r" }] });
    expect(renderProposalTable(s)).toContain('| param threads | "4" -- r |');
  });

  it("reads concrete repeat instances as dataset slots, and refuses the placeholder", () => {
    const ok = toolProposal({
      inputs: [
        { slot: "reads", src: "hda", id: "a1" },
        { slot: "queries_0|extra", src: "hda", id: "a2" },
        { slot: "queries_1|extra", src: "hda", id: "a3" },
      ],
    });
    expect(validateProposal(ok, shape)).toEqual([]);
    const placeholder = toolProposal({
      inputs: [
        { slot: "reads", src: "hda", id: "a1" },
        { slot: "queries_#|extra", src: "hda", id: "a2" },
      ],
      overrides: [{ param: "queries_#|tag", value: "x", rationale: "r" }],
    });
    expect(validateProposal(placeholder, shape)).toEqual([
      expect.stringMatching(/"queries_#\|extra" is not a dataset input/),
      expect.stringMatching(/"queries_#\|tag" is not a parameter/),
    ]);
  });

  it("reads a user-defined tool's nested groups in its own vocabulary", () => {
    const udt = templateShape("udt", {
      version: "1.0",
      body: {
        representation: {
          version: "1.0",
          inputs: [
            {
              name: "mode",
              type: "conditional",
              test_parameter: { name: "pick", type: "select" },
              whens: [{ discriminator: "a", parameters: [{ name: "extra", type: "data" }] }],
            },
            { name: "opts", type: "section", parameters: [{ name: "table", type: "data" }] },
            { name: "rows", type: "repeat", parameters: [{ name: "n", type: "integer" }] },
          ],
        },
      },
    });
    expect([...udt.slots.keys()].sort()).toEqual(["mode|extra", "opts|table"]);
    expect(udt.slots.get("opts|table")?.required).toBe(true);
    expect(udt.slots.get("mode|extra")?.required).toBe(false);
    expect([...udt.params].sort()).toEqual(["mode|pick", "rows_#|n"]);
  });

  it("re-approving the same proposal later is still the same approval", () => {
    const s = store();
    const first = approveProposal(s, {
      proposal: toolProposal(),
      snapshot: TOOL_SNAPSHOT,
      assertionDefinitions: new Map(),
      now: "2026-10-07T12:00:00.000Z",
    });
    const second = approveProposal(s, {
      proposal: toolProposal(),
      snapshot: TOOL_SNAPSHOT,
      assertionDefinitions: new Map(),
      now: "2026-10-07T13:30:00.000Z",
    });
    if (!first.ok || !second.ok) throw new Error("expected both to approve");
    expect(second.unchanged).toBe(true);
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.specRevision).toBe(first.specRevision);
    expect(Object.keys(s.snapshot().attempts)).toHaveLength(1);
  });

  it("revokes when the approved step is gone from the notebook", () => {
    const s = store();
    const r = approve(s, toolProposal());
    if (!r.ok) throw new Error("approve failed");
    expect(findDrift(s.snapshot(), [seen(toolProposal())], () => true)).toEqual([]);
    expect(findDrift(s.snapshot(), [seen(toolProposal())], () => false)).toEqual([
      { attemptId: r.attemptId, proposalId: "prop-abc123", reason: "step_removed" },
    ]);
  });
});

describe("plain rendering for notices", () => {
  it("lines the columns up and drops the markdown", () => {
    const out = renderProposalTable(toolProposal(), { plain: true });
    expect(out).not.toContain("|");
    expect(out.split("\n")[0]).toMatch(/^Proposal +prop-abc123$/);
    expect(out).toMatch(/^param threads +4 -- the queue gives four cores$/m);
  });
});
