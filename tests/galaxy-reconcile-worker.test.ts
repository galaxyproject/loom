/**
 * Reconcile under the browser worker (slice 3, commit 5): no pass at session_start, one inside
 * the tick that asks for it, and a terminal run seen by /reconcile wakes the watch instead of
 * polling outside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/orbit/galaxy-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/galaxy-api.js")>()),
  getGalaxyConfig: vi.fn(() => ({ url: SERVER, apiKey: "k" })),
  galaxyListHistoryJobs: vi.fn(),
  galaxyListHistoryInvocations: vi.fn(),
  galaxyGetJobDetails: vi.fn(),
  verifyGalaxyRun: vi.fn(async () => ({ outcome: "found" })),
}));

import {
  galaxyGetJobDetails,
  galaxyListHistoryInvocations,
  galaxyListHistoryJobs,
} from "../extensions/orbit/galaxy-api.js";
import { renderGalaxyPageBlock } from "../extensions/orbit/galaxy-page-binding";
import { renderJobYaml } from "../extensions/orbit/galaxy-job-block";
import {
  pollerIdle,
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/orbit/galaxy-poller";
import {
  followThrough,
  galaxyBackgroundIdle,
  registerCaptureFollowThrough,
  resetReconcileState,
  setPollWake,
} from "../extensions/orbit/galaxy-reconcile";
import { resetState, setNotebookPath } from "../extensions/orbit/state";
import { setSubmissionLedger } from "../extensions/orbit/submission-ledger";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const SERVER = "https://galaxy.test";
const HISTORY = "0a248a1f62a0cc04";
const listJobs = vi.mocked(galaxyListHistoryJobs);
const listInvocations = vi.mocked(galaxyListHistoryInvocations);
const getJob = vi.mocked(galaxyGetJobDetails);

const binding = renderGalaxyPageBlock({
  pageId: "aaaa000000000001",
  pageSlug: null,
  galaxyServerUrl: SERVER,
  historyId: HISTORY,
  lastSyncedRevision: null,
  boundAt: "2026-10-07T00:00:00Z",
});

/** The handlers and the /reconcile command registerCaptureFollowThrough installs. */
function register() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerCaptureFollowThrough({
    on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    registerCommand: (_name: string, spec: { handler: typeof command }) => {
      command = spec.handler;
    },
  } as unknown as ExtensionAPI);
  return {
    sessionStart: () => handlers.get("session_start")!({}, {}),
    reconcile: () => command!("", { hasUI: false }),
  };
}

describe("reconcile under the browser worker", () => {
  let dir: string;
  let nb: string;
  const worker = () => setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(join(tmpdir(), "loom-reconcile-worker-"));
    nb = join(dir, "notebook.md");
    resetState();
    resetReconcileState();
    setSubmissionLedger(null);
    setNotebookPath(nb);
    // A run recorded in flight that Galaxy lists as finished: the pass sees one terminal run.
    writeFileSync(
      nb,
      [
        binding,
        renderJobYaml({
          jobId: "aa11",
          galaxyServerUrl: SERVER,
          notebookAnchor: "step-1",
          label: "fastp",
          submittedAt: "2026-10-07T09:00:00.000Z",
          status: "in_progress",
        }),
      ].join("\n"),
    );
    listJobs.mockResolvedValue([{ id: "aa11", state: "ok", create_time: "2026-10-07T09:00:00" }]);
    listInvocations.mockResolvedValue([]);
    getJob.mockImplementation(async (id) => ({ id, state: "running", tool_id: "fastp" }) as never);
  });

  afterEach(async () => {
    stopGalaxyPoller();
    await galaxyBackgroundIdle();
    setPollWake(null);
    setCapabilityProfile(null);
    setSubmissionLedger(null);
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs no pass at session_start, which the desktop still does", async () => {
    worker();
    const hooks = register();
    await hooks.sessionStart();
    await galaxyBackgroundIdle();
    expect(listJobs).not.toHaveBeenCalled();

    setCapabilityProfile(null);
    await hooks.sessionStart();
    await galaxyBackgroundIdle();
    expect(listJobs).toHaveBeenCalledOnce();
  });

  it("reconciles inside the tick that asks for it, and only then", async () => {
    worker();
    register();
    startGalaxyPoller(vi.fn());
    await pollGalaxyNow({ awaitEnrichment: true });
    expect(listJobs).not.toHaveBeenCalled();
    await pollGalaxyNow({ awaitEnrichment: true, reconcile: true });
    expect(listJobs).toHaveBeenCalledOnce();
  });

  it("/reconcile that sees a run end wakes the watch and polls nothing itself", async () => {
    worker();
    const hooks = register();
    const wake = vi.fn();
    setPollWake(wake);
    await hooks.reconcile();
    await galaxyBackgroundIdle();
    expect(wake).toHaveBeenCalledOnce();
    expect(getJob).not.toHaveBeenCalled();
  });

  it("/reconcile on the desktop still polls right away", async () => {
    const hooks = register();
    await hooks.reconcile();
    await pollerIdle();
    expect(getJob).toHaveBeenCalledWith("aa11");
  });

  it("galaxyBackgroundIdle waits for a held tick even with the queue empty", async () => {
    worker();
    register();
    startGalaxyPoller(vi.fn());
    let releaseTick!: () => void;
    getJob.mockImplementation(
      (id) =>
        new Promise((r) => {
          releaseTick = () => r({ id, state: "running", tool_id: "fastp" } as never);
        }) as never,
    );
    void pollGalaxyNow();
    await vi.waitFor(() => expect(getJob).toHaveBeenCalled());
    let idle = false;
    const waiting = galaxyBackgroundIdle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    releaseTick();
    await waiting;
    expect(idle).toBe(true);
  });

  it("galaxyBackgroundIdle waits for a held tick and a queued reconcile", async () => {
    worker();
    register();
    startGalaxyPoller(vi.fn());
    let releaseTick!: () => void;
    getJob.mockImplementation(
      (id) =>
        new Promise((r) => {
          releaseTick = () => r({ id, state: "running", tool_id: "fastp" } as never);
        }) as never,
    );
    let releaseListing!: () => void;
    listJobs.mockImplementation(
      () =>
        new Promise((r) => {
          releaseListing = () => r([]);
        }),
    );
    void pollGalaxyNow();
    void followThrough("command");
    await vi.waitFor(() => {
      expect(getJob).toHaveBeenCalled();
      expect(listJobs).toHaveBeenCalled();
    });

    let idle = false;
    const waiting = galaxyBackgroundIdle().then(() => {
      idle = true;
    });
    releaseTick();
    await pollerIdle();
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    releaseListing();
    await waiting;
    expect(idle).toBe(true);
  });
});
