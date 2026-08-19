/**
 * Load the curated model matrix and decide which entries can actually run.
 *
 * Skip-with-warning rather than fail-on-missing-env: most contributors won't
 * have every credential (Anthropic + TACC + OpenAI + ...), and we want the
 * subset they do have to keep working locally.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { ModelEntry, ModelMatrix } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const evalsDir = path.resolve(path.dirname(__filename), "..");
const modelsJsonPath = path.join(evalsDir, "models.json");

export interface MatrixLoadResult {
  available: ModelEntry[];
  skipped: { model: ModelEntry; missing: string[] }[];
}

export function loadMatrix(filterIds?: string[]): MatrixLoadResult {
  const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) as ModelMatrix;
  const available: ModelEntry[] = [];
  const skipped: MatrixLoadResult["skipped"] = [];

  for (const model of raw.models) {
    if (filterIds && filterIds.length > 0 && !filterIds.includes(model.id)) continue;
    const missing = (model.envRequires ?? []).filter((v) => !process.env[v]);
    if (missing.length > 0) {
      skipped.push({ model, missing });
      continue;
    }
    available.push(model);
  }
  return { available, skipped };
}

/**
 * Synthesize a Pi-shaped models.json into the temp agent dir for any
 * OpenAI-compatible custom provider. First-class providers (anthropic et al.)
 * are no-ops -- Pi loads them from its built-in registry.
 */
export function writePiModelsConfig(model: ModelEntry, agentDir: string): void {
  if (!model.providerConfig) return;

  const cfg = model.providerConfig;
  const baseUrl = cfg.baseUrlIsEnvVar ? process.env[cfg.baseUrl] : cfg.baseUrl;
  if (!baseUrl) {
    throw new Error(`Model ${model.id}: providerConfig.baseUrl env var '${cfg.baseUrl}' is unset`);
  }

  // pi's provider `apiKey` is the literal credential, not the name of an env var
  // holding it -- writing the name got it sent verbatim as the bearer token, so the
  // whole matrix 401'd ("Received=PROX****_KEY"). Resolve it here. The file lives in
  // a per-run mkdtemp that runScenario removes in its finally block.
  const apiKey = process.env[cfg.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Model ${model.id}: providerConfig.apiKeyEnvVar '${cfg.apiKeyEnvVar}' is unset`,
    );
  }

  const piModels = {
    providers: {
      [model.provider]: {
        baseUrl,
        api: "openai-completions",
        apiKey,
        models: [
          {
            id: model.model,
            name: model.model,
            reasoning: model.reasoningModel ?? false,
            input: ["text"],
            contextWindow: cfg.contextWindow ?? 32000,
            maxTokens: cfg.maxTokens ?? 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };

  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(piModels, null, 2));
}
