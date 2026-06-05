import { describe, it, expect, vi, beforeEach } from "vitest";
import { submitFeedback } from "../extensions/loom/feedback.js";

describe("brain submitFeedback", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("POSTs the payload and returns ok+id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: "abc" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await submitFeedback({
      schemaVersion: 1,
      source: "loom-cli",
      title: "t",
      body: "b",
      clientTs: "now",
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBe("abc");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/feedback$/);
    expect(opts.method).toBe("POST");
  });

  it("returns ok:false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const res = await submitFeedback({
      schemaVersion: 1,
      source: "loom-cli",
      title: "t",
      body: "b",
      clientTs: "now",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("offline");
  });
});
