import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureAttemptRecord,
  listAttemptRecords,
  noteEnrichmentRetry,
  provenanceRelativePath,
  readAttemptRecord,
  readAttemptRecordSync,
  readReconcileState,
  setProvenanceFs,
  writeEnrichment,
  writeProvenanceSidecar,
  writeReconcileState,
  UNKNOWN,
  type AttemptSeed,
  type ProvenanceJob,
} from "../extensions/loom/galaxy-provenance";
import { memoryProvenanceFs } from "../extensions/loom/provenance-memory-fs";
import { ulid } from "../extensions/loom/ulid";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const SERVER = "https://usegalaxy.org";

function job(jobId: string): ProvenanceJob {
  return {
    job_id: jobId,
    tool_id: "fastp",
    tool_version: "0.24.0",
    tool_version_source: "submission",
    state: "ok",
    exit_code: 0,
    create_time: UNKNOWN,
    update_time: UNKNOWN,
    command_version: UNKNOWN,
    params: {},
    inputs: [],
    outputs: [],
    output_collections: [],
  };
}

function seed(attemptId: string, jobIds = ["j1"]): AttemptSeed {
  return {
    attemptId,
    kind: "jobs",
    galaxyServerUrl: SERVER,
    historyId: "h1",
    submittedBy: "harness",
    ids: { job_ids: jobIds },
    origin: "submission",
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-provenance-memory-"));
});

afterEach(() => {
  setProvenanceFs(null);
  setCapabilityProfile(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("provenance over a memory fs", () => {
  it("keeps records and the cursor on the Map and writes nothing to disk", async () => {
    const memory = memoryProvenanceFs();
    setProvenanceFs(memory);
    const id = ulid();
    const first = await ensureAttemptRecord(dir, seed(id));
    // First-writer-wins: the second call gets the first record back.
    const again = await ensureAttemptRecord(dir, { ...seed(id, ["other"]), historyId: "h2" });
    expect(again).toEqual(first);
    expect(again.ids).toEqual({ job_ids: ["j1"] });

    const enriched = await writeEnrichment(dir, id, {
      blockKind: "job",
      blockId: "j1",
      state: "complete",
      attempts: 1,
      jobs: [job("j1")],
      serverUrl: SERVER,
    });
    expect(enriched.enrichment.state).toBe("complete");
    await noteEnrichmentRetry(
      dir,
      id,
      { blockKind: "job", blockId: "j1", serverUrl: SERVER },
      2,
      "503",
    );
    const back = await readAttemptRecord(dir, id);
    expect(back?.enrichment.attempts).toBe(2);
    expect(back?.enrichment.error).toBe("503");
    expect(readAttemptRecordSync(dir, id)).toEqual(back);

    // A non-ULID key under the provenance dir is not a record.
    memory.files.set(path.join(dir, ".loom", "provenance", "notes.json"), "{}");
    expect((await listAttemptRecords(dir)).map((r) => r.attempt_id)).toEqual([id]);

    expect(await readReconcileState(dir)).toBeNull();
    const state = { schema: 1, analysis_started_at: "2026-10-07T00:00:00.000Z", histories: {} };
    await writeReconcileState(dir, state);
    expect(await readReconcileState(dir)).toEqual(state);

    expect(provenanceRelativePath(id)).toBe(`.loom/provenance/${id}.json`);
    expect(fs.existsSync(path.join(dir, ".loom"))).toBe(false);
  });

  it("keeps two analysis directories apart on one Map", async () => {
    setProvenanceFs(memoryProvenanceFs());
    const other = path.join(dir, "other");
    const a = ulid();
    const b = ulid();
    await ensureAttemptRecord(dir, seed(a));
    await ensureAttemptRecord(other, seed(b));
    expect((await listAttemptRecords(dir)).map((r) => r.attempt_id)).toEqual([a]);
    expect((await listAttemptRecords(other)).map((r) => r.attempt_id)).toEqual([b]);
    expect(await readAttemptRecord(other, a)).toBeNull();
  });

  it("defaults to the memory fs under a page notebook", async () => {
    // A cursor planted on disk is invisible under the page profile: the bytes
    // come from the Map, so the file system is never consulted.
    const planted = path.join(dir, ".loom", "provenance");
    fs.mkdirSync(planted, { recursive: true });
    const onDisk = { schema: 1, analysis_started_at: "2020-01-01T00:00:00.000Z", histories: {} };
    fs.writeFileSync(path.join(planted, "reconcile-state.json"), JSON.stringify(onDisk));
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    expect(await readReconcileState(dir)).toBeNull();
    const state = { schema: 1, analysis_started_at: "2026-10-07T00:00:00.000Z", histories: {} };
    await writeReconcileState(dir, state);
    expect(await readReconcileState(dir)).toEqual(state);
    expect(
      JSON.parse(fs.readFileSync(path.join(planted, "reconcile-state.json"), "utf-8")),
    ).toEqual(onDisk);
    // And with the profile gone, the file backend reads what was on disk all along.
    setCapabilityProfile(null);
    expect(await readReconcileState(dir)).toEqual(onDisk);
    // Restoring the default also starts the page Map afresh.
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    expect(await readReconcileState(dir)).toEqual(state);
    setProvenanceFs(null);
    expect(await readReconcileState(dir)).toBeNull();
  });
});

describe("provenance sidecars over a memory fs", () => {
  it("keeps the first text written under a name and writes nothing to disk", async () => {
    const memory = memoryProvenanceFs();
    setProvenanceFs(memory);
    await writeProvenanceSidecar(dir, ["udt", "x.yaml"], "a: 1\n");
    await writeProvenanceSidecar(dir, ["udt", "x.yaml"], "a: 2\n");
    expect(memory.files.get(path.join(dir, ".loom", "provenance", "udt", "x.yaml"))).toBe("a: 1\n");
    expect(fs.existsSync(path.join(dir, ".loom"))).toBe(false);
  });
});
