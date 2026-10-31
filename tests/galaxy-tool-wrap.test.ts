import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { allOperations, type AnyOperation, type GalaxyContext } from "@galaxyproject/galaxy-ops";
import { resetGalaxyOpsVersion, setGalaxyTransport } from "../extensions/orbit/galaxy-api";
import { GALAXY_DEADLINE_TEXT } from "../extensions/orbit/galaxy-failure";
import { GALAXY_OUTPUT_MARKER } from "../extensions/orbit/galaxy-output";
import { galaxyOutputStore, setGalaxyOutputStore } from "../extensions/orbit/galaxy-output-store";
import { toolFromOperation } from "../extensions/orbit/galaxy-ops-tools";
import type { GalaxyTool } from "../extensions/orbit/galaxy-tool-source";
import {
  GALAXY_DEADLINE_MS,
  GALAXY_SPILL_BYTES,
  renderGalaxyResult,
  runGalaxyCall,
  wrapGalaxyTool,
} from "../extensions/orbit/galaxy-tool-wrap";
import { isUlid } from "../extensions/orbit/ulid";
import { ServiceOutageError } from "../shared/service-outage.js";
import { utf8ByteLength } from "../shared/truncate-middle.js";
import { CREDENTIALS, json } from "./galaxy-test-helpers";

const op = (name: string) => [...allOperations].find((o) => o.name === name)!;
const NO_CREDENTIALS = () => ({ url: undefined, apiKey: undefined });
const run = (tool: GalaxyTool, params: object = {}, signal?: AbortSignal) =>
  tool.execute("call-1", params, signal, undefined, {} as never);

afterEach(() => {
  vi.useRealTimers();
  setGalaxyTransport(null);
  setGalaxyOutputStore(null);
});

describe("the deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns a timeout against a transport that never settles and ignores its signal", async () => {
    // get_user has no version requirement, so no 3 s probe stands between the call and fetch.
    setGalaxyTransport({ credentials: CREDENTIALS, fetch: () => new Promise<Response>(() => {}) });
    const pending = run(toolFromOperation(op("get_user")));
    let done = false;
    void pending.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(GALAXY_DEADLINE_MS).toBe(300_000);
    expect(result.isError).toBe(true);
    expect(result.details.galaxy).toMatchObject({ tool: "get_user", kind: "timeout" });
    expect(result.content[0].text).toContain("request timed out");
    expect(result.structuredContent).toMatchObject({
      success: false,
      message: GALAXY_DEADLINE_TEXT,
    });
  });

  it("calls an error thrown after the deadline fired a timeout", async () => {
    // A poll sleep rejects with a plain Error("aborted") when its signal fires.
    const pending = runGalaxyCall(
      "probe",
      undefined,
      (_ctx, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      { context: () => ({}) as GalaxyContext },
    );
    await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
    const result = await pending;
    expect(result.details.galaxy.kind).toBe("timeout");
    expect(result.isError).toBe(true);
  });

  it("calls a failure envelope that lands after the deadline a timeout", async () => {
    let fire: () => void = () => {};
    const pending = runGalaxyCall(
      "probe",
      undefined,
      () =>
        new Promise((resolve) => {
          fire = () =>
            resolve({
              data: undefined,
              success: false,
              message: "fetch failed",
              errorKind: "connection",
            });
        }),
      { context: () => ({}) as GalaxyContext, deadlineMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(50);
    fire();
    const result = await pending;
    expect(result.details.galaxy.kind).toBe("timeout");
    expect(result.structuredContent.message).toBe(GALAXY_DEADLINE_TEXT);
  });

  it("cuts a policy check that never settles at the deadline", async () => {
    setGalaxyTransport({ credentials: CREDENTIALS, fetch: async () => json({ id: "u1" }) });
    const tool = toolFromOperation(op("get_user"), {
      policy: { check: () => new Promise<string | undefined>(() => {}) },
    });
    const pending = run(tool);
    await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
    const result = await pending;
    expect(result.details.galaxy.kind).toBe("timeout");
  });

  it("sends no request once a policy check has outlasted the deadline", async () => {
    // The model has already been told the result is unknown; a request sent now could submit a
    // job it then retries.
    const fetched: string[] = [];
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async (url) => {
        fetched.push(url);
        return json({ id: "u1" });
      },
    });
    let pass: (refusal: string | undefined) => void = () => {};
    const tool = toolFromOperation(op("get_user"), {
      policy: { check: () => new Promise<string | undefined>((resolve) => (pass = resolve)) },
    });
    const pending = run(tool);
    await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
    expect((await pending).details.galaxy.kind).toBe("timeout");
    pass(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched).toEqual([]);
  });

  it("rethrows the caller's abort instead of reporting a failure", async () => {
    setGalaxyTransport({ credentials: CREDENTIALS, fetch: () => new Promise<Response>(() => {}) });
    const stop = new AbortController();
    const pending = run(toolFromOperation(op("get_user")), {}, stop.signal);
    stop.abort(new Error("stopped by the user"));
    await expect(pending).rejects.toThrow("stopped by the user");
  });

  it("clears its timer once the call returns", async () => {
    setGalaxyTransport({ credentials: CREDENTIALS, fetch: async () => json({ id: "u1" }) });
    const result = await run(toolFromOperation(op("get_user")));
    expect(result.isError).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("failure kinds from galaxy-ops' error kinds", () => {
  it.each([
    // No code to add, so galaxy-ops' own wording stands.
    ["no cause", new TypeError("fetch failed"), /fetch failed(?! \()/],
    [
      "undici's cause code",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("Connect Timeout Error"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
      /fetch failed \(UND_ERR_CONNECT_TIMEOUT\)/,
    ],
    [
      "an AggregateError's code",
      new TypeError("fetch failed", {
        cause: new AggregateError([Object.assign(new Error("refused"), { code: "ECONNREFUSED" })]),
      }),
      /fetch failed \(ECONNREFUSED\)/,
    ],
  ])("a fetch that throws (%s) is a dropped connection", async (_name, err, said) => {
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async () => {
        throw err;
      },
    });
    const result = await run(toolFromOperation(op("get_user")));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.errorKind).toBe("connection");
    expect(result.details.galaxy.kind).toBe("dropped");
    expect(result.structuredContent.message).toMatch(said);
    expect(result.content[0].text).toMatch(said);
  });

  it("an abort carrying a cause code is not rewritten", async () => {
    const abort = Object.assign(new DOMException("This operation was aborted", "AbortError"), {
      cause: { code: "UND_ERR_ABORTED" },
    });
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async () => {
        throw abort;
      },
    });
    const result = await run(toolFromOperation(op("get_user")));
    expect(result.structuredContent.message).not.toContain("UND_ERR_ABORTED");
  });

  it.each([
    [401, "Provided API key is not valid.", "auth", "auth"],
    [404, "No such history", "not_found", null],
  ])("a %i is errorKind %s, recovery kind %s", async (status, errMsg, errorKind, kind) => {
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async () => json({ err_msg: errMsg }, status),
    });
    const result = await run(toolFromOperation(op("get_history_details")), { history_id: "f00d" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.errorKind).toBe(errorKind);
    expect(result.details.galaxy.kind).toBe(kind);
  });

  it("no credentials is auth, and the text names /connect", async () => {
    const fetch = vi.fn();
    setGalaxyTransport({ credentials: NO_CREDENTIALS, fetch });
    const result = await run(toolFromOperation(op("get_user")));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details.galaxy.kind).toBe("auth");
    expect(result.content[0].text).toContain("/connect");
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "auth" });
  });
});

