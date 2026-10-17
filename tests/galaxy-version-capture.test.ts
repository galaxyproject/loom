import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bareFamily } from "../shared/galaxy-mcp-tools.js";
import { setGalaxyTransport } from "../extensions/loom/galaxy-api";
import { registerGalaxyVersionCapture, versionOf } from "../extensions/loom/galaxy-version-capture";
import { getGalaxyVersion, resetGalaxyVersion } from "../extensions/loom/observations";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

const CREDENTIALS = () => ({ url: "https://galaxy.test", apiKey: "k" });
const VERSION = { version_major: "26.1", version_minor: "1", extra: { site: "x" } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets every pending .then run: the capture is fire-and-forget, so nothing hands back its promise. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let handlers: Map<string, Handler[]>;
let versionCalls: number;

function load() {
  handlers = new Map();
  const pi = {
    on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
  };
  registerGalaxyVersionCapture(pi as never, bareFamily(["get_server_info", "get_user"]));
}

const fire = async (event: string, payload: unknown = {}) => {
  for (const h of handlers.get(event) ?? []) await h(payload);
};

/** A transport that answers /api/version from a queue of pending replies, one per lookup. */
function versionsFrom(replies: Array<Promise<Response>>) {
  versionCalls = 0;
  setGalaxyTransport({
    credentials: CREDENTIALS,
    fetch: (url) => {
      if (url.endsWith("/api/version")) {
        versionCalls++;
        return replies.shift() ?? Promise.resolve(json({}, 404));
      }
      return Promise.resolve(json({}));
    },
  });
}

beforeEach(() => {
  resetGalaxyVersion();
  load();
});

afterEach(() => {
  setGalaxyTransport(null);
  resetGalaxyVersion();
});

describe("versionOf", () => {
  it("joins version_major and version_minor", () => {
    expect(versionOf(VERSION)).toBe("26.1.1");
    expect(versionOf({ version_major: "26.1" })).toBe("26.1");
    expect(versionOf({ version_major: "26.1", version_minor: "" })).toBe("26.1");
  });

  it("gives nothing without a major version", () => {
    expect(versionOf({})).toBeUndefined();
    expect(versionOf({ version_major: 26 })).toBeUndefined();
    expect(versionOf(null)).toBeUndefined();
    expect(versionOf("26.1")).toBeUndefined();
  });
});

describe("session_start", () => {
  it("records the version from /api/version", async () => {
    versionsFrom([Promise.resolve(json(VERSION))]);
    await fire("session_start");
    await settle();
    expect(versionCalls).toBe(1);
    expect(getGalaxyVersion()).toBe("26.1.1");
  });

  it("does not wait for the lookup", async () => {
    const reply = deferred<Response>();
    versionsFrom([reply.promise]);
    await fire("session_start");
    expect(versionCalls).toBe(1);
    expect(getGalaxyVersion()).toBeUndefined();
    reply.resolve(json(VERSION));
    await settle();
    expect(getGalaxyVersion()).toBe("26.1.1");
  });

  it("ignores a lookup that finishes after a newer session started", async () => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    versionsFrom([stale.promise, fresh.promise]);
    await fire("session_start");
    await fire("session_start");
    stale.resolve(json({ version_major: "25.0", version_minor: "1" }));
    await settle();
    expect(getGalaxyVersion()).toBeUndefined();
    fresh.resolve(json(VERSION));
    await settle();
    expect(getGalaxyVersion()).toBe("26.1.1");
  });

  it("keeps the newer session's version when the older lookup lands last", async () => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    versionsFrom([stale.promise, fresh.promise]);
    await fire("session_start");
    await fire("session_start");
    fresh.resolve(json(VERSION));
    await settle();
    stale.resolve(json({ version_major: "25.0", version_minor: "1" }));
    await settle();
    expect(getGalaxyVersion()).toBe("26.1.1");
  });

  it("asks nothing without credentials", async () => {
    versionCalls = 0;
    setGalaxyTransport({
      credentials: () => ({ url: undefined, apiKey: undefined }),
      fetch: () => {
        versionCalls++;
        return Promise.resolve(json(VERSION));
      },
    });
    await fire("session_start");
    await settle();
    expect(versionCalls).toBe(0);
    expect(getGalaxyVersion()).toBeUndefined();
  });

  it("swallows a failed lookup and records nothing", async () => {
    versionsFrom([Promise.reject(new TypeError("fetch failed")), Promise.resolve(json({}, 500))]);
    await fire("session_start");
    await settle();
    await fire("session_start");
    await settle();
    expect(getGalaxyVersion()).toBeUndefined();
  });

  it("refuses a version that is not a release number", async () => {
    versionsFrom([Promise.resolve(json({ version_major: "galaxy.example.org" }))]);
    await fire("session_start");
    await settle();
    expect(getGalaxyVersion()).toBeUndefined();
  });
});

describe("get_server_info", () => {
  const envelope = (version: unknown) => ({
    success: true,
    data: { url: "https://galaxy.test", version, version_known: true },
  });
  const result = (structured: unknown, extra: object = {}) => ({
    toolName: "get_server_info",
    isError: false,
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...extra,
  });

  beforeEach(() => versionsFrom([]));

  it("refreshes the version from structuredContent", async () => {
    await fire("tool_result", result(envelope(VERSION)));
    expect(getGalaxyVersion()).toBe("26.1.1");
    await fire("tool_result", result(envelope({ version_major: "26.0", version_minor: "2" })));
    expect(getGalaxyVersion()).toBe("26.0.2");
  });

  it("reads the text when a handler dropped structuredContent", async () => {
    await fire("tool_result", result(envelope(VERSION), { structuredContent: undefined }));
    expect(getGalaxyVersion()).toBe("26.1.1");
  });

  it("ignores errors, other tools, and text that is not the envelope", async () => {
    await fire("tool_result", result(envelope(VERSION), { isError: true }));
    await fire("tool_result", result(envelope(VERSION), { toolName: "get_user" }));
    await fire(
      "tool_result",
      result(envelope(VERSION), { toolName: "mcp__galaxy__get_server_info" }),
    );
    await fire("tool_result", {
      toolName: "get_server_info",
      isError: false,
      content: [{ type: "text", text: "Large Galaxy response saved in memory." }],
    });
    expect(getGalaxyVersion()).toBeUndefined();
  });
});
