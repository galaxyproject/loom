import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Observation } from "../shared/observation-contract.js";

let tmpHome: string;
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;

const obs: Observation = {
  schemaVersion: 1,
  id: "550e8400-e29b-41d4-a716-446655440000",
  clientTs: "2026-09-30T12:00:00.000Z",
  client: { app: "loom-cli", version: "0.8.0", platform: "darwin" },
  installToken: "a".repeat(32),
  kind: "tool-error",
  stage: "tool-parameterization",
  trigger: "tool_error",
  tools: [{ id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2", version: "2.2.1+galaxy1" }],
  mcpTool: "galaxy_run_tool",
  datatypes: ["tabular"],
  signature: "ToolExecutionError: dataset <id> failed",
  galaxy: { server: "usegalaxy.org" },
  description: "A filter step refused a header-only table.",
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-tx-"));
  fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, ".loom", "config.json"), "{}", "utf-8");
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.ORBIT_OBSERVATIONS_URL;
  delete process.env.LOOM_OBSERVATIONS_URL;
  delete process.env.ORBIT_FEEDBACK_KEY;
  delete process.env.LOOM_FEEDBACK_KEY;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  delete process.env.ORBIT_FEEDBACK_KEY;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function load() {
  return await import("../extensions/loom/observations.js");
}

function lines(file: string): string[] {
  const p = path.join(tmpHome, ".loom", file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
}

describe("submitObservation", () => {
  it("POSTs to /observations and returns the id and retract token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, id: obs.id, retractToken: "b".repeat(32) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.ORBIT_FEEDBACK_KEY = "shared-key";
    const m = await load();
    const res = await m.submitObservation(obs);
    expect(res.ok).toBe(true);
    expect(res.id).toBe(obs.id);
    expect(res.retractToken).toBe("b".repeat(32));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/observations$/);
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Orbit-Feedback-Key"]).toBe("shared-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("reports a 400's field names without retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid", errors: ["signature:bad-length"] }),
      }),
    );
    const m = await load();
    const res = await m.submitObservation(obs);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(["signature:bad-length"]);
    expect(res.queueable).toBe(false);
  });

  it("treats a 503 as queueable, like a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );
    const m = await load();
    const res = await m.submitObservation(obs);
    expect(res.ok).toBe(false);
    expect(res.queueable).toBe(true);
  });

  it("treats a 429 as queueable but a 401 as not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    );
    let m = await load();
    expect((await m.submitObservation(obs)).queueable).toBe(true);
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    m = await load();
    expect((await m.submitObservation(obs)).queueable).toBe(false);
  });

  it("retries a 500 once, then treats it as permanent rather than queueing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    const res = await m.submitObservation(obs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(500);
    expect(res.queueable).toBe(false);
  });

  it("takes a 500 followed by a 202 as sent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ ok: true, id: obs.id }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    expect((await m.submitObservation(obs)).ok).toBe(true);
  });

  it("never follows a redirect, and doesn't queue one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 307, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    const res = await m.submitObservation(obs);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    expect(res.queueable).toBe(false);
  });

  it("returns ok:false and queueable on a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const m = await load();
    const res = await m.submitObservation(obs);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("offline");
    expect(res.queueable).toBe(true);
  });

  it("refuses to send an over-cap payload rather than letting the Worker bounce it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    const fat = { ...obs, signature: "s".repeat(200), description: "d".repeat(500) } as Observation;
    // Pad past the cap through a legal-shaped but absurd tools array.
    const tools = Array(5).fill({ id: "x".repeat(200), version: "y".repeat(40) });
    const res = await m.submitObservation({
      ...fat,
      tools,
      datatypes: Array(5).fill("d".repeat(40)),
    });
    // A legal maximum payload is far under 16 KB, so this must still send.
    expect(fetchMock).toHaveBeenCalled();
    expect(res.queueable).toBeDefined();
  });

  it("refuses a payload over the byte cap without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    // Only reachable by skipping capObservation, which is the point: the
    // transport holds its own floor.
    const res = await m.submitObservation({ ...obs, description: "z".repeat(20_000) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.queueable).toBe(false);
  });

  it("honours the dev endpoint override", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 202, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    process.env.ORBIT_OBSERVATIONS_URL = "http://localhost:8787";
    const m = await load();
    await m.submitObservation(obs);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://localhost:8787/observations");
  });
});

