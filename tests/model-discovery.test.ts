import { describe, expect, it, vi } from "vitest";
import { discoverProviderModels } from "../app/src/main/model-discovery.js";
import type { LoomConfig } from "../shared/loom-config.js";

const CONFIG: LoomConfig = {
  llm: {
    active: "anthropic",
    providers: {
      anthropic: { apiKeyEncrypted: "enc", model: "claude-opus-5" },
      "openai-compatible": {
        apiKeyEncrypted: "enc",
        model: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1/",
      },
    },
  },
};

const okProbe = (models: string[]) => vi.fn(async () => ({ valid: true as const, models }));

describe("discoverProviderModels", () => {
  it("probes the stored base URL with the stored key", async () => {
    const probe = okProbe(["a/one", "b/two"]);
    const res = await discoverProviderModels("openai-compatible", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe,
    });
    expect(res).toEqual({ ok: true, models: ["a/one", "b/two"] });
    expect(probe).toHaveBeenCalledWith("https://openrouter.ai/api/v1/", "sk-stored");
  });

  it("dedupes and drops blank ids the endpoint reports", async () => {
    const res = await discoverProviderModels("openai-compatible", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe: okProbe(["a/one", "a/one", "  ", "", "b/two"]),
    });
    expect(res).toEqual({ ok: true, models: ["a/one", "b/two"] });
  });

  it("reports an empty catalog as success with no models", async () => {
    const res = await discoverProviderModels("openai-compatible", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe: okProbe([]),
    });
    expect(res).toEqual({ ok: true, models: [] });
  });

  it("fails without probing when the provider has no stored config", async () => {
    const probe = okProbe(["a/one"]);
    const res = await discoverProviderModels("nope", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe,
    });
    expect(res.ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails without probing for a provider that has no base URL", async () => {
    const probe = okProbe(["a/one"]);
    const res = await discoverProviderModels("anthropic", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/base URL/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails without probing when no key is stored", async () => {
    const probe = okProbe(["a/one"]);
    const res = await discoverProviderModels("openai-compatible", {
      config: CONFIG,
      resolveKey: () => null,
      probe,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/key/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it("surfaces the probe's rejection reason", async () => {
    const res = await discoverProviderModels("openai-compatible", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe: async () => ({ valid: false as const, error: "Invalid API key (401)" }),
    });
    expect(res).toEqual({ ok: false, error: "Invalid API key (401)" });
  });

  it("turns a thrown probe into an error result", async () => {
    const res = await discoverProviderModels("openai-compatible", {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe: async () => {
        throw new Error("boom");
      },
    });
    expect(res).toEqual({ ok: false, error: "boom" });
  });

  it("rejects a non-string provider from the renderer", async () => {
    const res = await discoverProviderModels(undefined as unknown as string, {
      config: CONFIG,
      resolveKey: () => "sk-stored",
      probe: okProbe(["a/one"]),
    });
    expect(res.ok).toBe(false);
  });
});
