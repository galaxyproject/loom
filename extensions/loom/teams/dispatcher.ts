import { validateTeamSpec } from "./validate";
import { parseCriticResponse } from "./critic-parser";
import type { DispatchDeps, TeamResult, TeamSpec, TeamTurn } from "./types";

export interface DispatchOptions {
  tokenCeiling?: number; // default 300_000
}

export type OnTurnUpdate = (snapshot: {
  round: number;
  max_rounds: number;
  current_role: string;
  turns: TeamTurn[];
}) => void;

const DEFAULT_TOKEN_CEILING = 300_000;

/**
 * Run the two-role critic loop to completion.
 * `deps.runRoleTurn` is injected so this function is unit-testable without
 * a real Pi runtime.
 */
export async function runTeamDispatch(
  spec: TeamSpec,
  deps: DispatchDeps,
  signal: AbortSignal,
  onTurn?: OnTurnUpdate,
  options: DispatchOptions = {},
): Promise<TeamResult> {
  validateTeamSpec(spec);

  const tokenCeiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING;
  const maxRounds = spec.max_rounds ?? 5;
  const [proposer, critic] = spec.roles;
  const transcript: TeamTurn[] = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let currentProposal = "";
  let currentCritique: string | null = null;
  let round = 0;

  try {
    for (round = 1; round <= maxRounds; round++) {
      // --- Proposer turn ---
      if (signal.aborted) return aborted(transcript, round, currentProposal, totalUsage);
      const proposerInput = renderProposerInput(spec.description, currentCritique);
      const proposerPreamble = buildPreamble(spec, proposer, "proposer");
      const proposerResult = await deps.runRoleTurn(
        proposer,
        proposerPreamble,
        proposerInput,
        signal,
      );
      currentProposal = proposerResult.content;
      transcript.push({
        round,
        role: proposer.name,
        content: currentProposal,
      });
      totalUsage = add(totalUsage, proposerResult.usage);
      onTurn?.({ round, max_rounds: maxRounds, current_role: proposer.name, turns: transcript });

      if (exceedsCeiling(totalUsage, tokenCeiling)) {
        return budgetExhausted(transcript, round, currentProposal, totalUsage);
      }

      // --- Critic turn ---
      if (signal.aborted) return aborted(transcript, round, currentProposal, totalUsage);
      const criticInput = renderCriticInput(spec.description, currentProposal);
      const criticPreamble = buildPreamble(spec, critic, "critic");
      const criticResult = await deps.runRoleTurn(critic, criticPreamble, criticInput, signal);
      const verdict = parseCriticResponse(criticResult.content);
      transcript.push({
        round,
        role: critic.name,
        content: criticResult.content,
        approved: verdict.approved,
      });
      totalUsage = add(totalUsage, criticResult.usage);
      onTurn?.({ round, max_rounds: maxRounds, current_role: critic.name, turns: transcript });

      if (verdict.approved) {
        return {
          converged: true,
          rounds: round,
          final_output: currentProposal,
          transcript,
          usage: totalUsage,
        };
      }
      if (exceedsCeiling(totalUsage, tokenCeiling)) {
        return budgetExhausted(transcript, round, currentProposal, totalUsage);
      }
      currentCritique = verdict.critique;
    }

    return {
      converged: false,
      rounds: maxRounds,
      final_output: currentProposal,
      transcript,
      usage: totalUsage,
    };
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return aborted(transcript, round, currentProposal, totalUsage);
    }
    return {
      converged: false,
      rounds: round,
      final_output: currentProposal,
      transcript,
      usage: totalUsage,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- helpers ------------------------------------------------------------

function renderProposerInput(description: string, priorCritique: string | null): string {
  if (priorCritique === null) {
    return `Team task: ${description}\n\nProduce your first proposal.`;
  }
  return (
    `Team task: ${description}\n\n` +
    `The critic raised the following issues with your previous proposal:\n${priorCritique}\n\n` +
    `Produce a revised proposal that addresses them.`
  );
}

function renderCriticInput(description: string, proposal: string): string {
  return (
    `Team task: ${description}\n\n` +
    `Proposer output:\n${proposal}\n\n` +
    `Critique the proposal. End your response with a JSON line of shape ` +
    `{"approved": boolean, "critique": string}.`
  );
}

function buildPreamble(
  spec: TeamSpec,
  role: { system_prompt: string },
  kind: "proposer" | "critic",
): string {
  const teamContext =
    `You are one role in a two-agent team collaborating on the task: "${spec.description}". ` +
    `Respond only from your role's perspective.`;
  const criticContract =
    kind === "critic"
      ? ` When you have finished critiquing, finish your response with a JSON line: ` +
        `{"approved": boolean, "critique": "one paragraph"}.`
      : "";
  return `${teamContext}${criticContract}\n\n${role.system_prompt}`;
}

function add(
  a: { input_tokens: number; output_tokens: number },
  b: { input_tokens: number; output_tokens: number },
) {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

function exceedsCeiling(
  u: { input_tokens: number; output_tokens: number },
  ceiling: number,
): boolean {
  return u.input_tokens + u.output_tokens > ceiling;
}

function aborted(
  transcript: TeamTurn[],
  round: number,
  finalOutput: string,
  usage: { input_tokens: number; output_tokens: number },
): TeamResult {
  return {
    converged: false,
    aborted: true,
    rounds: round,
    final_output: finalOutput,
    transcript,
    usage,
  };
}

function budgetExhausted(
  transcript: TeamTurn[],
  round: number,
  finalOutput: string,
  usage: { input_tokens: number; output_tokens: number },
): TeamResult {
  return {
    converged: false,
    budget_exhausted: true,
    rounds: round,
    final_output: finalOutput,
    transcript,
    usage,
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("abort"))
  );
}
