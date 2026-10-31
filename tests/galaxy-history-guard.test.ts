import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setGalaxyFetchOverride } from "../extensions/orbit/galaxy-api";
import { fixtureFetch } from "../extensions/orbit/galaxy-fixture";
import {
  registerGalaxyHistoryGuard,
  resetGalaxyCurrentUser,
} from "../extensions/orbit/galaxy-history-guard";
import { GALAXY } from "./galaxy-family-fixture";
import { SPELLED, guardHooks, json } from "./galaxy-test-helpers";

const check = (toolName: string, input: Record<string, unknown>) =>
  guardHooks(
    registerGalaxyHistoryGuard,
    GALAXY,
    {},
  )("tool_call", {
    toolName,
    toolCallId: "c1",
    input,
  });

type FixtureRoute = Parameters<typeof fixtureFetch>[0][number];

const RUN = "run_tool";
const dataset = (id: string, history_id: string): FixtureRoute => ({
  path: `/api/datasets/${id}`,
  responses: [{ status: 200, body: { id, name: `${id}.txt`, history_id } }],
});

beforeEach(() => {
  vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
  vi.stubEnv("GALAXY_API_KEY", "fixture-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  setGalaxyFetchOverride(null);
  resetGalaxyCurrentUser();
});

describe("registerGalaxyHistoryGuard", () => {
  it("lets inputs from the job's own history through", async () => {
    setGalaxyFetchOverride(fixtureFetch([dataset("d1", "here")]));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check(RUN, input)).toBeUndefined();
  });

  it("finds a foreign collection and a foreign dataset nested in a repeat", async () => {
    setGalaxyFetchOverride(
      fixtureFetch([
        dataset("d1", "here"),
        dataset("d2", "elsewhere"),
        {
          path: "/api/dataset_collections/c1",
          responses: [{ status: 200, body: { id: "c1", name: "pairs", history_id: "other" } }],
        },
      ]),
    );
    const input = {
      history_id: "here",
      inputs: {
        queries_0: { input2: { src: "hda", id: "d1" } },
        queries_1: { input2: { values: [{ src: "hda", id: "d2" }] } },
        reads: { src: "hdca", id: "c1" },
      },
    };
    const foreign = [
      {
        input: "queries_1.input2.values[0]",
        supplied_id: "d2",
        history_id: "elsewhere",
        name: "d2.txt",
      },
      { input: "reads", supplied_id: "c1", history_id: "other", name: "pairs" },
    ];
    // Orbit's text is the base; the browser's guards.test.ts follows it when slice 4 lands.
    expect(await check(RUN, input)).toEqual({
      block: true,
      reason:
        "Refused: these inputs are in another history, not in history here " +
        `where this job runs: ${JSON.stringify(foreign)}. An id from another history is ` +
        "usually the wrong one: take the input's `id` from get_history_contents for this " +
        "history. If the user does mean that data, say which history it is in and ask them " +
        "to copy it into this one in Galaxy, then use the copy's id.",
    });
  });

  it("leaves an id Galaxy can't resolve for the run to report", async () => {
    setGalaxyFetchOverride(fixtureFetch([]));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "missing" } } };
    expect(await check(RUN, input)).toBeUndefined();
  });

  it("fails open when Galaxy can't be reached", async () => {
    setGalaxyFetchOverride(() => Promise.reject(new TypeError("fetch failed")));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check(RUN, input)).toBeUndefined();
  });

  it("only checks run_tool", async () => {
    const fetch = vi.fn(fixtureFetch([dataset("d1", "elsewhere")]));
    setGalaxyFetchOverride(fetch);
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check("get_dataset_details", input)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("registerGalaxyHistoryGuard: history ownership", () => {
  /** Answers /users/current per API key and /histories/{id} from `owners`; counts user lookups. */
  function owned(
    owners: Record<string, string | null>,
    users: Record<string, unknown> = { "fixture-key": { id: "me" } },
  ) {
    const seen = { users: 0, histories: 0 };
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const { pathname } = new URL(url);
      const key = (init.headers as Record<string, string>)["x-api-key"];
      if (pathname === "/api/users/current") {
        seen.users++;
        // Answers a tick later, as a real server would, so an abort can land first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (init.signal?.aborted) throw init.signal.reason;
        return key in users ? json(users[key]) : json({ err_msg: "no" }, 401);
      }
      const history = pathname.match(/^\/api\/histories\/([^/]+)$/)?.[1];
      if (history !== undefined) {
        seen.histories++;
        return history in owners
          ? json({ id: history, user_id: owners[history] })
          : json({ err_msg: "no such history" }, 404);
      }
      const dataset = pathname.match(/^\/api\/datasets\/([^/]+)$/)?.[1];
      if (dataset !== undefined) return json({ id: dataset, name: "d", history_id: "theirs" });
      return json({ err_msg: `no route for ${pathname}` }, 404);
    });
    setGalaxyFetchOverride(fetch);
    return seen;
  }

  const refusal = (
    history: string,
    tools = { list: "get_histories", create: "create_history" },
  ) => ({
    block: true,
    reason:
      `Refused: history ${history} belongs to another Galaxy user, not to ` +
      "the account this session is signed in as. Don't run jobs, upload, or change anything " +
      "in someone else's history: use a history of the user's own -- take its id from " +
      `${tools.list}, or make one with ${tools.create}. ` +
      "If the user really means to work in that history, ask them first before trying again.",
  });

  it("lets a write into the user's own history through", async () => {
    owned({ mine: "me" });
    expect(await check(RUN, { history_id: "mine", inputs: {} })).toBeUndefined();
  });

  it("refuses a run in another user's history even when its inputs are there too", async () => {
    owned({ theirs: "someone-else" });
    const input = { history_id: "theirs", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check(RUN, input)).toEqual(refusal("theirs"));
  });

  it.each([
    ["run_user_tool", { tool_id: "t", history_id: "theirs", inputs: {} }],
    ["invoke_workflow", { workflow_id: "w", history_id: "theirs", inputs: {} }],
    ["upload_file", { path: "/tmp/x", history_id: "theirs" }],
    ["upload_file_from_url", { url: "https://x.example/a", history_id: "theirs" }],
    ["update_history", { history_id: "theirs", name: "renamed" }],
    ["create_page", { slug: "p", title: "p", history_id: "theirs" }],
    ["galaxy_upload_local_file", { path: "x.txt", history_id: "theirs" }],
    ["notebook_push_to_galaxy", { history_id: "theirs", title: "n" }],
  ])("refuses %s into another user's history", async (tool, input) => {
    owned({ theirs: "someone-else", mine: "me" });
    expect(await check(tool, input)).toEqual(refusal("theirs"));
    expect(await check(tool, { ...input, history_id: "mine" })).toBeUndefined();
  });

  it("refuses another user's history named in upper case", async () => {
    // The stub answers in lower case for any spelling, as Galaxy's hex decoder does.
    const fetch = vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/api/users/current") return json({ id: "me" });
      if (pathname.toLowerCase() === "/api/histories/abc123") {
        return json({ id: "abc123", user_id: "someone-else" });
      }
      return json({ err_msg: "no" }, 404);
    });
    setGalaxyFetchOverride(fetch);
    expect(await check("update_history", { history_id: "ABC123", name: "x" })).toEqual(
      refusal("ABC123"),
    );
  });

  it("shares one user lookup between concurrent checks, and one aborting doesn't spoil the other", async () => {
    const seen = owned({ theirs: "someone-else" });
    const aborted = new AbortController();
    const hook = guardHooks(registerGalaxyHistoryGuard, GALAXY);
    const call = { toolName: "update_history", toolCallId: "c", input: { history_id: "theirs" } };
    const first = hook("tool_call", call, { signal: aborted.signal });
    const second = hook("tool_call", call, { signal: new AbortController().signal });
    aborted.abort();
    expect(await first).toBeUndefined();
    expect(await second).toEqual(refusal("theirs"));
    expect(seen.users).toBe(1);
  });

  it("names the shell's own tools in the refusal", async () => {
    owned({ theirs: "someone-else" });
    const hook = guardHooks(registerGalaxyHistoryGuard, SPELLED, {});
    const result = await hook("tool_call", {
      toolName: "gx_update_history",
      toolCallId: "c1",
      input: { history_id: "theirs", name: "x" },
    });
    expect(result).toEqual(
      refusal("theirs", { list: "gx_get_histories", create: "gx_create_history" }),
    );
  });

  it("leaves reads, and writes with no explicit history, alone", async () => {
    const seen = owned({ theirs: "someone-else" });
    expect(await check("get_history_contents", { history_id: "theirs" })).toBeUndefined();
    expect(await check("get_history_details", { history_id: "theirs" })).toBeUndefined();
    expect(
      await check("invoke_workflow", { workflow_id: "w", history_name: "new" }),
    ).toBeUndefined();
    expect(await check("upload_file_from_url", { url: "https://x.example/a" })).toBeUndefined();
    expect(seen).toEqual({ users: 0, histories: 0 });
  });

  it("fails open when the history can't be looked up", async () => {
    owned({});
    expect(await check("update_history", { history_id: "gone", name: "x" })).toBeUndefined();
  });

  it("fails open when the signed-in user can't be looked up, and asks again next time", async () => {
    const seen = owned({ theirs: "someone-else" }, {});
    expect(await check("update_history", { history_id: "theirs", name: "x" })).toBeUndefined();
    expect(await check("update_history", { history_id: "theirs", name: "x" })).toBeUndefined();
    expect(seen.users).toBe(2);
  });

  it("fails open for an anonymous session and a history with no named owner", async () => {
    owned({ theirs: "someone-else" }, { "fixture-key": {} });
    expect(await check("update_history", { history_id: "theirs", name: "x" })).toBeUndefined();
    resetGalaxyCurrentUser();
    owned({ orphan: null });
    expect(await check("update_history", { history_id: "orphan", name: "x" })).toBeUndefined();
  });

  it("fails open when Galaxy is unreachable", async () => {
    setGalaxyFetchOverride(() => Promise.reject(new TypeError("fetch failed")));
    expect(await check("update_history", { history_id: "theirs", name: "x" })).toBeUndefined();
  });

  it("asks who the user is once per credentials, and again after they change", async () => {
    const seen = owned(
      { a: "me", b: "you" },
      { "fixture-key": { id: "me" }, "other-key": { id: "you" } },
    );
    expect(await check("update_history", { history_id: "a", name: "x" })).toBeUndefined();
    expect(await check("update_history", { history_id: "b", name: "x" })).toEqual(refusal("b"));
    expect(seen.users).toBe(1);

    // A /connect to another account: history b is now the user's own, and a is not.
    vi.stubEnv("GALAXY_API_KEY", "other-key");
    expect(await check("update_history", { history_id: "b", name: "x" })).toBeUndefined();
    expect(await check("update_history", { history_id: "a", name: "x" })).toEqual(refusal("a"));
    expect(seen.users).toBe(2);

    // Same key, another server: asked again too.
    vi.stubEnv("GALAXY_URL", "https://galaxy2.example.org");
    await check("update_history", { history_id: "a", name: "x" });
    expect(seen.users).toBe(3);
  });

  it("forgets the user on a new session", async () => {
    const seen = owned({ a: "me" });
    const on = vi.fn();
    registerGalaxyHistoryGuard({ on } as never, GALAXY);
    const hook = (name: string) => on.mock.calls.find(([key]) => key === name)![1];
    const call = { toolName: "update_history", toolCallId: "c", input: { history_id: "a" } };
    await hook("tool_call")(call, {});
    await hook("tool_call")(call, {});
    expect(seen.users).toBe(1);
    hook("session_start")({}, {});
    await hook("tool_call")(call, {});
    expect(seen.users).toBe(2);
  });
});
