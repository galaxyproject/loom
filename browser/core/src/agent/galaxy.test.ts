import { afterEach, describe, expect, it, vi } from "vitest";

import {
  briefly,
  connectGalaxy,
  connectWeb,
  ERROR_MAX,
  galaxyFetch,
  HttpError,
  segment,
} from "./galaxy";

describe("segment", () => {
  it("keeps an id from adding a segment, a query or a fragment", () => {
    expect(segment("../users/current?x=1#y")).toBe("..%2Fusers%2Fcurrent%3Fx%3D1%23y");
    expect(segment("f2c1a0")).toBe("f2c1a0");
  });

  it("refuses the values a URL reads as this or the parent segment", () => {
    for (const value of ["", ".", "..", "%2e%2e", "%2E.", ".%2e"]) {
      expect(() => segment(value)).toThrow(/is not a Galaxy id/);
    }
  });
});

describe("galaxyFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A Galaxy that answers 503 once, then 200, counting what it was sent. */
  function flaky() {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (request: Request) => {
      methods.push(request.method);
      return methods.length === 1
        ? new Response("busy", { status: 503 })
        : new Response("{}", { status: 200 });
    });
    return methods;
  }

  it("resends a refused read for galaxy-ops' client too, which has no retry of its own", async () => {
    vi.useFakeTimers();
    const methods = flaky();
    const pending = galaxyFetch({ root: "http://galaxy.test/" })("http://galaxy.test/api/version");
    await vi.advanceTimersByTimeAsync(1100);
    expect((await pending).status).toBe(200);
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("never resends a write Galaxy may already have applied", async () => {
    const methods = flaky();
    const response = await galaxyFetch({ root: "http://galaxy.test/" })(
      "http://galaxy.test/api/tools",
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(503);
    expect(methods).toEqual(["POST"]);
  });

  // With a key set, the headless transport must not let the key follow a redirect to another
  // origin, as shared/redirect-guard.js keeps Orbit's from doing.
  it("never carries the key across a redirect to another origin", async () => {
    const sent: Array<{ url: string; key: string | null }> = [];
    // Node's fetch: a followed redirect drops only a few headers (authorization, cookie), so
    // x-api-key goes along.
    const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      sent.push({ url: request.url, key: request.headers.get("x-api-key") });
      if (new URL(request.url).origin !== "http://galaxy.test") {
        return new Response("{}", { status: 200 });
      }
      const location = "http://elsewhere.test/x";
      return request.redirect === "follow"
        ? send(new Request(location, { headers: request.headers }))
        : new Response(null, { status: 302, headers: { location } });
    };
    vi.stubGlobal("fetch", send);
    await expect(
      galaxyFetch({ root: "http://galaxy.test/", key: "secret" })(
        "http://galaxy.test/api/datasets/d1/display",
      ),
    ).rejects.toMatchObject({ name: "RedirectRefusedError", kind: "cross-origin" });
    expect(sent[0]).toEqual({ url: "http://galaxy.test/api/datasets/d1/display", key: "secret" });
    expect(sent.filter((s) => !s.url.startsWith("http://galaxy.test/") && s.key)).toEqual([]);
  });

  // The keyed path reads a write's body once up front, so it must survive both resends.
  it("resends a keyed write's body across a same-origin hop and a rate limit", async () => {
    const sent: Array<{ url: string; type: string | null; body: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        type: request.headers.get("content-type"),
        body: await request.text(),
      });
      if (sent.length === 1) {
        return new Response(null, { status: 307, headers: { location: "/api/tools/fetch" } });
      }
      return sent.length === 2
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : new Response("{}", { status: 200 });
    });
    const body = JSON.stringify({ tool_id: "cat1", inputs: { input1: "d1" } });
    const response = await galaxyFetch({ root: "http://galaxy.test/", key: "secret" })(
      "http://galaxy.test/api/tools",
      { method: "POST", headers: { "content-type": "application/json" }, body },
    );
    expect(response.status).toBe(200);
    const sentAs = { type: "application/json", body };
    expect(sent).toEqual([
      { url: "http://galaxy.test/api/tools", ...sentAs },
      { url: "http://galaxy.test/api/tools/fetch", ...sentAs },
      { url: "http://galaxy.test/api/tools", ...sentAs },
    ]);
  });
});

