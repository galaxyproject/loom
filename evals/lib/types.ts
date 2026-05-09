/**
 * Scenario file format. A scenario lives at evals/scenarios/<name>/scenario.json
 * with optional fixture files in cwd/ and golden files in expected/.
 */

export interface ToolCallExpectation {
  name: string;
  argsContains?: Record<string, string>;
}

export interface Assertions {
  toolCalls?: {
    mustInclude?: ToolCallExpectation[];
    mustNotInclude?: string[];
  };
  events?: {
    mustInclude?: string[];
    mustNotInclude?: string[];
  };
  chatText?: {
    mustInclude?: string[];
    mustNotInclude?: string[];
  };
  exitCode?: number;
}

export interface Scenario {
  name: string;
  description?: string;
  tier: 1 | 2;
  /**
   * Tier 2 scenarios that exercise the agent loop set this true; the runner
   * crosses them with every model in evals/models.json that has its env
   * requirements satisfied. Tier 1 scenarios that hit a synchronous code
   * path (slash-command preflight, etc.) leave it false and run once.
   */
  requiresModel?: boolean;
  inputs: string[];
  env?: Record<string, string>;
  /**
   * Extra CLI flags forwarded verbatim to the loom invocation. Useful for
   * `--no-tools`, `--tools read,bash`, etc. -- different scenarios want
   * different tool surfaces. Comes after `--mode json` and any
   * `--provider`/`--model` injected by the runner.
   */
  loomArgs?: string[];
  /** Hard wall-clock cap for the loom invocation. Defaults to 15s. */
  timeoutMs?: number;
  assertions: Assertions;
}

export interface ScenarioFailure {
  assertion: string;
  detail: string;
}

/**
 * Curated matrix of models. First-class Pi providers (anthropic/openai/google)
 * just need env vars set. OpenAI-compatible custom providers (TACC, litellm)
 * also carry a `providerConfig` block that the runner synthesizes into a Pi
 * models.json before spawning.
 */
export interface ModelEntry {
  /** Stable id for reporting, e.g. "tacc:llama-3.3-70b" */
  id: string;
  /** Pi `--provider` argument */
  provider: string;
  /** Pi `--model` argument */
  model: string;
  /**
   * Env vars that must be set for this model to run. Missing vars cause a
   * skip (with a warning), not a failure.
   */
  envRequires?: string[];
  /**
   * For OpenAI-compatible custom providers: enough to write a Pi models.json
   * entry. First-class providers leave this undefined.
   */
  providerConfig?: {
    type: "openai-compatible";
    /** Either a literal URL or the env var name to read it from. */
    baseUrl: string;
    baseUrlIsEnvVar?: boolean;
    /** Env var name holding the API key. */
    apiKeyEnvVar: string;
    contextWindow?: number;
    maxTokens?: number;
  };
  /**
   * Strip <think>...</think> blocks from chat text before assertion. Some
   * thinking-mode models (Qwen3-32B) emit them by default.
   */
  stripThinkingTags?: boolean;
}

export interface ModelMatrix {
  models: ModelEntry[];
}

export interface ScenarioRun {
  scenarioDir: string;
  scenario: Scenario;
  /** null for Tier 1 scenarios that don't traverse the matrix. */
  model: ModelEntry | null;
  exitCode: number;
  events: AnyEvent[];
  stdout: string;
  stderr: string;
  failures: ScenarioFailure[];
  durationMs: number;
}

export interface AnyEvent {
  type: string;
  [k: string]: unknown;
}
