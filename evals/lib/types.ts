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
  inputs: string[];
  env?: Record<string, string>;
  /** Hard wall-clock cap for the loom invocation. Defaults to 15s. */
  timeoutMs?: number;
  assertions: Assertions;
}

export interface ScenarioFailure {
  assertion: string;
  detail: string;
}

export interface ScenarioRun {
  scenarioDir: string;
  scenario: Scenario;
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
