/**
 * The page record store under the browser worker (slice 3, commit 7): typed blocks go up as
 * carriers Galaxy accepts, a conversation has no page until something is written to it, and a
 * write pinned to one record lands in that record's page whichever store is bound by then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findJobBlocks } from "../extensions/orbit/galaxy-job-block";
import {
  pinnedDispatch,
  registerSubmissionCapture,
  resetSubmissionCapture,
} from "../extensions/orbit/galaxy-submission-capture";
import {
  EMPTY_RECORD_VERSION,
  NotebookChangedError,
  recordStore,
  setRecordStore,
  withRecordCas,
  withRecordLock,
} from "../extensions/orbit/record-store";
import { createPageRecordStore } from "../extensions/orbit/record-store-page";
import { registerSessionLifecycle } from "../extensions/orbit/session-lifecycle";
import { resetState, setNotebookPath } from "../extensions/orbit/state";
import { setSubmissionLedger } from "../extensions/orbit/submission-ledger";
import { pageContentProblem } from "../shared/galaxy-page-cells.js";
import { pageContentHash } from "../shared/page-content-hash.js";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";
import { GALAXY } from "./galaxy-family-fixture";
import { guardHooks, json, recordGalaxy, runOp, type SeenRequest } from "./galaxy-test-helpers";

// session_start's artifacts would land an activity log in the test runner's cwd.
vi.mock("../extensions/orbit/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/state.js")>()),
  initSessionArtifacts: vi.fn(async () => {}),
}));
// Opening the real registry would take a lock under the test runner's cwd.
vi.mock("../extensions/orbit/registry-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/registry-runtime.js")>()),
  openSessionRegistry: vi.fn(() => ({ session: { store: { mode: "writer" } }, notice: null })),
  closeSessionRegistry: vi.fn(),
  recordActiveAtShutdown: vi.fn(() => 0),
}));

const HISTORY = "bbbb000000000002";
const JOB = "aaaa000000000001";
const UPLOAD = { url: "https://data.test/reads.fq", history_id: HISTORY };

/** Galaxy's pages, refusing a fence it has no cell for, with every other route answered by `other`. */
function galaxyPages(other: (req: SeenRequest) => Response | Promise<Response> = () => json({})) {
  const pages = new Map<string, string>();
  const puts: string[] = [];
  let created = 0;
  let holdGets: Promise<void> | null = null;
  const seen = recordGalaxy(async (req) => {
    const id = req.path.match(/^\/api\/pages\/([^/]+)$/)?.[1];
    if (!id) return other(req);
    if (req.method === "GET") {
      if (holdGets) await holdGets;
      return pages.has(id)
        ? json({ id, content: pages.get(id), content_editor: pages.get(id) })
        : json({ err_msg: "Page not found" }, 404);
    }
    const content = String(req.body?.content ?? "");
    const problem = pageContentProblem(content);
    if (problem) return json({ err_msg: problem }, 400);
    puts.push(id);
    pages.set(id, content);
    return json({ id });
  });
  return {
    pages,
    puts,
    seen,
    created: () => created,
    /** Make a page, standing in for the worker's create(). */
    create: async () => {
      const page = `page-${++created}`;
      pages.set(page, "");
      return page;
    },
    hold(gate: Promise<void> | null) {
      holdGets = gate;
    },
  };
}

const FENCED = [
  "# Analysis",
  "",
  "```loom-invocation",
  "invocation_id: abc",
  "```",
  "",
  "```loom-job",
  "job_id: def",
  "```",
  "",
  "```loom-session",
  "id: s1",
  "```",
  "",
  "```loom-udt",
  "name: tidy",
  "```",
  "",
  "```loom-proposal",
  "id: prop-1",
  "```",
  "",
].join("\n");

beforeEach(() => {
  resetState();
  setRecordStore(null);
  setSubmissionLedger(null);
});

afterEach(() => {
  setCapabilityProfile(null);
  setRecordStore(null);
  setSubmissionLedger(null);
  resetState();
});