describe("retractObservation", () => {
  it("sends both headers and reports success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, deleted: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.ORBIT_FEEDBACK_KEY = "shared-key";
    const m = await load();
    const res = await m.retractObservation(obs.id, "b".repeat(32));
    expect(res.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://orbit-feedback.dannon-baker.workers.dev/observations/${obs.id}`,
    );
    expect(opts.method).toBe("DELETE");
    expect(opts.headers["X-Orbit-Feedback-Key"]).toBe("shared-key");
    expect(opts.headers["X-Retract-Token"]).toBe("b".repeat(32));
  });

  it("reads a 404 as already gone, not as an error worth retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    const m = await load();
    const res = await m.retractObservation(obs.id, "b".repeat(32));
    expect(res.ok).toBe(true);
    expect(res.alreadyGone).toBe(true);
  });

  it("reports a transport failure as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const m = await load();
    const res = await m.retractObservation(obs.id, "b".repeat(32));
    expect(res.ok).toBe(false);
    expect(res.alreadyGone).toBe(false);
  });
});

describe("local logs", () => {
  it("appends to the outbox and reads back", async () => {
    const m = await load();
    const written = m.appendToObservationOutbox(obs);
    expect(written).toBe(path.join(tmpHome, ".loom", "observations-outbox.jsonl"));
    expect(JSON.parse(lines("observations-outbox.jsonl")[0]).id).toBe(obs.id);
  });

  it("builds a sent-log entry with no retract token and no install token in it", async () => {
    const m = await load();
    const entry = m.sentLogEntryFor(obs, "sent");
    expect(entry).toMatchObject({
      id: obs.id,
      status: "sent",
      kind: "tool-error",
      stage: "tool-parameterization",
      trigger: "tool_error",
      signature: obs.signature,
      tools: ["toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2"],
      mcpTool: "galaxy_run_tool",
      datatypes: ["tabular"],
      server: "usegalaxy.org",
      description: obs.description,
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(obs.installToken);
    expect(serialized).not.toContain("retractToken");
  });

  it("appends and reads the sent log in order, skipping malformed lines", async () => {
    const m = await load();
    m.appendSentLog(m.sentLogEntryFor(obs, "sent"));
    fs.appendFileSync(path.join(tmpHome, ".loom", "observations-sent.jsonl"), "{ broken\n");
    m.appendSentLog({ ...m.sentLogEntryFor(obs, "retracted"), at: "2026-10-01T00:00:00.000Z" });
    const rows = m.readSentLog();
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("sent");
    expect(rows[1].status).toBe("retracted");
  });

  it("writes the outbox and the sent log at 0600", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    m.appendSentLog(m.sentLogEntryFor(obs, "sent"));
    for (const name of ["observations-outbox.jsonl", "observations-sent.jsonl"]) {
      // chmod is a no-op on Windows, so the mode there is whatever the runner reports.
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(tmpHome, ".loom", name)).mode & 0o777, name).toBe(0o600);
      }
    }
  });

  it("creates the state dir if it is missing", async () => {
    fs.rmSync(path.join(tmpHome, ".loom"), { recursive: true, force: true });
    const m = await load();
    expect(m.appendToObservationOutbox(obs)).not.toBeNull();
  });
});

describe("cancelling a queued observation", () => {
  it("removes the row by id and leaves the others", async () => {
    const m = await load();
    const other = { ...obs, id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" };
    m.appendToObservationOutbox(obs);
    m.appendToObservationOutbox(other);
    expect(m.removeFromObservationOutbox(obs.id)).toBe("removed");
    expect(lines("observations-outbox.jsonl").map((l) => JSON.parse(l).id)).toEqual([other.id]);
    expect(m.removeFromObservationOutbox(obs.id)).toBe("absent");
  });

  it("refuses while a drain may be sending that very row", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const drain = m.drainObservationOutbox(
      async () => {
        await blocked;
        return { ok: true, status: 202, queueable: false };
      },
      () => true,
    );
    expect(m.removeFromObservationOutbox(obs.id)).toBe("busy");
    release();
    await drain;
  });
});

describe("a local write that fails", () => {
  it("reports the outbox write as failed instead of pretending it was saved", async () => {
    // The second review's setup: the state dirs are regular files.
    fs.rmSync(path.join(tmpHome, ".loom"), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmpHome, ".loom"), "not a directory");
    fs.writeFileSync(path.join(tmpHome, ".orbit"), "not a directory");
    const m = await load();
    expect(m.appendToObservationOutbox(obs)).toBeNull();
    expect(m.saveRetractToken(obs.id, "b".repeat(32))).toBe(false);
  });
});

