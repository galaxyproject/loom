import { describe, expect, it } from "vitest";

import { endpointModels } from "./endpoint";

describe("model settings", () => {
  it("gives every user the service key, tagged with who they are", () => {
    const modelFor = endpointModels({ url: new URL("https://litellm.test"), key: "sk-service", model: "minimax" });
    expect(modelFor("user-a")).toEqual({ baseUrl: "https://litellm.test/v1", id: "minimax", apiKey: "sk-service", user: "user-a" });
    expect(modelFor("user-b").user).toBe("user-b");
  });

  it("keeps a path on the endpoint's URL", () => {
    const modelFor = endpointModels({ url: new URL("https://example.org/litellm"), key: "k", model: "m" });
    expect(modelFor("u").baseUrl).toBe("https://example.org/litellm/v1");
  });
});
