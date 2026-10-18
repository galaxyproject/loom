import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GalaxyRerouter } from "../extensions/loom/galaxy-reroute";
import {
  listGalaxyConnections,
  setGalaxyCredentialEnvelope,
} from "../extensions/loom/galaxy-connections";
import { openSessionRegistry, closeSessionRegistry } from "../extensions/loom/registry-runtime";
import { findJobBlocks, upsertJobBlock } from "../extensions/loom/galaxy-job-block";
import { findInvocationBlocks, upsertInvocationBlock } from "../extensions/loom/notebook-writer";
import { setNotebookPath, resetState } from "../extensions/loom/state";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller";
import { ulid } from "../extensions/loom/ulid";

const cfg = vi.hoisted(() => ({
  galaxy: { active: "us", profiles: {} as Record<string, { url: string; apiKey: string }> },
}));
vi.mock("../extensions/loom/config", () => ({ loadConfig: () => cfg }));

import {
  fakeGalaxy,
  JOB,
  TARGET_HISTORY,
  COLLECTION,
  content,
} from "./helpers/fake-galaxy-reroute.js";

describe("verified cross-instance rerouting", () => {
  let us: Awaited<ReturnType<typeof fakeGalaxy>>,
    eu: Awaited<ReturnType<typeof fakeGalaxy>>,
    dir: string,
    notebook: string,
    rerouter: GalaxyRerouter,
    store: ReturnType<typeof openSessionRegistry>["session"]["store"];
  beforeEach(async () => {
    [us, eu] = await Promise.all([fakeGalaxy("us"), fakeGalaxy("eu")]);
    cfg.galaxy.profiles = {
      us: { url: us.url, apiKey: "us-key" },
      eu: { url: eu.url, apiKey: "eu-key" },
    };
    vi.stubEnv("GALAXY_URL", us.url);
    vi.stubEnv("GALAXY_API_KEY", "us-key");
    setGalaxyCredentialEnvelope({});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-reroute-test-"));
    notebook = path.join(dir, "notebook.md");
    setNotebookPath(notebook);
    const source = listGalaxyConnections()[0];
    fs.writeFileSync(
      notebook,
      upsertJobBlock(
        "# Analysis\n\n- [ ] Work {#step-one}\n",
        {
          jobId: JOB,
          galaxyServerUrl: us.url,
          notebookAnchor: "step-one",
          label: "cat",
          submittedAt: new Date().toISOString(),
          status: "in_progress",
        },
        { attemptId: ulid(), connectionId: source.id, accountId: "account-us" },
      ),
    );
    store = openSessionRegistry({
      analysisDir: dir,
      serverUrl: us.url,
      sessionId: "test",
      heartbeatMs: null,
    }).session.store;
    rerouter = new GalaxyRerouter(store, notebook);
  });
  afterEach(async () => {
    stopGalaxyPoller();
    closeSessionRegistry();
    resetState();
    vi.unstubAllEnvs();
    setGalaxyCredentialEnvelope({});
    await Promise.all([us.close(), eu.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preflights without remote mutations, then transfers private bytes and records a linked replacement with the same remote ID", async () => {
    const { route, plan } = await rerouter.prepare("job", JOB, "us", "eu");
    expect(us.state.requests.concat(eu.state.requests).every((r) => r.method === "GET")).toBe(true);
    expect(plan.transferBytes).toBe(content.length);
    const result = await rerouter.execute(route.id);
    expect(result.phase).toBe("submitted");
    expect(us.state.jobState).toBe("deleted");
    expect(eu.state.submissions).toHaveLength(1);
    expect((eu.state.submissions[0].inputs as Record<string, unknown>).input).toEqual({
      src: "hda",
      id: "9000000000000000",
    });
    expect(eu.state.datasets.get("9000000000000000")).toEqual(content);
    expect(fs.readFileSync(notebook, "utf8")).toContain("SHA-256");
    const records = findJobBlocks(fs.readFileSync(notebook, "utf8"));
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.jobId)).toEqual([JOB, JOB]);
    expect(records[0].supersededBy).toBe(route.destination_attempt);
    expect(records[1].connectionId).toBe(listGalaxyConnections()[1].id);
    expect(store.snapshot().attempts[route.destination_attempt].rerun_of).toEqual([
      route.source_attempt,
    ]);
    expect(store.snapshot().attempts[route.destination_attempt].handoff_eligible).toBe(false);
    expect(us.state.requests.every((r) => r.key === "us-key")).toBe(true);
    expect(eu.state.requests.every((r) => r.key === "eu-key")).toBe(true);
  });

  it("preserves paired collection order and dataset checksums", async () => {
    us.state.collection = true;
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await rerouter.execute(route.id);
    const collection = [...eu.state.collections.values()][0];
    expect(
      (collection.elements as Array<Record<string, unknown>>).map((e) => e.element_identifier),
    ).toEqual(["forward", "reverse"]);
    expect(eu.state.datasets.size).toBe(2);
    expect(store.snapshot().reroutes![route.id].mapping[`hdca:${COLLECTION}`].src).toBe("hdca");
  });

  it("stops before cancellation or submission when the destination corrupts an input", async () => {
    eu.state.corrupt = true;
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await expect(rerouter.execute(route.id)).rejects.toThrow("checksum");
    expect(us.state.jobState).toBe("queued");
    expect(eu.state.submissions).toHaveLength(0);
    expect(store.snapshot().reroutes![route.id].phase).toBe("failed");
  });

  it("rejects a missing exact tool version before copying data", async () => {
    eu.state.version = "2.0.0";
    await expect(rerouter.prepare("job", JOB, "us", "eu")).rejects.toThrow("exact tool version");
    expect(eu.state.datasets.size).toBe(0);
    expect(us.state.jobState).toBe("queued");
  });

  it("preserves unknown acceptance across restart and refuses a duplicate", async () => {
    eu.state.timeout = true;
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await expect(rerouter.execute(route.id)).rejects.toThrow();
    expect(store.snapshot().reroutes![route.id].phase).toBe("submission_unknown");
    closeSessionRegistry();
    store = openSessionRegistry({
      analysisDir: dir,
      serverUrl: eu.url,
      sessionId: "next",
      heartbeatMs: null,
    }).session.store;
    expect(store.snapshot().quarantine).toBeUndefined();
    rerouter = new GalaxyRerouter(store, notebook);
    await expect(rerouter.execute(route.id)).rejects.toThrow("cannot be submitted again");
    await expect(rerouter.prepare("job", JOB, "us", "eu")).rejects.toThrow("already has reroute");
    expect(eu.state.submissions).toHaveLength(1);
    await expect(rerouter.reconcile(route.id, ["wrong-id"])).rejects.toThrow();
    const recovered = await rerouter.reconcile(route.id, [JOB]);
    expect(recovered.phase).toBe("submitted");
    expect(findJobBlocks(fs.readFileSync(notebook, "utf8"))).toHaveLength(2);
    expect(eu.state.submissions).toHaveLength(1);
  });

  it("requires an explicit overlap choice to keep the original running", async () => {
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await rerouter.execute(route.id, { allowOverlap: true });
    expect(us.state.jobState).toBe("queued");
    expect(us.state.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(findJobBlocks(fs.readFileSync(notebook, "utf8"))[0].supersededBy).toBe(
      route.destination_attempt,
    );
  });

  it("copies nested collections using embedded collection identities", async () => {
    us.state.collection = true;
    us.state.nested = true;
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await rerouter.execute(route.id);
    expect(eu.state.collections.size).toBe(2);
    expect(
      us.state.requests.some((r) => r.url.includes("/dataset_collections/nested-collection")),
    ).toBe(false);
    expect([...eu.state.collections.values()].map((c) => c.collection_type)).toEqual([
      "paired",
      "list:paired",
    ]);
  });

  it("recreates a user-defined tool and verifies its exact definition", async () => {
    us.state.udt = true;
    eu.state.udt = true;
    const { route, plan } = await rerouter.prepare("job", JOB, "us", "eu");
    expect(plan.target.kind).toBe("udt");
    await rerouter.execute(route.id);
    expect(eu.state.submissions[0].tool_uuid).toBe("d51e6248-1220-42a8-8d42-d245ae192732");
  });

  it("stops if the original finishes while inputs are being staged", async () => {
    us.state.completeDuringTransfer = true;
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await expect(rerouter.execute(route.id)).rejects.toThrow("completed");
    expect(eu.state.submissions).toHaveLength(0);
    expect(us.state.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("does not submit when source cancellation is refused", async () => {
    us.state.denyCancel = true;
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await expect(rerouter.execute(route.id)).rejects.toThrow();
    expect(eu.state.submissions).toHaveLength(0);
  });

  it("refuses cached references whose content cannot be established across servers", async () => {
    us.state.reference = true;
    await expect(rerouter.prepare("job", JOB, "us", "eu")).rejects.toThrow(
      "explicit reference datasets",
    );
    expect(eu.state.datasets.size).toBe(0);
  });

  it("checks account identity again after approval", async () => {
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    eu.state.account = "different-account";
    await expect(rerouter.execute(route.id)).rejects.toThrow("account changed");
    expect(eu.state.datasets.size).toBe(0);
    expect(eu.state.submissions).toHaveLength(0);
  });

  it("continues observing the other connection when one server is unreachable", async () => {
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await rerouter.execute(route.id, { allowOverlap: true });
    eu.state.jobState = "ok";
    await us.close();
    await pollGalaxyNow();
    expect(
      findJobBlocks(fs.readFileSync(notebook, "utf8")).find((b) => b.galaxyServerUrl === eu.url)
        ?.status,
    ).toBe("completed");
  });

  it("does not schedule downstream follow-ups for a superseded original", async () => {
    const { route } = await rerouter.prepare("job", JOB, "us", "eu");
    await rerouter.execute(route.id, { allowOverlap: true });
    us.state.jobState = "ok";
    const followUp = vi.fn();
    startGalaxyPoller(undefined, followUp);
    await pollGalaxyNow();
    stopGalaxyPoller();
    expect(followUp).not.toHaveBeenCalled();
    expect(
      findJobBlocks(fs.readFileSync(notebook, "utf8")).find((b) => b.galaxyServerUrl === us.url)
        ?.status,
    ).toBe("completed");
  });

  it("reroutes a complete workflow and cancels both invocation scheduling and active jobs", async () => {
    const source = listGalaxyConnections()[0];
    fs.writeFileSync(
      notebook,
      upsertInvocationBlock(
        "# Analysis\n",
        {
          invocationId: JOB,
          galaxyServerUrl: us.url,
          notebookAnchor: "step-one",
          label: "workflow",
          submittedAt: new Date().toISOString(),
          status: "in_progress",
        },
        { attemptId: ulid(), connectionId: source.id, accountId: "account-us" },
      ),
    );
    const { route } = await rerouter.prepare("invocation", JOB, "us", "eu");
    await rerouter.execute(route.id);
    expect(us.state.invocationState).toBe("cancelled");
    expect(us.state.jobState).toBe("deleted");
    expect(eu.state.submissions).toHaveLength(1);
    expect(eu.state.submissions[0].history_id).toBe(TARGET_HISTORY);
    expect(findInvocationBlocks(fs.readFileSync(notebook, "utf8"))).toHaveLength(2);
  });
});
