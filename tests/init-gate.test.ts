import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseMostRecentPlan,
  parseProjectContext,
  checkPreconditions,
  renderFailures,
} from "../extensions/loom/init-gate";
import { setNotebookPath, setGalaxyConnection, resetState } from "../extensions/loom/state";

let tmpDir: string;
let nbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-init-gate-"));
  nbPath = path.join(tmpDir, "notebook.md");
  resetState();
});

afterEach(() => {
  resetState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeNotebook(contents: string) {
  fs.writeFileSync(nbPath, contents, "utf-8");
  setNotebookPath(nbPath);
}

describe("parseMostRecentPlan", () => {
  it("returns null when no plan heading is present", () => {
    expect(parseMostRecentPlan("# nb\n\nsome notes\n")).toBeNull();
  });

  it("extracts title, routing, and the first pending step", () => {
    const plan = parseMostRecentPlan(`
# nb

## Plan A: chrM Variant Calling [hybrid]

### Steps

- [ ] 1. **QC FASTQ** {#plan-a-step-1} -- fastp adapter trim + per-base QC
- [ ] 2. **Reference index** {#plan-a-step-2} -- bwa index of chrM
`);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("A: chrM Variant Calling");
    expect(plan!.routing).toBe("hybrid");
    expect(plan!.nextStep).not.toBeNull();
    expect(plan!.nextStep!.raw).toContain("QC FASTQ");
  });

  it("returns the LAST plan when multiple coexist", () => {
    const plan = parseMostRecentPlan(`
## Plan A: First [local]

- [x] 1. **Done** -- already complete

## Plan B: Second [galaxy]

- [ ] 1. **Active step** -- run something
`);
    expect(plan!.title).toBe("B: Second");
    expect(plan!.routing).toBe("galaxy");
    expect(plan!.nextStep!.raw).toContain("Active step");
  });

  it("skips completed (`- [x]`) and failed (`- [!]`) steps", () => {
    const plan = parseMostRecentPlan(`
## Plan A: Test [local]

- [x] 1. **Done** -- ok
- [!] 2. **Failed** -- ouch
- [ ] 3. **Pending** -- this one
- [ ] 4. **Later** -- skip me
`);
    expect(plan!.nextStep!.raw).toContain("Pending");
    expect(plan!.nextStep!.raw).not.toContain("Later");
  });

  it("returns nextStep null when all steps are complete", () => {
    const plan = parseMostRecentPlan(`
## Plan A: Done [local]

- [x] 1. **Step 1** -- ok
- [x] 2. **Step 2** -- ok
`);
    expect(plan!.nextStep).toBeNull();
  });

  it("does not look past the next h2 boundary for pending steps", () => {
    const plan = parseMostRecentPlan(`
## Plan A: Test [local]

- [x] 1. **Done** -- ok

## Notes

- [ ] this is not a step in the plan
`);
    // The latest plan is Plan A (Notes is not a Plan heading); its only
    // step is complete; the bullet under Notes is outside the plan section.
    expect(plan!.title).toBe("A: Test");
    expect(plan!.nextStep).toBeNull();
  });

  it("treats a missing routing tag as `unknown`", () => {
    const plan = parseMostRecentPlan(`
## Plan X: Untagged

- [ ] 1. **Step** -- description
`);
    expect(plan!.routing).toBe("unknown");
  });

  it("flags a bare-title step as having a tiny description", () => {
    const plan = parseMostRecentPlan(`
## Plan A: Skinny [local]

- [ ] 1. **Hi**
`);
    expect(plan!.nextStep!.descriptionLength).toBeLessThan(8);
  });
});

describe("parseProjectContext", () => {
  it("returns null when no `## Project context` block exists", () => {
    expect(parseProjectContext("# nb\n\nno context\n")).toBeNull();
  });

  it("extracts history_id and galaxy_url", () => {
    const ctx = parseProjectContext(`
# nb

## Project context

history_id: f5912ab34
galaxy_url: https://usegalaxy.org

## Plan A: Foo [local]
`);
    expect(ctx).toEqual({
      historyId: "f5912ab34",
      galaxyUrl: "https://usegalaxy.org",
    });
  });

  it("stops at the next h2 boundary", () => {
    const ctx = parseProjectContext(`
## Project context

history_id: only_this

## Other

history_id: not_this
`);
    expect(ctx?.historyId).toBe("only_this");
  });
});

describe("checkPreconditions -- hard failures", () => {
  it("hard-fails with notebook=hard when no notebook is set", () => {
    const result = checkPreconditions();
    expect(result.ok).toBe(false);
    expect(result.hardFailed).toBe(true);
    expect(result.failures.map((f) => f.name)).toEqual(["notebook"]);
    expect(result.failures[0].severity).toBe("hard");
  });

  it("hard-fails when a galaxy plan has no active connection", () => {
    writeNotebook(`
## Plan A: Run remotely [galaxy]

- [ ] 1. **Heavy alignment** -- bwa-mem on big WGS
`);
    setGalaxyConnection(false);
    const result = checkPreconditions();
    expect(result.hardFailed).toBe(true);
    expect(result.failures.find((f) => f.name === "galaxy_connection")).toBeTruthy();
  });

  it("does not hard-fail on missing connection for a local plan", () => {
    writeNotebook(`
## Plan A: Local stuff [local]

- [ ] 1. **Parse data** -- awk magic over CSV
`);
    setGalaxyConnection(false);
    const result = checkPreconditions();
    expect(result.ok).toBe(true);
    expect(result.hardFailed).toBe(false);
  });
});

describe("checkPreconditions -- soft failures", () => {
  it("soft-fails when there's no plan section", () => {
    writeNotebook("# nb\n\nfreeform notes only\n");
    const result = checkPreconditions();
    expect(result.ok).toBe(false);
    expect(result.hardFailed).toBe(false);
    expect(result.failures.map((f) => f.name)).toEqual(["plan"]);
  });

  it("soft-fails when galaxy plan has no history", () => {
    writeNotebook(`
## Plan A: Galaxy [galaxy]

- [ ] 1. **Step** -- with a description that exceeds the threshold
`);
    setGalaxyConnection(true); // connected, but no history
    const result = checkPreconditions();
    expect(result.failures.find((f) => f.name === "history")).toBeTruthy();
    expect(result.failures.find((f) => f.name === "history")!.severity).toBe("soft");
  });

  it("clears the history failure when Project context provides one", () => {
    writeNotebook(`
## Project context

history_id: f5912ab34

## Plan A: Galaxy [galaxy]

- [ ] 1. **Step** -- with a description that exceeds the threshold
`);
    setGalaxyConnection(true);
    const result = checkPreconditions();
    expect(result.failures.find((f) => f.name === "history")).toBeUndefined();
  });

  it("clears the history failure when state has currentHistoryId", () => {
    writeNotebook(`
## Plan A: Galaxy [galaxy]

- [ ] 1. **Step** -- adequate description here
`);
    setGalaxyConnection(true, "history_from_state");
    const result = checkPreconditions();
    expect(result.failures.find((f) => f.name === "history")).toBeUndefined();
  });

  it("soft-fails on a bare-title step (no acceptance description)", () => {
    writeNotebook(`
## Plan A: Skinny [local]

- [ ] 1. **Hi**
`);
    const result = checkPreconditions();
    expect(result.failures.find((f) => f.name === "acceptance")).toBeTruthy();
    expect(result.failures.find((f) => f.name === "acceptance")!.severity).toBe("soft");
  });
});

describe("checkPreconditions -- happy path", () => {
  it("passes for a well-formed local plan", () => {
    writeNotebook(`
## Plan A: chrM [local]

- [ ] 1. **QC FASTQ** {#plan-a-step-1} -- fastp adapter trim + per-base QC
`);
    const result = checkPreconditions();
    expect(result.ok).toBe(true);
    expect(result.hardFailed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.plan?.routing).toBe("local");
  });

  it("passes for a galaxy plan when connection + history are present", () => {
    writeNotebook(`
## Plan A: Aligned [galaxy]

- [ ] 1. **bwa-mem PE** {#plan-a-step-1} -- 4 samples on chrM reference
`);
    setGalaxyConnection(true, "abc123");
    const result = checkPreconditions();
    expect(result.ok).toBe(true);
  });
});

describe("renderFailures", () => {
  it("renders failures as a markdown bullet list", () => {
    const out = renderFailures([
      { name: "plan", severity: "soft", remediation: "no plan" },
      { name: "history", severity: "soft", remediation: "no history" },
    ]);
    expect(out).toContain("- **plan**: no plan");
    expect(out).toContain("- **history**: no history");
  });

  it("returns empty string when there are no failures", () => {
    expect(renderFailures([])).toBe("");
  });
});

describe("checkPreconditions handles unreadable notebook", () => {
  it("hard-fails when the path exists but isn't a readable file", () => {
    // Point notebookPath at the directory itself: existsSync returns true,
    // but readFileSync throws EISDIR. Exercises the catch branch in
    // checkPreconditions without needing an ESM-incompatible spy.
    setNotebookPath(tmpDir);
    const result = checkPreconditions();
    expect(result.hardFailed).toBe(true);
    expect(result.failures[0].name).toBe("notebook");
  });
});
