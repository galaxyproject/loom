import { describe, expect, it } from "vitest";

import { buildConfig, type Launched } from "./config";

const incoming: Launched = { root: "/", datasetId: "d1", galaxyChatUrl: "/api/plugins/olit" };

describe("buildConfig", () => {
  it("never hands the agent the API key", () => {
    const config = buildConfig(incoming, { provider: "openrouter", apiKey: "sk-secret" });
    expect(JSON.stringify(config)).not.toContain("sk-secret");
    expect("ai_api_key" in config).toBe(false);
  });

  it("defaults to the Galaxy proxy only where there is one", () => {
    expect(buildConfig(incoming).ai_provider).toBe("galaxy");
    expect(buildConfig(incoming).ai_base_url).toBe("/api/plugins/olit");
    const unhosted = buildConfig({ root: "/", datasetId: "d1" });
    expect(unhosted.ai_provider).toBeUndefined();
    expect(unhosted.ai_base_url).toBeUndefined();
  });

  // Launched has no field for either, but a launch that carries the plugin's specs along
  // anyway still mustn't pass them through.
  it("carries no Galaxy key or capability grant from whatever launched it", () => {
    const launched = {
      ...incoming,
      galaxy_api_key: "fea4130124bb18ef",
      capabilities: "llm,local,read",
    } as Launched;
    const config = JSON.stringify(buildConfig(launched));
    expect(config).not.toContain("fea4130124bb18ef");
    expect(config).not.toContain("llm,local,read");
  });
});