describe("a service outage", () => {
  const outage = () => new ServiceOutageError("Galaxy is unavailable right now");
  const expectOutage = (result: Awaited<ReturnType<typeof run>>) => {
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ galaxy: { kind: "service_outage" } });
    expect(result.content[0].text).toContain("Galaxy is unavailable right now");
  };

  it("a transport that throws one is service_outage, never dropped or auth", async () => {
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async () => {
        throw outage();
      },
    });
    const result = await run(toolFromOperation(op("get_user")));
    expectOutage(result);
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "service_outage" });
  });

  it("survives withTransportCode rebuilding it with a cause code", async () => {
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async () => {
        throw new ServiceOutageError("Galaxy is unavailable right now", {
          cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
        });
      },
    });
    const result = await run(toolFromOperation(op("get_user")));
    expectOutage(result);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });

  it("matches another bundle's copy of the class by name, down the cause chain", async () => {
    const foreign = Object.assign(new Error("Galaxy is unavailable right now"), {
      name: "ServiceOutageError",
    });
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: foreign });
      },
    });
    expectOutage(await run(toolFromOperation(op("get_user"))));
  });

  it("an outage only the version probe hit doesn't relabel the op's own failure", async () => {
    resetGalaxyOpsVersion();
    const urls: string[] = [];
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async (url) => {
        urls.push(url);
        if (url.endsWith("/api/version")) throw outage();
        return json({ err_msg: "No such history" }, 404);
      },
    });
    // Only an op that needs a minimum Galaxy version runs the probe; the page ops do.
    const result = await run(toolFromOperation(op("list_pages")), { history_id: "f00d" });
    expect(urls.some((u) => u.endsWith("/api/version"))).toBe(true);
    expect(result.structuredContent.errorKind).toBe("not_found");
    expect(result.details.galaxy.kind).toBeNull();
  });

  it("a policy check that throws one is service_outage, not a thrown error", async () => {
    const fetch = vi.fn();
    setGalaxyTransport({ credentials: CREDENTIALS, fetch });
    const tool = toolFromOperation(op("get_user"), {
      policy: {
        check: async () => {
          throw outage();
        },
      },
    });
    expectOutage(await run(tool));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an extra that throws one is service_outage", async () => {
    const down: GalaxyTool = {
      name: "download_dataset",
      label: "download_dataset",
      description: "shell extra",
      parameters: Type.Object({}),
      execute: async () => {
        throw outage();
      },
    };
    const result = await run(wrapGalaxyTool(down));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      galaxy: { tool: "download_dataset", kind: "service_outage" },
    });
  });

  it("an extra's other errors still throw", async () => {
    const broken: GalaxyTool = {
      name: "download_dataset",
      label: "download_dataset",
      description: "shell extra",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("not an outage");
      },
    };
    await expect(run(wrapGalaxyTool(broken))).rejects.toThrow("not an outage");
  });
});