describe("typed blocks on a page", () => {
  it("go up as carriers Galaxy accepts and read back exactly", async () => {
    const galaxy = galaxyPages();
    galaxy.pages.set("p1", "");
    const store = createPageRecordStore({ key: "/pages/a/notebook.md", pageId: "p1" });
    await store.write(FENCED);
    const stored = galaxy.pages.get("p1")!;
    expect(pageContentProblem(stored)).toBeUndefined();
    for (const kind of ["invocation", "job", "session", "udt", "proposal"]) {
      expect(stored).toContain(`[orbit-${kind}:v1]: #orbit "`);
    }
    expect(await store.read()).toEqual({ content: FENCED, version: pageContentHash(stored) });
    // The version is the page as Galaxy holds it, so a guarded write against it goes through.
    await store.write(FENCED + "more\n", pageContentHash(stored));
    expect((await store.read()).content).toBe(FENCED + "more\n");
  });
});

describe("a conversation with no page yet", () => {
  const key = "/pages/a/notebook.md";

  it("reads empty at the sentinel version and makes nothing for an empty write", async () => {
    const galaxy = galaxyPages();
    const create = vi.fn(galaxy.create);
    const store = createPageRecordStore({ key, create });
    expect(await store.stat()).toBe(EMPTY_RECORD_VERSION);
    expect(await store.read()).toEqual({ content: "", version: EMPTY_RECORD_VERSION });
    expect(await store.ensure()).toBe(false);
    await store.write("", EMPTY_RECORD_VERSION);
    expect(create).not.toHaveBeenCalled();
    expect(store.pageId).toBeUndefined();
    expect(galaxy.seen).toEqual([]);
  });

  it("makes one page for two first writes, binding it before any content goes up", async () => {
    const galaxy = galaxyPages();
    const order: string[] = [];
    let releaseBind!: () => void;
    const store = createPageRecordStore({
      key,
      create: async () => {
        order.push("create");
        return galaxy.create();
      },
      bind: async (pageId) => {
        order.push(`bind ${pageId}`);
        await new Promise<void>((r) => (releaseBind = r));
      },
    });
    const append = (line: string) =>
      withRecordLock(key, () =>
        withRecordCas(store, (content) => ({ content: content + line, result: undefined })),
      );
    const first = append("one\n");
    const second = append("two\n");
    await vi.waitFor(() => expect(order).toEqual(["create", "bind page-1"]));
    expect(galaxy.puts).toEqual([]);
    releaseBind();
    await Promise.all([first, second]);
    expect(galaxy.created()).toBe(1);
    expect(store.pageId).toBe("page-1");
    expect(galaxy.pages.get("page-1")).toBe("one\ntwo\n");
  });

  it("makes one page even for two first writers that don't take the record lock", async () => {
    const galaxy = galaxyPages();
    const store = createPageRecordStore({ key, create: galaxy.create });
    await Promise.all([store.write("one\n"), store.write("two\n")]);
    expect(galaxy.created()).toBe(1);

    // Guarded against the empty record, only the writer that made the page goes through.
    const guarded = createPageRecordStore({ key: "/pages/b/notebook.md", create: galaxy.create });
    const results = await Promise.allSettled([
      guarded.write("first\n", EMPTY_RECORD_VERSION),
      guarded.write("second\n", EMPTY_RECORD_VERSION),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(NotebookChangedError);
    expect(galaxy.pages.get(guarded.pageId!)).toBe("first\n");
  });

  it("binds the page it already made when a binding failed, instead of making another", async () => {
    const galaxy = galaxyPages();
    const create = vi.fn(galaxy.create);
    const bind = vi.fn().mockRejectedValueOnce(new Error("binding doc unavailable"));
    const store = createPageRecordStore({ key, create, bind });
    await expect(store.write("text\n")).rejects.toThrow("binding doc unavailable");
    expect(store.pageId).toBeUndefined();
    expect(await store.stat()).toBe(EMPTY_RECORD_VERSION);
    expect(galaxy.puts).toEqual([]);

    await store.write("text\n");
    expect(create).toHaveBeenCalledOnce();
    expect(bind.mock.calls).toEqual([["page-1"], ["page-1"]]);
    expect(galaxy.pages.get("page-1")).toBe("text\n");
  });

  it("refuses a write against the sentinel once the page exists, and the retry succeeds", async () => {
    const galaxy = galaxyPages();
    const store = createPageRecordStore({ key, create: galaxy.create });
    const stale = (await store.read()).version!;
    await store.write("first\n");
    await expect(store.write("clobber\n", stale)).rejects.toBeInstanceOf(NotebookChangedError);
    await withRecordCas(store, (content) => ({ content: content + "second\n", result: undefined }));
    expect(galaxy.pages.get(store.pageId!)).toBe("first\nsecond\n");
  });

  it("refuses a first write with nothing to create a page through", async () => {
    galaxyPages();
    const store = createPageRecordStore({ key });
    await expect(store.write("text\n")).rejects.toThrow(/No Galaxy page is bound/);
  });

  it("doesn't make a page for the shutdown summary", async () => {
    const galaxy = galaxyPages();
    const create = vi.fn(galaxy.create);
    const store = createPageRecordStore({
      key: path.join(os.tmpdir(), "unbound", "notebook.md"),
      create,
    });
    const summary = await shutDown(store.key, () => setRecordStore(store));
    expect(summary).toBe("none");
    expect(create).not.toHaveBeenCalled();
    expect(galaxy.seen).toEqual([]);

    // The same shutdown over a page that exists does write the summary.
    galaxy.pages.set("p1", "# Analysis\n");
    const bound = createPageRecordStore({ key: store.key, pageId: "p1" });
    expect(await shutDown(bound.key, () => setRecordStore(bound))).toBe("written");
    expect(galaxy.pages.get("p1")).toContain("[orbit-session:v1]");
  });
});

/** Start and shut down a session over the record at `key`; what became of its summary. */
async function shutDown(key: string, install: () => void): Promise<"none" | "written"> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
    sendUserMessage: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  registerSessionLifecycle(pi);
  setCapabilityProfile({ ...profileFromEnv({}), ui: "worker", notebook: "page" });
  install();
  const before = await recordStore(key).read();
  const ctx = {
    hasUI: false,
    cwd: path.dirname(key),
    ui: { setToolsExpanded: vi.fn(), notify: vi.fn() },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s1" },
  };
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
  setNotebookPath(key);
  await handlers.get("session_shutdown")!({}, ctx);
  const after = await recordStore(key).read();
  return after.content === before.content ? "none" : "written";
}

describe("stores by key under a page record", () => {
  beforeEach(() => setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" }));

  it("throws for a key no store was installed under, instead of reaching for a file", () => {
    setRecordStore(createPageRecordStore({ key: "/pages/a/notebook.md", pageId: "p1" }));
    expect(() => recordStore("/pages/b/notebook.md")).toThrow(/No record store is installed/);
  });

  it("lands a capture held open across a switch in the first conversation's page", async () => {
    const galaxy = galaxyPages(() =>
      json({ jobs: [{ id: JOB, tool_id: "__DATA_FETCH__", history_id: HISTORY }], outputs: [] }),
    );
    // The keys sit under a temp dir: capture files its attempt record beside the record key.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-page-key-"));
    try {
      const keyA = path.join(dir, "a", "notebook.md");
      const keyB = path.join(dir, "b", "notebook.md");
      galaxy.pages.set("pa", "# A\n");
      galaxy.pages.set("pb", "# B\n");
      setRecordStore(createPageRecordStore({ key: keyA, pageId: "pa" }));
      setNotebookPath(keyA);
      resetSubmissionCapture();
      const fire = guardHooks(registerSubmissionCapture, GALAXY);
      await fire("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "upload_file_from_url",
        args: UPLOAD,
      });
      expect(pinnedDispatch("call-1")?.recordKey).toBe(keyA);
      const result = await runOp("upload_file_from_url", UPLOAD);

      // Capture reads the record first; hold that read while the worker switches to B.
      let release!: () => void;
      galaxy.hold(new Promise<void>((r) => (release = r)));
      const ended = fire("tool_execution_end", {
        toolCallId: "call-1",
        toolName: "upload_file_from_url",
        result,
        isError: false,
      });
      await vi.waitFor(() =>
        expect(galaxy.seen.some((r) => r.method === "GET" && r.path === "/api/pages/pa")).toBe(
          true,
        ),
      );
      setRecordStore(createPageRecordStore({ key: keyB, pageId: "pb" }));
      setNotebookPath(keyB);
      galaxy.hold(null);
      release();
      await ended;

      expect(findJobBlocks(await readBack(keyA)).map((j) => j.jobId)).toEqual([JOB]);
      expect(galaxy.pages.get("pb")).toBe("# B\n");
      expect(galaxy.puts).toEqual(["pa"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const readBack = async (key: string) => (await recordStore(key).read()).content;
