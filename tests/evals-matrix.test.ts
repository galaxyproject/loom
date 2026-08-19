import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writePiModelsConfig } from "../evals/lib/matrix";
import type { ModelEntry } from "../evals/lib/types";

function tmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evals-matrix-"));
}

const baseProviderConfig = {
  type: "openai-compatible" as const,
  baseUrl: "PROXY_URL",
  baseUrlIsEnvVar: true,
  apiKeyEnvVar: "PROXY_API_KEY",
  contextWindow: 128000,
  maxTokens: 8192,
};

describe("evals matrix: writePiModelsConfig", () => {
  beforeEach(() => {
    process.env.PROXY_URL = "https://proxy.example/v1";
    process.env.PROXY_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    // don't leak the fake credentials into other test files in this worker
    delete process.env.PROXY_URL;
    delete process.env.PROXY_API_KEY;
  });

  it("marks a reasoning model with reasoning:true and the configured maxTokens", () => {
    const model: ModelEntry = {
      id: "tacc:gpt-oss-120b",
      provider: "tacc-sambanova",
      model: "gpt-oss-120b",
      reasoningModel: true,
      providerConfig: baseProviderConfig,
    };
    const dir = tmpAgentDir();
    writePiModelsConfig(model, dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
    const entry = cfg.providers["tacc-sambanova"].models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.maxTokens).toBe(8192);
  });

  it("defaults non-reasoning models to reasoning:false", () => {
    const model: ModelEntry = {
      id: "tacc:llama-3.3-70b",
      provider: "tacc-sambanova",
      model: "Meta-Llama-3.3-70B-Instruct",
      providerConfig: { ...baseProviderConfig, maxTokens: 4096 },
    };
    const dir = tmpAgentDir();
    writePiModelsConfig(model, dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
    expect(cfg.providers["tacc-sambanova"].models[0].reasoning).toBe(false);
  });
  it("writes the resolved API key, not the name of the env var", () => {
    // Regression: pi's provider `apiKey` is the literal credential. Writing the
    // env var NAME sent "PROXY_API_KEY" as the bearer token, 401'd every model,
    // and surfaced as a content assertion failure rather than an auth error.
    const model: ModelEntry = {
      id: "tacc:qwen3-32b",
      provider: "tacc-sambanova",
      model: "Qwen3-32B",
      providerConfig: baseProviderConfig,
    };
    const dir = tmpAgentDir();
    writePiModelsConfig(model, dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
    expect(cfg.providers["tacc-sambanova"].apiKey).toBe("sk-test-key");
    expect(cfg.providers["tacc-sambanova"].apiKey).not.toBe("PROXY_API_KEY");
  });

  it("throws a named error when the API key env var is unset", () => {
    delete process.env.PROXY_API_KEY;
    const model: ModelEntry = {
      id: "tacc:qwen3-32b",
      provider: "tacc-sambanova",
      model: "Qwen3-32B",
      providerConfig: baseProviderConfig,
    };
    expect(() => writePiModelsConfig(model, tmpAgentDir())).toThrow(/PROXY_API_KEY/);
  });
});