describe("spill", () => {
  const big = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      name: `dataset ${i}`,
      note: "x".repeat(80),
    }));
  const listing = (rows: unknown[]) =>
    ({
      name: "probe_listing",
      domain: "histories",
      summary: "Probe listing.",
      input: {},
      run: async () => rows,
    }) as unknown as AnyOperation;
  const context = () => ({}) as GalaxyContext;

  it("saves a large envelope and shows a bounded preview with its outputId", async () => {
    const rows = big(400);
    const result = await run(toolFromOperation(listing(rows), { context }));
    const text = result.content[0].text;
    const { outputId } = result.details.galaxy;
    expect(utf8ByteLength(JSON.stringify(result.structuredContent))).toBeGreaterThan(
      GALAXY_SPILL_BYTES,
    );
    expect(text).toContain(GALAXY_OUTPUT_MARKER);
    expect(text).toContain(`outputId ${JSON.stringify(outputId)}`);
    expect(text).not.toMatch(/MCP/);
    expect(utf8ByteLength(text)).toBeLessThan(GALAXY_SPILL_BYTES);
    expect(isUlid(outputId!)).toBe(true);
    expect(galaxyOutputStore().get(outputId!)).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({ success: true, data: rows });
    expect(result.isError).toBe(false);
  });

  it("leaves a small envelope whole, with no outputId", async () => {
    const result = await run(toolFromOperation(listing(big(3)), { context }));
    expect(result.details.galaxy.outputId).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(galaxyOutputStore().list()).toEqual([]);
  });

  it("previews a large failure under the error headline", () => {
    const env = { data: undefined, success: false, message: "x".repeat(30_000) };
    const result = renderGalaxyResult("probe", env, 1);
    expect(result.content[0].text).toMatch(/^Galaxy returned a large error response/);
    expect(result.isError).toBe(true);
  });
});

describe("wrapGalaxyTool", () => {
  const extra = (text: string, details: unknown = { source: "shell" }): GalaxyTool => ({
    name: "download_dataset",
    label: "download_dataset",
    description: "shell extra",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text },
      ],
      details,
    }),
  });

  it("spills an extra's large text and names it in details.galaxy", async () => {
    const text = JSON.stringify({
      rows: Array.from({ length: 2000 }, (_, i) => ({ i, v: "abcdefgh" })),
    });
    const result = await run(wrapGalaxyTool(extra(text)));
    const { galaxy } = result.details as {
      galaxy: { tool: string; outputId: string };
      source: string;
    };
    expect(galaxy.tool).toBe("download_dataset");
    expect((result.details as { source: string }).source).toBe("shell");
    expect(galaxyOutputStore().get(galaxy.outputId)).toBe(text);
    expect(result.content[0]).toMatchObject({ type: "image" });
    expect(result.content[1].text).toContain(GALAXY_OUTPUT_MARKER);
  });

  it("leaves a small result alone apart from details.galaxy", async () => {
    const result = await run(wrapGalaxyTool(extra("ok", undefined)));
    expect(result.content[1]).toEqual({ type: "text", text: "ok" });
    expect(result.details).toMatchObject({ galaxy: { tool: "download_dataset" } });
    expect((result.details as { galaxy: object }).galaxy).not.toHaveProperty("outputId");
  });

  it("puts the extra under the same deadline", async () => {
    vi.useFakeTimers();
    const stuck: GalaxyTool = { ...extra(""), execute: () => new Promise(() => {}) };
    const pending = run(wrapGalaxyTool(stuck));
    await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ galaxy: { tool: "download_dataset", kind: "timeout" } });
  });
});
