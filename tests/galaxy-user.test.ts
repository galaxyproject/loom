import { describe, it, expect, vi } from "vitest";
import { fetchGalaxyCurrentUser } from "../app/src/main/galaxy-user.js";
import { formatGalaxyTooltip } from "../app/src/renderer/galaxy-tooltip.js";

describe("formatGalaxyTooltip", () => {
  const U = "https://test.galaxyproject.org";

  it("shows the url alone when there's no user info yet", () => {
    expect(formatGalaxyTooltip(U)).toBe(`Galaxy: ${U}`);
    expect(formatGalaxyTooltip(U, null)).toBe(`Galaxy: ${U}`);
  });

  it("appends the username when connected", () => {
    expect(formatGalaxyTooltip(U, { ok: true, username: "dannon" })).toBe(`Galaxy: ${U} (dannon)`);
  });

  it("falls back to email when there's no username", () => {
    expect(formatGalaxyTooltip(U, { ok: true, email: "dannon@lab.org" })).toBe(
      `Galaxy: ${U} (dannon@lab.org)`,
    );
  });

  it("prefers username over email when both are present", () => {
    expect(formatGalaxyTooltip(U, { ok: true, username: "dannon", email: "dannon@lab.org" })).toBe(
      `Galaxy: ${U} (dannon)`,
    );
  });

  it("shows url alone when connected but the account has no public identity", () => {
    expect(formatGalaxyTooltip(U, { ok: true })).toBe(`Galaxy: ${U}`);
  });

  it("flags an auth failure", () => {
    expect(formatGalaxyTooltip(U, { ok: false, authFailed: true })).toBe(
      `Galaxy: ${U} (sign-in failed)`,
    );
  });

  it("stays silent (url only) on a non-auth failure", () => {
    expect(formatGalaxyTooltip(U, { ok: false, authFailed: false })).toBe(`Galaxy: ${U}`);
  });
});

describe("fetchGalaxyCurrentUser", () => {
  const U = "https://test.galaxyproject.org";
  const KEY = "secret-key";

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  it("returns username + email from /api/users/current with the x-api-key header", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { username: "dannon", email: "dannon@lab.org", id: "abc" }),
    );
    const result = await fetchGalaxyCurrentUser(U, KEY, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, username: "dannon", email: "dannon@lab.org" });
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe(`${U}/api/users/current`);
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": KEY });
  });

  it("strips a trailing slash from the base url", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { username: "dannon" }));
    await fetchGalaxyCurrentUser(`${U}/`, KEY, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${U}/api/users/current`);
  });

  it("treats an empty username as no public identity", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { username: "", email: "" }));
    const result = await fetchGalaxyCurrentUser(U, KEY, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
  });

  it("reports an auth failure on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, {}));
    expect(await fetchGalaxyCurrentUser(U, KEY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      authFailed: true,
    });
  });

  it("reports an auth failure on 403", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, {}));
    expect(await fetchGalaxyCurrentUser(U, KEY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      authFailed: true,
    });
  });

  it("stays silent on a non-auth HTTP error (5xx)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    expect(await fetchGalaxyCurrentUser(U, KEY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      authFailed: false,
    });
  });

  it("stays silent on a network/timeout error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await fetchGalaxyCurrentUser(U, KEY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      authFailed: false,
    });
  });

  it("does not send the key to a non-https/non-loopback url", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { username: "x" }));
    expect(
      await fetchGalaxyCurrentUser(
        "http://evil.example",
        KEY,
        fetchImpl as unknown as typeof fetch,
      ),
    ).toEqual({ ok: false, authFailed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call the network when url or key is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    expect(await fetchGalaxyCurrentUser("", KEY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      authFailed: false,
    });
    expect(await fetchGalaxyCurrentUser(U, "", fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      authFailed: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