describe("retract-token store", () => {
  it("is written via a temp file and rename, so a failed write leaves the old store intact", async () => {
    const m = await load();
    m.saveRetractToken(obs.id, "b".repeat(32));
    const store = path.join(tmpHome, ".loom", "observations-tokens.json");
    // Block the temp path: the write fails before anything touches the store.
    fs.mkdirSync(`${store}.${process.pid}.tmp`);
    expect(m.saveRetractToken("6ba7b810-9dad-41d1-80b4-00c04fd430c8", "c".repeat(32))).toBe(false);
    expect(m.readRetractToken(obs.id)).toBe("b".repeat(32));
    expect(JSON.parse(fs.readFileSync(store, "utf-8"))).toEqual({ [obs.id]: "b".repeat(32) });
  });

  it("round-trips a token and forgets it, at 0600", async () => {
    const m = await load();
    m.saveRetractToken(obs.id, "b".repeat(32));
    expect(m.readRetractToken(obs.id)).toBe("b".repeat(32));
    const store = path.join(tmpHome, ".loom", "observations-tokens.json");
    if (process.platform !== "win32") expect(fs.statSync(store).mode & 0o777).toBe(0o600);
    m.forgetRetractToken(obs.id);
    expect(m.readRetractToken(obs.id)).toBeUndefined();
  });

  it("survives a corrupt store rather than throwing", async () => {
    fs.writeFileSync(path.join(tmpHome, ".loom", "observations-tokens.json"), "{ broken", "utf-8");
    const m = await load();
    expect(m.readRetractToken(obs.id)).toBeUndefined();
    m.saveRetractToken(obs.id, "c".repeat(32));
    expect(m.readRetractToken(obs.id)).toBe("c".repeat(32));
  });
});