describe("connectGalaxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("backs off when a refusal states no wait, instead of retrying at once", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    vi.stubGlobal("fetch", async () => {
      calls.push(Date.now());
      return calls.length === 1
        ? new Response("busy", { status: 503 })
        : new Response("{}", { status: 200 });
    });
    const pending = connectGalaxy({ root: "http://galaxy.test/" }).get("api/version");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(calls).toHaveLength(2);
  });
});

describe("an error, as the model reads it", () => {
  const NGINX =
    "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n" +
    "<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
  const MAINTENANCE =
    "<!DOCTYPE html><html><head><style>" +
    "body{}".repeat(5000) +
    "</style></head>" +
    "<body><h1>Galaxy is down for maintenance</h1></body></html>";

  afterEach(() => vi.unstubAllGlobals());

  it("keeps Galaxy's own message", () => {
    expect(briefly('{"err_msg": "Tool \'cat9\' not found", "err_code": 400008}')).toBe(
      "Tool 'cat9' not found",
    );
  });

  it("names an HTML page by its title, or by its heading", () => {
    expect(briefly(NGINX)).toBe("502 Bad Gateway");
    expect(briefly(MAINTENANCE)).toBe("Galaxy is down for maintenance");
  });

  it("keeps what was said before a page, as a client library quotes one", () => {
    expect(briefly(`GET: error 502: b'${NGINX}', 0 attempts left: ${NGINX}`)).toBe(
      "GET: error 502: 502 Bad Gateway",
    );
  });

  it("keeps the whole of a multi-line error on one line, not its closing brace", () => {
    const error = `400 ${JSON.stringify({ error: { message: "context too long" } }, null, 2)}`;
    expect(briefly(error)).toBe('400 { "error": { "message": "context too long" } }');
  });

  it("cuts anything else that runs long", () => {
    const out = briefly("Traceback: " + "frame ".repeat(1000));
    expect(out.length).toBeLessThan(ERROR_MAX + 40);
    expect(out).toMatch(/… \(\d+ more characters\)$/);
  });

  it("throws Galaxy's status with the short form", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(MAINTENANCE, { status: 502, headers: { "content-type": "text/html" } }),
    );
    const error = await connectGalaxy({ root: "http://galaxy.test/" })
      .post("api/tools", {})
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("HTTP 502: Galaxy is down for maintenance");
  });
});

describe("a tool call's web", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Hosts that never answer, until their request is aborted. */
  const hung = () =>
    vi.stubGlobal(
      "fetch",
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_, reject) => {
          const signal = input instanceof Request ? input.signal : init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

  it("ends with the call", async () => {
    hung();
    const call = new AbortController();
    const pending = connectWeb(call.signal).connect("https://www.ebi.ac.uk/").get("x");
    call.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("ends once its time is up, and says so", async () => {
    hung();
    await expect(connectWeb(undefined, 50).fetch("https://quay.io/x")).rejects.toThrow(
      "no answer within 0.05 s",
    );
  });

  it("counts the waits between retries against the same time", async () => {
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked++;
      return new Response("busy", { status: 503, headers: { "retry-after": "60" } });
    });
    const started = Date.now();
    await expect(
      connectWeb(undefined, 100).connect("https://www.ebi.ac.uk/").get("x"),
    ).rejects.toThrow("no answer within 0.1 s");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(asked).toBe(1);
  });

  it("never sends Galaxy's login", async () => {
    const sent: RequestCredentials[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(
        input instanceof Request ? input.credentials : (init?.credentials ?? "same-origin"),
      );
      return new Response("{}");
    });
    const web = connectWeb();
    await web.connect("https://training.galaxyproject.org/").get("x");
    await web.fetch("https://quay.io/x");
    expect(sent).toEqual(["omit", "omit"]);
  });
});
