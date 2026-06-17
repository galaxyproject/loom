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
  /**
   * Structural plan checks parsed from the agent's chat text. Use this for
   * single-turn plan-creation scenarios -- Loom's plan-convention block
   * tells the agent to draft plans IN CHAT first and only write to
   * notebook.md after explicit user approval, so for a one-shot eval the
   * correct plan is in chat, not in the file.
   */
  chatPlan?: PlanAssertions;
  /**
   * Structural assertions on the post-run notebook.md. Reads the file from
   * the scenario's temp cwd after loom exits (or times out -- the runner
   * captures notebook state before cleanup). Content quality (right tools,
   * right reasoning) is intentionally out of scope here; that lives in
   * the galaxy/brc Python harnesses with LLMJudge.
   */
  notebook?: NotebookAssertions;
  /**
   * Source-aware plan check. Unlike `chatPlan` / `notebook.plan` (which are
   * pinned to one surface), this reads the latest plan from wherever it landed
   * per `source` (default "any"). Preferred for decision-correctness scenarios.
   */
  plan?: PlanAssertions;
  exitCode?: number;
}

export interface NotebookAssertions {
  /** notebook.md must (or must not) exist after the run */
  exists?: boolean;
  /** every string must appear in the notebook content */
  contains?: string[];
  /** none of these strings may appear */
  mustNotContain?: string[];
  /** structural checks on the latest plan section */
  plan?: PlanAssertions;
}

export interface PlanAssertions {
  /** at least one `## Plan X: ... [routing]` heading must exist */
  exists?: boolean;
  /**
   * Where to read the plan from. "any" (default) = notebook.md if it contains
   * a plan, else the chat text. Models don't reliably follow Loom's
   * draft-in-chat-then-write gate, so "any" is the right default for grading.
   */
  source?: "chat" | "notebook" | "any";
  /** routing tag in the heading must be one of these */
  routingIn?: ("local" | "galaxy" | "hybrid" | "remote")[];
  /** plan section must have at least N pending (`- [ ]`) steps */
  minPendingSteps?: number;
  /**
   * Every pending step must carry a description beyond just `**Title**`.
   * Mirrors init-gate's >= 8 chars heuristic (number/title/anchor stripped).
   */
  eachStepHasDescription?: boolean;
  /**
   * The plan-source text must mention at least one of these (case-insensitive
   * substring). Used as a coarse tool/approach-appropriateness check -- a
   * heuristic, not an oracle. Curate generously to limit false negatives.
   */
  mentionsOneOf?: string[];
  /** The plan-source text must mention none of these (case-insensitive). */
  mentionsNoneOf?: string[];
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

/**
 * Which decision-correctness axis a failure belongs to. Lets the report
 * group results into a model x dimension leaderboard.
 */
export type Dimension = "validity" | "routing" | "tools" | "behavior" | "other";

export interface ScenarioFailure {
  assertion: string;
  detail: string;
  dimension?: Dimension;
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
  /**
   * Reasoning models (gpt-oss-120b) emit chain-of-thought in `reasoning_content`
   * rather than inline. Surface that to Pi so it gives the model room and reads
   * the field instead of returning empty `content`.
   */
  reasoningModel?: boolean;
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
  /** Final notebook.md content from the scenario's temp cwd, null if absent. */
  notebookContent: string | null;
  failures: ScenarioFailure[];
  durationMs: number;
}

export interface AnyEvent {
  type: string;
  [k: string]: unknown;
}