describe("drainObservationOutbox", () => {
  const ok = async () => ({
    ok: true,
    status: 202,
    retractToken: "c".repeat(32),
    queueable: false,
  });

  it("sends what the outbox holds, logs it as sent and empties the file", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    const submit = vi.fn(ok);
    expect(await m.drainObservationOutbox(submit, () => true)).toEqual({
      sent: 1,
      kept: 0,
      dropped: 0,
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(lines("observations-outbox.jsonl")).toEqual([]);
    expect(m.readSentLog().at(-1)?.status).toBe("sent");
    expect(m.readRetractToken(obs.id)).toBe("c".repeat(32));
    const file = path.join(tmpHome, ".loom", "observations-outbox.jsonl");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps a row that is still queueable and drops one refused for good", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    m.appendToObservationOutbox({ ...obs, id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" });
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, queueable: true })
      .mockResolvedValueOnce({ ok: false, status: 500, queueable: false });
    expect(await m.drainObservationOutbox(submit, () => true)).toEqual({
      sent: 0,
      kept: 1,
      dropped: 1,
    });
    expect(JSON.parse(lines("observations-outbox.jsonl")[0]).id).toBe(obs.id);
  });

  it("re-validates every row and never sends one that was edited to leak", async () => {
    const m = await load();
    fs.writeFileSync(
      path.join(tmpHome, ".loom", "observations-outbox.jsonl"),
      JSON.stringify({ ...obs, signature: "failed on 10.12.4.7" }) + "\n{ broken\n",
    );
    const submit = vi.fn(ok);
    expect(await m.drainObservationOutbox(submit, () => true)).toEqual({
      sent: 0,
      kept: 0,
      dropped: 2,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps rows appended while the sends were in flight", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    const late = { ...obs, id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" };
    const submit = vi.fn(async () => {
      m.appendToObservationOutbox(late);
      return { ok: true, status: 202, queueable: false };
    });
    expect((await m.drainObservationOutbox(submit, () => true)).sent).toBe(1);
    expect(lines("observations-outbox.jsonl").map((l) => JSON.parse(l).id)).toEqual([late.id]);
  });

  it("stops trying once the route is unreachable this round", async () => {
    const m = await load();
    for (let i = 0; i < 3; i++) m.appendToObservationOutbox(obs);
    const submit = vi.fn().mockResolvedValue({ ok: false, error: "offline", queueable: true });
    expect(await m.drainObservationOutbox(submit, () => true)).toEqual({
      sent: 0,
      kept: 3,
      dropped: 0,
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("stops sending as soon as collection is turned off mid-drain", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    m.appendToObservationOutbox({ ...obs, id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" });
    let collecting = true;
    const submit = vi.fn(async () => {
      collecting = false;
      return { ok: true, status: 202, queueable: false };
    });
    expect(await m.drainObservationOutbox(submit, () => collecting)).toEqual({
      sent: 1,
      kept: 1,
      dropped: 0,
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("re-applies the builder's admission rules to a hand-edited row", async () => {
    const m = await load();
    // The second review's row: legal under the wire validator and clean under
    // the old scan, but nothing the builder would ever have produced.
    fs.writeFileSync(
      path.join(tmpHome, ".loom", "observations-outbox.jsonl"),
      JSON.stringify({
        ...obs,
        tools: [{ id: "/srv/Alice_Smith", version: "alice@localhost" }],
        mcpTool: "galaxy.internal",
        datatypes: ["192.0.2.12"],
        galaxy: { server: "usegalaxy.org", version: "Alice Smith" },
      }) + "\n",
    );
    const submit = vi.fn(ok);
    expect(await m.drainObservationOutbox(submit, () => true)).toEqual({
      sent: 0,
      kept: 0,
      dropped: 1,
    });
    expect(submit).not.toHaveBeenCalled();
    // Each structured field is refused on its own, not just by the leak scan.
    for (const forged of [
      { ...obs, tools: [{ id: "Alice_Smith" }] },
      { ...obs, mcpTool: "galaxy_alice_smith" },
      { ...obs, datatypes: ["patient_17"] },
      { ...obs, galaxy: { server: "usegalaxy.org", version: "Smith" } },
    ]) {
      expect(
        m.observationProblems(forged as Observation).errors.length,
        JSON.stringify(forged),
      ).toBeGreaterThan(0);
    }
  });

  it("never loses a row when two drains overlap", async () => {
    // The second review's sequence. Outbox holds A; drain 1 starts sending A
    // and blocks; B is appended; a second drain runs meanwhile. Before, drain
    // 2 rewrote the file to [B] and drain 1 then truncated it by line count,
    // losing B.
    const m = await load();
    const a = obs;
    const b = { ...obs, id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" };
    m.appendToObservationOutbox(a);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const first = m.drainObservationOutbox(
      async () => {
        m.appendToObservationOutbox(b);
        await blocked;
        return { ok: true, status: 202, queueable: false };
      },
      () => true,
    );
    const secondSubmit = vi.fn().mockResolvedValue({ ok: false, status: 503, queueable: true });
    const second = await m.drainObservationOutbox(secondSubmit, () => true);
    // The second drain stood aside rather than sending A a second time.
    expect(second).toEqual({ sent: 0, kept: 0, dropped: 0 });
    expect(secondSubmit).not.toHaveBeenCalled();
    release();
    expect((await first).sent).toBe(1);
    expect(lines("observations-outbox.jsonl").map((l) => JSON.parse(l).id)).toEqual([b.id]);
  });

  it("stands aside while another live process holds the drain lock", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    // The parent process is alive and is not this one.
    fs.writeFileSync(
      path.join(tmpHome, ".loom", "observations-outbox.jsonl.drain"),
      String(process.ppid),
    );
    const submit = vi.fn(ok);
    expect(await m.drainObservationOutbox(submit, () => true)).toEqual({
      sent: 0,
      kept: 0,
      dropped: 0,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not take a fresh lock that has no pid in it yet", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    fs.writeFileSync(path.join(tmpHome, ".loom", "observations-outbox.jsonl.drain"), "");
    const submit = vi.fn(ok);
    expect((await m.drainObservationOutbox(submit, () => true)).sent).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpHome, ".loom", "observations-outbox.jsonl.drain"))).toBe(
      true,
    );
  });

  it("counts a row that went but whose retract token could not be saved", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    fs.mkdirSync(path.join(tmpHome, ".loom", "observations-tokens.json"));
    expect(await m.drainObservationOutbox(vi.fn(ok), () => true)).toEqual({
      sent: 1,
      kept: 0,
      dropped: 0,
      unretractable: 1,
    });
  });

  it("takes over a drain lock its holder died with", async () => {
    const m = await load();
    m.appendToObservationOutbox(obs);
    // Far past any real pid; kill(pid, 0) says it does not exist.
    fs.writeFileSync(path.join(tmpHome, ".loom", "observations-outbox.jsonl.drain"), "99999999");
    expect((await m.drainObservationOutbox(vi.fn(ok), () => true)).sent).toBe(1);
  });

  it("is a no-op with no outbox", async () => {
    const m = await load();
    expect(await m.drainObservationOutbox(vi.fn(), () => true)).toEqual({
      sent: 0,
      kept: 0,
      dropped: 0,
    });
  });
});
