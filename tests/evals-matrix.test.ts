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
  });

  afterEach(() => {
    // don't leak the fake PROXY_URL into other test files in this worker
    delete process.env.PROXY_URL;
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
});
