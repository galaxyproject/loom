import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseMostRecentPlan,
  parseProjectContext,
  checkPreconditions,
  normalizeRouting,
  renderFailures,
} from "../extensions/loom/init-gate";
import { setNotebookPath, setGalaxyConnection, resetState } from "../extensions/loom/state";
import { registerGalaxyTools, setGalaxyToolSource } from "../extensions/loom/galaxy-tool-source";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

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

describe("normalizeRouting", () => {
  it("reads the legacy [galaxy] tag as remote and passes the rest through", () => {
    expect(normalizeRouting("galaxy")).toBe("remote");
    expect(normalizeRouting("Galaxy")).toBe("remote");
    expect(normalizeRouting("remote")).toBe("remote");
    expect(normalizeRouting("HYBRID")).toBe("hybrid");
    expect(normalizeRouting("local")).toBe("local");
    expect(normalizeRouting(undefined)).toBe("unknown");
  });
});

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
  - Verification: confirm fastp HTML/JSON report exists and includes per-base quality summary
- [ ] 2. **Reference index** {#plan-a-step-2} -- bwa index of chrM
`);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("A: chrM Variant Calling");
    expect(plan!.routing).toBe("hybrid");
    expect(plan!.nextStep).not.toBeNull();
    expect(plan!.nextStep!.raw).toContain("QC FASTQ");
  });

  it("still parses legacy continuation-line routing details", () => {
    const plan = parseMostRecentPlan(`
## Plan A: Legacy Format [local]

- [ ] 1. **QC FASTQ** {#plan-a-step-1} -- fastp adapter trim + per-base QC
     Routing: local
`);
    expect(plan).not.toBeNull();
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
    // [galaxy] is the legacy spelling of [remote].
    expect(plan!.routing).toBe("remote");
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
  it("hard-fails with notebook=hard when no notebook is set", async () => {
    const result = await checkPreconditions();
    expect(result.ok).toBe(false);
    expect(result.hardFailed).toBe(true);
    expect(result.failures.map((f) => f.name)).toEqual(["notebook"]);
    expect(result.failures[0].severity).toBe("hard");
  });

  it("hard-fails when a galaxy plan has no active connection", async () => {
    writeNotebook(`
## Plan A: Run remotely [galaxy]

- [ ] 1. **Heavy alignment** -- bwa-mem on big WGS
`);
    setGalaxyConnection(false);
    const result = await checkPreconditions();
    expect(result.hardFailed).toBe(true);
    expect(result.failures.find((f) => f.name === "galaxy_connection")).toBeTruthy();
  });

  it("does not hard-fail on missing connection for a local plan", async () => {
    writeNotebook(`
## Plan A: Local stuff [local]

- [ ] 1. **Parse data** -- awk magic over CSV
  - Verification: confirm the parsed CSV exists and has the expected header
`);
    setGalaxyConnection(false);
    const result = await checkPreconditions();
    expect(result.ok).toBe(true);
    expect(result.hardFailed).toBe(false);
  });
});

describe("checkPreconditions -- soft failures", () => {
  it("soft-fails when there's no plan section", async () => {
    writeNotebook("# nb\n\nfreeform notes only\n");
    const result = await checkPreconditions();
    expect(result.ok).toBe(false);
    expect(result.hardFailed).toBe(false);
    expect(result.failures.map((f) => f.name)).toEqual(["plan"]);
  });

  it("soft-fails when galaxy plan has no history", async () => {
    writeNotebook(`
## Plan A: Galaxy [galaxy]

- [ ] 1. **Step** -- with a description that exceeds the threshold
`);
    setGalaxyConnection(true); // connected, but no history
    const result = await checkPreconditions();
    expect(result.failures.find((f) => f.name === "history")).toBeTruthy();
    expect(result.failures.find((f) => f.name === "history")!.severity).toBe("soft");
  });

  it("clears the history failure when Project context provides one", async () => {
    writeNotebook(`
## Project context

history_id: f5912ab34

## Plan A: Galaxy [galaxy]

- [ ] 1. **Step** -- with a description that exceeds the threshold
`);
    setGalaxyConnection(true);
    const result = await checkPreconditions();
    expect(result.failures.find((f) => f.name === "history")).toBeUndefined();
  });

  it("clears the history failure when state has currentHistoryId", async () => {
    writeNotebook(`
## Plan A: Galaxy [galaxy]

- [ ] 1. **Step** -- adequate description here
`);
    setGalaxyConnection(true, "history_from_state");
    const result = await checkPreconditions();
    expect(result.failures.find((f) => f.name === "history")).toBeUndefined();
  });

  it("soft-fails on a bare-title step (no acceptance description)", async () => {
    writeNotebook(`
## Plan A: Skinny [local]

- [ ] 1. **Hi**
`);
    const result = await checkPreconditions();
    expect(result.failures.find((f) => f.name === "acceptance")).toBeTruthy();
    expect(result.failures.find((f) => f.name === "acceptance")!.severity).toBe("soft");
  });

  it("does not block execution when verification criteria are missing", async () => {
    writeNotebook(`
## Plan A: Legacy [local]

- [ ] 1. **Write config** {#plan-a-step-1} -- create the requested config file
`);
    const result = await checkPreconditions();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe("checkPreconditions -- happy path", () => {
  it("passes for a well-formed local plan", async () => {
    writeNotebook(`
## Plan A: chrM [local]

- [ ] 1. **QC FASTQ** {#plan-a-step-1} -- fastp adapter trim + per-base QC
  - Verification: confirm fastp HTML/JSON report exists and includes the summary module
`);
    const result = await checkPreconditions();
    expect(result.ok).toBe(true);
    expect(result.hardFailed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.plan?.routing).toBe("local");
  });

  it("passes for a galaxy plan when connection + history are present", async () => {
    writeNotebook(`
## Plan A: Aligned [galaxy]

- [ ] 1. **bwa-mem PE** {#plan-a-step-1} -- 4 samples on chrM reference
  - Verification: poll the Galaxy invocation to completion and inspect BAM outputs
`);
    setGalaxyConnection(true, "abc123");
    const result = await checkPreconditions();
    expect(result.ok).toBe(true);
  });
});

describe("checkPreconditions -- Galaxy readiness without a connect tool", () => {
  const REMOTE = `
## Plan A: Aligned [remote]

- [ ] 1. **bwa-mem PE** {#plan-a-step-1} -- 4 samples on chrM reference
`;
  const connectionFailure = async () =>
    (await checkPreconditions()).failures.find((f) => f.name === "galaxy_connection");
  const bare = () => {
    setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
    // The default in-process source: galaxy-ops' operations, which have no connect tool.
    registerGalaxyTools({ registerTool: () => {} } as never);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    setGalaxyToolSource(null);
    setCapabilityProfile(null);
  });

  it("passes a [remote] plan under bare once credentials are configured", async () => {
    writeNotebook(REMOTE);
    vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
    vi.stubEnv("GALAXY_API_KEY", "key");
    bare();
    // Nothing called connect: in-process tools have no such step.
    setGalaxyConnection(false);
    expect(await connectionFailure()).toBeUndefined();
  });

  it("hard-fails a [remote] plan under bare without credentials", async () => {
    writeNotebook(REMOTE);
    vi.stubEnv("GALAXY_URL", "");
    vi.stubEnv("GALAXY_API_KEY", "");
    bare();
    const result = await checkPreconditions();
    expect(result.hardFailed).toBe(true);
    expect(await connectionFailure()).toBeTruthy();
  });

  it("still asks for connect under mcp, credentials or not", async () => {
    writeNotebook(REMOTE);
    vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
    vi.stubEnv("GALAXY_API_KEY", "key");
    setGalaxyConnection(false);
    expect(await connectionFailure()).toBeTruthy();
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
  it("hard-fails when the path exists but isn't a readable file", async () => {
    // Point notebookPath at the directory itself: existsSync returns true,
    // but readFileSync throws EISDIR. Exercises the catch branch in
    // checkPreconditions without needing an ESM-incompatible spy.
    setNotebookPath(tmpDir);
    const result = await checkPreconditions();
    expect(result.hardFailed).toBe(true);
    expect(result.failures[0].name).toBe("notebook");
  });
});

describe("checkPreconditions -- local-shell gate", () => {
  let savedShell: string | undefined;

  beforeEach(() => {
    savedShell = process.env.LOOM_LOCAL_SHELL;
  });
  afterEach(() => {
    if (savedShell === undefined) delete process.env.LOOM_LOCAL_SHELL;
    else process.env.LOOM_LOCAL_SHELL = savedShell;
  });

  const localExecFailure = (failures: { name: string; severity: string }[]) =>
    failures.find((f) => f.name === "local_exec");

  it.each(["local", "hybrid"])(
    "hard-fails a [%s] plan when the local shell is gone",
    async (routing) => {
      process.env.LOOM_LOCAL_SHELL = "off";
      writeNotebook(
        `## Plan A: Thing [${routing}]\n\n- [ ] 1. **Do it** -- with enough description\n`,
      );
      const gate = await checkPreconditions();
      expect(gate.hardFailed).toBe(true);
      const f = localExecFailure(gate.failures);
      expect(f?.severity).toBe("hard");
      expect(f?.remediation).toContain("needs local execution");
    },
  );

  it("hard-fails an untagged (unknown) plan when the local shell is gone", async () => {
    process.env.LOOM_LOCAL_SHELL = "off";
    writeNotebook(`## Plan A: Thing\n\n- [ ] 1. **Do it** -- with enough description\n`);
    const gate = await checkPreconditions();
    expect(localExecFailure(gate.failures)?.severity).toBe("hard");
  });

  it.each(["galaxy", "remote"])("never local_exec-fails a [%s] plan", async (routing) => {
    process.env.LOOM_LOCAL_SHELL = "off";
    writeNotebook(
      `## Plan A: Thing [${routing}]\n\n- [ ] 1. **Do it** -- with enough description\n`,
    );
    expect(localExecFailure((await checkPreconditions()).failures)).toBeUndefined();
  });

  it("does not local_exec-fail when the shell is available (mac/linux unaffected)", async () => {
    delete process.env.LOOM_LOCAL_SHELL;
    writeNotebook(`## Plan A: Thing [local]\n\n- [ ] 1. **Do it** -- with enough description\n`);
    expect(localExecFailure((await checkPreconditions()).failures)).toBeUndefined();
  });
});
